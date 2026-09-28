package main

import (
	"errors"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

// loopbackStreamTargets 给测试出口的目标表：这条规则允许拨 127.0.0.1 上的这些端口。
func loopbackStreamTargets(ruleID int, ports ...int) []streamTarget {
	return loopbackStreamTargetMatrix([]int{ruleID}, ports...)
}

func loopbackStreamTargetMatrix(ruleIDs []int, ports ...int) []streamTarget {
	var targets []streamTarget
	for _, ruleID := range ruleIDs {
		for _, port := range ports {
			targets = append(targets, streamTarget{RuleID: ruleID, TargetIP: "127.0.0.1", TargetPort: port})
		}
	}
	return targets
}

// countingTCPTarget 是一个回显目标，记下被连了几次。
func countingTCPTarget(t *testing.T) (int, <-chan struct{}) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	accepted := make(chan struct{}, 16)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			accepted <- struct{}{}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, accepted
}

func expectNoDial(t *testing.T, accepted <-chan struct{}, within time.Duration) {
	t.Helper()
	select {
	case <-accepted:
		t.Fatal("出口不该替这个 hello 拨目标")
	case <-time.After(within):
	}
}

// tcpLoopbackPair 给一对本机 TCP 连接。流水线握手要靠内核缓冲：客户端一口气写
// 握手 + hello + 首包时，服务端同时在回确认，net.Pipe 没有缓冲会互相卡死。
func tcpLoopbackPair(t *testing.T) (client net.Conn, server net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, _ := ln.Accept()
		accepted <- c
	}()
	client, err = net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server = <-accepted
	if server == nil {
		t.Fatal("accept failed")
	}
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
	return client, server
}

// helloThroughExit 跑一个出口会话，发 hello（和一个首包），返回客户端连接和
// 出口会话的返回值。
func helloThroughExit(t *testing.T, cfg config, hello string) (*secureConn, <-chan error) {
	t.Helper()
	clientConn, serverConn := tcpLoopbackPair(t)
	result := make(chan error, 1)
	go func() { result <- handleExitSession(serverConn, cfg) }()
	sec, err := newPipelinedClientSecureConn(clientConn, cfg, fxpWireCurrent)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeSecureFramesWithDeadline(sec, []byte(hello), []byte("ping")); err != nil {
		t.Fatal(err)
	}
	return sec, result
}

