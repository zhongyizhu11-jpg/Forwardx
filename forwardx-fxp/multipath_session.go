package main

// multipathSession presents several parallel legs as one ordered frame stream.
//
// It satisfies the same writeFrame/readFrame contract as a single secureConn,
// so the existing copy loops relay a multipath session without knowing that the
// bytes are spread over more than one link.

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

// frameConn is the frame transport the FXP copy loops relay over. Both a plain
// secureConn and a multipathSession implement it.
type frameConn interface {
	writeFrame(plain []byte) error
	readFrame() ([]byte, error)
	// closeTransport tears down the underlying connections.
	closeTransport()
}

// multipathLegConn is one secure link of a multipath session.
type multipathLegConn struct {
	index int
	sec   *secureConn
	// label identifies the leg in logs, e.g. "direct" or a relay address.
	label string
	// failed guards the alive-leg count: a leg's reader and its writer both
	// notice the same breakage, and only the first may retire the leg.
	failed atomic.Bool

	// writeStartedAt is when this leg's writer entered its current write, in
	// unix nanoseconds, or zero when it is not writing. progressAtWrite is the
	// session's write counter as that write began. Together they let the
	// watchdog tell a leg that has stopped from legs that are all held up by
	// the same backpressure.
	writeStartedAt  atomic.Int64
	progressAtWrite atomic.Uint64
	// deadlineArmed is set when the watchdog has cut a write short. The writer
	// clears it before its next write, because the watchdog can land on a
	// write that was already finishing and a leftover deadline would then fail
	// the following write on a leg that is perfectly healthy.
	deadlineArmed atomic.Bool
}

// clearStaleDeadline undoes a write deadline the watchdog set on a write that
// turned out to be finishing anyway. It costs one atomic load per frame in the
// normal case, where nothing was ever armed.
func (leg *multipathLegConn) clearStaleDeadline() {
	if leg.deadlineArmed.CompareAndSwap(true, false) {
		_ = leg.sec.conn.SetWriteDeadline(time.Time{})
	}
}

// mpChunk is one unit of work handed to whichever leg writer claims it.
type mpChunk struct {
	seq  uint64
	data []byte
}

type multipathSession struct {
	legs    []*multipathLegConn
	reorder *reorderBuffer

	// sendCh carries fresh chunks; retryCh carries chunks a failed leg gave
	// back. Writers drain retryCh first so a retry cannot be starved.
	sendCh  chan mpChunk
	retryCh chan mpChunk

	// controlQueue carries the tiny protocol frames — ready and ack — that
	// must not queue behind bulk data. Writers take them before anything else.
	controlMu    sync.Mutex
	controlQueue [][]byte
	controlReady chan struct{}

	// sendWin holds this side back from running further ahead than the far
	// side can buffer. peerExtended is whether that side has proved it speaks
	// the extended frame kinds, which is what allows sending them at all.
	sendWin      *sendWindow
	peerExtended atomic.Bool
	ackedSeq     atomic.Uint64

	// writeProgress counts frames successfully written on any leg. The
	// watchdog compares it against a leg's own snapshot to tell "this leg has
	// stopped" from "every leg is held up by the same backpressure".
	writeProgress atomic.Uint64

	// legStallTimeout and legStallCheck hold the watchdog's two constants, in
	// nanoseconds. They are fields rather than constants so the tests can reach
	// the edge in milliseconds instead of seconds; production never moves them.
	legStallTimeout atomic.Int64
	legStallCheck   atomic.Int64

	sendSeq uint64

	// aliveLegs drops as legs fail; reaching zero fails the session.
	aliveLegs atomic.Int64

	writerWG sync.WaitGroup
	readerWG sync.WaitGroup
	// inFlight counts chunks queued but not yet written to a leg, so the
	// end-of-stream marker can wait for them without polling.
	inFlight sync.WaitGroup

	closeOnce sync.Once
	closed    chan struct{}
	// finOnce guards the single broadcast of the end-of-stream marker.
	finOnce sync.Once

	errMu    sync.Mutex
	firstErr error

	// bytesPerLeg records how much each leg carried, for logging.
	bytesPerLeg []atomic.Uint64
}

