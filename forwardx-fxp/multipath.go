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
	"time"
)

const (
	multipathKindData byte = 0
	multipathKindFin  byte = 1
	// multipathKindReady is the exit telling the entry that it understands the
	// frame kinds below; multipathKindAck carries flow control. Neither is ever
	// sent to a peer that has not proved it understands them, because a peer
	// that does not treats an unknown kind as a protocol error and drops the
	// session. See multipath_flow.go.
	multipathKindReady byte = 2
	multipathKindAck   byte = 3
)

// multipathKnownKind reports whether a received frame kind can be parsed.
func multipathKnownKind(kind byte) bool {
	switch kind {
	case multipathKindData, multipathKindFin, multipathKindReady, multipathKindAck:
		return true
	}
	return false
}

// multipathHeaderSize is the per-chunk overhead: one kind byte plus an 8 byte
// sequence number.
const multipathHeaderSize = 9

// multipathMaxPendingChunks bounds the reorder buffer. Reaching it stops the
// fast legs until the laggard catches up, which keeps a stalled leg from
// growing memory without bound.
const multipathMaxPendingChunks = 1024

// multipathMinPendingChunks floors a panel-supplied reorder bound.
//
// A tiny bound no longer wedges the stream, but it does make the receiver
// overdraw on nearly every chunk, which costs more than the memory the bound
// was meant to save.
const multipathMinPendingChunks = 64

// multipathReorderStallGrace is how long a full buffer waits for the chunk due
// next before taking one more chunk than its bound.
//
// It separates the two reasons a leg can be missing that chunk. A leg that is
// merely slow delivers well inside the grace, and holding the fast legs back
// meanwhile is the whole point of the bound. A leg that is not going to deliver
// at all never comes back, and waiting on it forever is what hangs the session,
// so past the grace the receiver takes a chunk instead of waiting again. Half a
// second is long enough that ordinary jitter never reaches it and short enough
// that a wedged stream is not noticeably stalled.
const multipathReorderStallGrace = 500 * time.Millisecond

// multipathReorderOverdraftChunks caps how far past its bound the reorder
// buffer may grow while the chunk due next is missing.
//
// It has to cover the chunks the legs can legitimately be carrying ahead of
// that one — the send queue, the retry queue, one chunk per leg writer and
// whatever the kernel socket buffers hold. Past it the buffer waits again: that
// can wedge the stream, which is what multipathReorderGapTimeout is for.
const multipathReorderOverdraftChunks = 256

// multipathReorderGapTimeout is how long the chunk due next may stay missing,
// with the buffer full, before the session is given up on.
//
// This is the only unconditional way out, so it has to be long enough that no
// working leg ever reaches it: by the time a leg has delivered nothing for this
// long while the others filled the whole reorder buffer past its bound, it is
// not slow, it is a black hole, and the stream can never be reassembled. The
// connection resetting is then the right answer — the caller reconnects, which
// is exactly what it would do for any other broken tunnel, and far better than
// both ends hanging with no error.
const multipathReorderGapTimeout = 15 * time.Second

// multipathLegStallTimeout is how long one leg's write may sit still, while
// other legs keep completing writes, before that leg is retired.
//
// The comparison against the other legs is what makes this safe: every leg
// blocking together is ordinary backpressure and nothing is retired. Only a leg
// that has stopped on its own is, and a leg that has moved nothing in this long
// while its siblings drained is contributing no bandwidth anyway.
const multipathLegStallTimeout = 10 * time.Second

// multipathLegStallCheck is how often the watchdog looks.
const multipathLegStallCheck = 2 * time.Second

// multipathAckInterval is how often progress that the inline thresholds did not
// report is reported anyway, so a lost acknowledgement cannot strand the sender.
const multipathAckInterval = 500 * time.Millisecond

// multipathMinLegs is the smallest number of legs that still counts as
// multipath. A single leg is just an ordinary session.
const multipathMinLegs = 2

