//go:build !linux

package main

import "net"

func forceUDPSocketBuffers(*net.UDPConn, int) {}
