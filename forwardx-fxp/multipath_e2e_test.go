package main

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"testing"
	"time"
)

// startEchoTarget runs a TCP echo server standing in for the forwarding target.
func startEchoTarget(t *testing.T) (int, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen target: %v", err)
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}(conn)
		}
	}()
	return listener.Addr().(*net.TCPAddr).Port, func() { _ = listener.Close() }
}

// waitForTCPPort blocks until a runtime has bound its listener.
func waitForTCPPort(t *testing.T, port int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("port %d never came up", port)
}

// multipathTopology starts an exit, a set of relay fronts, and a multipath
// entry striping over one direct leg plus one leg per relay.
type multipathTopology struct {
	entryPort  int
	targetPort int
	stop       func()
}

func startMultipathTopology(t *testing.T, relayCount int) *multipathTopology {
	t.Helper()
	targetPort, stopTarget := startEchoTarget(t)

	const tunnelID = 9100
	const ruleID = 9101
	exitKey := "multipath-e2e-exit-key"
	exitPort := freeTCPPort(t)

	stops := []func(){stopTarget}
	exitDone := make(chan struct{})
	stops = append(stops, func() { close(exitDone) })
	go func() {
		_ = runExit(exitDone, config{
			Role:       "exit",
			TunnelID:   tunnelID,
			ListenPort: exitPort,
			Protocol:   "tcp",
			Key:        exitKey,
			TargetIP:   "127.0.0.1",
			TargetPort: targetPort,
		})
	}()
	waitForTCPPort(t, exitPort)

	// Leg 0 goes straight to the exit; the rest ride through a relay front,
	// which is exactly the shape the panel generates for aggregate mode.
	legs := []multipathLeg{{Host: "127.0.0.1", Port: exitPort, Key: exitKey, Via: "direct"}}
	for i := 0; i < relayCount; i++ {
		relayKey := fmt.Sprintf("multipath-e2e-relay-key-%d", i)
		relayPort := freeTCPPort(t)
		relayDone := make(chan struct{})
		stops = append(stops, func() { close(relayDone) })
		go func(relayPort int, relayKey string) {
			_ = runRelay(relayDone, config{
				Role:          "relay",
				TunnelID:      tunnelID,
				ListenPort:    relayPort,
				Protocol:      "tcp",
				Key:           relayKey,
				RelayExitHost: "127.0.0.1",
				RelayExitPort: exitPort,
				RelayKey:      exitKey,
			})
		}(relayPort, relayKey)
		waitForTCPPort(t, relayPort)
		legs = append(legs, multipathLeg{
			Host: "127.0.0.1",
			Port: relayPort,
			Key:  relayKey,
			Via:  fmt.Sprintf("relay-%d", i),
		})
	}

	entryPort := freeTCPPort(t)
	entryDone := make(chan struct{})
	stops = append(stops, func() { close(entryDone) })
	go func() {
		_ = runEntry(entryDone, config{
			Role:             "entry",
			TunnelID:         tunnelID,
			RuleID:           ruleID,
			ListenPort:       entryPort,
			Protocol:         "tcp",
			ExitHost:         "127.0.0.1",
			ExitPort:         exitPort,
			Key:              exitKey,
			TargetIP:         "127.0.0.1",
			TargetPort:       targetPort,
			MultipathEnabled: true,
			MultipathLegs:    legs,
		})
	}()
	waitForTCPPort(t, entryPort)

	topology := &multipathTopology{
		entryPort:  entryPort,
		targetPort: targetPort,
		stop: func() {
			for i := len(stops) - 1; i >= 0; i-- {
				stops[i]()
			}
		},
	}
	t.Cleanup(topology.stop)
	return topology
}

