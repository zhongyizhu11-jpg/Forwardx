//go:build !windows

package main

import (
	"net"
	"syscall"
)

// pooledConnAlive 不阻塞地偷看一眼预热连接：对端在等 hello 的这段时间里本不该
// 发任何东西，读到 EOF / 数据 / 错误都说明这条连接不能再用了（对端重启、被
// 中间设备掐掉）。只有「现在没东西可读」才算活着。
//
// 不能用「把读超时设成过去再 Read」代替：Go 发现超时已过会直接返回，根本不去
// 读，EOF 永远看不到。
func pooledConnAlive(conn net.Conn) bool {
	sc, ok := conn.(syscall.Conn)
	if !ok {
		return true
	}
	raw, err := sc.SyscallConn()
	if err != nil {
		return false
	}
	alive := false
	var buf [1]byte
	err = raw.Read(func(fd uintptr) bool {
		n, _, recvErr := syscall.Recvfrom(int(fd), buf[:], syscall.MSG_PEEK|syscall.MSG_DONTWAIT)
		switch {
		case recvErr == syscall.EAGAIN || recvErr == syscall.EWOULDBLOCK:
			alive = true
		case recvErr == syscall.EINTR:
			alive = true
		default:
			// n == 0 是 EOF，n > 0 是不该出现的数据，其余是错误。
			_ = n
			alive = false
		}
		return true
	})
	return err == nil && alive
}
