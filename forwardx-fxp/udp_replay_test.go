package main

import (
	"net"
	"sync/atomic"
	"testing"
	"time"
)

// udpEchoRecorder 是一个 UDP 目标：收到什么记下来，再原样回给发来的地址。
func udpEchoRecorder(t *testing.T) (int, <-chan string) {
	t.Helper()
	target, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = target.Close() })
	got := make(chan string, 64)
	go func() {
		buf := make([]byte, 65535)
		for {
			n, addr, err := target.ReadFromUDP(buf)
			if err != nil {
				return
			}
			got <- string(buf[:n])
			_, _ = target.WriteToUDP(buf[:n], addr)
		}
	}()
	return target.LocalAddr().(*net.UDPAddr).Port, got
}

func expectUDPPayload(t *testing.T, got <-chan string, want string) {
	t.Helper()
	select {
	case payload := <-got:
		if payload != want {
			t.Fatalf("target got %q, want %q", payload, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("target never got %q", want)
	}
}

func expectNoUDPPayload(t *testing.T, got <-chan string, within time.Duration) {
	t.Helper()
	select {
	case payload := <-got:
		t.Fatalf("重放的包不该转给目标，目标却收到了 %q", payload)
	case <-time.After(within):
	}
}

// startUDPExitOn 在指定端口（0 = 随便挑）跑一个 UDP 直连出口，返回它的地址和关停函数。
func startUDPExitOn(t *testing.T, port int, cfg config) (*net.UDPAddr, func()) {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: port})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- serveExitUDPDirect(conn, cfg) }()
	stopped := false
	stop := func() {
		if stopped {
			return
		}
		stopped = true
		_ = conn.Close()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("exit UDP server did not stop")
		}
	}
	t.Cleanup(stop)
	return conn.LocalAddr().(*net.UDPAddr), stop
}

func sealTestUDPData(t *testing.T, tunnelID, ruleID int, sessionID uint64, key string, sequence *atomic.Uint64, payload string) []byte {
	t.Helper()
	frames, err := sealFXPUDPDatagrams(fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   tunnelID,
		ruleID:     ruleID,
		sessionID:  sessionID,
		payload:    []byte(payload),
	}, key, sequence)
	if err != nil || len(frames) != 1 {
		t.Fatalf("seal: %v frames=%d", err, len(frames))
	}
	return frames[0]
}

func readUDPReturn(t *testing.T, conn *net.UDPConn, tunnelID int, key string, within time.Duration) (fxpUDPPacket, bool) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(within))
	buf := make([]byte, 65535)
	n, err := conn.Read(buf)
	if err != nil {
		return fxpUDPPacket{}, false
	}
	packet, err := openFXPUDPPacket(buf[:n], tunnelID, key)
	if err != nil {
		t.Fatalf("return packet: %v", err)
	}
	return packet, true
}

