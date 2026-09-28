package main

import (
	"context"
	"fmt"
	"os/exec"
	"time"
)

func commandOutputWithTimeout(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), normalizedCommandTimeout(timeout))
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	// 超时后最多再等 5 秒管道关闭：`sh -c "a | b"` 之类的命令被杀时，
	// 残留的孙进程会一直占着 stdout，不设 WaitDelay 会让调用方永远阻塞。
	cmd.WaitDelay = shellCommandWaitDelay
	out, err := cmd.Output()
	if ctx.Err() == context.DeadlineExceeded {
		return out, fmt.Errorf("%s timed out after %s: %w", name, normalizedCommandTimeout(timeout), ctx.Err())
	}
	return out, err
}

func commandCombinedOutputWithTimeout(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), normalizedCommandTimeout(timeout))
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = shellCommandWaitDelay
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return out, fmt.Errorf("%s timed out after %s: %w", name, normalizedCommandTimeout(timeout), ctx.Err())
	}
	return out, err
}

func normalizedCommandTimeout(timeout time.Duration) time.Duration {
	if timeout <= 0 {
		return 5 * time.Second
	}
	return timeout
}
