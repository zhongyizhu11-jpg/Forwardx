//go:build windows

package main

import "os/exec"

func configurePluginTaskCommand(_ *exec.Cmd) {}

func configureShellProcessGroup(_ *exec.Cmd) {}
