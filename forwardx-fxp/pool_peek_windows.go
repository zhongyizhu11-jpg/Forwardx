//go:build windows

package main

import "net"

func pooledConnAlive(net.Conn) bool { return true }
