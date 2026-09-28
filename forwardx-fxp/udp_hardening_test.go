package main

import (
	"errors"
	"net"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func TestUDPPeerMigrationNeedsTwoFreshPacketsFromTheNewAddress(t *testing.T) {
	current := &net.UDPAddr{IP: net.ParseIP("192.0.2.1"), Port: 1000}
	moved := &net.UDPAddr{IP: net.ParseIP("192.0.2.1"), Port: 2000}
	other := &net.UDPAddr{IP: net.ParseIP("198.51.100.9"), Port: 3000}
	now := time.Unix(1_000_000, 0)

	// 会话收下的第一个包定下回程：建会话的那个包可能是换了地址的重放，没被收下。
	m := &udpPeerMigration{}
	if !m.observe(moved, current, 1, true, now) {
		t.Fatal("会话收下的第一个包应该直接定下回程地址")
	}
	fresh := func() *udpPeerMigration {
		m := &udpPeerMigration{}
		if m.observe(current, current, 1, true, now) {
			t.Fatal("第一个包来自建会话的地址，不该迁移")
		}
		return m
	}

	m = fresh()
	if m.observe(moved, current, 10, true, now) {
		t.Fatal("一个包就挪了回程")
	}
	if m.observe(moved, current, 11, false, now) {
		t.Fatal("不是最新的包不该算数")
	}
	if !m.observe(moved, current, 12, true, now.Add(time.Second)) {
		t.Fatal("新地址连着来了两个最新包，回程应该挪过去（NAT 重新映射）")
	}

	// 抢发一个包之后，原地址又送来最新包：候选作废，要从头再来。
	m = fresh()
	m.observe(other, current, 20, true, now)
	m.observe(current, current, 21, true, now)
	if m.observe(other, current, 22, true, now) {
		t.Fatal("原地址中间送来过最新包，候选应该作废")
	}

	// 两个包隔得太久不算连着。
	m = fresh()
	m.observe(moved, current, 30, true, now)
	if m.observe(moved, current, 31, true, now.Add(fxpUDPPeerMigrateWindow+time.Second)) {
		t.Fatal("超出时间窗的第二个包不该触发迁移")
	}
	if !m.observe(moved, current, 32, true, now.Add(fxpUDPPeerMigrateWindow+2*time.Second)) {
		t.Fatal("时间窗重新开始后再来一个包应该迁移")
	}

	// 两个不同的新地址交替出现，谁也凑不够两个。
	m = fresh()
	m.observe(moved, current, 40, true, now)
	if m.observe(other, current, 41, true, now) || m.observe(moved, current, 42, true, now) {
		t.Fatal("交替的两个地址不该触发迁移")
	}
}

// 域名目标解析到出口本机、链路本地、组播地址的，UDP 直连出口也不拨（和走 TCP
// 流的一样）；写死的 IP 照拨。
func TestUDPDirectExitRejectsDomainResolvingToRestrictedAddress(t *testing.T) {
	flushHopResolverCache()
	defer flushHopResolverCache()
	storeHopIPs("loopback.example.test", []net.IP{net.ParseIP("127.0.0.1")})
	storeHopIPs("linklocal.example.test", []net.IP{net.ParseIP("169.254.169.254")})
	storeHopIPs("public.example.test", []net.IP{net.ParseIP("203.0.113.5")})
	for _, host := range []string{"loopback.example.test", "linklocal.example.test"} {
		if _, err := resolveExitUDPDirectTarget(1, host, 53); !errors.Is(err, errExitTargetNotAllowed) {
			t.Fatalf("%s: 应该拒绝，实际 %v", host, err)
		}
	}
	if addr, err := resolveExitUDPDirectTarget(1, "public.example.test", 53); err != nil || !addr.IP.Equal(net.ParseIP("203.0.113.5")) {
		t.Fatalf("公网域名目标：%v %v", addr, err)
	}
	if addr, err := resolveExitUDPDirectTarget(1, "127.0.0.1", 53); err != nil || !addr.IP.IsLoopback() {
		t.Fatalf("面板写死的 IP 应该照拨：%v %v", addr, err)
	}
}

// 读循环里不等 DNS：缓存里没有的域名立刻返回「在解析」，后台查完之后就能用。
func TestResolveHopAddressNonBlockingDoesNotWaitForDNS(t *testing.T) {
	flushHopResolverCache()
	defer flushHopResolverCache()
	started := time.Now()
	_, err := resolveHopAddressNonBlocking("localhost", 53)
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("non-blocking resolve waited %s", elapsed)
	}
	if !errors.Is(err, errHopResolvePending) {
		// 极快的机器上后台可能已经查完 —— 只有这一种情况允许直接成功。
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	deadline := time.Now().Add(fxpHopResolveTimeout + time.Second)
	for {
		address, err := resolveHopAddressNonBlocking("localhost", 53)
		if err == nil {
			if host, port, _ := net.SplitHostPort(address); net.ParseIP(host) == nil || port != "53" {
				t.Fatalf("resolved address %q", address)
			}
			return
		}
		if !errors.Is(err, errHopResolvePending) || time.Now().After(deadline) {
			t.Fatalf("background resolution never completed: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// 规则设了 maxConnections / maxIPs 时，UDP 直连入口也按它限会话数；会话结束
// 之后份额归还。
func TestEntryUDPDirectEnforcesRuleConnectionLimits(t *testing.T) {
	cases := []struct {
		name string
		cfg  func(c *config)
	}{
		{name: "maxConnections", cfg: func(c *config) { c.MaxConnections = 1 }},
		{name: "maxIPs", cfg: func(c *config) { c.MaxIPs = 1 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 假出口：只记下收到了几个不同会话的包。
			exit, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
			if err != nil {
				t.Fatal(err)
			}
			defer exit.Close()
			sessions := make(chan uint64, 16)
			go func() {
				buf := make([]byte, 65535)
				seen := map[uint64]bool{}
				for {
					n, _, err := exit.ReadFromUDP(buf)
					if err != nil {
						return
					}
					if id, ok := fxpUDPSessionID(buf[:n]); ok && !seen[id] {
						seen[id] = true
						sessions <- id
					}
				}
			}()
			exitPort := exit.LocalAddr().(*net.UDPAddr).Port
			cfg := config{Role: "entry", TunnelID: 610, RuleID: 611, Protocol: "udp", Key: "udp-limit-key",
				ExitHost: "127.0.0.1", ExitPort: exitPort, UDPExitPort: exitPort, TargetIP: "127.0.0.1", TargetPort: 9}
			tc.cfg(&cfg)
			listener, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
			if err != nil {
				t.Fatal(err)
			}
			selector := newExitEndpointSelector(nil, exitEndpoint{Host: "127.0.0.1", Port: exitPort, UDPPort: exitPort, Key: cfg.Key}, "")
			served := make(chan error, 1)
			go func() { served <- serveEntryUDPDirect(listener, cfg, selector, newLimiter(0), newLimiter(0)) }()
			defer func() {
				_ = listener.Close()
				<-served
			}()
			entryAddr := listener.LocalAddr().(*net.UDPAddr)
			dial := func() *net.UDPConn {
				c, err := net.DialUDP("udp", nil, entryAddr)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = c.Close() })
				return c
			}
			first, second := dial(), dial()
			if _, err := first.Write([]byte("a")); err != nil {
				t.Fatal(err)
			}
			select {
			case <-sessions:
			case <-time.After(2 * time.Second):
				t.Fatal("first session never reached the exit")
			}
			// 同一个 IP（127.0.0.1）的第二个客户端：两种限制下都该被拒。
			for i := 0; i < 3; i++ {
				_, _ = second.Write([]byte("b" + strconv.Itoa(i)))
			}
			select {
			case id := <-sessions:
				t.Fatalf("second session %d admitted despite %s=1", id, tc.name)
			case <-time.After(300 * time.Millisecond):
			}
		})
	}
}

// 限制放开（0）时不影响多个会话。
func TestEntryUDPDirectUnlimitedRuleAdmitsSessions(t *testing.T) {
	exit, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer exit.Close()
	var distinct atomic.Int32
	go func() {
		buf := make([]byte, 65535)
		seen := map[uint64]bool{}
		for {
			n, _, err := exit.ReadFromUDP(buf)
			if err != nil {
				return
			}
			if id, ok := fxpUDPSessionID(buf[:n]); ok && !seen[id] {
				seen[id] = true
				distinct.Add(1)
			}
		}
	}()
	exitPort := exit.LocalAddr().(*net.UDPAddr).Port
	cfg := config{Role: "entry", TunnelID: 612, RuleID: 613, Protocol: "udp", Key: "udp-unlimited-key",
		ExitHost: "127.0.0.1", ExitPort: exitPort, UDPExitPort: exitPort, TargetIP: "127.0.0.1", TargetPort: 9}
	listener, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	selector := newExitEndpointSelector(nil, exitEndpoint{Host: "127.0.0.1", Port: exitPort, UDPPort: exitPort, Key: cfg.Key}, "")
	served := make(chan error, 1)
	go func() { served <- serveEntryUDPDirect(listener, cfg, selector, newLimiter(0), newLimiter(0)) }()
	defer func() {
		_ = listener.Close()
		<-served
	}()
	for i := 0; i < 3; i++ {
		c, err := net.DialUDP("udp", nil, listener.LocalAddr().(*net.UDPAddr))
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		_, _ = c.Write([]byte("x"))
	}
	deadline := time.Now().Add(2 * time.Second)
	for distinct.Load() < 3 {
		if time.Now().After(deadline) {
			t.Fatalf("only %d sessions reached the exit", distinct.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
}
