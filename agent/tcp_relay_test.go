package main

import (
	"bytes"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// startHalfCloseReplyServer 起一个上游：读到 EOF（客户端半关闭）以后，隔一会儿
// 再把收到的内容加前缀回写，然后关闭。
func startHalfCloseReplyServer(t *testing.T, delay time.Duration) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen upstream: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				request, err := io.ReadAll(conn)
				if err != nil {
					return
				}
				time.Sleep(delay)
				_, _ = conn.Write(append([]byte("reply:"), request...))
			}(conn)
		}
	}()
	return ln
}

// relayPair 在两个真实 TCP 连接之间跑 relayTCPBidirectional，返回客户端连接和
// relay 结束的信号。
func relayPair(t *testing.T, upstreamAddr string, linger time.Duration) (*net.TCPConn, <-chan struct{}) {
	t.Helper()
	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen front: %v", err)
	}
	t.Cleanup(func() { _ = front.Close() })
	done := make(chan struct{})
	go func() {
		defer close(done)
		client, err := front.Accept()
		if err != nil {
			return
		}
		upstream, err := net.Dial("tcp", upstreamAddr)
		if err != nil {
			_ = client.Close()
			return
		}
		relayTCPBidirectional(client, upstream, linger)
	}()
	conn, err := net.Dial("tcp", front.Addr().String())
	if err != nil {
		t.Fatalf("dial front: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn.(*net.TCPConn), done
}

func waitRelayDone(t *testing.T, done <-chan struct{}, within time.Duration) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(within):
		t.Fatalf("relay did not finish within %s", within)
	}
}

func TestRelayTCPBidirectionalDeliversReplyAfterClientHalfClose(t *testing.T) {
	upstream := startHalfCloseReplyServer(t, 200*time.Millisecond)
	conn, done := relayPair(t, upstream.Addr().String(), 5*time.Second)

	if _, err := conn.Write([]byte("GET / HTTP/1.0\r\n\r\n")); err != nil {
		t.Fatalf("write request: %v", err)
	}
	if err := conn.CloseWrite(); err != nil {
		t.Fatalf("half-close client: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	got, err := io.ReadAll(conn)
	if err != nil {
		t.Fatalf("read reply: %v", err)
	}
	if want := "reply:GET / HTTP/1.0\r\n\r\n"; string(got) != want {
		t.Fatalf("reply = %q, want %q", got, want)
	}
	waitRelayDone(t, done, 2*time.Second)
}

func TestRelayTCPBidirectionalLingerIsBoundedWhenPeerNeverCloses(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen upstream: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	held := make(chan net.Conn, 1)
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			held <- conn // 读也不读、关也不关
		}
	}()
	t.Cleanup(func() {
		select {
		case conn := <-held:
			_ = conn.Close()
		default:
		}
	})

	conn, done := relayPair(t, ln.Addr().String(), 150*time.Millisecond)
	if _, err := conn.Write([]byte("x")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := conn.CloseWrite(); err != nil {
		t.Fatalf("half-close client: %v", err)
	}
	waitRelayDone(t, done, 3*time.Second)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.ReadAll(conn); err != nil {
		t.Fatalf("client should see the connection closed after linger: %v", err)
	}
}

func TestRelayTCPBidirectionalLingerDoesNotCutActiveResponse(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen upstream: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	const chunks = 12
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = io.ReadAll(conn)
		// 总时长远大于 linger，但每次间隔都小于 linger。
		for i := 0; i < chunks; i++ {
			time.Sleep(60 * time.Millisecond)
			if _, err := conn.Write([]byte("chunk\n")); err != nil {
				return
			}
		}
	}()

	conn, done := relayPair(t, ln.Addr().String(), 200*time.Millisecond)
	if err := conn.CloseWrite(); err != nil {
		t.Fatalf("half-close client: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	got, err := io.ReadAll(conn)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if want := strings.Repeat("chunk\n", chunks); string(got) != want {
		t.Fatalf("response truncated: got %d bytes, want %d", len(got), len(want))
	}
	waitRelayDone(t, done, 2*time.Second)
}

func TestRelayTCPBidirectionalClosesBothSidesOnReset(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen upstream: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	upstreamClosed := make(chan struct{})
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = io.Copy(io.Discard, conn)
		close(upstreamClosed)
	}()

	conn, done := relayPair(t, ln.Addr().String(), time.Minute)
	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatalf("write: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	_ = conn.SetLinger(0)
	_ = conn.Close() // RST，不是半关闭
	waitRelayDone(t, done, 3*time.Second)
	select {
	case <-upstreamClosed:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream side was not closed after client reset")
	}
}

func TestFailoverProxyKeepsResponseAfterClientHalfClose(t *testing.T) {
	oldPersistentDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldPersistentDir })

	upstream := startHalfCloseReplyServer(t, 300*time.Millisecond)
	upstreamPort := upstream.Addr().(*net.TCPAddr).Port

	const ruleID = 910101
	const sourcePort = 61101
	t.Cleanup(func() { stopFailoverProxy(ruleID, sourcePort) })
	listenPort := failoverTestPort(t)
	spec := failoverTestSpec(listenPort)
	spec.Targets = []failoverTarget{
		{TargetIP: "127.0.0.1", TargetPort: upstreamPort},
		{TargetIP: "127.0.0.1", TargetPort: upstreamPort},
	}
	if !startFailoverProxy(ruleID, sourcePort, spec, nil) {
		t.Fatal("failover proxy did not start")
	}

	raw, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(listenPort)), 3*time.Second)
	if err != nil {
		t.Fatalf("dial failover proxy: %v", err)
	}
	defer raw.Close()
	conn := raw.(*net.TCPConn)
	payload := bytes.Repeat([]byte("p"), 64*1024)
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	if err := conn.CloseWrite(); err != nil {
		t.Fatalf("half-close: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	got, err := io.ReadAll(conn)
	if err != nil {
		t.Fatalf("read reply: %v", err)
	}
	want := append([]byte("reply:"), payload...)
	if !bytes.Equal(got, want) {
		t.Fatalf("reply through failover proxy truncated: got %d bytes, want %d", len(got), len(want))
	}
}
