package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type capturedTrafficReport struct {
	ReportSide       string `json:"reportSide"`
	ReportProducerID string `json:"reportProducerId"`
	Stats            []struct {
		RuleID      int    `json:"ruleId"`
		BytesIn     uint64 `json:"bytesIn"`
		BytesOut    uint64 `json:"bytesOut"`
		Connections uint64 `json:"connections"`
	} `json:"stats"`
}

// trafficPanel 是一个假面板：把 FXP 报上来的流量解开记下来。
type trafficPanel struct {
	url     string
	token   string
	mu      sync.Mutex
	reports []capturedTrafficReport
}

func newTrafficPanel(t *testing.T, token string) *trafficPanel {
	t.Helper()
	panel := &trafficPanel{token: token}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/traffic" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var env envelope
		if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		iv, _ := hex.DecodeString(env.IV)
		ct, _ := hex.DecodeString(env.CT)
		keyEnc := sha256.Sum256([]byte(token + "|forwardx-agent-v1"))
		block, err := aes.NewCipher(keyEnc[:])
		if err != nil || len(iv) != aes.BlockSize {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		plain := make([]byte, len(ct))
		cipher.NewCTR(block, iv).XORKeyStream(plain, ct)
		var report capturedTrafficReport
		if err := json.Unmarshal(plain, &report); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		panel.mu.Lock()
		panel.reports = append(panel.reports, report)
		panel.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	panel.url = server.URL
	return panel
}

type ruleTrafficTotal struct {
	bytesIn, bytesOut, connections uint64
	sides, producers               map[string]bool
}

func (p *trafficPanel) totalFor(ruleID int) ruleTrafficTotal {
	p.mu.Lock()
	defer p.mu.Unlock()
	total := ruleTrafficTotal{sides: map[string]bool{}, producers: map[string]bool{}}
	for _, report := range p.reports {
		for _, stat := range report.Stats {
			if stat.RuleID != ruleID {
				continue
			}
			total.bytesIn += stat.BytesIn
			total.bytesOut += stat.BytesOut
			total.connections += stat.Connections
			total.sides[report.ReportSide] = true
			total.producers[report.ReportProducerID] = true
		}
	}
	return total
}

func (p *trafficPanel) waitFor(t *testing.T, ruleID int, done func(ruleTrafficTotal) bool) ruleTrafficTotal {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		total := p.totalFor(ruleID)
		if done(total) {
			return total
		}
		if time.Now().After(deadline) {
			t.Fatalf("rule %d traffic never reached the panel: %+v", ruleID, total)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// fixedReplyTCPTarget 读满 request 个字节，回 reply 个字节，然后关连接。
func fixedReplyTCPTarget(t *testing.T, request, reply int) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				if _, err := io.ReadFull(c, make([]byte, request)); err != nil {
					return
				}
				_, _ = c.Write(bytes.Repeat([]byte("r"), reply))
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func exitTrafficSideKeys() []trafficBatchKey {
	var keys []trafficBatchKey
	for key := range trafficBatchSnapshot() {
		if key.side == trafficReportSideExit {
			keys = append(keys, key)
		}
	}
	for key := range trafficBatchPendingSnapshot() {
		if key.side == trafficReportSideExit {
			keys = append(keys, key)
		}
	}
	return keys
}

// 入口 → 出口的会话每个方向各走一批字节：出口按 hello 的规则报一份流量，in 是
// 入口 → 目标，out 是目标 → 入口（和入口的记法一样），带着出口自己的 producer
// 和 reportSide=exit，面板靠它分辨这是出口那一份。
func TestExitReportsPerRuleTrafficForStreamSession(t *testing.T) {
	resetTrafficBatchesForTest()
	t.Cleanup(resetTrafficBatchesForTest)
	const (
		tunnelID = 160
		ruleID   = 161
		upload   = 70000
		download = 50000
		token    = "exit-traffic-token"
	)
	panel := newTrafficPanel(t, token)
	targetPort := fixedReplyTCPTarget(t, upload, download)
	cfg := config{
		Role: "exit", TunnelID: tunnelID, ListenPort: 30160, Key: "exit-traffic-key",
		StreamTargets: loopbackStreamTargets(ruleID, targetPort),
		PanelURL:      panel.url, Token: token,
	}

	clientConn, serverConn := tcpLoopbackPair(t)
	result := make(chan error, 1)
	go func() { result <- handleExitSession(serverConn, cfg) }()
	sec, err := newPipelinedClientSecureConn(clientConn, cfg, fxpWireCurrent)
	if err != nil {
		t.Fatal(err)
	}
	hello := `{"network":"tcp","targetIp":"127.0.0.1","targetPort":` + strconv.Itoa(targetPort) + `,"tunnelId":160,"ruleId":161}`
	payload := bytes.Repeat([]byte("u"), upload)
	frames := [][]byte{[]byte(hello)}
	for offset := 0; offset < len(payload); offset += 16 * 1024 {
		end := offset + 16*1024
		if end > len(payload) {
			end = len(payload)
		}
		frames = append(frames, payload[offset:end])
	}
	frames = append(frames, nil)
	if err := writeSecureFramesWithDeadline(sec, frames...); err != nil {
		t.Fatal(err)
	}
	received := 0
	_ = sec.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		frame, err := sec.readFrame()
		if err != nil {
			t.Fatalf("read reply after %d bytes: %v", received, err)
		}
		if len(frame) == 0 {
			break
		}
		received += len(frame)
	}
	if received != download {
		t.Fatalf("client got %d bytes, want %d", received, download)
	}
	select {
	case err := <-result:
		if err != nil && !isClosedErr(err) {
			t.Fatalf("exit session: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("exit session did not finish")
	}

	total := panel.waitFor(t, ruleID, func(total ruleTrafficTotal) bool {
		return total.bytesIn >= upload && total.bytesOut >= download && total.connections >= 1
	})
	if total.bytesIn != upload || total.bytesOut != download || total.connections != 1 {
		t.Fatalf("exit traffic = in %d out %d connections %d, want in %d out %d connections 1", total.bytesIn, total.bytesOut, total.connections, upload, download)
	}
	reportCfg, _ := exitTrafficReportConfig(cfg, ruleID)
	wantProducer := fxpExitTrafficProducerID(reportCfg)
	if len(total.sides) != 1 || !total.sides[trafficReportSideExit] {
		t.Fatalf("exit report side = %v, want only %q", total.sides, trafficReportSideExit)
	}
	if len(total.producers) != 1 || !total.producers[wantProducer] {
		t.Fatalf("exit producer = %v, want %q", total.producers, wantProducer)
	}
	entryProducer := fxpTrafficProducerID(config{PanelURL: cfg.PanelURL, Token: token, Role: "entry", TunnelID: tunnelID, RuleID: ruleID, ListenPort: cfg.ListenPort})
	if wantProducer == entryProducer || wantProducer == fxpTrafficProducerID(reportCfg) {
		t.Fatal("exit producer id must differ from entry producer ids")
	}
}

// hello 写的规则号不在出口的目标表里：出口拒绝，也不替它报任何流量。只靠出口
// 配置自己的单个目标放行、配置里没有规则号的，同样不记。
func TestExitDoesNotReportTrafficForUnlistedRule(t *testing.T) {
	resetTrafficBatchesForTest()
	t.Cleanup(resetTrafficBatchesForTest)
	const token = "exit-traffic-unlisted-token"
	panel := newTrafficPanel(t, token)
	allowedPort, accepted := countingTCPTarget(t)
	cfg := config{
		Role: "exit", TunnelID: 170, ListenPort: 30170, Key: "exit-traffic-unlisted-key",
		StreamTargets: loopbackStreamTargets(171, allowedPort),
		PanelURL:      panel.url, Token: token,
	}
	sec, result := helloThroughExit(t, cfg, `{"network":"tcp","targetIp":"127.0.0.1","targetPort":`+strconv.Itoa(allowedPort)+`,"tunnelId":170,"ruleId":999}`)
	select {
	case err := <-result:
		if !errors.Is(err, errExitTargetNotAllowed) {
			t.Fatalf("出口应该拒绝不在表里的规则，实际 %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("出口没有拒绝")
	}
	_ = sec.conn.Close()
	expectNoDial(t, accepted, 50*time.Millisecond)

	// 单个目标放行、配置本身没有规则号：照转，但不知道该记给谁，不记。
	fallbackCfg := config{
		Role: "exit", TunnelID: 172, ListenPort: 30172, Key: "exit-traffic-fallback-key",
		TargetIP: "127.0.0.1", TargetPort: allowedPort,
		PanelURL: panel.url, Token: token,
	}
	fallbackSec, fallbackResult := helloThroughExit(t, fallbackCfg, `{"network":"tcp","targetIp":"127.0.0.1","targetPort":`+strconv.Itoa(allowedPort)+`,"tunnelId":172,"ruleId":998}`)
	_ = fallbackSec.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if reply, err := fallbackSec.readFrame(); err != nil || string(reply) != "ping" {
		t.Fatalf("单目标出口走不通：%q %v", reply, err)
	}
	_ = fallbackSec.writeFrame(nil)
	_ = fallbackSec.conn.Close()
	select {
	case <-fallbackResult:
	case <-time.After(5 * time.Second):
		t.Fatal("fallback exit session did not finish")
	}

	flushTrafficBatches()
	time.Sleep(50 * time.Millisecond)
	if keys := exitTrafficSideKeys(); len(keys) != 0 {
		t.Fatalf("出口不该为没放行的规则记流量：%+v", keys)
	}
	for _, rule := range []int{999, 998, 171, 0} {
		if total := panel.totalFor(rule); total.bytesIn != 0 || total.bytesOut != 0 || total.connections != 0 {
			t.Fatalf("rule %d must not be reported by the exit: %+v", rule, total)
		}
	}
}

// UDP 直连出口按 udpTargets 里的规则记：发给目标的是 in，目标回的是 out，每个
// 新会话算一个连接。
func TestExitReportsPerRuleTrafficForUDPDirect(t *testing.T) {
	resetTrafficBatchesForTest()
	t.Cleanup(resetTrafficBatchesForTest)
	const (
		tunnelID  = 180
		ruleID    = 181
		sessionID = uint64(0x1801810001)
		key       = "exit-traffic-udp-key"
		token     = "exit-traffic-udp-token"
	)
	panel := newTrafficPanel(t, token)
	targetPort, got := udpEchoRecorder(t)
	cfg := config{Role: "exit", TunnelID: tunnelID, ListenPort: 30180, Protocol: "udp", Key: key,
		UDPTargets: []udpTarget{{RuleID: ruleID, TargetIP: "127.0.0.1", TargetPort: targetPort}},
		PanelURL:   panel.url, Token: token}
	exitAddr, stop := startUDPExitOn(t, 0, cfg)

	client, err := net.DialUDP("udp", nil, exitAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var sequence atomic.Uint64
	sequence.Store(4000)
	payloads := []string{"first-datagram", "second-datagram-longer"}
	want := uint64(0)
	for _, payload := range payloads {
		if _, err := client.Write(sealTestUDPData(t, tunnelID, ruleID, sessionID, key, &sequence, payload)); err != nil {
			t.Fatal(err)
		}
		expectUDPPayload(t, got, payload)
		if packet, ok := readUDPReturn(t, client, tunnelID, key, 2*time.Second); !ok || string(packet.payload) != payload {
			t.Fatalf("reply: %q %v", packet.payload, ok)
		}
		want += uint64(len(payload))
	}
	// 关监听时交最后一份。
	stop()
	total := panel.waitFor(t, ruleID, func(total ruleTrafficTotal) bool {
		return total.bytesIn >= want && total.bytesOut >= want && total.connections >= 1
	})
	if total.bytesIn != want || total.bytesOut != want || total.connections != 1 {
		t.Fatalf("udp exit traffic = %+v, want in/out %d and one connection", total, want)
	}
	if len(total.sides) != 1 || !total.sides[trafficReportSideExit] {
		t.Fatalf("udp exit report side = %v", total.sides)
	}
}

func TestAuthorizeExitTargetRecordsAccountingRule(t *testing.T) {
	cfg := config{
		RuleID:        0,
		TargetIP:      "127.0.0.9",
		TargetPort:    7000,
		StreamTargets: []streamTarget{{RuleID: 5, TargetIP: "127.0.0.1", TargetPort: 9000}},
		UDPTargets:    []udpTarget{{RuleID: 6, TargetIP: "127.0.0.2", TargetPort: 53}},
	}
	cases := []struct {
		hello helloFrame
		want  int
	}{
		{helloFrame{Network: "tcp", RuleID: 5, TargetIP: "127.0.0.1", TargetPort: 9000}, 5},
		{helloFrame{Network: "udp", RuleID: 6, TargetIP: "127.0.0.2", TargetPort: 53}, 6},
		// 靠出口配置自己的目标放行的：记给配置的规则（这里没有），不认 hello 写的号。
		{helloFrame{Network: "tcp", RuleID: 77, TargetIP: "127.0.0.9", TargetPort: 7000}, 0},
	}
	for _, tc := range cases {
		hello := tc.hello
		if err := authorizeExitTarget(cfg, &hello); err != nil {
			t.Fatalf("%+v: %v", tc.hello, err)
		}
		if hello.accountingRuleID != tc.want {
			t.Fatalf("%+v: accounting rule %d, want %d", tc.hello, hello.accountingRuleID, tc.want)
		}
	}
	cfg.RuleID = 8
	hello := helloFrame{Network: "tcp", RuleID: 77, TargetIP: "127.0.0.9", TargetPort: 7000}
	if err := authorizeExitTarget(cfg, &hello); err != nil || hello.accountingRuleID != 8 {
		t.Fatalf("single-target exit should account to its own rule: %v rule=%d", err, hello.accountingRuleID)
	}
}

// 走 TCP 流的 UDP 会话：出口一样按规则记，in 是发给目标的，out 是目标回的。
func TestExitReportsPerRuleTrafficForUDPOverStream(t *testing.T) {
	resetTrafficBatchesForTest()
	t.Cleanup(resetTrafficBatchesForTest)
	const (
		ruleID = 191
		token  = "exit-traffic-udp-stream-token"
	)
	panel := newTrafficPanel(t, token)
	targetPort, got := udpEchoRecorder(t)
	cfg := config{Role: "exit", TunnelID: 190, ListenPort: 30190, Key: "exit-traffic-udp-stream-key",
		UDPTargets: []udpTarget{{RuleID: ruleID, TargetIP: "127.0.0.1", TargetPort: targetPort}},
		PanelURL:   panel.url, Token: token}
	sec, result := helloThroughExit(t, cfg, `{"network":"udp","targetIp":"127.0.0.1","targetPort":`+strconv.Itoa(targetPort)+`,"tunnelId":190,"ruleId":191}`)
	expectUDPPayload(t, got, "ping")
	_ = sec.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if reply, err := sec.readFrame(); err != nil || string(reply) != "ping" {
		t.Fatalf("udp over stream reply: %q %v", reply, err)
	}
	if err := sec.writeFrame([]byte("second")); err != nil {
		t.Fatal(err)
	}
	expectUDPPayload(t, got, "second")
	if reply, err := sec.readFrame(); err != nil || string(reply) != "second" {
		t.Fatalf("udp over stream reply: %q %v", reply, err)
	}
	_ = sec.writeFrame(nil)
	select {
	case <-result:
	case <-time.After(5 * time.Second):
		t.Fatal("udp over stream exit session did not finish")
	}
	want := uint64(len("ping") + len("second"))
	total := panel.waitFor(t, ruleID, func(total ruleTrafficTotal) bool {
		return total.bytesIn >= want && total.bytesOut >= want && total.connections >= 1
	})
	if total.bytesIn != want || total.bytesOut != want || total.connections != 1 || !total.sides[trafficReportSideExit] {
		t.Fatalf("udp over stream exit traffic = %+v, want in/out %d", total, want)
	}
}
