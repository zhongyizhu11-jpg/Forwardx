package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// 写一个假的 forwardx-fxp：script 是 -version 时要执行的 shell 片段。
func writeFakeFXPRuntime(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "forwardx-fxp")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func useFakeFXPRuntime(t *testing.T, path string) {
	t.Helper()
	previous := resolveFXPRuntimeExecutable
	resolveFXPRuntimeExecutable = func() (string, error) { return path, nil }
	resetFXPVersionCache()
	t.Cleanup(func() {
		resolveFXPRuntimeExecutable = previous
		resetFXPVersionCache()
	})
}

func TestInstalledFXPVersionReadsVersionFlag(t *testing.T) {
	useFakeFXPRuntime(t, writeFakeFXPRuntime(t, `[ "$1" = "-version" ] && echo 2.2.124 && exit 0; exit 9`))
	if got := installedFXPVersion(); got != "2.2.124" {
		t.Fatalf("installedFXPVersion = %q, want 2.2.124", got)
	}
	if fxpVersionWireIncompatible("2.2.124") || fxpRuntimeCompatibilityError() != nil {
		t.Fatal("a current FXP must not be treated as incompatible")
	}
}

// 早于 2.2.121 的 FXP 不认识 -version（flag 包报错退出 2），二进制里也没有握手 v3 的文案：
// 握不上新节点。
func TestInstalledFXPVersionTreatsPreHandshakeV3BinaryAsIncompatible(t *testing.T) {
	useFakeFXPRuntime(t, writeFakeFXPRuntime(t, `echo "flag provided but not defined: -version" >&2; exit 2`))
	if got := installedFXPVersion(); got != fxpVersionLegacyV2 {
		t.Fatalf("installedFXPVersion = %q, want legacy-v2", got)
	}
	err := fxpRuntimeCompatibilityError()
	if err == nil || !strings.Contains(err.Error(), "版本过旧") || !strings.Contains(err.Error(), minWireCompatibleFXPVersion) {
		t.Fatalf("pre-v3 FXP must produce a clear error, got %v", err)
	}
}

// 2.2.121 ~ 2.2.123 也不认识 -version，但已经说握手 v3：只是该升级，不能被当成握不上。
func TestInstalledFXPVersionKeepsHandshakeV3LegacyBinaryUsable(t *testing.T) {
	useFakeFXPRuntime(t, writeFakeFXPRuntime(t, "# "+fxpHandshakeV3Marker+"\nexit 2"))
	if got := installedFXPVersion(); got != fxpVersionLegacy {
		t.Fatalf("installedFXPVersion = %q, want legacy", got)
	}
	if err := fxpRuntimeCompatibilityError(); err != nil {
		t.Fatalf("a handshake-v3 FXP without -version must keep running: %v", err)
	}
}

func TestFileContainsMarkerAcrossChunkBoundary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "blob")
	for _, offset := range []int{0, 256*1024 - 10, 256 * 1024, 700 * 1024} {
		content := make([]byte, 900*1024)
		copy(content[offset:], fxpHandshakeV3Marker)
		if err := os.WriteFile(path, content, 0o644); err != nil {
			t.Fatal(err)
		}
		found, err := fileContainsMarker(path, fxpHandshakeV3Marker)
		if err != nil || !found {
			t.Fatalf("marker at offset %d not found: found=%v err=%v", offset, found, err)
		}
	}
	if err := os.WriteFile(path, make([]byte, 600*1024), 0o644); err != nil {
		t.Fatal(err)
	}
	if found, _ := fileContainsMarker(path, fxpHandshakeV3Marker); found {
		t.Fatal("marker found in a file that does not contain it")
	}
}

// 真编一个仓库里的 FXP：-version 能问出版本，并且和当前协议兼容。
func TestInstalledFXPVersionOfRepositoryRuntime(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not available")
	}
	out := filepath.Join(t.TempDir(), "forwardx-fxp")
	build := exec.Command("go", "build", "-o", out, ".")
	build.Dir = filepath.Join("..", "forwardx-fxp")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build forwardx-fxp: %v\n%s", err, output)
	}
	useFakeFXPRuntime(t, out)
	version := installedFXPVersion()
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(version) || fxpVersionWireIncompatible(version) {
		t.Fatalf("repository FXP reported %q", version)
	}
	if found, err := fileContainsMarker(out, fxpHandshakeV3Marker); err != nil || !found {
		t.Fatalf("handshake v3 marker missing from the FXP binary (found=%v err=%v); legacy detection in the agent and install script relies on it", found, err)
	}
}

