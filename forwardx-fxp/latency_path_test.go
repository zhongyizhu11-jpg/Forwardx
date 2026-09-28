package main

import (
	"errors"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

func startLatencyEchoTarget(t *testing.T) int {
	t.Helper()
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = target.Close() })
	go func() {
		for {
			c, e := target.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	return target.Addr().(*net.TCPAddr).Port
}

func startTestExit(t *testing.T, tunnelID int, key string) int {
	t.Helper()
	port := freeTCPUDPPort(t)
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	go func() {
		_ = runExit(done, config{Role: "exit", TunnelID: tunnelID, ListenPort: port, Protocol: "tcp", Key: key})
	}()
	waitForTCP(t, port)
	return port
}

// 服务端先说话的协议（SSH、SMTP、MySQL）：客户端连上什么都不发，等服务端的
// 欢迎语。以前入口先等客户端首包最多 150ms 才去拨出口，这类协议每条连接都
// 白白多等 150ms。
func TestEntryDoesNotWaitForClientFirstBytes(t *testing.T) {
	resetFXPEndpointRegistry()
	banner, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer banner.Close()
	go func() {
		for {
			c, e := banner.Accept()
			if e != nil {
				return
			}
			_, _ = c.Write([]byte("220 ready\r\n"))
			go func() { defer c.Close(); _, _ = io.Copy(io.Discard, c) }()
		}
	}()
	key := "server-first-key"
	exitPort := startTestExit(t, 91, key)
	entryPort := freeTCPUDPPort(t)
	entryDone := make(chan struct{})
	defer close(entryDone)
	go func() {
		_ = runEntry(entryDone, config{
			Role: "entry", TunnelID: 91, RuleID: 92, ListenPort: entryPort, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: exitPort, Key: key,
			TargetIP: "127.0.0.1", TargetPort: banner.Addr().(*net.TCPAddr).Port,
		})
	}()
	waitForTCP(t, entryPort)

	var slowest time.Duration
	for i := 0; i < 5; i++ {
		start := time.Now()
		c, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)))
		if err != nil {
			t.Fatal(err)
		}
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		line := make([]byte, len("220 ready\r\n"))
		if _, err := io.ReadFull(c, line); err != nil {
			t.Fatal(err)
		}
		_ = c.Close()
		if elapsed := time.Since(start); elapsed > slowest {
			slowest = elapsed
		}
	}
	t.Logf("服务端先说话：最慢一条拿到欢迎语用了 %v", slowest.Round(time.Microsecond))
	if slowest >= 100*time.Millisecond {
		t.Fatalf("拿到欢迎语用了 %v，入口还在等客户端首包", slowest)
	}
}

func TestPooledConnectionsAreHandshakedAndReused(t *testing.T) {
	resetFXPEndpointRegistry()
	key := "pool-key"
	targetPort := startLatencyEchoTarget(t)
	exitPort := startTestExit(t, 93, key)
	cfg := config{TunnelID: 93, Key: key}
	state := fxpEndpointStateFor(exitEndpoint{Host: "127.0.0.1", Port: exitPort, Key: key})
	state.prewarm(cfg)

	deadline := time.Now().Add(5 * time.Second)
	for {
		state.mu.Lock()
		idle := len(state.idle)
		state.mu.Unlock()
		if idle >= fxpPoolMinSize {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("连接池没有预热起来：idle=%d", idle)
		}
		time.Sleep(10 * time.Millisecond)
	}

	conn, sec, ok := state.take(cfg)
	if !ok {
		t.Fatal("池里有预热连接，却没取到")
	}
	defer conn.Close()
	if sec.ackPending || len(sec.pendingPrefix) != 0 {
		t.Fatal("池里的连接应该已经确认过握手")
	}
	hello := []byte(`{"network":"tcp","targetIp":"127.0.0.1","targetPort":` + strconv.Itoa(targetPort) + `,"tunnelId":93}`)
	if err := writeSecureFramesWithDeadline(sec, hello, []byte("ping")); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	reply, err := sec.readFrame()
	if err != nil || string(reply) != "ping" {
		t.Fatalf("预热连接走不通：reply=%q err=%v", reply, err)
	}
}