// newMultipathSession starts the writer and reader goroutines for the legs.
//
// The caller keeps ownership of the underlying connections only for closing;
// all reads and writes go through the session from here on.
func newMultipathSession(legs []*multipathLegConn, maxPending int) *multipathSession {
	session := &multipathSession{
		legs:         legs,
		reorder:      newReorderBuffer(maxPending),
		sendCh:       make(chan mpChunk, len(legs)*2),
		retryCh:      make(chan mpChunk, len(legs)+1),
		controlReady: make(chan struct{}, 1),
		sendWin:      newSendWindow(),
		closed:       make(chan struct{}),
		bytesPerLeg:  make([]atomic.Uint64, len(legs)),
	}
	session.legStallTimeout.Store(int64(multipathLegStallTimeout))
	session.legStallCheck.Store(int64(multipathLegStallCheck))
	session.aliveLegs.Store(int64(len(legs)))
	for _, leg := range legs {
		session.writerWG.Add(1)
		go session.legWriter(leg)
		session.readerWG.Add(1)
		go session.legReader(leg)
	}
	session.reorder.onDeliver = session.ackDelivery
	go session.housekeeping()
	return session
}

// legCount reports how many legs the session was built with.
func (s *multipathSession) legCount() int {
	return len(s.legs)
}

// aliveLegCount reports how many legs are still carrying traffic.
func (s *multipathSession) aliveLegCount() int {
	count := s.aliveLegs.Load()
	if count < 0 {
		return 0
	}
	return int(count)
}

// legBytes reports the bytes each leg has carried outbound, for logging the
// realised split.
func (s *multipathSession) legBytes() []uint64 {
	out := make([]uint64, len(s.bytesPerLeg))
	for i := range s.bytesPerLeg {
		out[i] = s.bytesPerLeg[i].Load()
	}
	return out
}

func (s *multipathSession) setErr(err error) {
	if err == nil {
		return
	}
	s.errMu.Lock()
	if s.firstErr == nil {
		s.firstErr = err
	}
	s.errMu.Unlock()
}

func (s *multipathSession) err() error {
	s.errMu.Lock()
	defer s.errMu.Unlock()
	return s.firstErr
}

// legWriter claims chunks and writes them to one leg.
//
// Because every leg writer competes for the same queue, a fast leg claims more
// chunks than a slow one without any configured weighting: the split tracks the
// bandwidth each path actually delivers.
func (s *multipathSession) legWriter(leg *multipathLegConn) {
	defer s.writerWG.Done()
	for {
		work := s.nextWork()
		if work.stop {
			return
		}
		if work.control != nil {
			if err := s.writeLegFrame(leg, work.control); err != nil {
				// 回执/握手帧不重传，所以先还回队列让别的腿带走。
				s.sendControl(work.control)
				s.legFailed(leg, err)
				return
			}
			continue
		}
		chunk := work.chunk
		frame := encodeMultipathFrame(multipathKindData, chunk.seq, chunk.data)
		leg.clearStaleDeadline()
		leg.progressAtWrite.Store(s.writeProgress.Load())
		leg.writeStartedAt.Store(time.Now().UnixNano())
		err := leg.sec.writeFrame(frame)
		leg.writeStartedAt.Store(0)
		if err != nil {
			// Hand the chunk back so another leg carries it. The receiver drops
			// duplicates by sequence number, so a write that partially landed
			// is harmless.
			s.requeue(chunk)
			s.legFailed(leg, err)
			return
		}
		s.writeProgress.Add(1)
		s.bytesPerLeg[leg.index].Add(uint64(len(chunk.data)))
		s.inFlight.Done()
	}
}

// writeLegFrame writes one protocol frame, tracked like a data write so the
// watchdog can see a leg that stops part way through one.
func (s *multipathSession) writeLegFrame(leg *multipathLegConn, frame []byte) error {
	leg.clearStaleDeadline()
	leg.progressAtWrite.Store(s.writeProgress.Load())
	leg.writeStartedAt.Store(time.Now().UnixNano())
	err := leg.sec.writeFrame(frame)
	leg.writeStartedAt.Store(0)
	if err == nil {
		s.writeProgress.Add(1)
	}
	return err
}

