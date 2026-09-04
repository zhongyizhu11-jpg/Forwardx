package main

// Entry and exit wiring for single-connection multipath aggregation.
//
// The entry opens one leg per configured path — typically one straight to the
// exit plus one through each relay front — and stripes a single client
// connection over all of them. The exit groups the legs that share a session id
// back into one stream and hands it to the target as if it had arrived over a
// single link.
//
// Relays need no changes: they forward secure frames verbatim, so a leg routed
// through a relay looks exactly like a direct leg to both ends.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

// multipathLegJoinTimeout bounds how long the exit waits for the remaining legs
// of a session before starting with the ones that arrived. A leg delayed past
// this is refused rather than allowed to join a running stream mid-flight.
const multipathLegJoinTimeout = 10 * time.Second

// newMultipathSessionID mints the identifier that ties an entry's legs together
// at the exit.
func newMultipathSessionID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// multipathEnabled reports whether this runtime should stripe sessions.
func multipathEnabled(cfg config) bool {
	return cfg.MultipathEnabled && len(cfg.MultipathLegs) >= multipathMinLegs
}

// multipathPendingLimit is the reorder bound for a session, defaulting when the
// panel does not pin one.
func multipathPendingLimit(cfg config) int {
	if cfg.MultipathMaxPending > 0 {
		return cfg.MultipathMaxPending
	}
	return multipathMaxPendingChunks
}

func multipathLegLabel(leg multipathLeg) string {
	if via := strings.TrimSpace(leg.Via); via != "" {
		return via
	}
	return fmt.Sprintf("%s:%d", leg.Host, leg.Port)
}

// dialMultipathLegs opens every configured leg and announces the shared session
// on each one.
//
// Dialling and announcing are separate phases on purpose: the hello carries the
// leg count the exit should wait for, and only once every dial has resolved is
// that count actually known. Announcing the configured count instead would make
// the exit sit through its join timeout on every connection whenever one relay
// front happens to be down.
//
// A leg that fails is skipped rather than failing the session, so losing a relay
// front costs bandwidth instead of connectivity.
func dialMultipathLegs(cfg config, hello helloFrame, sessionID string) ([]*multipathLegConn, error) {
	type dialed struct {
		index int
		conn  net.Conn
		sec   *secureConn
		label string
		err   error
	}
	configured := len(cfg.MultipathLegs)
	results := make(chan dialed, configured)
	var wg sync.WaitGroup
	for index, legCfg := range cfg.MultipathLegs {
		wg.Add(1)
		go func(index int, legCfg multipathLeg) {
			defer wg.Done()
			dialCfg := cfg
			if strings.TrimSpace(legCfg.Key) != "" {
				dialCfg.Key = legCfg.Key
			}
			label := multipathLegLabel(legCfg)
			conn, sec, err := dialSecureTCP(legCfg.Host, legCfg.Port, dialCfg)
			if err != nil {
				results <- dialed{index: index, label: label, err: fmt.Errorf("leg %d (%s): %w", index, label, err)}
				return
			}
			results <- dialed{index: index, conn: conn, sec: sec, label: label}
		}(index, legCfg)
	}
	wg.Wait()
	close(results)

	ordered := make([]*dialed, configured)
	var firstErr error
	for result := range results {
		result := result
		if result.err != nil {
			if firstErr == nil {
				firstErr = result.err
			}
			fxpVerbosef("multipath leg dial failed: %v", result.err)
			continue
		}
		ordered[result.index] = &result
	}

	// Keep the configured order so leg labels stay meaningful in logs.
	live := make([]*dialed, 0, configured)
	for _, result := range ordered {
		if result != nil {
			live = append(live, result)
		}
	}
	if len(live) == 0 {
		if firstErr == nil {
			firstErr = errMultipathNoLegs
		}
		return nil, firstErr
	}

	// Announce the count the exit will actually see.
	legs := make([]*multipathLegConn, 0, len(live))
	for index, result := range live {
		legHello := hello
		legHello.MultipathSessionID = sessionID
		legHello.MultipathLegIndex = index
		legHello.MultipathLegCount = len(live)
		frame, marshalErr := json.Marshal(legHello)
		if marshalErr != nil {
			_ = result.conn.Close()
			if firstErr == nil {
				firstErr = marshalErr
			}
			continue
		}
		if err := writeSecureHello(result.sec, frame); err != nil {
			_ = result.conn.Close()
			wrapped := fmt.Errorf("leg %d (%s) hello: %w", index, result.label, err)
			if firstErr == nil {
				firstErr = wrapped
			}
			fxpVerbosef("multipath leg hello failed: %v", wrapped)
			continue
		}
		legs = append(legs, &multipathLegConn{index: len(legs), sec: result.sec, label: result.label})
	}
	if len(legs) == 0 {
		if firstErr == nil {
			firstErr = errMultipathNoLegs
		}
		return nil, firstErr
	}
	return legs, nil
}

// closeMultipathLegs tears down legs that will not be used.
func closeMultipathLegs(legs []*multipathLegConn) {
	for _, leg := range legs {
		if leg != nil && leg.sec != nil {
			_ = leg.sec.conn.Close()
		}
	}
}

