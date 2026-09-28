package main

import (
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
		fxpLocalRestart.attempts[id] = 0
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
			if err := syscall.Kill(pid, 0); err != syscall.ESRCH {
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
