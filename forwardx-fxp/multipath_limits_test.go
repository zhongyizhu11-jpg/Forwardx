package main

import (
	"errors"
	"fmt"
	"net"
	"testing"
	"time"
)

func multipathTestLeg(t *testing.T, index int) (*multipathLegConn, net.Conn) {
	t.Helper()
	a, b := net.Pipe()
	t.Cleanup(func() { _ = a.Close(); _ = b.Close() })
	sec, err := newSessionSecureConn(a, "limits-key", make([]byte, fxpSaltSize), false)
	if err != nil {
		t.Fatal(err)
	}
	return newMultipathLeg(index, sec, fmt.Sprintf("leg-%d", index)), b
}

// 一个会话最多 multipathMaxLegs 条腿；对端换着腿号往里加也加不进去。
func TestMultipathSessionCapsLegCount(t *testing.T) {
	registry := newMultipathExitRegistry()
	first, _ := multipathTestLeg(t, 0)
	session, leader, err := registry.join("s", first, 64)
	if err != nil || !leader {
		t.Fatalf("first leg: %v leader=%v", err, leader)
	}
	defer session.closeTransport()
	for index := 1; index < multipathMaxLegs; index++ {
		leg, _ := multipathTestLeg(t, index)
		if _, _, err := registry.join("s", leg, 64); err != nil {
			t.Fatalf("leg %d refused below the cap: %v", index, err)
		}
	}
	extra, _ := multipathTestLeg(t, multipathMaxLegs)
	if _, _, err := registry.join("s", extra, 64); err == nil {
		t.Fatal("a leg beyond multipathMaxLegs joined the session")
	}
	if got := session.legCount(); got != multipathMaxLegs {
		t.Fatalf("legCount=%d, want %d", got, multipathMaxLegs)
	}
}

// 出口的登记表按（隧道, 会话号）分开：别的隧道上同名会话号的腿挂不进来。
func TestMultipathExitSessionKeyIsScopedByTunnel(t *testing.T) {
	registry := newMultipathExitRegistry()
	legA, _ := multipathTestLeg(t, 0)
	legB, _ := multipathTestLeg(t, 1)
	sessionA, leaderA, err := registry.join(multipathExitSessionKey(1, "same-id"), legA, 64)
	if err != nil || !leaderA {
		t.Fatalf("tunnel 1: %v", err)
	}
	defer sessionA.closeTransport()
	sessionB, leaderB, err := registry.join(multipathExitSessionKey(2, "same-id"), legB, 64)
	if err != nil || !leaderB || sessionB == sessionA {
		t.Fatalf("另一个隧道的同名会话号不该并进同一个会话：%v leader=%v same=%v", err, leaderB, sessionB == sessionA)
	}
	defer sessionB.closeTransport()
}

// 超过 multipathMaxChunkPayload 的数据块收端直接拒掉整个会话；正常大小的照收。
func TestMultipathRejectsOversizedChunks(t *testing.T) {
	if multipathMaxChunkPayload < 32*1024 {
		t.Fatalf("chunk limit %d is below what the copy loops send", multipathMaxChunkPayload)
	}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	salt := make([]byte, fxpSaltSize)
	receiverSec, err := newSessionSecureConn(a, "chunk-key", salt, false)
	if err != nil {
		t.Fatal(err)
	}
	senderSec, err := newSessionSecureConn(b, "chunk-key", salt, true)
	if err != nil {
		t.Fatal(err)
	}
	// 发端这边不跑会话，只把它写出来的东西（首个确认帧）读掉，免得管道卡住。
	go func() {
		for {
			if _, err := senderSec.readFrame(); err != nil {
				return
			}
		}
	}()
	session := newMultipathSession([]*multipathLegConn{newMultipathLeg(0, receiverSec, "leg-0")}, 64)
	defer session.closeTransport()

	normal := make([]byte, 32*1024)
	if err := senderSec.writeFrame(encodeMultipathFrame(multipathKindData, 0, normal)); err != nil {
		t.Fatal(err)
	}
	got, err := session.readFrame()
	if err != nil || len(got) != len(normal) {
		t.Fatalf("normal chunk: %d bytes, %v", len(got), err)
	}
	oversized := make([]byte, multipathMaxChunkPayload+1)
	if err := senderSec.writeFrame(encodeMultipathFrame(multipathKindData, 1, oversized)); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := session.readFrame()
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("oversized chunk was delivered")
		}
		if sessionErr := session.err(); !errors.Is(sessionErr, errMultipathChunkLarge) {
			t.Fatalf("session error = %v, want %v", sessionErr, errMultipathChunkLarge)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("oversized chunk did not end the session")
	}
}

func TestMultipathEntryDialsAtMostTheLegCap(t *testing.T) {
	cfg := config{MultipathEnabled: true}
	for i := 0; i < multipathMaxLegs+4; i++ {
		cfg.MultipathLegs = append(cfg.MultipathLegs, multipathLeg{Host: fmt.Sprintf("192.0.2.%d", i+1), Port: 1000})
	}
	if got := len(multipathLegCandidates(cfg)); got != multipathMaxLegs {
		t.Fatalf("candidates=%d, want %d", got, multipathMaxLegs)
	}
}
