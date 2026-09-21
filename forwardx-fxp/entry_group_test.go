package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestReadConfigEntryGroup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "entry-group.json")
	contents := `{
		"role":" ENTRY-GROUP ",
		"tunnelId":8,
		"entries":[{
			"role":" ENTRY ",
			"tunnelId":8,
			"ruleId":9,
			"listenHost":" 127.0.0.1 ",
			"listenPort":18080,
			"protocol":" TCP+UDP ",
			"exitHost":" 127.0.0.1 ",
			"exitPort":18081,
			"targetIp":" 127.0.0.1 ",
			"targetPort":443,
			"key":"key"
		}]
	}`
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := readConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Role != "entry-group" || len(cfg.Entries) != 1 {
		t.Fatalf("group config was not decoded: %+v", cfg)
	}
	entry := cfg.Entries[0]
	if entry.Role != "entry" || entry.Protocol != "both" || entry.ListenHost != "127.0.0.1" || entry.TargetIP != "127.0.0.1" {
		t.Fatalf("grouped entry was not normalized: %+v", entry)
	}
}

func TestValidateEntryGroupConfig(t *testing.T) {
	validEntry := func(ruleID, port int, protocol string) config {
		return normalizeConfig(config{
			Role:       "entry",
			TunnelID:   91,
			RuleID:     ruleID,
			ListenHost: "127.0.0.1",
			ListenPort: port,
			Protocol:   protocol,
			ExitHost:   "127.0.0.1",
			ExitPort:   19091,
			TargetIP:   "127.0.0.1",
			TargetPort: 443,
			Key:        "entry-group-key",
		})
	}

	tests := []struct {
		name    string
		cfg     config
		wantErr string
	}{
		{
			name:    "empty",
			cfg:     config{Role: "entry-group", TunnelID: 91},
			wantErr: "at least one entry",
		},
		{
			name: "child role",
			cfg: config{Role: "entry-group", TunnelID: 91, Entries: []config{
				{Role: "exit", TunnelID: 91},
			}},
			wantErr: "requires role entry",
		},
		{
			name: "tunnel mismatch",
			cfg: config{Role: "entry-group", TunnelID: 91, Entries: []config{
				func() config { entry := validEntry(1, 19101, "tcp"); entry.TunnelID = 92; return entry }(),
			}},
			wantErr: "does not match group tunnel",
		},
		{
			name: "invalid child",
			cfg: config{Role: "entry-group", TunnelID: 91, Entries: []config{
				func() config { entry := validEntry(1, 19101, "tcp"); entry.Key = ""; return entry }(),
			}},
			wantErr: "empty key",
		},
		{
			name: "tcp conflict",
			cfg: config{Role: "entry-group", TunnelID: 91, Entries: []config{
				validEntry(1, 19101, "tcp"),
				validEntry(2, 19101, "both"),
			}},
			wantErr: "conflict on tcp listen",
		},
		{
			name: "udp conflict",
			cfg: config{Role: "entry-group", TunnelID: 91, Entries: []config{
				func() config { entry := validEntry(1, 19101, "udp"); entry.UDPListenPort = 19103; return entry }(),
				func() config { entry := validEntry(2, 19102, "both"); entry.UDPListenPort = 19103; return entry }(),
			}},
			wantErr: "conflict on udp listen",
		},
		{
			name: "wildcard conflict",
			cfg: config{Role: "entry-group", TunnelID: 91, Entries: []config{
				func() config { entry := validEntry(1, 19101, "tcp"); entry.ListenHost = ""; return entry }(),
				validEntry(2, 19101, "tcp"),
			}},
			wantErr: "conflict on tcp listen",
		},
		{
			name: "tcp and udp same port are separate lanes",
			cfg: config{Role: "entry-group", TunnelID: 91, Entries: []config{
				validEntry(1, 19101, "tcp"),
				validEntry(2, 19101, "udp"),
			}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateConfig(tt.cfg)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected validation error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("validation error = %v, want substring %q", err, tt.wantErr)
			}
		})
	}
}

func TestNormalizeConfigNormalizesGroupedEntries(t *testing.T) {
	cfg := normalizeConfig(config{
		Role:     " ENTRY-GROUP ",
		TunnelID: 8,
		Entries: []config{{
			Role:       " ENTRY ",
			TunnelID:   8,
			ListenPort: 18080,
			Protocol:   " TCP+UDP ",
			ExitHost:   " 127.0.0.1 ",
			ExitPort:   18081,
			Key:        "key",
		}},
	})
	if cfg.Role != "entry-group" || len(cfg.Entries) != 1 {
		t.Fatalf("group was not normalized: %+v", cfg)
	}
	entry := cfg.Entries[0]
	if entry.Role != "entry" || entry.Protocol != "both" || entry.ExitHost != "127.0.0.1" {
		t.Fatalf("entry was not recursively normalized: %+v", entry)
	}
	if entry.UDPListenPort != entry.ListenPort || entry.UDPExitPort != entry.ExitPort {
		t.Fatalf("entry UDP defaults were not recursively applied: %+v", entry)
	}
}

func TestRunEntryClosesTCPListenerWhenUDPBindFails(t *testing.T) {
	tcpPort := freeTCPPort(t)
	occupiedUDP, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer occupiedUDP.Close()
	udpPort := occupiedUDP.LocalAddr().(*net.UDPAddr).Port

	err = runEntry(make(chan struct{}), config{
		Role:          "entry",
		TunnelID:      92,
		RuleID:        1,
		ListenHost:    "127.0.0.1",
		ListenPort:    tcpPort,
		UDPListenPort: udpPort,
		Protocol:      "both",
		ExitHost:      "127.0.0.1",
		ExitPort:      19092,
		UDPExitPort:   19092,
		TargetIP:      "127.0.0.1",
		TargetPort:    443,
		Key:           "entry-bind-cleanup-key",
	})
	if err == nil {
		t.Fatal("expected occupied UDP port to fail")
	}
	ln, listenErr := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(tcpPort)))
	if listenErr != nil {
		t.Fatalf("TCP listener leaked after UDP bind failure: %v", listenErr)
	}
	_ = ln.Close()
}

