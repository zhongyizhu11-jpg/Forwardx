//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

const sigpipeChildEnv = "FORWARDX_FXP_SIGPIPE_CHILD"

// 模拟旧 Agent 重启：FXP 的 stdout/stderr 是管道，读端先关掉，FXP 之后再写日志。
func TestBrokenStderrPipeDoesNotKillFXP(t *testing.T) {
	switch os.Getenv(sigpipeChildEnv) {
	case "ignore":
		ignoreBrokenPipeSignal()
		fallthrough
	case "default":
		time.Sleep(300 * time.Millisecond)
		for i := 0; i < 3; i++ {
			fmt.Fprintln(os.Stderr, "fxp log line after agent restart")
		}
		os.Exit(0)
	}

	run := func(mode string) error {
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(os.Args[0], "-test.run=^TestBrokenStderrPipeDoesNotKillFXP$")
		cmd.Env = append(os.Environ(), sigpipeChildEnv+"="+mode)
		cmd.Stdout = writer
		cmd.Stderr = writer
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		_ = writer.Close()
		_ = reader.Close()
		return cmd.Wait()
	}

	if err := run("ignore"); err != nil {
		t.Fatalf("FXP exited after writing to a broken stderr pipe: %v", err)
	}
	// 对照组：不忽略 SIGPIPE 时，同样的写入会让进程死于 SIGPIPE，说明上面的用例确实覆盖到了。
	err := run("default")
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("control child without SIGPIPE handling exited with %v, want SIGPIPE", err)
	}
	status, ok := exitErr.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() || status.Signal() != syscall.SIGPIPE {
		t.Fatalf("control child exit status = %v, want SIGPIPE", exitErr)
	}
}
