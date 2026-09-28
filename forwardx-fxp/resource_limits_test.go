package main

import (
	"crypto/rand"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConnGateEnforcesTotalAndPerIPLimits(t *testing.T) {
	gate := newConnGate(3, 2)
	addrA := &net.TCPAddr{IP: net.ParseIP("192.0.2.1"), Port: 10001}
	addrB := &net.TCPAddr{IP: net.ParseIP("192.0.2.2"), Port: 10002}
	addrC := &net.TCPAddr{IP: net.ParseIP("192.0.2.3"), Port: 10003}

	releaseA1, ok, reason := gate.acquire(addrA)
	if !ok {
		t.Fatalf("first connection rejected: %s", reason)
	}
	releaseA2, ok, reason := gate.acquire(addrA)
	if !ok {
		t.Fatalf("second connection rejected: %s", reason)
	}
	if _, ok, reason := gate.acquire(addrA); ok || reason != "maxIPs" {
		t.Fatalf("third connection from one IP: ok=%v reason=%q", ok, reason)
	}
	releaseB, ok, reason := gate.acquire(addrB)
	if !ok {
		t.Fatalf("connection from second IP rejected: %s", reason)
	}
	if _, ok, reason := gate.acquire(addrC); ok || reason != "maxConnections" {
		t.Fatalf("connection above total limit: ok=%v reason=%q", ok, reason)
	}

	releaseA1()
	releaseA3, ok, reason := gate.acquire(addrA)
	if !ok {
		t.Fatalf("connection was not admitted after release: %s", reason)
	}
	releaseA3()
	releaseA3() // Leases are intentionally idempotent.
	releaseA2()
	releaseB()

	if active, ips := gate.stats(); active != 0 || ips != 0 {
		t.Fatalf("gate did not return to empty state: active=%d ips=%d", active, ips)
	}
}

func TestConnGateConcurrentAcquireNeverExceedsHardLimit(t *testing.T) {
	const (
		limit   = 8
		workers = 128
	)
	gate := newConnGate(limit, 0)
	addr := &net.TCPAddr{IP: net.ParseIP("198.51.100.10"), Port: 443}
	start := make(chan struct{})
	releaseAll := make(chan struct{})
	var attempts sync.WaitGroup
	var workersWG sync.WaitGroup
	var admitted atomic.Int64
	var current atomic.Int64
	var peak atomic.Int64

	attempts.Add(workers)
	workersWG.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer workersWG.Done()
			<-start
			release, ok, _ := gate.acquire(addr)
			if !ok {
				attempts.Done()
				return
			}
			admitted.Add(1)
			now := current.Add(1)
			for {
				observed := peak.Load()
				if now <= observed || peak.CompareAndSwap(observed, now) {
					break
				}
			}
			attempts.Done()
			<-releaseAll
			current.Add(-1)
			release()
		}()
	}
	close(start)
	attempts.Wait()

	if got := admitted.Load(); got != limit {
		t.Fatalf("admitted=%d, want %d", got, limit)
	}
	if got := peak.Load(); got > limit {
		t.Fatalf("peak=%d exceeds limit %d", got, limit)
	}
	if active, _ := gate.stats(); active != limit {
		t.Fatalf("active=%d, want %d", active, limit)
	}

	close(releaseAll)
	workersWG.Wait()
	if active, ips := gate.stats(); active != 0 || ips != 0 {
		t.Fatalf("gate did not drain: active=%d ips=%d", active, ips)
	}
}

