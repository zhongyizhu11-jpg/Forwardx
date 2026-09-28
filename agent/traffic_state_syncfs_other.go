//go:build !linux

package main

import "errors"

var errTrafficStateSyncfsUnsupported = errors.New("syncfs is not supported on this platform")

// 非 Linux 平台没有 syncfs，调用方退回逐个 fsync。
func syncTrafficStateFilesystem(string) error {
	return errTrafficStateSyncfsUnsupported
}
