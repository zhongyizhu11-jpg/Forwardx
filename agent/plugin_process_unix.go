//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func configurePluginTaskCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	bindChildToAgent(cmd)
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}

// configureShellProcessGroup 让 Agent 执行的 shell 命令自成进程组，超时取消时连同
// 它派生的子孙进程一起杀掉。不设 Pdeathsig：这些命令可能正是去启动常驻服务的。
func configureShellProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
