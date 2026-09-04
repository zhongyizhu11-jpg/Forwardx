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
		legs:        legs,
		reorder:     newReorderBuffer(maxPending),
		sendCh:      make(chan mpChunk, len(legs)*2),
		retryCh:     make(chan mpChunk, len(legs)+1),
		closed:      make(chan struct{}),
		bytesPerLeg: make([]atomic.Uint64, len(legs)),
	}
	session.aliveLegs.Store(int64(len(legs)))
	for _, leg := range legs {
		session.writerWG.Add(1)
		go session.legWriter(leg)
		session.readerWG.Add(1)
		go session.legReader(leg)
	}
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
		chunk, ok := s.nextChunk()
		if !ok {
			return
		}
		frame := encodeMultipathFrame(multipathKindData, chunk.seq, chunk.data)
		if err := leg.sec.writeFrame(frame); err != nil {
			// Hand the chunk back so another leg carries it. The receiver drops
			// duplicates by sequence number, so a write that partially landed
			// is harmless.
			s.requeue(chunk)
			s.legFailed(leg, err)
			return
		}
		s.bytesPerLeg[leg.index].Add(uint64(len(chunk.data)))
		s.inFlight.Done()
	}
}

// nextChunk claims the next chunk for a leg writer, preferring a chunk handed
// back by a failed leg so the stream cannot stall at that sequence number.
func (s *multipathSession) nextChunk() (mpChunk, bool) {
	select {
	case chunk := <-s.retryCh:
		return chunk, true
	case <-s.closed:
		return mpChunk{}, false
	default:
	}
	select {
	case chunk := <-s.retryCh:
		return chunk, true
	case chunk := <-s.sendCh:
		return chunk, true
	case <-s.closed:
		return mpChunk{}, false
	}
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
		if decoded.kind == multipathKindFin {
			// Every leg carries the same fin, so the first one to arrive ends
			// the stream and the rest are redundant.
			s.reorder.setFinal(decoded.seq)
			continue
		}
		if err := s.reorder.push(decoded.seq, decoded.payload); err != nil {
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
		s.reorder.close(reason)
		for _, leg := range s.legs {
			_ = leg.sec.conn.Close()
		}
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
