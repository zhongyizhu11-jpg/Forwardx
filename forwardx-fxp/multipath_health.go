package main

// Per-leg health memory for multipath entries.
//
// 一条中转挂了，每条新连接都照样去拨它：拨不通要等满拨号超时，拨通了又可能
// 在几秒后被判卡死、摘掉、重发。会话启动虽然已经不等它了，但这些后台拨号和
// 重发都是白花的。
//
// 所以进程里记一笔：最近坏过的腿，新会话先跳过一段时间，5 秒起、每坏一次翻倍、
// 封顶 60 秒。到期之后放**一个**会话去试（其余的继续跳过），试通了就重新开放；
// 这条腿在一个会话里一直好好地用到会话结束，才把坏的次数清零。
//
// 所有腿都在冷却里的时候照样全拨 —— 这份记忆只是省事，绝不能变成连不上的理由。

import (
	"sync"
	"time"
)

const (
	multipathLegBackoffBase = 5 * time.Second
	multipathLegBackoffMax  = 60 * time.Second
)

// multipathLegHealth remembers which leg endpoints failed recently.
type multipathLegHealth struct {
	mu      sync.Mutex
	entries map[string]*multipathLegHealthEntry
	now     func() time.Time
}

type multipathLegHealthEntry struct {
	failures int
	// until is when the leg may be tried again. A probe claims the slot by
	// pushing it forward, so only one session at a time pays for trying a leg
	// that may still be down.
	until time.Time
}

var multipathLegHealthMemory = newMultipathLegHealth()

func newMultipathLegHealth() *multipathLegHealth {
	return &multipathLegHealth{entries: map[string]*multipathLegHealthEntry{}, now: time.Now}
}

func multipathLegBackoff(failures int) time.Duration {
	backoff := multipathLegBackoffBase
	for i := 1; i < failures && backoff < multipathLegBackoffMax; i++ {
		backoff *= 2
	}
	if backoff > multipathLegBackoffMax {
		backoff = multipathLegBackoffMax
	}
	return backoff
}

// allow reports whether a new session should dial this leg, claiming the
// probe if the leg is due for one.
func (h *multipathLegHealth) allow(key string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	entry := h.entries[key]
	if entry == nil {
		return true
	}
	now := h.now()
	if now.Before(entry.until) {
		return false
	}
	if entry.failures > 0 {
		entry.until = now.Add(multipathLegBackoff(entry.failures))
	}
	return true
}

// failed records that the leg could not be dialled or broke mid-session.
func (h *multipathLegHealth) failed(key string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	entry := h.entries[key]
	if entry == nil {
		entry = &multipathLegHealthEntry{}
		h.entries[key] = entry
	}
	entry.failures++
	entry.until = h.now().Add(multipathLegBackoff(entry.failures))
}

// dialed reopens the leg to new sessions without forgetting its failures, so
// a leg that keeps connecting and then breaking still backs off further.
func (h *multipathLegHealth) dialed(key string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if entry := h.entries[key]; entry != nil {
		entry.until = time.Time{}
	}
}

// healthy forgets the leg's failures: it carried a whole session.
func (h *multipathLegHealth) healthy(key string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.entries, key)
}

// reset forgets everything, for tests.
func (h *multipathLegHealth) reset() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.entries = map[string]*multipathLegHealthEntry{}
}
