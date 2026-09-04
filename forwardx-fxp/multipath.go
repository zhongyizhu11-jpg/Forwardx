package main

// Single-connection multipath aggregation for FXP.
//
// A normal FXP session carries one client connection over one secure link from
// the entry to the exit, so the session is capped by the slowest single path.
// Multipath splits that one client connection across several parallel links —
// one direct to the exit plus one through each relay front — and reassembles it
// at the far side. A single download can then use the combined egress of every
// front instead of just the one it landed on.
//
// Layering
//
//	client <-> entry [multipathSession] === leg 0 direct ========> [multipathSession] exit <-> target
//	                                   \== leg 1 via relay A ===/
//	                                   \== leg 2 via relay B ===/
//
// Relays are unchanged: they already forward secure frames verbatim, so the
// multipath framing is end to end between the entry and the exit and a relay
// never has to understand it.
//
// Wire format, carried inside one existing secure frame on each leg:
//
//	byte 0     kind: 0 = data, 1 = fin
//	byte 1..8  seq, big endian
//	byte 9..   payload (data frames only)
//
// Sequence numbers are per direction and count chunks, not bytes. The receiver
// delivers chunks strictly in sequence order, so the byte stream the target
// sees is identical to the single-path case. A fin frame carries the total
// chunk count in its seq field and is broadcast on every leg, so the receiver
// learns where the stream ends no matter which legs survive.
//
// Scheduling is pull based: every leg has a writer goroutine competing for the
// same queue, so a fast leg naturally claims more chunks than a slow one and no
// static weighting is needed. A leg that fails hands its in-flight chunk back
// to the queue for another leg to carry; the receiver drops duplicates by
// sequence number, so a retry that partially reached the far side is harmless.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"sync"
)

const (
	multipathKindData byte = 0
	multipathKindFin  byte = 1
)

// multipathHeaderSize is the per-chunk overhead: one kind byte plus an 8 byte
// sequence number.
const multipathHeaderSize = 9

// multipathMaxPendingChunks bounds the reorder buffer. Reaching it stops the
// fast legs until the laggard catches up, which keeps a stalled leg from
// growing memory without bound.
const multipathMaxPendingChunks = 1024

// multipathMinLegs is the smallest number of legs that still counts as
// multipath. A single leg is just an ordinary session.
const multipathMinLegs = 2

var (
	errMultipathClosed     = errors.New("multipath session closed")
	errMultipathNoLegs     = errors.New("multipath session has no usable leg")
	errMultipathShortFrame = errors.New("multipath frame too short")
	errMultipathBadKind    = errors.New("multipath frame has unknown kind")
)

// encodeMultipathFrame builds the on-wire representation of one chunk.
func encodeMultipathFrame(kind byte, seq uint64, payload []byte) []byte {
	out := make([]byte, multipathHeaderSize+len(payload))
	out[0] = kind
	binary.BigEndian.PutUint64(out[1:multipathHeaderSize], seq)
	copy(out[multipathHeaderSize:], payload)
	return out
}

type multipathFrame struct {
	kind    byte
	seq     uint64
	payload []byte
}

// decodeMultipathFrame parses one on-wire chunk. The returned payload aliases
// the input, which is safe because callers hand over a freshly decrypted frame.
func decodeMultipathFrame(frame []byte) (multipathFrame, error) {
	if len(frame) < multipathHeaderSize {
		return multipathFrame{}, errMultipathShortFrame
	}
	kind := frame[0]
	if kind != multipathKindData && kind != multipathKindFin {
		return multipathFrame{}, fmt.Errorf("%w: %d", errMultipathBadKind, kind)
	}
	return multipathFrame{
		kind:    kind,
		seq:     binary.BigEndian.Uint64(frame[1:multipathHeaderSize]),
		payload: frame[multipathHeaderSize:],
	}, nil
}

// reorderBuffer turns the out-of-order chunks arriving on several legs back
// into a single in-order stream.
//
// It holds chunks whose sequence number runs ahead of the next one due for
// delivery, drops duplicates a leg retry may produce, and blocks producers once
// the pending set reaches its bound so a stalled leg cannot consume unbounded
// memory.
type reorderBuffer struct {
	mu       sync.Mutex
	ready    *sync.Cond // signalled when a consumer may make progress
	space    *sync.Cond // signalled when a producer may make progress
	pending  map[uint64][]byte
	nextSeq  uint64
	maxItems int

	// finalSeq is the total chunk count, known once a fin frame arrives.
	finalSeq    uint64
	finalKnown  bool
	closed      bool
	closeReason error
}

func newReorderBuffer(maxItems int) *reorderBuffer {
	if maxItems <= 0 {
		maxItems = multipathMaxPendingChunks
	}
	buffer := &reorderBuffer{
		pending:  make(map[uint64][]byte),
		maxItems: maxItems,
	}
	buffer.ready = sync.NewCond(&buffer.mu)
	buffer.space = sync.NewCond(&buffer.mu)
	return buffer
}

// deliverable reports whether a consumer can return right now: the next chunk
// is present, the stream has ended, or the buffer is closed.
func (b *reorderBuffer) deliverable() bool {
	if b.closed {
		return true
	}
	if _, ok := b.pending[b.nextSeq]; ok {
		return true
	}
	return b.finalKnown && b.nextSeq >= b.finalSeq
}

// push stores one received chunk, blocking while the buffer is full.
//
// A chunk whose sequence number was already delivered is dropped, which is what
// makes retrying a chunk on a second leg safe.
func (b *reorderBuffer) push(seq uint64, payload []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	for {
		if b.closed {
			return b.closeErrLocked()
		}
		if seq < b.nextSeq {
			return nil // already delivered
		}
		if _, ok := b.pending[seq]; ok {
			return nil // duplicate still waiting
		}
		// The chunk due next is always accepted, even at the bound, so a full
		// buffer can never deadlock against the very chunk that would drain it.
		if seq == b.nextSeq || len(b.pending) < b.maxItems {
			break
		}
		b.space.Wait()
	}
	stored := make([]byte, len(payload))
	copy(stored, payload)
	b.pending[seq] = stored
	b.ready.Broadcast()
	return nil
}

// setFinal records the total chunk count announced by a fin frame.
func (b *reorderBuffer) setFinal(finalSeq uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.finalKnown && b.finalSeq <= finalSeq {
		return
	}
	b.finalSeq = finalSeq
	b.finalKnown = true
	b.ready.Broadcast()
}

// pop returns the next chunk in sequence order, blocking until it arrives.
//
// It returns an empty, non-nil slice once every chunk up to the announced final
// sequence has been delivered, matching the half-close signal the single-path
// frame readers already use.
func (b *reorderBuffer) pop() ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for !b.deliverable() {
		b.ready.Wait()
	}
	if payload, ok := b.pending[b.nextSeq]; ok {
		delete(b.pending, b.nextSeq)
		b.nextSeq++
		b.space.Broadcast()
		return payload, nil
	}
	if b.finalKnown && b.nextSeq >= b.finalSeq {
		return []byte{}, nil
	}
	return nil, b.closeErrLocked()
}

func (b *reorderBuffer) closeErrLocked() error {
	if b.closeReason != nil {
		return b.closeReason
	}
	return errMultipathClosed
}

// close wakes every blocked producer and consumer with the given reason.
func (b *reorderBuffer) close(reason error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	if reason != nil {
		b.closeReason = reason
	}
	b.ready.Broadcast()
	b.space.Broadcast()
}

func (b *reorderBuffer) pendingCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.pending)
}

// delivered reports how many chunks have been handed to the consumer.
func (b *reorderBuffer) delivered() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.nextSeq
}
