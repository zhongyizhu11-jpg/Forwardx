//go:build windows

package main

// Windows 没有 SIGPIPE。
func ignoreBrokenPipeSignal() {}