func TestListenerConnGatesHaveDefaultsAndReleasePendingAfterHello(t *testing.T) {
	gates := newListenerConnGates(config{})
	if gates.active.maxConnections != fxpListenerMaxConnections || gates.active.maxPerIP != 0 {
		t.Fatalf("unexpected active defaults: total=%d perIP=%d", gates.active.maxConnections, gates.active.maxPerIP)
	}
	if gates.pending.maxConnections != fxpListenerMaxPendingConnections || gates.pending.maxPerIP != fxpListenerMaxPendingPerIP {
		t.Fatalf("unexpected pending defaults: total=%d perIP=%d", gates.pending.maxConnections, gates.pending.maxPerIP)
	}

	if gates.handshake.maxConnections != fxpListenerMaxPendingConnections || gates.handshake.maxPerIP != fxpListenerMaxHandshakePerIP {
		t.Fatalf("unexpected handshake defaults: total=%d perIP=%d", gates.handshake.maxConnections, gates.handshake.maxPerIP)
	}

	addr := &net.TCPAddr{IP: net.ParseIP("203.0.113.7"), Port: 50000}
	admission, ok, reason := gates.admit(addr)
	if !ok {
		t.Fatalf("listener gate rejected first connection: %s", reason)
	}
	// 握手之前只占握手闸，不占 pending 和 active。
	if handshake, _ := gates.handshake.stats(); handshake != 1 {
		t.Fatalf("handshake=%d, want 1", handshake)
	}
	if pending, _ := gates.pending.stats(); pending != 0 {
		t.Fatalf("unauthenticated connection took a pending lease: %d", pending)
	}
	if active, _ := gates.active.stats(); active != 0 {
		t.Fatalf("unauthenticated connection took an active lease: %d", active)
	}
	if ok, reason := admission.authenticated(); !ok {
		t.Fatalf("authenticated connection rejected: %s", reason)
	}
	if handshake, _ := gates.handshake.stats(); handshake != 0 {
		t.Fatalf("handshake lease remained after authentication: %d", handshake)
	}
	if pending, _ := gates.pending.stats(); pending != 1 {
		t.Fatalf("pending=%d, want 1", pending)
	}
	if active, _ := gates.active.stats(); active != 1 {
		t.Fatalf("active=%d, want 1", active)
	}

	admission.helloReceived()
	admission.helloReceived()
	if pending, _ := gates.pending.stats(); pending != 0 {
		t.Fatalf("pending remained after hello: %d", pending)
	}
	if active, _ := gates.active.stats(); active != 1 {
		t.Fatalf("active lease was released with pending lease: %d", active)
	}

	admission.release()
	admission.release()
	if active, ips := gates.active.stats(); active != 0 || ips != 0 {
		t.Fatalf("active gate did not drain: active=%d ips=%d", active, ips)
	}

	configured := newListenerConnGates(config{MaxConnections: 100, MaxIPs: 7})
	if configured.active.maxConnections != 100 || configured.active.maxPerIP != 0 {
		t.Fatalf("configured total limit was not honored independently of the upstream IP: total=%d perIP=%d", configured.active.maxConnections, configured.active.maxPerIP)
	}
	if configured.pending.maxConnections != 100 || configured.pending.maxPerIP != 100 {
		t.Fatalf("pending limits should be capped by configured limits: total=%d perIP=%d", configured.pending.maxConnections, configured.pending.maxPerIP)
	}

	oversized := newListenerConnGates(config{
		MaxConnections: fxpListenerMaxConnections + 1,
		MaxIPs:         1,
	})
	if oversized.active.maxConnections != fxpListenerMaxConnections || oversized.active.maxPerIP != 0 {
		t.Fatalf("configured limits exceeded hard bounds: total=%d perIP=%d", oversized.active.maxConnections, oversized.active.maxPerIP)
	}
}

func TestListenerConnGatesDoNotTreatAnEntryAgentAsOneUser(t *testing.T) {
	gates := newListenerConnGates(config{MaxConnections: 2})
	addr := &net.TCPAddr{IP: net.ParseIP("203.0.113.9"), Port: 50000}

	first := mustAuthenticate(t, gates, addr)
	second := mustAuthenticate(t, gates, addr)
	first.helloReceived()
	second.helloReceived()
	third, ok, reason := gates.admit(addr)
	if !ok {
		t.Fatalf("third connection should pass the handshake gate: %s", reason)
	}
	if ok, reason := third.authenticated(); ok || reason != "active/maxConnections" {
		t.Fatalf("third connection should hit the global limit, got ok=%v reason=%q", ok, reason)
	}
	third.release()
	second.release()
	first.release()
}

func mustAuthenticate(t *testing.T, gates *listenerConnGates, addr net.Addr) *listenerAdmission {
	t.Helper()
	admission, ok, reason := gates.admit(addr)
	if !ok {
		t.Fatalf("connection rejected at handshake gate: %s", reason)
	}
	if ok, reason := admission.authenticated(); !ok {
		admission.release()
		t.Fatalf("authenticated connection rejected: %s", reason)
	}
	return admission
}

// 慢速连接：握手之前不说话的连接每个 IP 只能占 fxpListenerMaxHandshakePerIP 条，
// 占满了也不影响别的 IP，更不影响已经握过手、在等 hello 的池连接。
func TestListenerHandshakeGateBoundsSilentConnectionsPerIP(t *testing.T) {
	gates := newListenerConnGates(config{})
	attacker := &net.TCPAddr{IP: net.ParseIP("198.51.100.66"), Port: 40000}
	var held []*listenerAdmission
	for i := 0; i < fxpListenerMaxHandshakePerIP; i++ {
		admission, ok, reason := gates.admit(attacker)
		if !ok {
			t.Fatalf("silent connection %d rejected early: %s", i+1, reason)
		}
		held = append(held, admission)
	}
	if _, ok, reason := gates.admit(attacker); ok || reason != "handshake/maxIPs" {
		t.Fatalf("attacker exceeded the per-IP handshake cap: ok=%v reason=%q", ok, reason)
	}
	entry := &net.TCPAddr{IP: net.ParseIP("198.51.100.7"), Port: 40001}
	// 合法入口的连接池：握手通过后在等 hello 的连接可以远超握手份额。
	var pooled []*listenerAdmission
	for i := 0; i < fxpListenerMaxHandshakePerIP*4; i++ {
		pooled = append(pooled, mustAuthenticate(t, gates, entry))
	}
	if pending, _ := gates.pending.stats(); pending != int64(len(pooled)) {
		t.Fatalf("pending=%d, want %d", pending, len(pooled))
	}
	for _, admission := range append(held, pooled...) {
		admission.release()
	}
	for name, gate := range map[string]*connGate{"handshake": gates.handshake, "pending": gates.pending, "active": gates.active} {
		if n, ips := gate.stats(); n != 0 || ips != 0 {
			t.Fatalf("%s gate did not drain: n=%d ips=%d", name, n, ips)
		}
	}
}

