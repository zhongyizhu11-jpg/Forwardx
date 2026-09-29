package main

import (
	"io"
	"net"
	"os"
	"strconv"
	"testing"
	"time"
)

/*
隧道出口的目标表变了（规则换到这条隧道、加一条规则、删一条规则），Agent 收到的是同一条隧道、
同一个端口上的出口 apply。端口上监听的正是这条隧道自己的 FXP 出口，只是配置旧了 —— 应当原地
热更新：进程不换，这条隧道上别的规则正在跑的连接一条不断，新规则的目标马上能拨。

以前动作执行前的清理把它当成「来历不明的监听」先杀掉再重启：规则换隧道时，出口机上新旧两条
隧道的出口进程都被重启，两条隧道上所有用户的连接全断，重启期间入口上的新规则也连不通。
*/
func TestTunnelExitApplyHotReloadsOwnFXPRuntimeWhenTargetsChange(t *testing.T) {
	buildFXPRuntimeForTest(t)
	previousPersistDir := persistentFXPDir
	persistentFXPDir = t.TempDir()
	t.Cleanup(func() { persistentFXPDir = previousPersistDir })

	key := "exit-hot-reload-key"
	tunnelID := 7402
	existingTarget := startAgentTaggedTarget(t, "T1")
	switchedTarget := startAgentTaggedTarget(t, "T2")
	exitPort := freeAgentTestPort(t)
	existingEntryPort := freeAgentTestPort(t)
	switchedEntryPort := freeAgentTestPort(t)
	t.Cleanup(func() {
		portText := strconv.Itoa(exitPort)
		_ = os.Remove("/var/lib/forwardx-agent/tunnel_" + portText + ".id")
		_ = os.Remove("/var/lib/forwardx-agent/tunnel_" + portText + ".fwtype")
	})

	exitSpec := func(targets ...fxpUDPTarget) *fxpSpec {
		return &fxpSpec{Role: "exit", TransportVersion: "v1", TunnelID: tunnelID, ListenPort: exitPort, Protocol: "both", Key: key, StreamTargets: targets}
	}
	exitAction := func(issuedAt int64, spec *fxpSpec) action {
		return action{
			TunnelID: tunnelID, StatusType: "tunnel", IssuedAt: issuedAt, Op: "apply", ForwardType: "forwardx-tunnel",
			SourcePort: exitPort, TargetIP: "127.0.0.1", TargetPort: exitPort, Protocol: "tcp", Fxp: spec,
		}
	}
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
	t.Cleanup(func() {
		fxpControlMu.Lock()
		stopFXPRuntime(group())
		stopFXPRuntime(*exitSpec())
		fxpControlMu.Unlock()
	})

	cfg := Config{}
	existingRuleTarget := fxpUDPTarget{RuleID: 11, TargetIP: "127.0.0.1", TargetPort: existingTarget}
	if !handleAction(cfg, exitAction(1000, exitSpec(existingRuleTarget))) {
		t.Fatal("initial tunnel exit apply failed")
	}
	waitAgentTestPort(t, exitPort)
	startGroup := func(spec fxpSpec) {
		t.Helper()
		message := newActionMessage()
		fxpControlMu.Lock()
		ok := startFXPProcessLockedWithPersistence(cfg, spec, message, false)
		fxpControlMu.Unlock()
		if !ok {
			t.Fatalf("start entry group: %s", message.get())
		}
	}
	startGroup(group(entry(11, existingEntryPort, existingTarget)))
	waitAgentTestPort(t, existingEntryPort)

	live, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(existingEntryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	_ = live.SetDeadline(time.Now().Add(15 * time.Second))
	tag := make([]byte, 2)
	if _, err := io.ReadFull(live, tag); err != nil || string(tag) != "T1" {
		t.Fatalf("existing rule before the switch: tag=%q err=%v", tag, err)
	}

	id := fxpServerID(normalizeFXPSpec(*exitSpec()))
	fxpMu.Lock()
	before := fxpServers[id]
	fxpMu.Unlock()
	if before == nil || before.cmd == nil || before.cmd.Process == nil {
		t.Fatal("tunnel exit runtime was not tracked")
	}

	// 规则 12 换到这条隧道：出口的目标表多了它的目标。
	switched := exitSpec(existingRuleTarget, fxpUDPTarget{RuleID: 12, TargetIP: "127.0.0.1", TargetPort: switchedTarget})
	if !handleAction(cfg, exitAction(2000, switched)) {
		t.Fatal("tunnel exit apply with the switched rule failed")
	}
	fxpMu.Lock()
	after := fxpServers[id]
	fxpMu.Unlock()
	if after == nil || after.cmd != before.cmd {
		t.Fatal("出口的目标表变了，Agent 把本隧道自己的出口进程当成未知监听杀掉重启了，而不是原地热更新")
	}
	if after.signature != fxpServerSignature(normalizeFXPSpec(*switched)) {
		t.Fatal("热更新后记录的出口签名没有更新")
	}
	if _, err := live.Write([]byte("ping")); err != nil {
		t.Fatalf("出口更新目标表时断开了这条隧道上别的规则正在跑的连接：%v", err)
	}
	reply := make([]byte, 4)
	if _, err := io.ReadFull(live, reply); err != nil || string(reply) != "ping" {
		t.Fatalf("出口更新目标表后已有连接不通：reply=%q err=%v", reply, err)
	}

	startGroup(group(entry(11, existingEntryPort, existingTarget), entry(12, switchedEntryPort, switchedTarget)))
	waitAgentTestPort(t, switchedEntryPort)
	switchedConn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(switchedEntryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer switchedConn.Close()
	_ = switchedConn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.ReadFull(switchedConn, tag); err != nil || string(tag) != "T2" {
		t.Fatalf("换过来的规则拨不到它的目标：tag=%q err=%v", tag, err)
	}
}