// 首选出口收下连接就立刻重置（端口被别的程序占了、进程在重启）：握手确认
// 读到的是错误而不是超时，应该马上换备用并重放，不用等任何超时。
func TestEntryFailsOverImmediatelyWhenThePrimaryResets(t *testing.T) {
	resetFXPEndpointRegistry()
	reset, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer reset.Close()
	go func() {
		for {
			c, e := reset.Accept()
			if e != nil {
				return
			}
			if tcp, ok := c.(*net.TCPConn); ok {
				_ = tcp.SetLinger(0)
			}
			_ = c.Close()
		}
	}()
	key := "reset-key"
	targetPort := startLatencyEchoTarget(t)
	backupPort := startTestExit(t, 95, key)
	entryPort := freeTCPUDPPort(t)
	entryDone := make(chan struct{})
	defer close(entryDone)
	go func() {
		_ = runEntry(entryDone, config{
			Role: "entry", TunnelID: 95, RuleID: 96, ListenPort: entryPort, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: reset.Addr().(*net.TCPAddr).Port, ExitStrategy: "fallback",
			Exits:    []exitEndpoint{{Host: "127.0.0.1", Port: backupPort, Key: key}},
			TargetIP: "127.0.0.1", TargetPort: targetPort, Key: key,
		})
	}()
	waitForTCP(t, entryPort)

	start := time.Now()
	c, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := c.Write([]byte("hello-over-failover")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, len("hello-over-failover"))
	if _, err := io.ReadFull(c, reply); err != nil {
		t.Fatal(err)
	}
	if string(reply) != "hello-over-failover" {
		t.Fatalf("重放后的内容不对：%q", reply)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("首选直接重置，切换却用了 %v", elapsed)
	}
}

func TestRecoveredEndpointNeedsSeveralProbesBeforeTakingTrafficBack(t *testing.T) {
	resetFXPEndpointRegistry()
	state := fxpEndpointStateFor(exitEndpoint{Host: "127.0.0.1", Port: 1, Key: "k"})
	state.markFailure(errTestEndpointDown)
	for i := 1; i < fxpRecoverProbes; i++ {
		state.probeSucceeded()
		if state.isHealthy() {
			t.Fatalf("第 %d 次探测成功就回切了，抖动的节点会反复卡住新连接", i)
		}
	}
	state.probeSucceeded()
	if !state.isHealthy() {
		t.Fatalf("连续 %d 次探测成功还没恢复", fxpRecoverProbes)
	}
}

func TestHealthyEndpointToleratesOneFailedProbe(t *testing.T) {
	resetFXPEndpointRegistry()
	state := fxpEndpointStateFor(exitEndpoint{Host: "127.0.0.1", Port: 2, Key: "k"})
	state.probeFailed(errTestEndpointDown)
	if !state.isHealthy() {
		t.Fatal("一次探测失败就判死了，一次丢包就会切线路")
	}
	state.probeFailed(errTestEndpointDown)
	if state.isHealthy() {
		t.Fatalf("连续 %d 次探测失败还算健康", fxpSuspectProbes)
	}
}

func TestHopResolverCachesHostnames(t *testing.T) {
	address, err := resolveHopAddress("localhost", 80)
	if err != nil {
		t.Skipf("localhost 解析不了：%v", err)
	}
	host, _, _ := net.SplitHostPort(address)
	if net.ParseIP(host) == nil {
		t.Fatalf("解析结果不是 IP：%s", address)
	}
	fxpHopResolver.mu.Lock()
	_, cached := fxpHopResolver.entries["localhost"]
	fxpHopResolver.mu.Unlock()
	if !cached {
		t.Fatal("域名解析结果没有缓存")
	}
	if got, _ := resolveHopAddress("10.0.0.1", 443); got != "10.0.0.1:443" {
		t.Fatalf("IP 不该经过解析：%s", got)
	}
}

func TestProbeHelloIsAnsweredQuietly(t *testing.T) {
	resetFXPEndpointRegistry()
	key := "probe-key"
	exitPort := startTestExit(t, 97, key)
	state := fxpEndpointStateFor(exitEndpoint{Host: "127.0.0.1", Port: exitPort, Key: key})
	state.markFailure(errors.New("pretend down"))
	for i := 0; i < fxpRecoverProbes; i++ {
		state.mu.Lock()
		state.probing = true
		state.mu.Unlock()
		state.runProbe(config{TunnelID: 97, Key: key})
	}
	if !state.isHealthy() {
		t.Fatal("对活着的出口探测没有成功")
	}
}