// 不说话的连接在 fxpServerHandshakeTimeout 内被出口关掉，不会一直占着握手份额。
func TestExitClosesSilentPreHandshakeConnection(t *testing.T) {
	if fxpServerHandshakeTimeout >= fxpHandshakeTimeout {
		t.Fatalf("server handshake timeout %s should be shorter than %s", fxpServerHandshakeTimeout, fxpHandshakeTimeout)
	}
	serverConn, clientConn := net.Pipe()
	defer clientConn.Close()
	started := time.Now()
	done := make(chan error, 1)
	go func() { done <- handleExitSession(serverConn, config{Role: "exit", TunnelID: 1, Key: "k"}) }()
	select {
	case <-done:
		if elapsed := time.Since(started); elapsed < fxpServerHandshakeTimeout-100*time.Millisecond {
			t.Fatalf("silent connection closed too early: %s", elapsed)
		}
	case <-time.After(fxpServerHandshakeTimeout + 3*time.Second):
		t.Fatal("silent pre-handshake connection was not closed")
	}
}

func TestListenerConnGatesAllowMoreThanLegacyPerIPLimitFromOneEntry(t *testing.T) {
	const admitted = 4097
	gates := newListenerConnGates(config{MaxConnections: admitted + 32})
	addr := &net.TCPAddr{IP: net.ParseIP("203.0.113.10"), Port: 50001}
	releases := make([]func(), 0, admitted)
	for i := 0; i < admitted; i++ {
		admission, ok, reason := gates.admit(addr)
		if ok {
			ok, reason = admission.authenticated()
		}
		if !ok {
			for _, cleanup := range releases {
				cleanup()
			}
			t.Fatalf("connection %d from one entry agent rejected: %s", i+1, reason)
		}
		// Handshake completion releases the stricter pending per-IP lease;
		// active connections remain protected by the listener-wide limit.
		admission.helloReceived()
		releases = append(releases, admission.release)
	}
	if active, _ := gates.active.stats(); active != admitted {
		t.Fatalf("active=%d, want %d", active, admitted)
	}
	for _, release := range releases {
		release()
	}
	if active, _ := gates.active.stats(); active != 0 {
		t.Fatalf("active gate did not drain: %d", active)
	}
}

func TestLimiterWaitReturnsWhenSessionIsCanceled(t *testing.T) {
	limiter := &limiter{
		rate:   1,
		burst:  1,
		tokens: 0,
		last:   time.Now(),
	}
	done := make(chan struct{})
	returned := make(chan bool, 1)
	go func() {
		returned <- limiter.waitDone(done, 1)
	}()
	close(done)
	select {
	case completed := <-returned:
		if completed {
			t.Fatal("canceled limiter wait reported success")
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("canceled limiter wait remained blocked")
	}
}

func TestServerHandshakeTimesOutWhenPeerStalls(t *testing.T) {
	tests := []struct {
		name    string
		partial []byte
	}{
		{name: "no handshake"},
		{name: "partial handshake", partial: make([]byte, fxpSaltSize+5)},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, rawServer := net.Pipe()
			defer client.Close()
			defer rawServer.Close()
			server := &shortDeadlineConn{Conn: rawServer, timeout: 25 * time.Millisecond}
			cfg := config{TunnelID: 700 + index, Key: "stalled-server-handshake"}
			errCh := make(chan error, 1)
			go func() {
				_, err := newServerSecureConn(server, cfg)
				errCh <- err
			}()
			if len(test.partial) > 0 {
				partial := append([]byte(nil), test.partial...)
				if _, err := rand.Read(partial[:fxpSaltSize]); err != nil {
					t.Fatal(err)
				}
				if _, err := client.Write(partial); err != nil {
					t.Fatal(err)
				}
			}
			assertTimeoutError(t, <-errCh)
		})
	}
}

