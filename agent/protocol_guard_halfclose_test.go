package main

import (
	"io"
	"net"
	"testing"
	"time"
)

// 客户端发完请求就关写端（HTTP/1.0、curl --data 之后 shutdown、nc -N）再等响应。
// 以前协议防护代理一看到客户端 EOF 就把两端都关了，响应一个字节都回不来。
func TestProtocolGuardKeepsResponseAfterClientHalfClose(t *testing.T) {
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer targetLn.Close()
	response := make([]byte, 256*1024)
	for i := range response {
		response[i] = byte(i % 251)
	}
	go func() {
		c, err := targetLn.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		// 读到 EOF 才回复：客户端必须把半关闭传过来，响应也必须能回去。
		if _, err := io.ReadAll(c); err != nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
		_, _ = c.Write(response)
	}()
	targetAddr := targetLn.Addr().(*net.TCPAddr)

	guardLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &protocolGuardServer{
		rule: guardRule{
			RuleID: 992, ListenPort: guardLn.Addr().(*net.TCPAddr).Port,
			TargetIP: targetAddr.IP.String(), TargetPort: targetAddr.Port, Protocol: "tcp",
		},
		tcpLn: guardLn,
		done:  make(chan struct{}),
	}
	go server.serveTCP(Config{})
	defer server.close()

	client, err := net.DialTimeout("tcp", guardLn.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := client.Write([]byte("request-body")); err != nil {
		t.Fatal(err)
	}
	if err := client.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(client)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if len(got) != len(response) {
		t.Fatalf("客户端半关闭后只收到 %d / %d 字节响应", len(got), len(response))
	}
}