// echoThroughEntry sends a payload through the entry and reads it back.
func echoThroughEntry(t *testing.T, entryPort int, payload []byte) []byte {
	t.Helper()
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", entryPort), 5*time.Second)
	if err != nil {
		t.Fatalf("dial entry: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))

	readErr := make(chan error, 1)
	got := make([]byte, len(payload))
	go func() {
		_, err := io.ReadFull(conn, got)
		readErr <- err
	}()
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	if err := <-readErr; err != nil {
		t.Fatalf("read echo: %v", err)
	}
	return got
}

func TestMultipathEntryToExitPreservesPayloadOverThreeFronts(t *testing.T) {
	topology := startMultipathTopology(t, 2) // one direct leg plus two relays

	payload := make([]byte, 512*1024)
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	got := echoThroughEntry(t, topology.entryPort, payload)
	if !bytes.Equal(got, payload) {
		t.Fatalf("payload corrupted across legs: %d bytes returned", len(got))
	}
}

func TestMultipathEntryToExitHandlesManyConcurrentSessions(t *testing.T) {
	topology := startMultipathTopology(t, 2)

	const sessions = 8
	errCh := make(chan error, sessions)
	for i := 0; i < sessions; i++ {
		go func(i int) {
			payload := bytes.Repeat([]byte{byte(i)}, 64*1024)
			conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", topology.entryPort), 5*time.Second)
			if err != nil {
				errCh <- err
				return
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
			got := make([]byte, len(payload))
			readDone := make(chan error, 1)
			go func() {
				_, err := io.ReadFull(conn, got)
				readDone <- err
			}()
			if _, err := conn.Write(payload); err != nil {
				errCh <- err
				return
			}
			if err := <-readDone; err != nil {
				errCh <- err
				return
			}
			if !bytes.Equal(got, payload) {
				errCh <- fmt.Errorf("session %d payload corrupted", i)
				return
			}
			errCh <- nil
		}(i)
	}
	for i := 0; i < sessions; i++ {
		if err := <-errCh; err != nil {
			t.Fatalf("concurrent multipath session: %v", err)
		}
	}
}

func TestMultipathEntryStillWorksWithASingleReachableLeg(t *testing.T) {
	targetPort, stopTarget := startEchoTarget(t)
	defer stopTarget()

	const tunnelID = 9200
	exitKey := "multipath-single-leg-key"
	exitPort := freeTCPPort(t)
	exitDone := make(chan struct{})
	defer close(exitDone)
	go func() {
		_ = runExit(exitDone, config{
			Role:       "exit",
			TunnelID:   tunnelID,
			ListenPort: exitPort,
			Protocol:   "tcp",
			Key:        exitKey,
			TargetIP:   "127.0.0.1",
			TargetPort: targetPort,
		})
	}()
	waitForTCPPort(t, exitPort)

	// The second leg points at a port with nothing on it, standing in for a
	// relay front that is down. The session must still come up on leg 0.
	deadPort := freeTCPPort(t)
	entryPort := freeTCPPort(t)
	entryDone := make(chan struct{})
	defer close(entryDone)
	go func() {
		_ = runEntry(entryDone, config{
			Role:             "entry",
			TunnelID:         tunnelID,
			RuleID:           9201,
			ListenPort:       entryPort,
			Protocol:         "tcp",
			ExitHost:         "127.0.0.1",
			ExitPort:         exitPort,
			Key:              exitKey,
			TargetIP:         "127.0.0.1",
			TargetPort:       targetPort,
			MultipathEnabled: true,
			MultipathLegs: []multipathLeg{
				{Host: "127.0.0.1", Port: exitPort, Key: exitKey, Via: "direct"},
				{Host: "127.0.0.1", Port: deadPort, Key: exitKey, Via: "down-relay"},
			},
		})
	}()
	waitForTCPPort(t, entryPort)

	payload := bytes.Repeat([]byte("degraded-but-working;"), 512)
	got := echoThroughEntry(t, entryPort, payload)
	if !bytes.Equal(got, payload) {
		t.Fatalf("expected the session to survive on the one reachable leg, got %d bytes", len(got))
	}
}

func TestMultipathExitRegistryReleasesFinishedSessions(t *testing.T) {
	topology := startMultipathTopology(t, 2)
	payload := bytes.Repeat([]byte("registry;"), 1024)
	if got := echoThroughEntry(t, topology.entryPort, payload); !bytes.Equal(got, payload) {
		t.Fatalf("payload corrupted")
	}
	// The leading leg removes its session once the stream finishes, so nothing
	// should accumulate in the registry across sessions.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if exitMultipathSessions.pendingCount() == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("exit registry still holds %d session(s)", exitMultipathSessions.pendingCount())
}
