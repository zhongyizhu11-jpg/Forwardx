package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

/*
FXP 热更新。

配置签名变了、但进程还活着时，先试着让它原地换配置：写新配置文件、发 SIGHUP、
等进程把带着同一个 nonce 的结果写进 <config>.applied。成功了，这台机器上走这条
隧道的连接一条都不断（没改的规则完全不受影响，改了的规则旧连接按旧配置跑完）。
任何一步不满足就返回 false，由调用方走原来的「停掉再启动」。

不热更新的情况：
  - V2（WireGuard）：它的代理端口由 Agent 按配置准备，和进程生命周期绑在一起。
  - 进程用的不是当前的 FXP 二进制（刚升级过）：本来就该重启换新版本。
  - 进程没写过 .applied：它是不认识 SIGHUP 的旧版本，SIGHUP 的默认动作会杀掉它。
  - 新配置要的端口正被别的 FXP 进程占着：那得先按原流程把对方停掉。
*/

const fxpReloadAckTimeout = 5 * time.Second

type fxpReloadAck struct {
	Nonce string `json:"nonce"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	PID   int    `json:"pid"`
}

func fxpReloadAckPath(configPath string) string {
	return configPath + ".applied"
}

func readFXPReloadAck(configPath string) (fxpReloadAck, bool) {
	raw, err := os.ReadFile(fxpReloadAckPath(configPath))
	if err != nil {
		return fxpReloadAck{}, false
	}
	var ack fxpReloadAck
	if json.Unmarshal(raw, &ack) != nil {
		return fxpReloadAck{}, false
	}
	return ack, true
}

func fxpProcessPID(process *fxpProcess) int {
	if process == nil {
		return 0
	}
	if process.cmd != nil && process.cmd.Process != nil {
		return process.cmd.Process.Pid
	}
	pids := fxpRuntimePIDs(process.configPath)
	if len(pids) == 1 {
		return pids[0]
	}
	return 0
}

// fxpSpecWithPanelCredentials 把入口上报流量要用的面板地址和令牌填进运行时配置。
func fxpSpecWithPanelCredentials(cfg Config, spec fxpSpec) fxpSpec {
	if spec.Role == "entry" {
		spec.PanelURL = currentPanelURL(cfg)
		spec.Token = cfg.Token
	} else if isFXPEntryGroup(spec) {
		entries := make([]fxpSpec, len(spec.Entries))
		copy(entries, spec.Entries)
		for index := range entries {
			entries[index].PanelURL = currentPanelURL(cfg)
			entries[index].Token = cfg.Token
		}
		spec.Entries = entries
	}
	return spec
}

// fxpReloadHasForeignListenConflict：新配置要的端口是否被别的 FXP 运行时占着（只读检查）。
func fxpReloadHasForeignListenConflict(spec fxpSpec, id string) bool {
	fxpMu.Lock()
	for otherID, process := range fxpServers {
		if otherID != id && process != nil && fxpSpecsListenConflict(process.spec, spec) {
			fxpMu.Unlock()
			return true
		}
	}
	fxpMu.Unlock()
	ownPath := fxpConfigPath(spec)
	paths, _ := filepath.Glob("/run/forwardx-agent/fxp-*.json")
	for _, path := range paths {
		if path == ownPath {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var other fxpSpec
		if json.Unmarshal(raw, &other) != nil {
			continue
		}
		other = normalizeFXPSpec(other)
		if fxpServerID(other) != id && fxpSpecsListenConflict(other, spec) {
			return true
		}
	}
	return false
}

func fxpHotReloadable(existing *fxpProcess, spec fxpSpec, signature, configPath, id string) (int, bool) {
	if existing == nil || existing.signature == signature {
		return 0, false
	}
	current := normalizeFXPSpec(existing.spec)
	if current.TransportVersion == forwardXWireGuardVersion || spec.TransportVersion == forwardXWireGuardVersion {
		return 0, false
	}
	if !strings.EqualFold(current.Role, spec.Role) || current.TransportVersion != spec.TransportVersion {
		return 0, false
	}
	if existing.configPath != configPath || !fxpProcessUsesCurrentExecutable(existing) {
		return 0, false
	}
	pid := fxpProcessPID(existing)
	if pid <= 0 {
		return 0, false
	}
	if ack, ok := readFXPReloadAck(configPath); !ok || ack.PID != pid {
		return 0, false
	}
	if fxpReloadHasForeignListenConflict(spec, id) {
		return 0, false
	}
	return pid, true
}

// reloadFXPRuntimeLocked 尝试让正在运行的 FXP 原地换成 spec。调用方持有 fxpControlMu。
func reloadFXPRuntimeLocked(cfg Config, existing *fxpProcess, id string, spec fxpSpec, signature, configPath, credentialDigest string, persistenceEnabled bool) bool {
	pid, ok := fxpHotReloadable(existing, spec, signature, configPath, id)
	if !ok {
		return false
	}
	nonceBytes := make([]byte, 12)
	if _, err := rand.Read(nonceBytes); err != nil {
		return false
	}
	nonce := hex.EncodeToString(nonceBytes)
	raw, err := json.Marshal(fxpSpecWithPanelCredentials(cfg, spec))
	if err != nil {
		return false
	}
	var document map[string]any
	if json.Unmarshal(raw, &document) != nil {
		return false
	}
	document["reloadNonce"] = nonce
	raw, err = json.Marshal(document)
	if err != nil {
		return false
	}
	previous, err := os.ReadFile(configPath)
	if err != nil {
		return false
	}
	if err := writeFileAtomic(configPath, raw); err != nil {
		return false
	}
	// 没成功就把旧配置写回去：调用方接下来会按配置文件判断能不能「接管」现有进程，
	// 文件里是新配置而进程还跑着旧配置，就会被误接管。
	confirmed := false
	defer func() {
		if !confirmed {
			_ = writeFileAtomic(configPath, previous)
		}
	}()
	if err := syscall.Kill(pid, syscall.SIGHUP); err != nil {
		logf("fxp hot reload signal failed tunnel=%d pid=%d: %v", spec.TunnelID, pid, err)
		return false
	}
	deadline := time.Now().Add(fxpReloadAckTimeout)
	for {
		if ack, ok := readFXPReloadAck(configPath); ok && ack.Nonce == nonce {
			if !ack.OK {
				logf("fxp hot reload rejected tunnel=%d rule=%d: %s; falling back to restart", spec.TunnelID, spec.RuleID, ack.Error)
				return false
			}
			break
		}
		if !time.Now().Before(deadline) {
			logf("fxp hot reload not confirmed tunnel=%d rule=%d within %s; falling back to restart", spec.TunnelID, spec.RuleID, fxpReloadAckTimeout)
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	confirmed = true
	if !waitForFXPListenEndpointsReady(spec, 3*time.Second) {
		// 进程已经换成了新配置，只是监听还没起来：配置文件保持新的，交给重启流程。
		logf("fxp hot reload listeners not ready tunnel=%d rule=%d; falling back to restart", spec.TunnelID, spec.RuleID)
		return false
	}
	if persistenceEnabled {
		if err := persistFXPSpec(spec); err != nil {
			logf("fxp persistent snapshot write failed after hot reload tunnel=%d: %v", spec.TunnelID, err)
		}
	}
	fxpMu.Lock()
	if current := fxpServers[id]; current == existing {
		updated := *existing
		updated.signature = signature
		updated.spec = spec
		updated.panelCredentialDigest = credentialDigest
		fxpServers[id] = &updated
	}
	fxpMu.Unlock()
	logf("fxp %s hot reloaded tunnel=%d rule=%d listen=:%d protocol=%s (live connections kept)", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort, spec.Protocol)
	return true
}

func writeFileAtomic(path string, raw []byte) error {
	tmp := path + ".reload.tmp"
	if err := os.WriteFile(tmp, raw, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