// 抓到的包换个来源地址重放：以前出口把它当新会话（窗口是空的），包又转给目标
// 一遍，目标的回包发到伪造的地址上。现在会话只按（规则, 会话号）找，重放的包
// 过不了原会话的窗口；出口重启监听（会话全关）之后也一样。
func TestUDPDirectReplayFromAnotherSourceIsDropped(t *testing.T) {
	targetPort, got := udpEchoRecorder(t)
	const (
		tunnelID  = 520
		ruleID    = 521
		sessionID = uint64(0x5205210001)
		key       = "udp-replay-source-key"
	)
	cfg := config{Role: "exit", TunnelID: tunnelID, Protocol: "udp", Key: key,
		UDPTargets: []udpTarget{{RuleID: ruleID, TargetIP: "127.0.0.1", TargetPort: targetPort}}}
	exitAddr, stop := startUDPExitOn(t, 0, cfg)

	client, err := net.DialUDP("udp", nil, exitAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var sequence atomic.Uint64
	sequence.Store(1000)
	captured := sealTestUDPData(t, tunnelID, ruleID, sessionID, key, &sequence, "original")
	if _, err := client.Write(captured); err != nil {
		t.Fatal(err)
	}
	expectUDPPayload(t, got, "original")
	if packet, ok := readUDPReturn(t, client, tunnelID, key, 2*time.Second); !ok || string(packet.payload) != "original" {
		t.Fatalf("original reply: %q %v", packet.payload, ok)
	}

	attacker, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer attacker.Close()
	if _, err := attacker.WriteToUDP(captured, exitAddr); err != nil {
		t.Fatal(err)
	}
	expectNoUDPPayload(t, got, 200*time.Millisecond)
	if _, ok := readUDPReturn(t, attacker, tunnelID, key, 100*time.Millisecond); ok {
		t.Fatal("重放者不该收到任何回包")
	}

	// 出口监听重启：会话全关了，防重放状态还在。
	stop()
	exitAddr, _ = startUDPExitOn(t, exitAddr.Port, cfg)
	if _, err := attacker.WriteToUDP(captured, exitAddr); err != nil {
		t.Fatal(err)
	}
	expectNoUDPPayload(t, got, 200*time.Millisecond)

	// 真正的入口接着发新包，会话照常恢复。
	if _, err := client.Write(sealTestUDPData(t, tunnelID, ruleID, sessionID, key, &sequence, "again")); err != nil {
		t.Fatal(err)
	}
	expectUDPPayload(t, got, "again")
	if packet, ok := readUDPReturn(t, client, tunnelID, key, 2*time.Second); !ok || string(packet.payload) != "again" {
		t.Fatalf("reply after restart: %q %v", packet.payload, ok)
	}
}

// 入口的来源地址变了（NAT 重新映射）：新地址来的新包照收，回程跟着挪过去。
func TestUDPDirectSessionFollowsNewSourceAddress(t *testing.T) {
	targetPort, got := udpEchoRecorder(t)
	const (
		tunnelID  = 530
		ruleID    = 531
		sessionID = uint64(0x5305310001)
		key       = "udp-rebind-key"
	)
	cfg := config{Role: "exit", TunnelID: tunnelID, Protocol: "udp", Key: key,
		UDPTargets: []udpTarget{{RuleID: ruleID, TargetIP: "127.0.0.1", TargetPort: targetPort}}}
	exitAddr, _ := startUDPExitOn(t, 0, cfg)
	var sequence atomic.Uint64
	sequence.Store(1)

	before, err := net.DialUDP("udp", nil, exitAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer before.Close()
	if _, err := before.Write(sealTestUDPData(t, tunnelID, ruleID, sessionID, key, &sequence, "one")); err != nil {
		t.Fatal(err)
	}
	expectUDPPayload(t, got, "one")
	if _, ok := readUDPReturn(t, before, tunnelID, key, 2*time.Second); !ok {
		t.Fatal("no reply before rebinding")
	}

	after, err := net.DialUDP("udp", nil, exitAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer after.Close()
	if _, err := after.Write(sealTestUDPData(t, tunnelID, ruleID, sessionID, key, &sequence, "two")); err != nil {
		t.Fatal(err)
	}
	expectUDPPayload(t, got, "two")
	if packet, ok := readUDPReturn(t, after, tunnelID, key, 2*time.Second); !ok || string(packet.payload) != "two" {
		t.Fatalf("回程没有跟到新地址：%q %v", packet.payload, ok)
	}
	if _, ok := readUDPReturn(t, before, tunnelID, key, 100*time.Millisecond); ok {
		t.Fatal("回程还在发往旧地址")
	}
}

// 包头里的发出时间参与认证，超出时间窗的包直接丢：录下的包过了窗口，就算
// 防重放状态早已忘了这个会话，也放不进去。
func TestUDPDirectRejectsStalePackets(t *testing.T) {
	targetPort, got := udpEchoRecorder(t)
	const (
		tunnelID  = 540
		ruleID    = 541
		sessionID = uint64(0x5405410001)
		key       = "udp-stale-key"
	)
	cfg := config{Role: "exit", TunnelID: tunnelID, Protocol: "udp", Key: key,
		UDPTargets: []udpTarget{{RuleID: ruleID, TargetIP: "127.0.0.1", TargetPort: targetPort}}}
	exitAddr, _ := startUDPExitOn(t, 0, cfg)
	client, err := net.DialUDP("udp", nil, exitAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var sequence atomic.Uint64
	sequence.Store(1)
	for _, sentAt := range []time.Time{time.Now().Add(-fxpUDPReplayWindow - 30*time.Second), time.Now().Add(fxpUDPReplayWindow + 30*time.Second)} {
		frames, err := sealFXPUDPDatagrams(fxpUDPPacket{
			packetType: fxpUDPTypeData,
			tunnelID:   tunnelID,
			ruleID:     ruleID,
			sessionID:  sessionID,
			sentAt:     uint32(sentAt.Unix()),
			payload:    []byte("stale"),
		}, key, &sequence)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client.Write(frames[0]); err != nil {
			t.Fatal(err)
		}
	}
	expectNoUDPPayload(t, got, 200*time.Millisecond)

	// 改包头里的时间会破坏认证。
	fresh := sealTestUDPData(t, tunnelID, ruleID, sessionID, key, &sequence, "fresh")
	tampered := append([]byte(nil), fresh...)
	tampered[11] ^= 1
	if _, err := openFXPUDPPacket(tampered, tunnelID, key); err == nil {
		t.Fatal("包头里的发出时间必须参与认证")
	}
	if _, err := client.Write(fresh); err != nil {
		t.Fatal(err)
	}
	expectUDPPayload(t, got, "fresh")
}

// 中转和出口一样：换个来源地址重放给中转，中转不会给下一跳重新封一个「新包」。
func TestRelayUDPDirectReplayFromAnotherSourceIsDropped(t *testing.T) {
	targetPort, got := udpEchoRecorder(t)
	const (
		tunnelID  = 550
		ruleID    = 551
		sessionID = uint64(0x5505510001)
	)
	upstreamKey, downstreamKey := "udp-relay-replay-up", "udp-relay-replay-down"
	exitPort := freeUDPPort(t)
	relayPort := freeUDPPort(t)
	exitDone, relayDone := make(chan struct{}), make(chan struct{})
	defer close(exitDone)
	defer close(relayDone)
	go func() {
		_ = runExit(exitDone, config{Role: "exit", TunnelID: tunnelID, ListenPort: exitPort, Protocol: "udp", Key: downstreamKey,
			UDPTargets: []udpTarget{{RuleID: ruleID, TargetIP: "127.0.0.1", TargetPort: targetPort}}})
	}()
	go func() {
		_ = runRelay(relayDone, config{Role: "relay", TunnelID: tunnelID, ListenPort: relayPort, Protocol: "udp", Key: upstreamKey,
			RelayExitHost: "127.0.0.1", RelayExitPort: exitPort, RelayKey: downstreamKey})
	}()
	relayAddr := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: relayPort}
	client, err := net.DialUDP("udp", nil, relayAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var sequence atomic.Uint64
	sequence.Store(1)
	captured := sealTestUDPData(t, tunnelID, ruleID, sessionID, upstreamKey, &sequence, "via-relay")
	// 监听起来之前的包会丢，重发到目标收到为止（每次都是新序号的新包）。
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, _ = client.Write(captured)
		select {
		case payload := <-got:
			if payload != "via-relay" {
				t.Fatalf("target got %q", payload)
			}
		case <-time.After(100 * time.Millisecond):
			if time.Now().After(deadline) {
				t.Fatal("relay path never delivered")
			}
			captured = sealTestUDPData(t, tunnelID, ruleID, sessionID, upstreamKey, &sequence, "via-relay")
			continue
		}
		break
	}
	if packet, ok := readUDPReturn(t, client, tunnelID, upstreamKey, 2*time.Second); !ok || string(packet.payload) != "via-relay" {
		t.Fatalf("relay reply: %q %v", packet.payload, ok)
	}

	attacker, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer attacker.Close()
	if _, err := attacker.WriteToUDP(captured, relayAddr); err != nil {
		t.Fatal(err)
	}
	expectNoUDPPayload(t, got, 200*time.Millisecond)
	if _, ok := readUDPReturn(t, attacker, tunnelID, upstreamKey, 100*time.Millisecond); ok {
		t.Fatal("重放者不该收到任何回包")
	}
}

func TestUDPReplayGuardMemoryAndFloor(t *testing.T) {
	start := time.Unix(1_000_000, 0)
	guard := newUDPReplayGuard(time.Minute, 1, start)
	now := start.Add(10 * time.Second)
	if guard.fresh(uint32(start.Unix()-1), now) {
		t.Fatal("进程启动前发出的包不该收")
	}
	if !guard.fresh(uint32(now.Unix()), now) || guard.fresh(uint32(now.Add(-2*time.Minute).Unix()), now) || guard.fresh(uint32(now.Add(2*time.Minute).Unix()), now) {
		t.Fatal("时间窗判断不对")
	}

	keyA := udpReplayKey{role: "exit", tunnelID: 1, ruleID: 1, sessionID: 1}
	keyB := udpReplayKey{role: "exit", tunnelID: 1, ruleID: 1, sessionID: 2}
	stateA := guard.acquire(keyA, now)
	stateA.window.accept(500)
	stateA.observe(uint32(now.Unix()))
	guard.release(keyA, stateA, now)

	// 会话结束后再来：还是原来的窗口，旧序号照样被拒。
	again := guard.acquire(keyA, now.Add(time.Second))
	if again != stateA || again.window.accept(500) {
		t.Fatal("刚结束的会话应该接着用原来的防重放窗口")
	}
	guard.release(keyA, again, now.Add(time.Second))

	// 容量 1：B 结束时把 A 挤掉，下限抬到 A 见过的最新发出时间。
	stateB := guard.acquire(keyB, now.Add(2*time.Second))
	guard.release(keyB, stateB, now.Add(2*time.Second))
	if guard.floor.Load() != uint32(now.Unix()) {
		t.Fatalf("floor=%d want %d", guard.floor.Load(), now.Unix())
	}
	if guard.fresh(uint32(now.Unix()), now.Add(3*time.Second)) {
		t.Fatal("被挤掉的会话的旧包应该被下限挡住")
	}
	if !guard.fresh(uint32(now.Add(3*time.Second).Unix()), now.Add(3*time.Second)) {
		t.Fatal("新包不该受影响")
	}

	// 过了 2 倍时间窗，记录自然过期。
	guard.acquire(keyA, now.Add(3*time.Minute))
	if len(guard.states) != 1 {
		t.Fatalf("expired entries were not swept: %d", len(guard.states))
	}
}
