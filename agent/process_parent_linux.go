//go:build linux

package main

import (
	"os/exec"
	"syscall"
)

// bindChildToAgent 让临时子进程（测速、插件任务）随 Agent 退出。
// Agent 的 systemd 单元是 KillMode=process，重启时只停 Agent 本身，
// 好让 FXP 隧道进程继续转发；这些短命的子进程则不该被留下来占端口。
func bindChildToAgent(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Pdeathsig = syscall.SIGKILL
}