// watchStalledLegs retires any leg whose write has stopped moving while the
// other legs carry on. It is one pass; housekeeping calls it on every tick.
//
// 一条腿「还连着但对端不再读」的时候，它的写入者会永远卡在 Write 里，手上那片
// 也就永远交不出去 —— 而接收端要的往往正是那一片。两端都不报错，连接就这么挂着。
//
// 判据是**不对称**：所有腿一起堵着是正常的背压，谁都不该动；只有别的腿还在往前
// 走、就这一条一动不动，才说明它已经废了。掐断那次写，它手上那片就退回队列，
// 由别的腿接着送 —— 整条流不用重来。
func (s *multipathSession) watchStalledLegs() {
	limit := time.Duration(s.legStallTimeout.Load())
	for _, leg := range s.legs {
		startedAt := leg.writeStartedAt.Load()
		if startedAt == 0 || leg.failed.Load() {
			continue
		}
		if time.Since(time.Unix(0, startedAt)) < limit {
			continue
		}
		if s.writeProgress.Load() == leg.progressAtWrite.Load() {
			continue // 大家都没动：这是背压，不是这条腿坏了
		}
		fxpVerbosef("multipath leg %d (%s) stopped draining, retiring it", leg.index, leg.label)
		// 掐断这次写；写入者会拿到超时错误，走正常的退回与下线流程。
		leg.deadlineArmed.Store(true)
		_ = leg.sec.conn.SetWriteDeadline(time.Now())
	}
}

// housekeeping runs the session's two periodic jobs on one timer.
//
// 一个会话对应一条客户端连接，出口上可能同时有成千上万条 —— 每条多开一个协程
// 加一个定时器都是要算的，所以这两件事合在一个节拍里做。
func (s *multipathSession) housekeeping() {
	for {
		tick := time.Duration(s.legStallCheck.Load())
		if ack := multipathAckInterval; ack < tick {
			tick = ack
		}
		timer := time.NewTimer(tick)
		select {
		case <-s.closed:
			timer.Stop()
			return
		case <-timer.C:
		}
		s.watchStalledLegs()
		s.reportProgress()
	}
}

// mpWork is one thing for a leg writer to do: a protocol frame, a data chunk,
// or nothing because the session is over.
type mpWork struct {
	control []byte
	chunk   mpChunk
	stop    bool
}

// nextWork claims the next thing for a leg writer, in priority order: protocol
// frames first because they are tiny and time critical, then chunks handed back
// by a failed leg so the stream cannot stall at that sequence number, then
// fresh chunks.
func (s *multipathSession) nextWork() mpWork {
	for {
		if frame, ok := s.popControl(); ok {
			return mpWork{control: frame}
		}
		select {
		case chunk := <-s.retryCh:
			return mpWork{chunk: chunk}
		default:
		}
		select {
		case <-s.closed:
			return mpWork{stop: true}
		case <-s.controlReady:
			continue // 队列里有东西了，回去取
		case chunk := <-s.retryCh:
			return mpWork{chunk: chunk}
		case chunk := <-s.sendCh:
			return mpWork{chunk: chunk}
		}
	}
}

// sendControl queues a protocol frame for whichever leg writer is free first.
func (s *multipathSession) sendControl(frame []byte) {
	s.controlMu.Lock()
	s.controlQueue = append(s.controlQueue, frame)
	s.controlMu.Unlock()
	select {
	case s.controlReady <- struct{}{}:
	default:
	}
}

func (s *multipathSession) popControl() ([]byte, bool) {
	s.controlMu.Lock()
	defer s.controlMu.Unlock()
	if len(s.controlQueue) == 0 {
		return nil, false
	}
	frame := s.controlQueue[0]
	s.controlQueue[0] = nil
	s.controlQueue = s.controlQueue[1:]
	if len(s.controlQueue) > 0 {
		select {
		case s.controlReady <- struct{}{}:
		default:
		}
	}
	return frame, true
}

