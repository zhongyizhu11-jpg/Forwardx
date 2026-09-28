package main

// Acknowledgements, flow control and retransmission for multipath sessions.
//
// 没有回执的时候，发送端写出去就忘了：一片分片一旦进了某条腿的内核发送队列，
// 那条腿再断掉，这一片就跟着没了 —— 接收端只能干等那个洞，15 秒后整条连接重置。
// 实测一条腿被 RST 能带走内核队列里十几兆还没送到的数据。
//
// 所以现在每一片都在发送端的**重传缓冲**里留一份，直到对端回执说「收到了」：
//
//   · 接收端定期回一帧 ack：交付到哪了（流控用）、连续收到哪了（可以忘掉哪些）、
//     结束标记收到没有、以及**每条腿**各自收到了多少字节。
//   · 一条腿断掉或者被判定卡死，它名下所有还没确认送到的分片立刻交给别的腿重发；
//     接收端按序号去重，同一片到两次也无妨。
//   · 发送端最多只能比对端已经交付出去的位置领先一个窗口（对端重排缓冲的容量），
//     重传缓冲也就被这个窗口封住了上限，内存有界。
//
// 回执的节奏：收到的字节每满 multipathAckEveryBytes、或者交付走了窗口的八分之一，
// 立刻回；否则最多攒 multipathAckDelay 再回。数据还在流的时候每
// multipathAckRefresh 再补一声 —— 回执本身不重传，丢了靠这一声补上。
//
// 每条腿各自的字节数是调度的依据（multipath_sched.go）：发送端据此知道每条腿上
// 压着多少还没送到，也据此测每条腿的往返时间和吞吐。
//
// Ack payload, after the usual kind + seq header (seq = next chunk due for
// delivery at the receiver):
//
//	byte 0..7    window, in chunks
//	byte 8..15   first chunk not yet received
//	byte 16      flags: bit 0 = the stream end has been received
//	byte 17      leg count n
//	then n times: byte leg id, 8 bytes received on that leg

import (
	"encoding/binary"
	"errors"
	"fmt"
	"time"
)

// multipathAckFixedSize is the part of an ack payload before the leg list.
const multipathAckFixedSize = 18

// multipathAckLegSize is one leg's entry in an ack.
const multipathAckLegSize = 9

// multipathAckFlagFin marks an ack sent after the stream end arrived.
const multipathAckFlagFin byte = 1

// multipathAckDelay is the longest a receiver sits on progress before it
// reports it. Short enough that the round trips the scheduler measures stay
// close to the real path latency, long enough to fold a burst into one ack.
const multipathAckDelay = 10 * time.Millisecond

// multipathAckEveryBytes reports receive progress immediately once this much
// has arrived since the last ack, so a fast stream is not paced by the delay.
const multipathAckEveryBytes = 64 * 1024

// multipathAckRefresh re-reports progress while data is flowing. Acks are not
// retransmitted, so one lost with its leg would otherwise leave the sender
// waiting on a window that has long since reopened.
const multipathAckRefresh = 250 * time.Millisecond

// multipathAckHot is how long after the last received chunk a session counts
// as flowing, for multipathAckRefresh.
const multipathAckHot = 2 * time.Second

// multipathAckKeepalive re-reports progress, even with nothing new, while the
// receiver holds chunks its consumer has not taken. A consumer that stops
// reading closes the window with nothing moving, and this is what tells the
// sender that the far side is alive and just full.
const multipathAckKeepalive = 5 * time.Second

// multipathInitialWindow is how far ahead the sender may run before the far
// side has reported its real window. The floor of any window a receiver uses,
// so it can never overrun one.
const multipathInitialWindow = multipathMinPendingChunks

// multipathMaxPeerWindow caps the window a far side may advertise. The window
// is also the bound on this side's retransmit buffer, so it is what keeps that
// buffer's memory finite whatever the far side is configured with.
const multipathMaxPeerWindow = 16384

// multipathSendStallTimeout bounds how long the sender may wait — on a closed
// window, or for the far side to confirm the end of the stream — with nothing
// at all coming back.
//
// Reaching it means the far side has not acknowledged anything for that long,
// which no working session does: a receiver that is merely full says so every
// multipathAckKeepalive, so silence this long is a broken path, not a slow one.
const multipathSendStallTimeout = 30 * time.Second