func TestFXPVersionWireCompatibility(t *testing.T) {
	cases := map[string]bool{
		"2.2.120":          true,
		"2.1.999":          true,
		"2.2.121":          false,
		"2.2.123":          false,
		"3.0.0":            false,
		fxpVersionLegacy:   false,
		fxpVersionLegacyV2: true,
		fxpVersionMissing:  false,
		fxpVersionUnknown:  false,
	}
	for version, want := range cases {
		if got := fxpVersionWireIncompatible(version); got != want {
			t.Errorf("fxpVersionWireIncompatible(%q) = %v, want %v", version, got, want)
		}
	}
}

func TestInstalledFXPVersionCachesByPathMtimeAndSize(t *testing.T) {
	path := writeFakeFXPRuntime(t, "echo 2.2.121")
	useFakeFXPRuntime(t, path)
	previousProbe := probeFXPBinaryVersion
	probes := 0
	probeFXPBinaryVersion = func(p string) (string, bool) {
		probes++
		return previousProbe(p)
	}
	t.Cleanup(func() { probeFXPBinaryVersion = previousProbe })

	for i := 0; i < 3; i++ {
		if got := installedFXPVersion(); got != "2.2.121" {
			t.Fatalf("installedFXPVersion = %q", got)
		}
	}
	if probes != 1 {
		t.Fatalf("unchanged binary probed %d times, want 1", probes)
	}

	// 安装脚本换了文件（大小和修改时间都变了）：要重新问。
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho 2.2.130 # replaced\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Minute)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatal(err)
	}
	if got := installedFXPVersion(); got != "2.2.130" {
		t.Fatalf("replaced binary reported %q, want 2.2.130", got)
	}
	if probes != 2 {
		t.Fatalf("replaced binary probed %d times in total, want 2", probes)
	}
}

func TestInstalledFXPVersionDoesNotCacheInconclusiveProbe(t *testing.T) {
	useFakeFXPRuntime(t, writeFakeFXPRuntime(t, "echo 2.2.123"))
	previousProbe := probeFXPBinaryVersion
	probes := 0
	probeFXPBinaryVersion = func(string) (string, bool) {
		probes++
		return fxpVersionUnknown, false
	}
	t.Cleanup(func() { probeFXPBinaryVersion = previousProbe })
	installedFXPVersion()
	if got := installedFXPVersion(); got != fxpVersionUnknown {
		t.Fatalf("installedFXPVersion = %q, want unknown", got)
	}
	if probes != 2 {
		t.Fatalf("inconclusive probe cached: probes=%d", probes)
	}
	if fxpRuntimeCompatibilityError() != nil {
		t.Fatal("an inconclusive probe must not block FXP actions")
	}
}

func TestInstalledFXPVersionMissingBinary(t *testing.T) {
	useFakeFXPRuntime(t, filepath.Join(t.TempDir(), "absent", "forwardx-fxp"))
	if got := installedFXPVersion(); got != fxpVersionMissing {
		t.Fatalf("installedFXPVersion = %q, want missing", got)
	}
	if fxpRuntimeCompatibilityError() != nil {
		t.Fatal("a missing binary is reported as runtime missing, not as a version error")
	}
}

// 旧 FXP 不能静默跑起来：启动动作失败，原因写进动作消息（面板上能看到）。
func TestStartFXPRefusesWireIncompatibleRuntime(t *testing.T) {
	useFakeFXPRuntime(t, writeFakeFXPRuntime(t, "echo 2.2.120"))
	message := &actionMessage{}
	spec := fxpSpec{
		Role:             "entry",
		TransportVersion: "v1",
		TunnelID:         7,
		RuleID:           8,
		ListenPort:       46796,
		Key:              "k",
		TargetIP:         "127.0.0.1",
		TargetPort:       1,
	}
	if startFXPProcessLockedWithPersistence(Config{}, spec, message, false) {
		t.Fatal("started an FXP runtime that cannot handshake with its peers")
	}
	if got := message.get(); !strings.Contains(got, "版本过旧（2.2.120）") || !strings.Contains(got, "升级") {
		t.Fatalf("action message does not explain the stale FXP: %q", got)
	}
	if fxpMatchesRunning(&spec) {
		t.Fatal("a stale FXP runtime must never count as already running")
	}
}