// enableExtended is the exit's side of the capability check: the entry said in
// its hello that it understands the extended frame kinds, so this side may use
// them and tells the entry that it may too.
func (s *multipathSession) enableExtended() {
	s.peerExtended.Store(true)
	s.sendControl(encodeMultipathFrame(multipathKindReady, 0, nil))
	// 窗口必须**先**报出去。等到第一次交付再报就晚了：对端还没开始消费的时候
	// 正是它最容易写过头的时候，而那时这边一片都还没交付，也就一声都不会吭。
	s.sendAck()
}

// sendAck reports where this side has got to and how much more it can hold.
func (s *multipathSession) sendAck() {
	delivered := s.reorder.delivered()
	s.ackedSeq.Store(delivered)
	s.sendControl(encodeMultipathAck(delivered, uint64(s.reorder.maxItems)))
}

// ackDelivery is called after every chunk handed to the target.
//
// 攒一点再回，别一片一回：窗口走掉四分之一就报一次，够让发送端一直有活干。
// 另外，缓冲一空就立刻报 —— 那说明这边已经追平了，而发送端很可能正卡在窗口上
// 等这一声。
func (s *multipathSession) ackDelivery(delivered uint64, window int, pending int) {
	if !s.peerExtended.Load() || window <= 0 {
		return
	}
	last := s.ackedSeq.Load()
	if delivered <= last {
		return
	}
	if pending > 0 && delivered-last < uint64(window)/4 {
		return
	}
	if s.ackedSeq.CompareAndSwap(last, delivered) {
		s.sendControl(encodeMultipathAck(delivered, uint64(window)))
	}
}

// reportProgress re-reports what the inline thresholds did not.
//
// 这是给「回执丢了」和「安静下来了」兜底的：回执自己不重传，丢一次就可能让
// 发送端一直卡在窗口上。定时补一声，代价是每秒最多两帧。
func (s *multipathSession) reportProgress() {
	if !s.peerExtended.Load() {
		return
	}
	if s.reorder.delivered() <= s.ackedSeq.Load() {
		return
	}
	s.sendAck()
}

// requeue returns a chunk to the queue for another leg to carry.
func (s *multipathSession) requeue(chunk mpChunk) {
	select {
	case s.retryCh <- chunk:
	case <-s.closed:
	}
}

// legFailed retires one leg, failing the whole session once none are left.
//
// A broken leg surfaces to both its reader and its writer, so the count is only
// adjusted by whichever notices first.
func (s *multipathSession) legFailed(leg *multipathLegConn, err error) {
	_ = leg.sec.conn.Close()
	if !leg.failed.CompareAndSwap(false, true) {
		return
	}
	if s.aliveLegs.Add(-1) > 0 {
		fxpVerbosef("multipath leg %d (%s) lost, %d remaining: %v", leg.index, leg.label, s.aliveLegCount(), err)
		return
	}
	s.setErr(err)
	s.closeWith(err)
}

// legReader feeds everything arriving on one leg into the reorder buffer.
func (s *multipathSession) legReader(leg *multipathLegConn) {
	defer s.readerWG.Done()
	for {
		frame, err := leg.sec.readFrame()
		if err != nil {
			s.legFailed(leg, err)
			return
		}
		decoded, decodeErr := decodeMultipathFrame(frame)
		if decodeErr != nil {
			s.setErr(decodeErr)
			s.closeWith(decodeErr)
			return
		}
		switch decoded.kind {
		case multipathKindFin:
			// Every leg carries the same fin, so the first one to arrive ends
			// the stream and the rest are redundant.
			s.reorder.setFinal(decoded.seq)
			continue
		case multipathKindReady:
			// 对端听得懂扩展帧 —— 从现在起这边也可以发回执了，而且要先把
			// 自己的窗口报过去，对端才知道该压着点写。
			if !s.peerExtended.Swap(true) {
				s.sendAck()
			}
			continue
		case multipathKindAck:
			window, ok := decodeMultipathAckWindow(decoded.payload)
			if !ok {
				continue
			}
			s.sendWin.update(decoded.seq, window)
			continue
		}
		if err := s.reorder.push(decoded.seq, decoded.payload); err != nil {
			if errors.Is(err, errMultipathReorderGap) {
				// 重排缓冲放弃等那一片了。整条会话跟着带原因收掉，上层重连，
				// 而不是让两端各自挂着一条永远拼不完的流。
				s.closeWith(err)
			}
			return
		}
	}
}

