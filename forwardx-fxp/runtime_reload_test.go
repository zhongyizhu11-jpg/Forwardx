package main

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// startTaggedTarget 每条连接先回一个标签，再原样回显，用来分辨连到了哪个目标。
func startTaggedTarget(t *testing.T, tag string) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, e := ln.Accept()
			if e != nil {
				return
			}
			go func() {
				defer c.Close()
				_, _ = c.Write([]byte(tag))
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

type taggedConn struct {
	t    *testing.T
	conn net.Conn
}

func dialTagged(t *testing.T, port int, tagLen int) (*taggedConn, string) {
	t.Helper()
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 3*time.Second)
	if err != nil {
		t.Fatalf("dial :%d: %v", port, err)
	}
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	tag := make([]byte, tagLen)
	if _, err := io.ReadFull(c, tag); err != nil {
		t.Fatalf("read tag on :%d: %v", port, err)
	}
	return &taggedConn{t: t, conn: c}, string(tag)
}

func (c *taggedConn) echo(payload string) error {
	_ = c.conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := c.conn.Write([]byte(payload)); err != nil {
		return err
	}
	reply := make([]byte, len(payload))
	if _, err := io.ReadFull(c.conn, reply); err != nil {
		return err
	}
	if string(reply) != payload {
		return errors.New("echo mismatch: " + string(reply))
	}
	return nil
}

func reloadEntry(ruleID, port, exitPort, targetPort int, key string) config {
	return normalizeConfig(config{
		Role: "entry", TunnelID: 120, RuleID: ruleID,
		ListenHost: "127.0.0.1", ListenPort: port, Protocol: "tcp",
		ExitHost: "127.0.0.1", ExitPort: exitPort,
		TargetIP: "127.0.0.1", TargetPort: targetPort, Key: key,
	})
}

func TestEntryGroupReloadKeepsUnchangedRulesAndLiveConnections(t *testing.T) {
	resetFXPEndpointRegistry()
	key := "reload-key"
	targetOne := startTaggedTarget(t, "T1")
	targetTwo := startTaggedTarget(t, "T2")
	exitPort := startTestExit(t, 120, key, loopbackStreamTargetMatrix([]int{1, 2, 3}, targetOne, targetTwo)...)
	ports, release := reserveFreeTCPPorts(t, 3)
	portA, portB, portC := ports[0], ports[1], ports[2]
	release()

	initial := config{Role: "entry-group", TunnelID: 120, Entries: []config{
		reloadEntry(1, portA, exitPort, targetOne, key),
		reloadEntry(2, portB, exitPort, targetOne, key),
	}}
	done := make(chan struct{})
	defer close(done)
	reloads := make(chan fxpReloadRequest)
	result := make(chan error, 1)
	go func() { result <- runManaged(done, initial, reloads) }()
	waitForTCP(t, portA)
	waitForTCP(t, portB)

	reload := func(cfg config) error {
		t.Helper()
		answer := make(chan error, 1)
		select {
		case reloads <- fxpReloadRequest{cfg: cfg, result: answer}:
		case err := <-result:
			t.Fatalf("runtime exited: %v", err)
		}
		return <-answer
	}

	liveA, tag := dialTagged(t, portA, 2)
	if tag != "T1" {
		t.Fatalf("rule A reached %q", tag)
	}
	liveB, tag := dialTagged(t, portB, 2)
	if tag != "T1" {
		t.Fatalf("rule B reached %q", tag)
	}

	// 改 B 的目标、加一条 C；A 不动。
	if err := reload(config{Role: "entry-group", TunnelID: 120, Entries: []config{
		reloadEntry(1, portA, exitPort, targetOne, key),
		reloadEntry(2, portB, exitPort, targetTwo, key),
		reloadEntry(3, portC, exitPort, targetTwo, key),
	}}); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if err := liveA.echo("still-alive-A"); err != nil {
		t.Fatalf("没改的规则 A 上的连接被重载断掉了：%v", err)
	}
	if err := liveB.echo("still-alive-B"); err != nil {
		t.Fatalf("改了的规则 B 上已有的连接应该用旧配置跑完，却断了：%v", err)
	}
	newB, tag := dialTagged(t, portB, 2)
	if tag != "T2" {
		t.Fatalf("重载后规则 B 的新连接还去了 %q", tag)
	}
	_ = newB.conn.Close()
	newC, tag := dialTagged(t, portC, 2)
	if tag != "T2" {
		t.Fatalf("新加的规则 C 去了 %q", tag)
	}
	_ = newC.conn.Close()

	// 删掉 B：端口关掉，B 上的连接断开；A 依旧不受影响。
	if err := reload(config{Role: "entry-group", TunnelID: 120, Entries: []config{
		reloadEntry(1, portA, exitPort, targetOne, key),
		reloadEntry(3, portC, exitPort, targetTwo, key),
	}}); err != nil {
		t.Fatalf("reload removing B: %v", err)
	}
	if err := liveB.echo("should-fail"); err == nil {
		t.Fatal("删掉的规则 B 上的连接还活着")
	}
	if c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(portB)), 300*time.Millisecond); err == nil {
		_ = c.Close()
		t.Fatal("删掉的规则 B 的端口还开着")
	}
	if err := liveA.echo("still-alive-A-2"); err != nil {
		t.Fatalf("删 B 的时候把 A 的连接也断了：%v", err)
	}
	_ = liveA.conn.Close()
	_ = liveB.conn.Close()
}

