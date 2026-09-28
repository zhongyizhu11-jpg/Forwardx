//go:build !linux

package main

import "os/exec"

func bindChildToAgent(cmd *exec.Cmd) {}
