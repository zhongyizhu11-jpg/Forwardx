package main

import (
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// buildFXPRuntimeForTest 编译仓库里的 forwardx-fxp，让 Agent 真的去起进程、发信号。
func buildFXPRuntimeForTest(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not available")
	}
	if os.Geteuid() != 0 {
		t.Skip("FXP runtime configs live under /run/forwardx-agent and need root")
	}
	out := filepath.Join(t.TempDir(), "forwardx-fxp")
	build := exec.Command("go", "build", "-o", out, ".")
	build.Dir = filepath.Join("..", "forwardx-fxp")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build forwardx-fxp: %v\n%s", err, output)
	}
	previous := resolveFXPRuntimeExecutable
	resolveFXPRuntimeExecutable = func() (string, error) { return out, nil }
	t.Cleanup(func() { resolveFXPRuntimeExecutable = previous })
	return out
}

func freeAgentTestPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

func startAgentTaggedTarget(t *testing.T, tag string) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, e := ln.Accept()
			if e != nil {
				return
			}
			go func() {
				defer c.Close()
				_, _ = c.Write([]byte(tag))
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func waitAgentTestPort(t *testing.T, port int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 200*time.Millisecond)
		if err == nil {
			_ = c.Close()
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("port %d did not open", port)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestAgentHotReloadsFXPEntryGroupWithoutDroppingConnections(t *testing.T) {
	buildFXPRuntimeForTest(t)
	key := "agent-hot-reload-key"
	tunnelID := 7301
	targetOne := startAgentTaggedTarget(t, "T1")
	targetTwo := startAgentTaggedTarget(t, "T2")
	exitPort := freeAgentTestPort(t)
	portA := freeAgentTestPort(t)
	portB := freeAgentTestPort(t)

	exitSpec := fxpSpec{Role: "exit", TransportVersion: "v1", TunnelID: tunnelID, ListenPort: exitPort, Protocol: "tcp", Key: key}
	entry := func(ruleID, port, target int) fxpSpec {
		return fxpSpec{
			Role: "entry", TransportVersion: "v1", TunnelID: tunnelID, RuleID: ruleID,
			ListenHost: "127.0.0.1", ListenPort: port, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: exitPort, TargetIP: "127.0.0.1", TargetPort: target, Key: key,
		}
	}
	group := func(entries ...fxpSpec) fxpSpec {
		return fxpSpec{Role: fxpEntryGroupRole, TransportVersion: "v1", TunnelID: tunnelID, Entries: entries}
	}
	cfg := Config{}

	fxpControlMu.Lock()
	defer fxpControlMu.Unlock()
	t.Cleanup(func() {
		stopFXPRuntime(group())
		stopFXPRuntime(exitSpec)
	})
	if msg := newActionMessage(); !startFXPProcessLockedWithPersistence(cfg, exitSpec, msg, false) {
		t.Fatalf("start exit: %s", msg.get())
	}
	waitAgentTestPort(t, exitPort)
	first := group(entry(1, portA, targetOne), entry(2, portB, targetOne))
	if msg := newActionMessage(); !startFXPProcessLockedWithPersistence(cfg, first, msg, false) {
		t.Fatalf("start entry group: %s", msg.get())
	}
	waitAgentTestPort(t, portA)
	id := fxpServerID(normalizeFXPSpec(first))
	fxpMu.Lock()
	before := fxpServers[id]
	fxpMu.Unlock()
	if before == nil || before.cmd == nil {
		t.Fatal("entry group process was not tracked")
	}

	live, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(portA)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	_ = live.SetDeadline(time.Now().Add(10 * time.Second))
	tag := make([]byte, 2)
	if _, err := io.ReadFull(live, tag); err != nil || string(tag) != "T1" {
		t.Fatalf("rule A before reload: tag=%q err=%v", tag, err)
	}

	// 改规则 B 的目标：签名变了。应当热更新，进程不换，A 上的连接不断。
	second := group(entry(1, portA, targetOne), entry(2, portB, targetTwo))
	if msg := newActionMessage(); !startFXPProcessLockedWithPersistence(cfg, second, msg, false) {
		t.Fatalf("apply changed entry group: %s", msg.get())
	}
	fxpMu.Lock()
	after := fxpServers[id]
	fxpMu.Unlock()
	if after == nil || after.cmd != before.cmd {
		t.Fatal("配置变化后进程被重启了，而不是热更新")
	}
	if after.signature != fxpServerSignature(normalizeFXPSpec(second)) {
		t.Fatal("热更新后记录的签名没有更新")
	}
	if _, err := live.Write([]byte("ping")); err != nil {
		t.Fatalf("热更新断开了没改的规则上的连接：%v", err)
	}
	reply := make([]byte, 4)
	if _, err := io.ReadFull(live, reply); err != nil || string(reply) != "ping" {
		t.Fatalf("热更新后规则 A 的连接不通：reply=%q err=%v", reply, err)
	}
	newB, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(portB)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer newB.Close()
	_ = newB.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.ReadFull(newB, tag); err != nil || string(tag) != "T2" {
		t.Fatalf("热更新后规则 B 的新连接没有去新目标：tag=%q err=%v", tag, err)
	}
}
