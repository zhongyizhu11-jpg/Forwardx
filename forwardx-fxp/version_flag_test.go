package main

import (
	"bytes"
	"errors"
	"flag"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeFlagsKeepConfigInvocationAndAddVersion(t *testing.T) {
	configPath, showVersion, err := parseRuntimeFlags([]string{"-config", "/run/forwardx-agent/fxp-exit-1-0-46796.json"}, io.Discard)
	if err != nil || showVersion || configPath != "/run/forwardx-agent/fxp-exit-1-0-46796.json" {
		t.Fatalf("Agent 起进程的参数不能变：config=%q version=%v err=%v", configPath, showVersion, err)
	}
	_, showVersion, err = parseRuntimeFlags([]string{"-version"}, io.Discard)
	if err != nil || !showVersion {
		t.Fatalf("-version not recognised: version=%v err=%v", showVersion, err)
	}
	if _, _, err = parseRuntimeFlags([]string{"-h"}, io.Discard); !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("-h should ask for help, got %v", err)
	}
	if _, _, err = parseRuntimeFlags([]string{"-bogus"}, io.Discard); err == nil {
		t.Fatal("unknown flags must still be rejected")
	}
	var out bytes.Buffer
	printRuntimeVersion(&out)
	if strings.TrimSpace(out.String()) != fxpRuntimeVersion {
		t.Fatalf("version output %q, want %q", out.String(), fxpRuntimeVersion)
	}
}

// 走真的二进制：Agent 和安装脚本就是这么问的。
func TestRuntimeBinaryPrintsVersionAndExitsZero(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not available")
	}
	binary := filepath.Join(t.TempDir(), "forwardx-fxp")
	if output, err := exec.Command("go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}
	output, err := exec.Command(binary, "-version").Output()
	if err != nil {
		t.Fatalf("-version exited with error: %v", err)
	}
	if strings.TrimSpace(string(output)) != fxpRuntimeVersion {
		t.Fatalf("-version printed %q, want %q", output, fxpRuntimeVersion)
	}
}
