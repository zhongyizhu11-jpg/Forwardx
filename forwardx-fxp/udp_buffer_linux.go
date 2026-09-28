//go:build linux

package main

import (
	"net"
	"syscall"
)

// forceUDPSocketBuffers：SetReadBuffer / SetWriteBuffer 会被内核悄悄截到
// net.core.rmem_max / wmem_max（默认约 208KB），2MB 的监听缓冲实际只有十分之一，
// 突发流量在内核里就被丢了。转发进程以 root 运行，有 CAP_NET_ADMIN，
// 可以用 SO_RCVBUFFORCE / SO_SNDBUFFORCE 越过这个上限。
func forceUDPSocketBuffers(conn *net.UDPConn, bytes int) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return
	}
	_ = raw.Control(func(fd uintptr) {
		force := func(get, set int) {
			// 内核报告的是翻倍后的值（含记账开销）。
			if current, err := syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, get); err == nil && current >= bytes {
				return
			}
			_ = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, set, bytes)
		}
		force(syscall.SO_RCVBUF, syscall.SO_RCVBUFFORCE)
		force(syscall.SO_SNDBUF, syscall.SO_SNDBUFFORCE)
	})
}
