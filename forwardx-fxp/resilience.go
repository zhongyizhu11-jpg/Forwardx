package main

import (
	"errors"
	"fmt"
	"log"
	"net"
	"runtime/debug"
	"time"
)

const (
	fxpAcceptRetryMin = 5 * time.Millisecond
	fxpAcceptRetryMax = time.Second
)

// acceptWithRetry 只在监听器被关掉时返回错误。
//
// 其余错误都是暂时的：文件描述符耗尽（EMFILE / ENFILE）、连接在 accept 之前
// 就被对端重置（ECONNABORTED）、内核缓冲不够（ENOBUFS）。以前任何一个都会一路
// 冒到 log.Fatal，整条隧道进程退出，这台机器上走这条隧道的连接全部断掉 ——
// 而且进程要等 Agent 下一次同步才会被拉起。现在退避一下接着 accept，
// 已经建立的连接完全不受影响。
func acceptWithRetry(ln net.Listener, role string, cfg config) (net.Conn, error) {
	var delay time.Duration
	var lastLog time.Time
	for {
		conn, err := ln.Accept()
		if err == nil {
			return conn, nil
		}
		if errors.Is(err, net.ErrClosed) {
			return nil, err
		}
		if delay == 0 {
			delay = fxpAcceptRetryMin
		} else {
			delay *= 2
		}
		if delay > fxpAcceptRetryMax {
			delay = fxpAcceptRetryMax
		}
		if now := time.Now(); now.Sub(lastLog) >= 5*time.Second {
			lastLog = now
			log.Printf("%s tcp accept error tunnel=%d rule=%d listen=:%d retryIn=%s: %v", role, cfg.TunnelID, cfg.RuleID, cfg.ListenPort, delay, err)
		}
		time.Sleep(delay)
	}
}

// catchPanic 把一次 panic 收成这一条连接的错误。
//
// 转发进程里没有别的地方兜底：任何一个连接协程 panic，整个进程连同这条隧道上
// 所有用户的连接一起退出。收成错误以后，出事的只是触发它的那一条连接。
func catchPanic(where string, fn func() error) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			log.Printf("fxp panic recovered in %s: %v\n%s", where, recovered, debug.Stack())
			err = fmt.Errorf("panic in %s: %v", where, recovered)
		}
	}()
	return fn()
}
