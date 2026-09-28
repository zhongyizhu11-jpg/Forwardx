package main

import (
	"net"
	"strconv"
	"testing"
	"time"
)

// 热重载之后，出口不再按接受连接时的旧配置放行：目标表里去掉的 (规则, 目标)
// 上已经在跑的会话被断开，池里空等 hello 的连接按新表核对，密钥换了就全部断开。
func TestExitReloadRevokesSessionsNoLongerAuthorized(t *testing.T) {
	resetFXPEndpointRegistry()
	const tunnelID = 150
	key := "revoke-key"
	targetOne, _ := countingTCPTarget(t)
	targetTwo, _ := countingTCPTarget(t)
	targetThree, _ := countingTCPTarget(t)
	port := freeTCPPort(t)
	exitCfg := func(key string, targets ...streamTarget) config {
		return config{Role: "exit", TunnelID: tunnelID, ListenHost: "127.0.0.1", ListenPort: port, Protocol: "tcp", Key: key, StreamTargets: targets}
	}
	ruleOne := streamTarget{RuleID: 1, TargetIP: "127.0.0.1", TargetPort: targetOne}
	ruleTwo := streamTarget{RuleID: 2, TargetIP: "127.0.0.1", TargetPort: targetTwo}
	ruleThree := streamTarget{RuleID: 3, TargetIP: "127.0.0.1", TargetPort: targetThree}

	done := make(chan struct{})
	defer close(done)
	reloads := make(chan fxpReloadRequest)
	go func() { _ = runManaged(done, exitCfg(key, ruleOne, ruleTwo), reloads) }()
	waitForTCP(t, port)
	reload := func(cfg config) {
		t.Helper()
		answer := make(chan error, 1)
		reloads <- fxpReloadRequest{cfg: cfg, result: answer}
		if err := <-answer; err != nil {
			t.Fatalf("reload: %v", err)
		}
	}

	// 握完手、还没发 hello 的连接：相当于上一跳连接池里预热好的。
	pooled := func(key string) *secureConn {
		t.Helper()
		conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 3*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		sec, err := newClientSecureConnWithWire(conn, config{TunnelID: tunnelID, Key: key}, fxpWireCurrent)
		if err != nil {
			t.Fatalf("handshake: %v", err)
		}
		return sec
	}
	hello := func(sec *secureConn, ruleID, targetPort int) error {
		t.Helper()
		raw := `{"network":"tcp","targetIp":"127.0.0.1","targetPort":` + strconv.Itoa(targetPort) + `,"tunnelId":` + strconv.Itoa(tunnelID) + `,"ruleId":` + strconv.Itoa(ruleID) + `}`
		if err := writeSecureFramesWithDeadline(sec, []byte(raw), []byte("ping")); err != nil {
			return err
		}
		return expectEcho(sec, "ping")
	}

	sessionOne := pooled(key)
	if err := hello(sessionOne, 1, targetOne); err != nil {
		t.Fatalf("rule 1 session: %v", err)
	}
	sessionTwo := pooled(key)
	if err := hello(sessionTwo, 2, targetTwo); err != nil {
		t.Fatalf("rule 2 session: %v", err)
	}
	waitingForOne := pooled(key)
	waitingForThree := pooled(key)

	// 去掉规则 1、加上规则 3。
	reload(exitCfg(key, ruleTwo, ruleThree))
	if err := expectEcho(sessionOne, "after-reload"); err == nil {
		t.Fatal("目标表里已经去掉的规则 1 会话还在跑")
	}
	if err := expectEchoWrite(sessionTwo, "after-reload"); err != nil {
		t.Fatalf("没变的规则 2 会话被重载断掉了：%v", err)
	}
	// 重载之前握手、之后才发 hello 的池连接按新表核对。
	if err := hello(waitingForOne, 1, targetOne); err == nil {
		t.Fatal("池连接用旧配置放行了已经去掉的规则 1")
	}
	if err := hello(waitingForThree, 3, targetThree); err != nil {
		t.Fatalf("池连接没按新表放行规则 3：%v", err)
	}

	// 换密钥：用旧密钥握手的连接全部断开，包括在等 hello 的。
	waitingOldKey := pooled(key)
	reload(exitCfg("rotated-key", ruleTwo, ruleThree))
	if err := expectEchoWrite(sessionTwo, "after-key-change"); err == nil {
		t.Fatal("换密钥之后旧密钥的会话还在跑")
	}
	if err := hello(waitingOldKey, 2, targetTwo); err == nil {
		t.Fatal("换密钥之后旧密钥的池连接还能发 hello")
	}
	fresh := pooled("rotated-key")
	if err := hello(fresh, 2, targetTwo); err != nil {
		t.Fatalf("新密钥的连接走不通：%v", err)
	}
}

// 连接在处理器换掉之前被接受、用旧密钥握了手，重载扫登记时它可能还没登记上；
// hello 时按当前处理器核对密钥兜住这种情况。
func TestExitHelloRejectsHandshakeKeyReplacedByReload(t *testing.T) {
	slot := &tcpListenerSlot{conns: map[net.Conn]*trackedConn{}}
	slot.handler.Store(&tcpHandler{cfg: config{Key: "new-key"}})
	in := &fxpInbound{role: "exit", tracked: &trackedConn{slot: slot}}
	if _, err := in.currentConfig(config{Key: "old-key"}); err == nil {
		t.Fatal("旧密钥握手的连接在 hello 时没被拒")
	}
	cfg, err := in.currentConfig(config{Key: "new-key", StreamTargets: nil})
	if err != nil || cfg.Key != "new-key" {
		t.Fatalf("当前密钥的连接应该拿到当前配置：%+v %v", cfg, err)
	}
	slot.handler.Store(nil)
	if _, err := in.currentConfig(config{Key: "new-key"}); err == nil {
		t.Fatal("监听已经关掉，hello 还被放行")
	}
}

func expectEchoWrite(sec *secureConn, payload string) error {
	if err := sec.writeFrame([]byte(payload)); err != nil {
		return err
	}
	return expectEcho(sec, payload)
}

// expectEcho 读一帧，要求是 payload。连接被对端断开时返回错误。
func expectEcho(sec *secureConn, payload string) error {
	_ = sec.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	defer sec.conn.SetReadDeadline(time.Time{})
	reply, err := sec.readFrame()
	if err != nil {
		return err
	}
	if string(reply) != payload {
		return errEchoMismatch(string(reply))
	}
	return nil
}

type errEchoMismatch string

func (e errEchoMismatch) Error() string { return "echo mismatch: " + string(e) }