var errMultipathSendStalled = errors.New("multipath far side stopped acknowledging")

// multipathAck is one decoded acknowledgement.
type multipathAck struct {
	// delivered is the far side's next undelivered chunk; window is how many
	// chunks past it that side can hold.
	delivered uint64
	window    uint64
	// received is the first chunk the far side has not received yet.
	received uint64
	finSeen  bool
	legs     []multipathLegAck
}

// multipathLegAck is how many data bytes the far side has read off one leg.
type multipathLegAck struct {
	id    int
	bytes uint64
}

// encodeMultipathAck builds an acknowledgement frame.
func encodeMultipathAck(ack multipathAck) []byte {
	payload := make([]byte, multipathAckFixedSize, multipathAckFixedSize+len(ack.legs)*multipathAckLegSize)
	binary.BigEndian.PutUint64(payload[0:8], ack.window)
	binary.BigEndian.PutUint64(payload[8:16], ack.received)
	if ack.finSeen {
		payload[16] |= multipathAckFlagFin
	}
	count := 0
	for _, leg := range ack.legs {
		if leg.id < 0 || leg.id > 255 || count == 255 {
			continue
		}
		var entry [multipathAckLegSize]byte
		entry[0] = byte(leg.id)
		binary.BigEndian.PutUint64(entry[1:], leg.bytes)
		payload = append(payload, entry[:]...)
		count++
	}
	payload[17] = byte(count)
	return encodeMultipathFrame(multipathKindAck, ack.delivered, payload)
}

// decodeMultipathAck parses an acknowledgement whose header carried seq.
func decodeMultipathAck(seq uint64, payload []byte) (multipathAck, error) {
	if len(payload) < multipathAckFixedSize {
		return multipathAck{}, fmt.Errorf("%w: ack payload %d bytes", errMultipathShortFrame, len(payload))
	}
	count := int(payload[17])
	if len(payload) < multipathAckFixedSize+count*multipathAckLegSize {
		return multipathAck{}, fmt.Errorf("%w: ack lists %d legs in %d bytes", errMultipathShortFrame, count, len(payload))
	}
	ack := multipathAck{
		delivered: seq,
		window:    binary.BigEndian.Uint64(payload[0:8]),
		received:  binary.BigEndian.Uint64(payload[8:16]),
		finSeen:   payload[16]&multipathAckFlagFin != 0,
		legs:      make([]multipathLegAck, 0, count),
	}
	for i := 0; i < count; i++ {
		entry := payload[multipathAckFixedSize+i*multipathAckLegSize:]
		ack.legs = append(ack.legs, multipathLegAck{
			id:    int(entry[0]),
			bytes: binary.BigEndian.Uint64(entry[1:multipathAckLegSize]),
		})
	}
	return ack, nil
}

// ---- receiver side: deciding when to acknowledge ----

// requestAck asks for an acknowledgement now, or within multipathAckDelay.
func (s *multipathSession) requestAck(urgent bool) {
	if urgent {
		s.queueAck()
		return
	}
	if s.ackTimerArmed.CompareAndSwap(false, true) {
		time.AfterFunc(multipathAckDelay, func() {
			s.ackTimerArmed.Store(false)
			s.queueAck()
		})
	}
}

// queueAck hands the next free leg writer an acknowledgement to send. The
// frame itself is built when a writer takes it, so it always carries the
// latest state and any number of requests collapse into one frame.
func (s *multipathSession) queueAck() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closedLocked() {
		return
	}
	s.ackWanted = true
	s.signalLocked()
}

// noteReceived is called after every data frame read off a leg.
func (s *multipathSession) noteReceived(total uint64) {
	s.lastRecvAt.Store(time.Now().UnixNano())
	s.requestAck(total-s.ackedRecvTotal.Load() >= multipathAckEveryBytes)
}

// ackDelivery is called after every chunk handed to the consumer.
//
// 交付走了窗口的八分之一就立刻报：发送端可能正卡在窗口上等这一声。
// 零零碎碎的交付攒一小会儿再报，免得一片一回。
func (s *multipathSession) ackDelivery(delivered uint64, window int, pending int) {
	step := uint64(window / 8)
	if step == 0 {
		step = 1
	}
	s.requestAck(delivered-s.ackedDelivered.Load() >= step)
}

