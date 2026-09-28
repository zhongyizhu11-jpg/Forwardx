package main

import (
	"errors"
	"net"
	"time"
)

// Accept / ReadFrom 循环的出错处理，照 net/http.Server.Serve 的做法：
//   - done 已关闭（正常收尾）→ 退出；
//   - 监听被意外关掉（net.ErrClosed）→ 这个循环再也收不到东西，是致命错误，退出并由调用方
//     把自己从运行表里摘掉，好让下一轮对账重建；否则就绪检查会一直报“就绪”而端口没人接；
//   - 其它错误（EMFILE、ECONNABORTED、ENOBUFS 等）→ 临时错误，从 5ms 起指数退避到 1s 再重试，
//     既不像以前那样第一次出错就悄悄退出，也不会在错误上空转刷日志。
const (
	serveLoopRetryMinDelay    = 5 * time.Millisecond
	serveLoopRetryMaxDelay    = time.Second
	serveLoopErrorLogInterval = 10 * time.Second
)

type serveLoopBackoff struct {
	delay      time.Duration
	lastLog    time.Time
	suppressed int
}

// failure 返回这次临时错误之后应等待的时长，并决定这次要不要打日志（节流）以及期间被压掉了几条。
func (b *serveLoopBackoff) failure(now time.Time) (time.Duration, bool, int) {
	if b.delay == 0 {
		b.delay = serveLoopRetryMinDelay
	} else {
		b.delay *= 2
	}
	if b.delay > serveLoopRetryMaxDelay {
		b.delay = serveLoopRetryMaxDelay
	}
	if b.lastLog.IsZero() || now.Sub(b.lastLog) >= serveLoopErrorLogInterval {
		suppressed := b.suppressed
		b.suppressed = 0
		b.lastLog = now
		return b.delay, true, suppressed
	}
	b.suppressed++
	return b.delay, false, 0
}

func (b *serveLoopBackoff) success() {
	b.delay = 0
}

func serveLoopFatalError(err error) bool {
	return errors.Is(err, net.ErrClosed)
}

func serveLoopDone(done <-chan struct{}) bool {
	if done == nil {
		return false
	}
	select {
	case <-done:
		return true
	default:
		return false
	}
}

// serveLoopWait 等待 delay；done 先关闭则返回 false。
func serveLoopWait(done <-chan struct{}, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-done:
		return false
	case <-timer.C:
		return true
	}
}

// serveLoopHandleError 统一处理一次 Accept/ReadFrom 错误，返回 true 表示循环应当退出。
// fatal 为 true 表示是“监听意外失效”，调用方要把自己标记为不可用以便重建。
func serveLoopHandleError(done <-chan struct{}, backoff *serveLoopBackoff, err error, logError func(err error, suppressed int)) (exit bool, fatal bool) {
	if serveLoopDone(done) {
		return true, false
	}
	if serveLoopFatalError(err) {
		return true, true
	}
	delay, shouldLog, suppressed := backoff.failure(time.Now())
	if shouldLog && logError != nil {
		logError(err, suppressed)
	}
	if !serveLoopWait(done, delay) {
		return true, false
	}
	return false, false
}