var (
	errMultipathClosed     = errors.New("multipath session closed")
	errMultipathNoLegs     = errors.New("multipath session has no usable leg")
	errMultipathShortFrame = errors.New("multipath frame too short")
	errMultipathBadKind    = errors.New("multipath frame has unknown kind")
	errMultipathReorderGap = errors.New("multipath leg stopped delivering and the stream cannot be reassembled")
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
	if !multipathKnownKind(kind) {
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

	// overdrafts counts the chunks taken past the bound because the chunk due
	// next had not arrived. Diagnostic only: a non-zero count means the legs
	// are delivering further out of order than the bound allows for, not that
	// anything went wrong.
	overdrafts uint64

	// waiting is how many producers are parked for room, and stallWaker
	// whether the goroutine that periodically wakes them is running. sync.Cond
	// has no timed wait, so that goroutine is the timer behind stallGrace.
	waiting    int
	stallWaker bool

	// stallSince is when the hole at nextSeq opened, and stallSeq which chunk
	// it is waiting for. The clock belongs to the buffer, not to one caller:
	// producers and the consumer are stuck on the same hole, and it restarts
	// the moment nextSeq changes.
	stallSince time.Time
	stallSeq   uint64

	// waitingConsumer is whether a consumer is parked in pop. The waker has to
	// know, because a hole can starve the consumer with no producer parked at
	// all — that is what happens once the legs have nothing left to deliver.
	waitingConsumer int

	// onDeliver, when set, is told after each chunk reaches the consumer: which
	// chunk is due next, how many this buffer holds in total, and how many are
	// waiting. It is called with the lock released, and it is how the session
	// turns delivery into the acknowledgements that pace the far side.
	onDeliver func(deliveredSeq uint64, window int, pending int)

	// stallGrace, overdraftLimit and gapTimeout hold the three tuning
	// constants above. They are fields rather than constants so the tests can
	// reach the edges in milliseconds instead of minutes; production never
	// moves them.
	stallGrace     time.Duration
	overdraftLimit int
	gapTimeout     time.Duration

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
		pending:        make(map[uint64][]byte),
		maxItems:       maxItems,
		stallGrace:     multipathReorderStallGrace,
		overdraftLimit: multipathReorderOverdraftChunks,
		gapTimeout:     multipathReorderGapTimeout,
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
//
// Waiting here is bounded on purpose. Each leg has one reader, and a reader
// parked in this function has stopped draining its own link, so a producer that
// waits forever can be the reason the stream never moves again: the chunk the
// consumer needs is on some leg, and that leg may be one of the parked ones —
// or the far side's writer for it may be blocked on a link nobody is reading.
// Neither end sees an error; the connection simply hangs.
//
// So a full buffer is handled by how long the chunk due next has been missing:
//
//	present            wait — the consumer is the bottleneck, which is
//	                   precisely what the bound is for
//	missing < grace    wait — that leg may just be slow, and making the fast
//	                   legs wait for it is also what the bound is for
//	missing > grace    take one chunk past the bound, so the reader can drain
//	                   another frame off its link and unjam whatever is behind
//	                   it; capped at overdraftLimit, past which it waits again
//	missing > timeout  give up — that leg is not coming back and the stream can
//	                   never be reassembled, so reset instead of hanging
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
		stalled := b.holeAgeLocked()
		if stalled == 0 {
			// 消费者手上就有下一片，它是在慢，不是在等。这时候挡住快腿正是
			// 缓冲上限存在的理由：等它取走一片，这里自然有位置。
			b.parkLocked()
			continue
		}
		if stalled >= b.gapTimeout {
			return b.giveUpOnHoleLocked(stalled)
		}
		// 还没超时就先等一等：那条腿可能只是慢，让快腿等它正是上限的意义。
		// 等过了宽限还不动，继续挂着就只会让这条还健康的链路一起停摆 ——
		// 而下一片很可能正排在它后面，所以宁可超一点收下。超额也有上限，
		// 到顶了就回去等，由上面的超时兜底。
		if stalled < b.stallGrace || len(b.pending) >= b.maxItems+b.overdraftLimit {
			b.parkLocked()
			continue
		}
		b.overdrafts++
		break
	}
	stored := make([]byte, len(payload))
	copy(stored, payload)
	b.pending[seq] = stored
	b.ready.Broadcast()
	return nil
}