// buildAck snapshots what this side has received and delivered. It runs on a
// leg writer, outside the session lock.
func (s *multipathSession) buildAck() []byte {
	total := s.recvTotal.Load()
	delivered, received, finSeen := s.reorder.ackState()
	legs := s.legSnapshot()
	ack := multipathAck{
		delivered: delivered,
		window:    uint64(s.reorder.maxItems),
		received:  received,
		finSeen:   finSeen,
		legs:      make([]multipathLegAck, 0, len(legs)),
	}
	for _, leg := range legs {
		ack.legs = append(ack.legs, multipathLegAck{id: leg.index, bytes: leg.recvBytes.Load()})
	}
	s.ackedRecvTotal.Store(total)
	s.ackedDelivered.Store(delivered)
	s.lastAckSentAt.Store(time.Now().UnixNano())
	return encodeMultipathAck(ack)
}

// refreshAcks is the housekeeping side of acknowledging: it covers acks lost
// with a leg, and a receiver that is full rather than gone.
func (s *multipathSession) refreshAcks(now time.Time) {
	sinceAck := now.Sub(time.Unix(0, s.lastAckSentAt.Load()))
	hot := now.Sub(time.Unix(0, s.lastRecvAt.Load())) < multipathAckHot
	if hot && sinceAck >= multipathAckRefresh {
		s.queueAck()
		return
	}
	if sinceAck >= multipathAckKeepalive && s.reorder.pendingCount() > 0 {
		s.queueAck()
	}
}

// ---- sender side: acting on what came back ----

// onAck applies one acknowledgement from the far side.
func (s *multipathSession) onAck(ack multipathAck) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastAckAt = now
	if ack.delivered > s.peerDelivered {
		s.peerDelivered = ack.delivered
	}
	if ack.window > 0 {
		s.peerWindow = ack.window
		if s.peerWindow > multipathMaxPeerWindow {
			s.peerWindow = multipathMaxPeerWindow
		}
	}
	if ack.received > s.outBase {
		s.trimLocked(ack.received)
	}
	for _, legAck := range ack.legs {
		leg := s.legByIDLocked(legAck.id)
		if leg == nil {
			continue
		}
		if leg.pace.onAcked(legAck.bytes, now) {
			s.lastLegProgressAt = now
		}
	}
	if s.finQueued && ack.finSeen && ack.received >= s.finSeq {
		s.finAcked = true
	}
	s.signalLocked()
}

// trimLocked forgets every chunk below upTo: the far side has it.
func (s *multipathSession) trimLocked(upTo uint64) {
	if upTo > s.sendSeq {
		upTo = s.sendSeq
	}
	if upTo <= s.outBase {
		return
	}
	count := int(upTo - s.outBase)
	for i := 0; i < count; i++ {
		s.out[i] = nil
	}
	s.out = s.out[count:]
	s.outBase = upTo
	if s.nextFresh < s.outBase {
		s.nextFresh = s.outBase
	}
}

// lockWhen blocks until ready reports true under the session lock and returns
// with the lock still held, so the caller acts on exactly the state it waited
// for. It fails, without the lock, once the session closes or the far side has
// been silent for the stall timeout.
//
// 对端只要还在回执、或者这边还在往外写，就说明链路活着，等多久都是正常的
// 背压。真正该报错的是**一直没有任何回音**。
func (s *multipathSession) lockWhen(ready func() bool) error {
	s.mu.Lock()
	for {
		if s.closedLocked() {
			s.mu.Unlock()
			return errMultipathClosed
		}
		if ready() {
			return nil
		}
		last := s.lastAckAt
		if s.lastProgressAt.After(last) {
			last = s.lastProgressAt
		}
		stall := time.Duration(s.sendStallTimeout.Load())
		remaining := stall - time.Since(last)
		if remaining <= 0 {
			s.mu.Unlock()
			return fmt.Errorf("%w: nothing back for %s (acked %d, sent %d)", errMultipathSendStalled, stall, s.outBase, s.sendSeq)
		}
		changed := s.changed
		s.mu.Unlock()
		timer := time.NewTimer(remaining)
		select {
		case <-changed:
		case <-s.closed:
		case <-timer.C:
		}
		timer.Stop()
		s.mu.Lock()
	}
}
