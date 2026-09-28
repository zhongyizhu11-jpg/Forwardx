package main

import (
	"net"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestFXPLocalRestartBacksOffAndCaps(t *testing.T) {
	if got := fxpLocalRestartDelay(0); got != fxpLocalRestartMin {
		t.Fatalf("first restart should wait %s, got %s", fxpLocalRestartMin, got)
	}
	if fxpLocalRestartDelay(3) <= fxpLocalRestartDelay(2) {
		t.Fatal("repeated crashes should back off further")
	}
	if got := fxpLocalRestartDelay(50); got != fxpLocalRestartMax {
		t.Fatalf("backoff should cap at %s, got %s", fxpLocalRestartMax, got)
	}
}

// 真的把 FXP 进程杀掉：Agent 应当不等面板，自己在本地把它拉起来。
func TestAgentRestartsCrashedFXPLocally(t *testing.T) {
	buildFXPRuntimeForTest(t)
	usePersistentRuntimeTestDirs(t)
	port := freeAgentTestPort(t)
	spec := fxpSpec{Role: "exit", TransportVersion: "v1", TunnelID: 7302, ListenPort: port, Protocol: "tcp", Key: "agent-local-restart-key"}
	id := fxpServerID(normalizeFXPSpec(spec))
	t.Cleanup(func() {
		fxpControlMu.Lock()
		stopFXPRuntime(spec)
		removePersistedFXPSpec(spec)
		fxpControlMu.Unlock()
	})

	fxpControlMu.Lock()
	started := startFXPProcessLockedWithPersistence(Config{}, spec, newActionMessage(), true)
	fxpControlMu.Unlock()
	if !started {
		t.Fatal("start exit")
	}
	waitAgentTestPort(t, port)
	fxpMu.Lock()
	first := fxpServers[id]
	fxpMu.Unlock()
	if first == nil || first.cmd == nil || first.cmd.Process == nil {
		t.Fatal("process was not tracked")
	}
	if err := first.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for {
		fxpMu.Lock()
		current := fxpServers[id]
		fxpMu.Unlock()
		if current != nil && current.cmd != nil && current.cmd != first.cmd {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("crashed FXP was not restarted locally")
		}
		time.Sleep(50 * time.Millisecond)
	}
	waitAgentTestPort(t, port)
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second)
	if err != nil {
		t.Fatalf("restarted exit is not listening: %v", err)
	}
	_ = c.Close()
}

// 主动停掉的进程不能被「看护」拉回来。
func TestAgentDoesNotRestartDeliberatelyStoppedFXP(t *testing.T) {
	buildFXPRuntimeForTest(t)
	usePersistentRuntimeTestDirs(t)
	port := freeAgentTestPort(t)
	spec := fxpSpec{Role: "exit", TransportVersion: "v1", TunnelID: 7303, ListenPort: port, Protocol: "tcp", Key: "agent-deliberate-stop-key"}
	restarts := make(chan string, 4)
	previous := fxpLocalRestartHook
	fxpLocalRestartHook = func(id string) { restarts <- id }
	t.Cleanup(func() { fxpLocalRestartHook = previous })

	fxpControlMu.Lock()
	started := startFXPProcessLockedWithPersistence(Config{}, spec, newActionMessage(), true)
	fxpControlMu.Unlock()
	if !started {
		t.Fatal("start exit")
	}
	waitAgentTestPort(t, port)
	fxpControlMu.Lock()
	stopFXPLocked(spec, nil, newActionMessage())
	fxpControlMu.Unlock()
	select {
	case id := <-restarts:
		t.Fatalf("deliberately stopped runtime %s was scheduled for restart", id)
	case <-time.After(fxpLocalRestartMin + 500*time.Millisecond):
	}
	_ = os.Remove(fxpConfigPath(spec))
}