// writeFrame queues one outbound chunk, or ends the stream when given no data.
//
// It blocks while every leg is busy, which is how backpressure reaches the
// reader on the other side of the proxy.
func (s *multipathSession) writeFrame(plain []byte) error {
	if len(plain) == 0 {
		return s.writeFin()
	}
	// 先问窗口要位置：对端能缓下多少，这边才写多少。老版本对端从不发回执，
	// 窗口就一直不生效，行为和以前一模一样。
	if err := s.sendWin.reserve(s.sendSeq, s.closed, multipathSendStallTimeout); err != nil {
		s.setErr(err)
		if !errors.Is(err, errMultipathClosed) {
			s.closeWith(err)
		}
		return s.closedErr()
	}
	// The copy loops reuse their read buffer, so the chunk must be copied
	// before it is handed to a leg writer running on another goroutine.
	data := make([]byte, len(plain))
	copy(data, plain)
	chunk := mpChunk{seq: s.sendSeq, data: data}
	s.sendSeq++
	s.inFlight.Add(1)
	select {
	case s.sendCh <- chunk:
		return nil
	case <-s.closed:
		s.inFlight.Done()
		return s.closedErr()
	}
}

// writeFin announces the total chunk count on every leg, so the far side knows
// where the stream ends regardless of which legs survived.
func (s *multipathSession) writeFin() error {
	var err error
	s.finOnce.Do(func() {
		// Let the queued data chunks reach their legs before the marker, or the
		// far side could end the stream early.
		s.drainQueued()
		frame := encodeMultipathFrame(multipathKindFin, s.sendSeq, nil)
		delivered := 0
		for _, leg := range s.legs {
			if writeErr := leg.sec.writeFrame(frame); writeErr != nil {
				continue
			}
			delivered++
		}
		if delivered == 0 {
			err = errors.New("multipath fin could not be delivered on any leg")
			s.setErr(err)
		}
	})
	return err
}

// drainQueued blocks until every queued chunk has reached a leg, or the session
// is torn down. Without it a session closed right after end of stream could
// strand chunks that were still waiting for a writer.
func (s *multipathSession) drainQueued() {
	done := make(chan struct{})
	go func() {
		s.inFlight.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-s.closed:
	}
}

// readFrame returns the next chunk in sequence order across all legs. It
// returns an empty, non-nil slice at end of stream, matching secureConn.
func (s *multipathSession) readFrame() ([]byte, error) {
	return s.reorder.pop()
}

func (s *multipathSession) closedErr() error {
	if err := s.err(); err != nil {
		return err
	}
	return errMultipathClosed
}

// closeWith tears the session down once, waking everything blocked on it.
func (s *multipathSession) closeWith(reason error) {
	s.closeOnce.Do(func() {
		s.setErr(reason)
		close(s.closed)
		s.sendWin.close()
		s.reorder.close(reason)
		for _, leg := range s.legs {
			_ = leg.sec.conn.Close()
		}
		// 收场时把实际跑出来的分流记一笔。overdrafts 非零说明各条腿的到达
		// 顺序比重排上限能容下的还散 —— 这是调 multipathMaxPending 唯一的
		// 现场依据，不记下来就只能靠猜。
		fxpVerbosef(
			"multipath session closed: legs=%d/%d bytes=%v overdrafts=%d reason=%v",
			s.aliveLegCount(), s.legCount(), s.legBytes(), s.reorder.overdraftCount(), reason,
		)
	})
}

// closeTransport satisfies frameConn.
func (s *multipathSession) closeTransport() {
	s.closeWith(nil)
}

// closeTransport lets a plain secure connection stand in for a multipath one.
func (c *secureConn) closeTransport() {
	_ = c.conn.Close()
}

// multipathLegsFromSecureConns builds legs from already handshaked connections.
func multipathLegsFromSecureConns(conns []*secureConn, labels []string) []*multipathLegConn {
	legs := make([]*multipathLegConn, 0, len(conns))
	for i, sec := range conns {
		label := ""
		if i < len(labels) {
			label = labels[i]
		}
		legs = append(legs, &multipathLegConn{index: i, sec: sec, label: label})
	}
	return legs
}
