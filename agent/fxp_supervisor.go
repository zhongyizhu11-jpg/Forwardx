package main

import (
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

/*
FXP 进程的本地看护。

以前 FXP 意外退出（panic、被 OOM 杀掉、任何 log.Fatal），Agent 只记一行日志：
进程要等下一次全量同步（最长约 5 分钟）才会被重建，面板连不上时就一直不恢复。
这段时间里这台机器上走这条隧道的连接全部不通。

现在意外退出的进程由 Agent 在本地按退避重启（1s、2s、4s……最长 30s），用的是
持久化快照里的期望配置 —— 和 Agent 重启后恢复运行时是同一份，不需要面板。
稳定跑满一分钟后退避清零。被 Agent 主动停掉、或者已经不再期望的进程不会被拉起。

Agent 重启后「接管」的进程不是它的子进程，收不到退出通知，就单独起一个协程
每两秒看一眼它的 PID 还在不在。
*/

const (
	fxpLocalRestartMin    = time.Second
	fxpLocalRestartMax    = 30 * time.Second
	fxpLocalRestartStable = time.Minute
	fxpAdoptedPollEvery   = 2 * time.Second
)

var fxpLocalRestart = struct {
	mu        sync.Mutex
	attempts  map[string]int
	scheduled map[string]bool
	watched   map[string]bool
}{attempts: map[string]int{}, scheduled: map[string]bool{}, watched: map[string]bool{}}

// fxpLocalRestartHook 让测试接住「要重启了」而不真的去起进程；nil 时走真正的重启。
var fxpLocalRestartHook func(id string)

func fxpLocalRestartDelay(attempt int) time.Duration {
	delay := fxpLocalRestartMin
	for i := 0; i < attempt && delay < fxpLocalRestartMax; i++ {
		delay *= 2
	}
	if delay > fxpLocalRestartMax {
		delay = fxpLocalRestartMax
	}
	return delay
}

// noteFXPUnexpectedExit 在一个仍被期望运行的 FXP 进程意外退出后调用。
func noteFXPUnexpectedExit(id string, ranFor time.Duration) {
	fxpLocalRestart.mu.Lock()
	if ranFor >= fxpLocalRestartStable {
		delete(fxpLocalRestart.attempts, id)
	}
	if fxpLocalRestart.scheduled[id] {
		fxpLocalRestart.mu.Unlock()
		return
	}
	fxpLocalRestart.scheduled[id] = true
	attempt := fxpLocalRestart.attempts[id]
	fxpLocalRestart.attempts[id] = attempt + 1
	fxpLocalRestart.mu.Unlock()
	delay := fxpLocalRestartDelay(attempt)
	logf("fxp runtime exited unexpectedly id=%s ranFor=%s; local restart in %s", id, ranFor.Round(time.Millisecond), delay)
	time.AfterFunc(delay, func() {
		fxpLocalRestart.mu.Lock()
		delete(fxpLocalRestart.scheduled, id)
		fxpLocalRestart.mu.Unlock()
		if hook := fxpLocalRestartHook; hook != nil {
			hook(id)
			return
		}
		restartFXPLocally(id)
	})
}

func restartFXPLocally(id string) {
	fxpControlMu.Lock()
	defer fxpControlMu.Unlock()
	fxpMu.Lock()
	_, running := fxpServers[id]
	fxpMu.Unlock()
	if running {
		// 面板同步或别的路径已经把它重建了。
		return
	}
	var desired *fxpSpec
	for _, spec := range planPersistedFXPRestoreSpecs(loadPersistedFXPSpecs()) {
		spec = normalizeFXPSpec(spec)
		if fxpServerID(spec) == id {
			candidate := spec
			desired = &candidate
			break
		}
	}
	if desired == nil {
		// 不再期望的进程不会再重启，退避计数随之清掉，免得 attempts 随规则增删无限增长。
		forgetFXPLocalRestartAttempts(id)
		logf("fxp local restart skipped id=%s: no longer desired", id)
		return
	}
	cfg, _ := loadConfig(activeConfigPath)
	message := newActionMessage()
	if startFXPProcessLockedWithPersistence(cfg, *desired, message, true) {
		logf("fxp runtime restarted locally id=%s tunnel=%d", id, desired.TunnelID)
		return
	}
	logf("fxp local restart failed id=%s tunnel=%d: %s", id, desired.TunnelID, message.get())
	go noteFXPUnexpectedExit(id, 0)
}

// watchAdoptedFXPProcess 看护一个接管来的（不是本 Agent 启动的）FXP 进程。
func watchAdoptedFXPProcess(id, configPath string) {
	pids := fxpRuntimePIDs(configPath)
	if len(pids) != 1 {
		return
	}
	pid := pids[0]
	fxpLocalRestart.mu.Lock()
	if fxpLocalRestart.watched[configPath] {
		fxpLocalRestart.mu.Unlock()
		return
	}
	fxpLocalRestart.watched[configPath] = true
	fxpLocalRestart.mu.Unlock()
	adoptedAt := time.Now()
	// 接管来的进程的输出还写在它自己的日志文件里（见 fxp_log_file.go），继续跟读，
	// 端点健康事件在 Agent 重启后不会断。只看接管之后新写的内容。
	logPath := fxpRuntimeLogPath(configPath)
	logOffset := int64(0)
	if info, err := os.Stat(logPath); err == nil {
		logOffset = info.Size()
	}
	logTail := newFXPLogTail(logPath, logOffset, func() io.Writer {
		fxpMu.Lock()
		defer fxpMu.Unlock()
		if current := fxpServers[id]; current != nil && current.cmd == nil && current.configPath == configPath {
			return fxpLogWriter{spec: current.spec}
		}
		return nil
	})
	go func() {
		defer func() {
			fxpLocalRestart.mu.Lock()
			delete(fxpLocalRestart.watched, configPath)
			fxpLocalRestart.mu.Unlock()
		}()
		ticker := time.NewTicker(fxpAdoptedPollEvery)
		defer ticker.Stop()
		for range ticker.C {
			stillAdopted := func() bool {
				current := fxpServers[id]
				return current != nil && current.cmd == nil && current.configPath == configPath
			}
			fxpMu.Lock()
			adopted := stillAdopted()
			fxpMu.Unlock()
			if !adopted {
				// 被主动停掉，或者已经换成了本 Agent 启动的进程。
				return
			}
			logTail.poll()
			if fxpAdoptedPIDAlive(pid, configPath) {
				continue
			}
			fxpMu.Lock()
			adopted = stillAdopted()
			if adopted {
				delete(fxpServers, id)
			}
			fxpMu.Unlock()
			if adopted {
				noteFXPUnexpectedExit(id, time.Since(adoptedAt))
			}
			return
		}
	}()
}

func forgetFXPLocalRestartAttempts(id string) {
	fxpLocalRestart.mu.Lock()
	delete(fxpLocalRestart.attempts, id)
	fxpLocalRestart.mu.Unlock()
}

// fxpProcCmdlineReader 读取 /proc/<pid>/cmdline；测试里替换。
var fxpProcCmdlineReader = func(pid int) ([]byte, error) {
	return os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
}

// fxpAdoptedPIDAlive 判断接管来的 FXP 进程是否还活着。
//
// 只看 kill(pid, 0) 不够：进程退出后 PID 可能被别的进程复用，看护协程就会一直以为它还在，
// 这条隧道再也不会被本地重启。所以在有 /proc 的系统上还要核对命令行确实是 forwardx-fxp
// 且带着这份配置（与 fxpRuntimePIDs 用 pgrep 找进程时的条件一致）。
func fxpAdoptedPIDAlive(pid int, configPath string) bool {
	if pid <= 0 {
		return false
	}
	if err := syscall.Kill(pid, 0); err == syscall.ESRCH {
		return false
	}
	raw, err := fxpProcCmdlineReader(pid)
	if err != nil {
		if os.IsNotExist(err) {
			if _, procErr := os.Stat("/proc/self/cmdline"); procErr == nil {
				return false
			}
		}
		// 没有 /proc（非 Linux）或读不了：退回只看 kill 的结果。
		return true
	}
	cmdline := strings.ReplaceAll(string(raw), "\x00", " ")
	if !strings.Contains(cmdline, "forwardx-fxp") {
		return false
	}
	configPath = strings.TrimSpace(configPath)
	return configPath == "" || strings.Contains(cmdline, configPath) || strings.Contains(cmdline, filepath.Base(configPath))
}
