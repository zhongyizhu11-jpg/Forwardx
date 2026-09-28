//go:build !windows

package main

import (
	"os/signal"
	"syscall"
)

// ignoreBrokenPipeSignal 让写已断开的 stdout/stderr 只返回 EPIPE，而不是让进程死于 SIGPIPE。
//
// Go 运行时对 fd 1/2 上的 EPIPE 会主动以 SIGPIPE 退出进程（除非该信号被忽略或被 Notify）。
// 旧版 Agent 用管道接 FXP 的输出，而 Agent 的 systemd 单元是 KillMode=process：Agent 重启时
// FXP 被故意留下继续转发，管道读端却随旧 Agent 消失，FXP 下一次写日志就会被 SIGPIPE 杀掉。
// 日志丢了可以接受，转发断了不行。
func ignoreBrokenPipeSignal() {
	signal.Ignore(syscall.SIGPIPE)
}
