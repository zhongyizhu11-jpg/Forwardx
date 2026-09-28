//go:build linux

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

// syncTrafficStateFilesystem 用一次 syncfs 把状态目录所在文件系统上的脏数据（文件内容与目录项）全部落盘。
func syncTrafficStateFilesystem(stateDir string) error {
	directory, err := os.Open(stateDir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return unix.Syncfs(int(directory.Fd()))
}