func TestRunEntryGroupListensOnManyEntriesInOneRuntime(t *testing.T) {
	// 端口这件事没法做到万无一失：占住再放开，到真正绑上之间总有个窗口，
	// 同机上任何一个进程都可能在这一瞬间把它拿走。所以允许重来几次 ——
	// 只对「端口被占」重来，别的错照样直接红。
	for attempt := 1; ; attempt++ {
		err := runManyEntryGroupAttempt(t)
		if err == nil {
			return
		}
		if attempt >= 3 || !strings.Contains(err.Error(), "address already in use") {
			t.Fatal(err)
		}
		t.Logf("第 %d 次撞上端口被占，换一批重来：%v", attempt, err)
	}
}

func runManyEntryGroupAttempt(t *testing.T) error {
	t.Helper()
	reserved, release := reserveFreeTCPPorts(t, 129)
	ports := reserved[:128]
	exitPort := reserved[128]
	entries := make([]config, 0, len(ports))
	for i, port := range ports {
		entries = append(entries, normalizeConfig(config{
			Role:       "entry",
			TunnelID:   93,
			RuleID:     i + 1,
			ListenHost: "127.0.0.1",
			ListenPort: port,
			Protocol:   "tcp",
			ExitHost:   "127.0.0.1",
			ExitPort:   exitPort,
			TargetIP:   "127.0.0.1",
			TargetPort: 443,
			Key:        "many-entry-group-key",
		}))
	}
	cfg := config{Role: "entry-group", TunnelID: 93, Entries: entries}
	if err := validateConfig(cfg); err != nil {
		t.Fatal(err)
	}

	// 占到这一刻才放开，把「别人抢走」的窗口压到最短。
	release()

	done := make(chan struct{})
	result := make(chan error, 1)
	go func() { result <- runEntryGroup(done, cfg) }()
	for _, port := range ports {
		if err := waitForEntryGroupPort(port, result); err != nil {
			close(done)
			return err
		}
	}
	close(done)
	select {
	case err := <-result:
		if err != nil {
			return fmt.Errorf("entry group shutdown failed: %w", err)
		}
	case <-time.After(10 * time.Second):
		return errors.New("entry group did not stop all entries")
	}
	return nil
}

func TestRunEntryGroupStopsOtherEntriesOnRuntimeError(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	badPort := occupied.Addr().(*net.TCPAddr).Port
	defer occupied.Close()
	goodPort := freeTCPPort(t)
	entry := func(ruleID, port int) config {
		return normalizeConfig(config{
			Role:       "entry",
			TunnelID:   94,
			RuleID:     ruleID,
			ListenHost: "127.0.0.1",
			ListenPort: port,
			Protocol:   "tcp",
			ExitHost:   "127.0.0.1",
			ExitPort:   19094,
			TargetIP:   "127.0.0.1",
			TargetPort: 443,
			Key:        "entry-runtime-error-key",
		})
	}

	err = runEntryGroup(make(chan struct{}), config{
		Role:     "entry-group",
		TunnelID: 94,
		Entries:  []config{entry(1, goodPort), entry(2, badPort)},
	})
	if err == nil || !strings.Contains(err.Error(), "entry-group entry") {
		t.Fatalf("expected grouped runtime error, got %v", err)
	}
	ln, listenErr := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(goodPort)))
	if listenErr != nil {
		t.Fatalf("sibling entry remained open after group error: %v", listenErr)
	}
	_ = ln.Close()
}

// waitForEntryGroupPort waits for one entry's listener, but gives up the moment
// the group itself reports a failure.
//
// 入口组只要有一个入口绑不上，整组就会带着原因退出、把所有监听都关掉。这时候
// 光等端口，等到的只会是一句「端口 N 没开」—— 真正的原因（比如端口被别人占了）
// 被丢在 result 里没人看。把它捞出来，红的时候才知道是怎么红的。
func waitForEntryGroupPort(port int, result <-chan error) error {
	deadline := time.Now().Add(3 * time.Second)
	for {
		select {
		case err := <-result:
			return fmt.Errorf("入口组在端口 %d 开起来之前就退出了：%w", port, err)
		default:
		}
		conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 100*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("port %d did not open", port)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// reserveFreeTCPPorts holds count ports at once and hands back the release.
//
// 一个一个地「绑了就放」不行：放掉的那些在轮到它们之前，同机上任何一个进程
// 都可能拿走 —— 并行跑测试的时候这事儿经常发生，实测就是这么红的。同时占住
// 才能保证这一批互不重复、也不会被别人拿走；放开到真正绑上之间那个窗口
// 关不掉，由调用方重试兜底。
func reserveFreeTCPPorts(t *testing.T, count int) ([]int, func()) {
	t.Helper()
	listeners := make([]net.Listener, 0, count)
	ports := make([]int, 0, count)
	release := func() {
		for _, ln := range listeners {
			_ = ln.Close()
		}
		listeners = nil
	}
	for len(ports) < count {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			release()
			t.Fatalf("reserve port %d/%d: %v", len(ports)+1, count, err)
		}
		listeners = append(listeners, ln)
		ports = append(ports, ln.Addr().(*net.TCPAddr).Port)
	}
	t.Cleanup(release)
	return ports, release
}
