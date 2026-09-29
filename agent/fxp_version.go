package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
装着的 FXP 运行时是什么版本。

Agent 和 FXP 是两个二进制，升级脚本以前在 FXP 下载失败（网络、校验值对不上）时只警告一句、
留着旧的 FXP 接着升 Agent：主机上报的 Agent 版本是新的，面板看它一切正常，可它的 FXP 还是
握手协议 v2 的旧版本，和已经升级的机器（握手 v3，FXP 2.2.121 起）根本握不上 —— 走这台做入口
的隧道 tcping 能通、真实流量全超时。

现在 Agent 跑一次 `forwardx-fxp -version` 问出版本（按路径 + 修改时间 + 大小缓存，换了文件
才重新问），随心跳报给面板；版本低于能握手的最低版本时，FXP 相关的动作一律失败并写清楚原因，
不再拿一个注定连不通的旧 FXP 装作在跑。

-version 是后来才加的。不认识它的旧二进制分两种：2.2.121 ~ 2.2.123 已经说握手 v3，只是问不出
版本（legacy，能用、但该升级）；更早的只会握手 v2（legacy-v2，握不上）。两者靠二进制里有没有
握手 v3 才引入的一条报错文案来区分（见 fxpHandshakeV3Marker）。
*/

// minWireCompatibleFXPVersion 是能和当前版本握手的最旧 FXP（握手版本 3，FXP 2.2.121 起）。
// 和 shared/versions.ts 的 FXP_MIN_WIRE_VERSION 保持一致（scripts/check-versions.mjs 会查）。
const minWireCompatibleFXPVersion = "2.2.121"

const (
	// fxpVersionLegacy：不认识 -version，但已经说握手 v3（2.2.121 ~ 2.2.123）。能握手，该升级。
	fxpVersionLegacy = "legacy"
	// fxpVersionLegacyV2：不认识 -version，也没有握手 v3（早于 2.2.121）。握不上新节点。
	fxpVersionLegacyV2 = "legacy-v2"
	// fxpVersionMissing：没装 FXP。
	fxpVersionMissing = "missing"
	// fxpVersionUnknown：问不出来（超时、启动失败），这次不下结论。
	fxpVersionUnknown = "unknown"
)

// fxpHandshakeV3Marker 是握手 v3（FXP 2.2.121）引入的一条报错文案，编进二进制的只读数据里。
// 不认识 -version 的旧二进制里有它，说明至少是 2.2.121；没有就是握手 v2 的老版本。
// 安装脚本（server/agentInstallScripts.ts）用同一条文案做同样的判断；和 shared/fxpRuntime.ts 的
// FXP_HANDSHAKE_V3_MARKER 保持一致（scripts/check-versions.mjs 会查）。
const fxpHandshakeV3Marker = "fxp handshake timestamp outside window"

const fxpVersionProbeTimeout = 3 * time.Second

var fxpSemverPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

type fxpVersionProbeKey struct {
	path    string
	modTime time.Time
	size    int64
}

var fxpVersionCache = struct {
	sync.Mutex
	key     fxpVersionProbeKey
	version string
	valid   bool
}{}

// probeFXPBinaryVersion 执行 `<fxp> -version`。definitive=false 表示这次问不出结论（超时、
// 起不来），不缓存，下次再问。
var probeFXPBinaryVersion = func(path string) (version string, definitive bool) {
	ctx, cancel := context.WithTimeout(context.Background(), fxpVersionProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "-version")
	cmd.WaitDelay = time.Second
	output, err := cmd.Output()
	if ctx.Err() != nil {
		return fxpVersionUnknown, false
	}
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			return fxpVersionUnknown, false
		}
		// 跑起来了、但不认识 -version（flag 包报错退出 2）：-version 之前的版本。
		return legacyFXPVersion(path)
	}
	line := strings.TrimSpace(strings.SplitN(string(output), "\n", 2)[0])
	line = strings.TrimPrefix(line, "v")
	if !fxpSemverPattern.MatchString(line) {
		return legacyFXPVersion(path)
	}
	return line, true
}