func TestClientHandshakeTimesOutWhenPeerDoesNotRead(t *testing.T) {
	rawClient, server := net.Pipe()
	defer rawClient.Close()
	defer server.Close()
	client := &shortDeadlineConn{Conn: rawClient, timeout: 25 * time.Millisecond}
	_, err := newClientSecureConn(client, config{TunnelID: 711, Key: "stalled-client-handshake"})
	assertTimeoutError(t, err)
}

func TestServerHelloTimesOutAfterSuccessfulHandshake(t *testing.T) {
	rawClient, rawServer := net.Pipe()
	defer rawClient.Close()
	defer rawServer.Close()
	client := &shortDeadlineConn{Conn: rawClient, timeout: 25 * time.Millisecond}
	server := &shortDeadlineConn{Conn: rawServer, timeout: 25 * time.Millisecond}
	cfg := config{TunnelID: 713, Key: "stalled-server-hello"}

	serverResult := make(chan secureConnResult, 1)
	go func() {
		sec, err := newServerSecureConn(server, cfg)
		serverResult <- secureConnResult{sec: sec, err: err}
	}()
	clientSec, err := newClientSecureConn(client, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer clientSec.conn.Close()
	result := <-serverResult
	if result.err != nil {
		t.Fatal(result.err)
	}
	defer result.sec.conn.Close()

	_, err = readSecureHello(result.sec)
	assertTimeoutError(t, err)
}

func TestHandshakeAndHelloDeadlinesAreClearedForEstablishedTraffic(t *testing.T) {
	rawClient, rawServer := net.Pipe()
	defer rawClient.Close()
	defer rawServer.Close()
	client := &shortDeadlineConn{Conn: rawClient, timeout: 30 * time.Millisecond}
	server := &shortDeadlineConn{Conn: rawServer, timeout: 30 * time.Millisecond}
	cfg := config{TunnelID: 712, Key: "deadline-clear-handshake"}

	serverResult := make(chan secureConnResult, 1)
	go func() {
		sec, err := newServerSecureConn(server, cfg)
		serverResult <- secureConnResult{sec: sec, err: err}
	}()
	clientSec, err := newClientSecureConn(client, cfg)
	if err != nil {
		t.Fatal(err)
	}
	result := <-serverResult
	if result.err != nil {
		t.Fatal(result.err)
	}
	serverSec := result.sec

	helloResult := make(chan frameResult, 1)
	go func() {
		frame, err := readSecureHello(serverSec)
		helloResult <- frameResult{frame: frame, err: err}
	}()
	if err := writeSecureHello(clientSec, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	hello := <-helloResult
	if hello.err != nil || string(hello.frame) != "hello" {
		t.Fatalf("hello frame=%q err=%v", hello.frame, hello.err)
	}

	// Waiting past the shortened test deadline proves both successful phases
	// cleared it before normal forwarding began.
	time.Sleep(90 * time.Millisecond)
	writeResult := make(chan error, 1)
	go func() { writeResult <- clientSec.writeFrame([]byte("established")) }()
	frame, err := serverSec.readFrame()
	if err != nil {
		t.Fatal(err)
	}
	if err := <-writeResult; err != nil {
		t.Fatal(err)
	}
	if string(frame) != "established" {
		t.Fatalf("unexpected established frame %q", frame)
	}
	if client.clearedCount() < 2 || server.clearedCount() < 2 {
		t.Fatalf("deadlines were not cleared after both phases: client=%d server=%d", client.clearedCount(), server.clearedCount())
	}
}

type shortDeadlineConn struct {
	net.Conn
	timeout time.Duration
	mu      sync.Mutex
	cleared int
}

func (c *shortDeadlineConn) SetDeadline(deadline time.Time) error {
	c.mu.Lock()
	if deadline.IsZero() {
		c.cleared++
	} else {
		deadline = time.Now().Add(c.timeout)
	}
	c.mu.Unlock()
	return c.Conn.SetDeadline(deadline)
}

func (c *shortDeadlineConn) shorten(deadline time.Time) time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if deadline.IsZero() {
		c.cleared++
		return deadline
	}
	return time.Now().Add(c.timeout)
}

// 握手确认和 hello 用的是单方向的读 / 写超时（另一个方向可能正有协程在等），
// 同样缩短、同样计数。
func (c *shortDeadlineConn) SetReadDeadline(deadline time.Time) error {
	return c.Conn.SetReadDeadline(c.shorten(deadline))
}

func (c *shortDeadlineConn) SetWriteDeadline(deadline time.Time) error {
	return c.Conn.SetWriteDeadline(c.shorten(deadline))
}

func (c *shortDeadlineConn) clearedCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cleared
}

type secureConnResult struct {
	sec *secureConn
	err error
}

type frameResult struct {
	frame []byte
	err   error
}

func assertTimeoutError(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected timeout error")
	}
	var netErr net.Error
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		t.Fatalf("expected network timeout, got %T: %v", err, err)
	}
}