func TestEntryGroupReloadRollsBackWhenANewPortIsTaken(t *testing.T) {
	resetFXPEndpointRegistry()
	key := "reload-rollback-key"
	target := startTaggedTarget(t, "T1")
	exitPort := startTestExit(t, 121, key, loopbackStreamTargetMatrix([]int{1, 2, 3}, target)...)
	portA := freeTCPPort(t)
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	taken := occupied.Addr().(*net.TCPAddr).Port
	portFresh := freeTCPPort(t)

	entry := func(ruleID, port int) config {
		cfg := reloadEntry(ruleID, port, exitPort, target, key)
		cfg.TunnelID = 121
		return cfg
	}
	done := make(chan struct{})
	defer close(done)
	reloads := make(chan fxpReloadRequest)
	go func() {
		_ = runManaged(done, config{Role: "entry-group", TunnelID: 121, Entries: []config{entry(1, portA)}}, reloads)
	}()
	waitForTCP(t, portA)

	answer := make(chan error, 1)
	reloads <- fxpReloadRequest{cfg: config{Role: "entry-group", TunnelID: 121, Entries: []config{
		entry(1, portA), entry(2, portFresh), entry(3, taken),
	}}, result: answer}
	if err := <-answer; err == nil {
		t.Fatal("端口被占时重载应该失败")
	}
	// 失败的这一批一条都不能留下：portFresh 没开，A 照常。
	if c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(portFresh)), 300*time.Millisecond); err == nil {
		_ = c.Close()
		t.Fatal("重载失败却留下了半截新监听")
	}
	live, tag := dialTagged(t, portA, 2)
	defer live.conn.Close()
	if tag != "T1" {
		t.Fatalf("重载失败后旧规则去了 %q", tag)
	}
}

// 走真正的进程入口：写配置、发 SIGHUP、读 .applied。Agent 就是这么用的。
func TestSIGHUPReloadWritesAppliedAck(t *testing.T) {
	resetFXPEndpointRegistry()
	key := "sighup-key"
	target := startTaggedTarget(t, "T1")
	exitPort := startTestExit(t, 122, key, loopbackStreamTargetMatrix([]int{1, 2, 3}, target)...)
	portA := freeTCPPort(t)
	portB := freeTCPPort(t)
	path := filepath.Join(t.TempDir(), "fxp-entry-group.json")
	write := func(cfg config) {
		raw, _ := json.Marshal(cfg)
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	entry := func(ruleID, port int) config {
		cfg := reloadEntry(ruleID, port, exitPort, target, key)
		cfg.TunnelID = 122
		return cfg
	}
	first := config{Role: "entry-group", TunnelID: 122, Entries: []config{entry(1, portA)}}
	write(first)
	done := make(chan struct{})
	defer close(done)
	go func() { _ = runManaged(done, first, watchFXPConfigReloads(path)) }()
	waitForTCP(t, portA)

	second := config{Role: "entry-group", TunnelID: 122, ReloadNonce: "nonce-42", Entries: []config{entry(1, portA), entry(2, portB)}}
	write(second)
	if err := syscall.Kill(os.Getpid(), syscall.SIGHUP); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		raw, err := os.ReadFile(path + ".applied")
		if err == nil {
			var ack struct {
				Nonce string `json:"nonce"`
				OK    bool   `json:"ok"`
				Error string `json:"error"`
			}
			if json.Unmarshal(raw, &ack) == nil && ack.Nonce == "nonce-42" {
				if !ack.OK {
					t.Fatalf("reload reported failure: %s", ack.Error)
				}
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("SIGHUP 之后没等到 .applied 确认")
		}
		time.Sleep(20 * time.Millisecond)
	}
	waitForTCP(t, portB)
}