// multipathExitPending collects the legs of one session as they arrive at the
// exit.
//
// The first leg to arrive leads: it waits for its siblings, runs the target
// connection for the whole session, and releases the follower goroutines when
// the session ends. Followers must stay parked because returning would close
// the connection their leg rides on.
type multipathExitPending struct {
	sessionID string
	legCount  int

	mu      sync.Mutex
	legs    []*multipathLegConn
	started bool

	// ready fires once every announced leg has arrived.
	ready     chan struct{}
	readyOnce sync.Once
	// done fires when the leader has finished the session.
	done chan struct{}
}

// multipathExitRegistry groups arriving legs by session id.
type multipathExitRegistry struct {
	mu       sync.Mutex
	sessions map[string]*multipathExitPending
}

var exitMultipathSessions = &multipathExitRegistry{sessions: map[string]*multipathExitPending{}}

// join adds one leg, reporting whether this caller leads the session.
//
// A leg arriving after the leader started is refused: the stream is already
// running and its sequence numbering cannot absorb a new path.
func (r *multipathExitRegistry) join(sessionID string, legCount int, leg *multipathLegConn) (*multipathExitPending, bool, error) {
	r.mu.Lock()
	pending, exists := r.sessions[sessionID]
	if !exists {
		pending = &multipathExitPending{
			sessionID: sessionID,
			legCount:  legCount,
			ready:     make(chan struct{}),
			done:      make(chan struct{}),
		}
		r.sessions[sessionID] = pending
	}
	r.mu.Unlock()

	pending.mu.Lock()
	if pending.started {
		pending.mu.Unlock()
		return nil, false, errors.New("multipath leg arrived after its session started")
	}
	if legCount > pending.legCount {
		pending.legCount = legCount
	}
	leg.index = len(pending.legs)
	pending.legs = append(pending.legs, leg)
	complete := len(pending.legs) >= pending.legCount
	pending.mu.Unlock()

	if complete {
		pending.readyOnce.Do(func() { close(pending.ready) })
	}
	return pending, !exists, nil
}

func (r *multipathExitRegistry) remove(sessionID string) {
	r.mu.Lock()
	delete(r.sessions, sessionID)
	r.mu.Unlock()
}

// pendingCount reports how many sessions are still assembling, for tests.
func (r *multipathExitRegistry) pendingCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sessions)
}

// claim closes the session to further legs and returns those collected.
func (p *multipathExitPending) claim() []*multipathLegConn {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.started = true
	legs := make([]*multipathLegConn, len(p.legs))
	copy(legs, p.legs)
	for index, leg := range legs {
		leg.index = index
	}
	return legs
}

// handleExitMultipath routes one arriving leg into its session.
//
// The leader assembles the session and drives the target connection; followers
// park until it finishes.
func handleExitMultipath(sec *secureConn, hello helloFrame, cfg config) error {
	sessionID := strings.TrimSpace(hello.MultipathSessionID)
	if sessionID == "" {
		return errors.New("multipath leg is missing its session id")
	}
	legCount := hello.MultipathLegCount
	if legCount < 1 {
		legCount = 1
	}
	leg := &multipathLegConn{
		sec:   sec,
		label: fmt.Sprintf("peer-%s", sec.conn.RemoteAddr()),
	}
	pending, leader, err := exitMultipathSessions.join(sessionID, legCount, leg)
	if err != nil {
		return err
	}
	if !leader {
		// Hold the connection open; the leader is relaying for every leg.
		<-pending.done
		return nil
	}

	defer func() {
		exitMultipathSessions.remove(sessionID)
		close(pending.done)
	}()
	// Give the sibling legs a moment to arrive, then run with what is there.
	timer := time.NewTimer(multipathLegJoinTimeout)
	defer timer.Stop()
	select {
	case <-pending.ready:
	case <-timer.C:
	}
	legs := pending.claim()
	fxpVerbosef(
		"exit multipath session=%s legs=%d/%d target=%s:%d",
		sessionID,
		len(legs),
		legCount,
		hello.TargetIP,
		hello.TargetPort,
	)
	session := newMultipathSession(legs, multipathPendingLimit(cfg))
	defer session.closeTransport()
	return relayExitTCPToTarget(session, hello)
}

// dialEntryMultipath brings up the legs for one client connection and wraps
// them in a session.
//
// A leg that fails to dial is skipped, so the session degrades to the paths
// that are up rather than failing outright. Even a single surviving leg is
// still served: it behaves exactly like an ordinary session, just with the
// multipath framing, which keeps the exit side consistent.
func dialEntryMultipath(cfg config, hello helloFrame, client net.Conn) (*multipathSession, error) {
	sessionID, err := newMultipathSessionID()
	if err != nil {
		return nil, err
	}
	legs, err := dialMultipathLegs(cfg, hello, sessionID)
	if err != nil {
		return nil, err
	}
	labels := make([]string, 0, len(legs))
	for _, leg := range legs {
		labels = append(labels, leg.label)
	}
	fxpVerbosef(
		"entry multipath tunnel=%d rule=%d client=%s session=%s legs=%d/%d [%s] target=%s:%d",
		cfg.TunnelID,
		cfg.RuleID,
		client.RemoteAddr(),
		sessionID,
		len(legs),
		len(cfg.MultipathLegs),
		strings.Join(labels, ", "),
		cfg.TargetIP,
		cfg.TargetPort,
	)
	return newMultipathSession(legs, multipathPendingLimit(cfg)), nil
}