func TestExitRejectsHelloNamingAnUnlistedTarget(t *testing.T) {
	allowedPort, allowedAccepted := countingTCPTarget(t)
	forbiddenPort, forbiddenAccepted := countingTCPTarget(t)
	cfg := config{Role: "exit", TunnelID: 140, Key: "exit-target-key", StreamTargets: loopbackStreamTargets(141, allowedPort)}

	cases := map[string]string{
		"target not listed": `{"network":"tcp","targetIp":"127.0.0.1","targetPort":` + strconv.Itoa(forbiddenPort) + `,"tunnelId":140,"ruleId":141}`,
		"another rule":      `{"network":"tcp","targetIp":"127.0.0.1","targetPort":` + strconv.Itoa(allowedPort) + `,"tunnelId":140,"ruleId":999}`,
		"udp over stream":   `{"network":"udp","targetIp":"127.0.0.1","targetPort":` + strconv.Itoa(forbiddenPort) + `,"tunnelId":140,"ruleId":141}`,
	}
	for name, hello := range cases {
		sec, result := helloThroughExit(t, cfg, hello)
		select {
		case err := <-result:
			if !errors.Is(err, errExitTargetNotAllowed) {
				t.Fatalf("%s: 出口应该拒绝，实际 %v", name, err)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("%s: 出口没有拒绝", name)
		}
		_ = sec.conn.Close()
	}
	expectNoDial(t, forbiddenAccepted, 100*time.Millisecond)
	expectNoDial(t, allowedAccepted, 10*time.Millisecond)

	// 表里有的照常能用。
	sec, _ := helloThroughExit(t, cfg, `{"network":"tcp","targetIp":"127.0.0.1","targetPort":`+strconv.Itoa(allowedPort)+`,"tunnelId":140,"ruleId":141}`)
	_ = sec.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if reply, err := sec.readFrame(); err != nil || string(reply) != "ping" {
		t.Fatalf("允许的目标走不通：%q %v", reply, err)
	}
}

func TestExitRefusesHostnameTargetThatResolvesToLoopback(t *testing.T) {
	port, accepted := countingTCPTarget(t)
	// 面板配的是域名：它现在解析到本机（比如有人把 DNS 改了），出口不能拨。
	cfg := config{Role: "exit", TunnelID: 142, Key: "exit-hostname-key", StreamTargets: []streamTarget{{RuleID: 143, TargetIP: "localhost", TargetPort: port}}}
	sec, result := helloThroughExit(t, cfg, `{"network":"tcp","targetIp":"LOCALHOST","targetPort":`+strconv.Itoa(port)+`,"tunnelId":142,"ruleId":143}`)
	defer sec.conn.Close()
	select {
	case err := <-result:
		if !errors.Is(err, errExitTargetNotAllowed) {
			t.Fatalf("解析到环回的域名目标应该被拒，实际 %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("出口没有拒绝解析到环回的域名目标")
	}
	expectNoDial(t, accepted, 100*time.Millisecond)
}

func TestAuthorizeExitTargetRules(t *testing.T) {
	cfg := config{
		StreamTargets: []streamTarget{
			{RuleID: 1, TargetIP: "Example.COM", TargetPort: 443},
			{RuleID: 2, TargetIP: "127.0.0.1", TargetPort: 9000},
			{RuleID: 3, TargetIP: "2001:db8::1", TargetPort: 80},
		},
		UDPTargets: []udpTarget{{RuleID: 4, TargetIP: "10.0.0.5", TargetPort: 53}},
	}
	allowed := []helloFrame{
		{Network: "tcp", RuleID: 1, TargetIP: "example.com", TargetPort: 443},
		{Network: "tcp", RuleID: 2, TargetIP: "127.0.0.1", TargetPort: 9000},
		{Network: "tcp", RuleID: 3, TargetIP: "[2001:db8:0::1]", TargetPort: 80},
		{Network: "udp", RuleID: 4, TargetIP: "10.0.0.5", TargetPort: 53},
	}
	for _, hello := range allowed {
		if err := authorizeExitTarget(cfg, &hello); err != nil {
			t.Fatalf("%+v 应该允许：%v", hello, err)
		}
	}
	rejected := []helloFrame{
		{Network: "tcp", RuleID: 1, TargetIP: "example.org", TargetPort: 443},
		{Network: "tcp", RuleID: 1, TargetIP: "example.com", TargetPort: 444},
		{Network: "tcp", RuleID: 2, TargetIP: "127.0.0.2", TargetPort: 9000},
		{Network: "tcp", RuleID: 4, TargetIP: "10.0.0.5", TargetPort: 53}, // UDP 规则的目标不给 TCP 用
		{Network: "tcp", RuleID: 1, TargetIP: "", TargetPort: 443},
	}
	for _, hello := range rejected {
		if err := authorizeExitTarget(cfg, &hello); !errors.Is(err, errExitTargetNotAllowed) {
			t.Fatalf("%+v 应该拒绝，实际 %v", hello, err)
		}
	}

	// 面板写死的环回 IP（出口本机调度器）照拨；域名解析到环回、链路本地、组播的不拨。
	literal := helloFrame{Network: "tcp", RuleID: 2, TargetIP: "127.0.0.1", TargetPort: 9000}
	if err := authorizeExitTarget(cfg, &literal); err != nil || !literal.targetLiteral {
		t.Fatalf("写死的 IP 应该算明确配置：%v literal=%v", err, literal.targetLiteral)
	}
	if err := checkResolvedExitTarget(literal, net.ParseIP("127.0.0.1")); err != nil {
		t.Fatalf("写死的环回 IP 应该放行：%v", err)
	}
	named := helloFrame{Network: "tcp", RuleID: 1, TargetIP: "example.com", TargetPort: 443}
	if err := authorizeExitTarget(cfg, &named); err != nil || named.targetLiteral {
		t.Fatalf("域名目标：%v literal=%v", err, named.targetLiteral)
	}
	for _, ip := range []string{"127.0.0.1", "::1", "0.0.0.0", "169.254.169.254", "fe80::1", "224.0.0.1", "ff02::1"} {
		if err := checkResolvedExitTarget(named, net.ParseIP(ip)); !errors.Is(err, errExitTargetNotAllowed) {
			t.Fatalf("域名解析到 %s 应该被拒，实际 %v", ip, err)
		}
	}
	if err := checkResolvedExitTarget(named, net.ParseIP("93.184.216.34")); err != nil {
		t.Fatalf("普通公网地址应该放行：%v", err)
	}
}