func legacyFXPVersion(path string) (string, bool) {
	hasV3, err := fileContainsMarker(path, fxpHandshakeV3Marker)
	if err != nil {
		return fxpVersionUnknown, false
	}
	if hasV3 {
		return fxpVersionLegacy, true
	}
	return fxpVersionLegacyV2, true
}

// fileContainsMarker 分块扫文件（块之间留 marker 长度的重叠），不把整个二进制读进内存。
func fileContainsMarker(path string, marker string) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	needle := []byte(marker)
	overlap := len(needle) - 1
	buffer := make([]byte, 256*1024+overlap)
	carried := 0
	for {
		n, readErr := file.Read(buffer[carried:])
		window := buffer[:carried+n]
		if bytes.Contains(window, needle) {
			return true, nil
		}
		if readErr == io.EOF {
			return false, nil
		}
		if readErr != nil {
			return false, readErr
		}
		if len(window) > overlap {
			carried = copy(buffer, window[len(window)-overlap:])
		} else {
			carried = len(window)
		}
	}
}

// installedFXPVersion 返回装着的 FXP 版本：x.y.z、legacy、legacy-v2、missing 或 unknown。
func installedFXPVersion() string {
	runtimePath, err := resolveFXPRuntimeExecutable()
	if err != nil || strings.TrimSpace(runtimePath) == "" {
		return fxpVersionMissing
	}
	info, err := os.Stat(runtimePath)
	if err != nil || info.IsDir() {
		return fxpVersionMissing
	}
	key := fxpVersionProbeKey{path: runtimePath, modTime: info.ModTime(), size: info.Size()}
	fxpVersionCache.Lock()
	if fxpVersionCache.valid && fxpVersionCache.key == key {
		version := fxpVersionCache.version
		fxpVersionCache.Unlock()
		return version
	}
	fxpVersionCache.Unlock()
	version, definitive := probeFXPBinaryVersion(runtimePath)
	if definitive {
		fxpVersionCache.Lock()
		fxpVersionCache.key = key
		fxpVersionCache.version = version
		fxpVersionCache.valid = true
		fxpVersionCache.Unlock()
	}
	return version
}

func resetFXPVersionCache() {
	fxpVersionCache.Lock()
	fxpVersionCache.valid = false
	fxpVersionCache.Unlock()
}

func compareFXPVersions(left, right string) int {
	lp := strings.Split(left, ".")
	rp := strings.Split(right, ".")
	for index := 0; index < 3; index++ {
		var l, r int
		if index < len(lp) {
			l, _ = strconv.Atoi(lp[index])
		}
		if index < len(rp) {
			r, _ = strconv.Atoi(rp[index])
		}
		if l != r {
			if l > r {
				return 1
			}
			return -1
		}
	}
	return 0
}

// fxpVersionWireIncompatible：这个版本的 FXP 确定握不上当前的隧道协议。问不出来的（unknown）
// 和没装的（missing，启动时自己会报 runtime missing）不算。
func fxpVersionWireIncompatible(version string) bool {
	if version == fxpVersionLegacyV2 {
		return true
	}
	if !fxpSemverPattern.MatchString(version) {
		return false
	}
	return compareFXPVersions(version, minWireCompatibleFXPVersion) < 0
}

// fxpRuntimeCompatibilityError 在装着的 FXP 握不上当前隧道协议时返回原因，并打一条警告。
func fxpRuntimeCompatibilityError() error {
	version := installedFXPVersion()
	if !fxpVersionWireIncompatible(version) {
		return nil
	}
	shown := version
	if version == fxpVersionLegacyV2 {
		shown = "早于 " + minWireCompatibleFXPVersion
	}
	err := fmt.Errorf("forwardx-fxp 版本过旧（%s），至少要 %s 才能和其它节点握手；请在面板上升级这台 Agent（会重新安装 FXP）", shown, minWireCompatibleFXPVersion)
	if shouldLogAgentReport("fxp-runtime-incompatible", agentReportLogInterval) {
		logf("warning: %v", err)
	}
	return err
}

// reportedFXPVersion 是心跳里报给面板的 FXP 版本。
func reportedFXPVersion() string {
	return installedFXPVersion()
}
