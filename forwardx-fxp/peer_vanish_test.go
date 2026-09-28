package main

import (
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

// 上一跳不发结束帧就断开（入口进程崩溃）：出口必须把连向目标的连接也关掉，
// 而不是一直挂着等目标先关。
func TestExitClosesTargetWhenUpstreamVanishes(t *testing.T) {
	resetFXPEndpointRegistry()
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	targetClosed := make(chan struct{})
	go func() {
		c, err := target.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_, _ = io.Copy(c, c) // 回显，读到 EOF 才返回
		close(targetClosed)
	}()
	key := "vanish-key"
	exitPort := startTestExit(t, 131, key)
	conn, sec, err := dialSecureTCPFresh("127.0.0.1", exitPort, config{TunnelID: 131, Key: key})
	if err != nil {
		t.Fatal(err)
	}
	hello := []byte(`{"network":"tcp","targetIp":"127.0.0.1","targetPort":` + strconv.Itoa(target.Addr().(*net.TCPAddr).Port) + `,"tunnelId":131}`)
	if err := writeSecureFramesWithDeadline(sec, hello, []byte("x")); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if reply, err := sec.readFrame(); err != nil || string(reply) != "x" {
		t.Fatalf("echo: %q %v", reply, err)
	}
	_ = conn.Close() // 不发结束帧，直接断
	select {
	case <-targetClosed:
	case <-time.After(3 * time.Second):
		t.Fatal("上一跳断了，出口却还挂着连向目标的连接")
	}
}
