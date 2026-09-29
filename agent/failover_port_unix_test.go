//go:build !windows

package main

import (
	"syscall"
	"testing"
)

// 返回一个连上去必然被拒绝的本机端口，当「挂了的目标」用。端口绑定但不 listen，测试期间
// 一直占着：先 Listen 再 Close 腾出来的端口会被并行的测试拿去开监听，「拨不通」偶尔变成「拨通了」。
func refusingTestPort(t *testing.T) int {
	t.Helper()
	if port, ok := reserveRefusingPort(t); ok {
		return port
	}
	return failoverTestPort(t)
}

func reserveRefusingPort(t *testing.T) (int, bool) {
	t.Helper()
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
	if err != nil {
		return 0, false
	}
	if err := syscall.Bind(fd, &syscall.SockaddrInet4{Addr: [4]byte{127, 0, 0, 1}}); err != nil {
		syscall.Close(fd)
		return 0, false
	}
	addr, err := syscall.Getsockname(fd)
	inet, ok := addr.(*syscall.SockaddrInet4)
	if err != nil || !ok || inet.Port == 0 {
		syscall.Close(fd)
		return 0, false
	}
	t.Cleanup(func() { syscall.Close(fd) })
	return inet.Port, true
}
