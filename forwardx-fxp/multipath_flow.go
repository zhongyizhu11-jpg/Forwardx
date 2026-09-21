package main

// Flow control for multipath sessions.
//
// 没有流控的时候，发送端想写多快就写多快，多出来的全堆在内核的收发队列里。
// 实测：接收端一停止消费，发送端还能再塞进去三千多片、十几兆 —— 这些数据
// 一旦那条腿断掉就全没了，而且重排缓冲被顶满之后，各条腿的读取者一挂，
// 整条流就再也动不了。
//
// 所以这里给发送端加一把尺子：**最多只能比对端已经交付出去的位置领先一个窗口**。
// 窗口就是对端重排缓冲的容量，由对端在 ack 帧里报上来。这样一来：
//
//   · 重排缓冲永远填不满 —— 所有在途分片都落在 [已交付, 已交付+窗口) 里，
//     而「下一个该交付的」本身也在其中，于是它永远进得去、永远排得空。
//     卡死从结构上就不成立了。
//   · 内核队列里积压的东西有了上限，一条腿断掉时真正有风险的那一段，
//     正好被每条腿自己留的那份备份盖住。
//
// 兼容性：入口在 hello 里声明自己听得懂扩展帧（老出口会直接忽略这个 JSON 字段），
// 出口看到之后回一帧 ready（老出口不会回）。两边都只在**确认对端听得懂**之后
// 才发新类型的帧；谁是老版本，行为就和今天完全一样，由重排缓冲那层兜底。

import (
	"encoding/binary"
	"errors"
	"fmt"
	"sync"
	"time"
)

// multipathAckPayloadSize is the advertised window that rides along with an
// acknowledgement, in chunks.
const multipathAckPayloadSize = 8

// multipathSendStallTimeout bounds how long the sender may sit at a closed
// window with nothing coming back.
//
// Reaching it means the far side has neither delivered a chunk nor said
// anything for that long, which no working session does: acknowledgements are
// sent as soon as the receiver catches up, so silence this long is a broken
// path, not a slow one.
const multipathSendStallTimeout = 30 * time.Second

var errMultipathSendStalled = errors.New("multipath send window never reopened")

// encodeMultipathAck builds an acknowledgement: everything below deliveredSeq
// has reached the far side's target, and it can take window more chunks beyond
// it.
func encodeMultipathAck(deliveredSeq uint64, window uint64) []byte {
	payload := make([]byte, multipathAckPayloadSize)
	binary.BigEndian.PutUint64(payload, window)
	return encodeMultipathFrame(multipathKindAck, deliveredSeq, payload)
}

// decodeMultipathAckWindow reads the window out of an acknowledgement payload.
func decodeMultipathAckWindow(payload []byte) (uint64, bool) {
	if len(payload) < multipathAckPayloadSize {
		return 0, false
	}
	return binary.BigEndian.Uint64(payload[:multipathAckPayloadSize]), true
}

// sendWindow keeps the sender from running further ahead of the far side than
// that side can hold.
//
// It stays dormant until the first acknowledgement arrives, so a session with
// an older peer — which will never send one — behaves exactly as it did before.
type sendWindow struct {
	mu     sync.Mutex
	active bool
	// deliveredSeq is the far side's next undelivered chunk; window is how many
	// chunks past it that side can hold.
	deliveredSeq uint64
	window       uint64
	closed       bool
	// updated is closed and replaced on every change, so waiters can select on
	// it alongside a timer.
	updated chan struct{}
}

func newSendWindow() *sendWindow {
	return &sendWindow{updated: make(chan struct{})}
}

// update records what the far side just reported. Going backwards is ignored:
// acknowledgements can arrive out of order across legs.
func (w *sendWindow) update(deliveredSeq uint64, window uint64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.active && deliveredSeq <= w.deliveredSeq && window <= w.window {
		return
	}
	if deliveredSeq > w.deliveredSeq {
		w.deliveredSeq = deliveredSeq
	}
	if window > w.window {
		w.window = window
	}
	w.active = true
	w.wakeLocked()
}

func (w *sendWindow) close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	w.wakeLocked()
}

func (w *sendWindow) wakeLocked() {
	close(w.updated)
	w.updated = make(chan struct{})
}

// limit reports the first sequence number the sender may not use yet, whether
// the limit is in force at all, and a channel that closes when either changes.
func (w *sendWindow) limit() (uint64, bool, bool, chan struct{}) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.deliveredSeq + w.window, w.active, w.closed, w.updated
}

// reserve blocks until seq is inside the window.
//
// 窗口一动就重新计时：对端只要还在交付，就说明它活着，等多久都是正常的背压。
// 真正该报错的是**一直没有任何回音**。
func (w *sendWindow) reserve(seq uint64, done <-chan struct{}, timeout time.Duration) error {
	var lastLimit uint64
	var since time.Time
	for {
		limit, active, closed, updated := w.limit()
		if closed {
			return errMultipathClosed
		}
		if !active || seq < limit {
			return nil
		}
		if since.IsZero() || limit != lastLimit {
			since, lastLimit = time.Now(), limit
		}
		remaining := timeout - time.Since(since)
		if remaining <= 0 {
			return fmt.Errorf("%w: seq %d stuck at %d for %s", errMultipathSendStalled, seq, limit, timeout)
		}
		timer := time.NewTimer(remaining)
		select {
		case <-updated:
		case <-done:
			timer.Stop()
			return errMultipathClosed
		case <-timer.C:
		}
		timer.Stop()
	}
}