// holeAgeLocked reports how long the chunk due next has been missing while
// later chunks were already in hand, starting that clock the first time.
//
// Zero means there is no hole to worry about: the chunk is here, or the stream
// has ended, or nothing at all has run ahead of it — an idle stream waiting for
// its next chunk looks exactly like that, and must never be mistaken for one
// that can no longer move.
func (b *reorderBuffer) holeAgeLocked() time.Duration {
	_, haveNext := b.pending[b.nextSeq]
	ended := b.finalKnown && b.nextSeq >= b.finalSeq
	if haveNext || ended || len(b.pending) == 0 {
		b.stallSince = time.Time{}
		return 0
	}
	if b.stallSince.IsZero() || b.stallSeq != b.nextSeq {
		b.stallSince, b.stallSeq = time.Now(), b.nextSeq
	}
	// 洞刚开的那一瞬也得算「有洞」，否则调用方会把它当成没洞。
	if age := time.Since(b.stallSince); age > 0 {
		return age
	}
	return time.Nanosecond
}

// giveUpOnHoleLocked closes the buffer because the chunk due next is never
// coming. Callers return what it returns.
func (b *reorderBuffer) giveUpOnHoleLocked(stalled time.Duration) error {
	// 欠那一片的腿不是慢，是没了。这条流再也拼不回来了，收掉连接让上层重连，
	// 比两端一起干挂着强。
	b.closeLocked(fmt.Errorf("%w: waiting for seq %d for %s, %d chunks held",
		errMultipathReorderGap, b.nextSeq, stalled.Round(time.Second), len(b.pending)))
	return b.closeErrLocked()
}

// parkLocked waits for room, making sure something will come back to wake it
// even if no consumer and no other leg ever does.
func (b *reorderBuffer) parkLocked() {
	b.waiting++
	b.startStallWakerLocked()
	b.space.Wait()
	b.waiting--
}

// startStallWakerLocked runs the timer behind stallGrace.
//
// sync.Cond only wakes on a Broadcast, so without this a producer waiting for a
// chunk that is never coming would never get the chance to notice. One
// goroutine serves every parked producer and retires as soon as none are left.
func (b *reorderBuffer) startStallWakerLocked() {
	if b.stallWaker || b.closed {
		return
	}
	b.stallWaker = true
	grace := b.stallGrace
	go func() {
		for {
			time.Sleep(grace)
			b.mu.Lock()
			// 生产者挂着，或者消费者正卡在一个洞上，都还需要有人来叫醒。
			// 两样都没有就退场 —— 空闲的流不该养着一个永远在转的协程。
			stuck := b.waiting > 0 || (b.waitingConsumer > 0 && b.holeAgeLocked() > 0)
			if b.closed || !stuck {
				b.stallWaker = false
				b.mu.Unlock()
				return
			}
			grace = b.stallGrace
			b.space.Broadcast()
			b.ready.Broadcast()
			b.mu.Unlock()
		}
	}()
}

// overdraftCount reports how many chunks were taken past the bound to keep the
// stream moving.
func (b *reorderBuffer) overdraftCount() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.overdrafts
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
	// 交付回调必须在放锁之后才跑 —— 它会去发回执，那条路要再绕回缓冲。
	// defer 是后进先出，所以这一条要抢在解锁那条前面注册。
	var notify func()
	defer func() {
		if notify != nil {
			notify()
		}
	}()
	b.mu.Lock()
	defer b.mu.Unlock()
	for !b.deliverable() {
		// 后面的分片都到了、就差这一片，而且差了太久 —— 等下去没有意义了。
		// 这一段必须在这里也有一份：腿上没东西可推时，push 根本不会再被调用，
		// 光靠那边兜底的话，消费者会一直干等。
		if stalled := b.holeAgeLocked(); stalled >= b.gapTimeout {
			return nil, b.giveUpOnHoleLocked(stalled)
		} else if stalled > 0 {
			b.startStallWakerLocked()
		}
		b.waitingConsumer++
		b.ready.Wait()
		b.waitingConsumer--
	}
	if payload, ok := b.pending[b.nextSeq]; ok {
		delete(b.pending, b.nextSeq)
		b.nextSeq++
		b.space.Broadcast()
		if b.onDeliver != nil {
			delivered, window, pending := b.nextSeq, b.maxItems, len(b.pending)
			notify = func() { b.onDeliver(delivered, window, pending) }
		}
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
	b.closeLocked(reason)
}

func (b *reorderBuffer) closeLocked(reason error) {
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
