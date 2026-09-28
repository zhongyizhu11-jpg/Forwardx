package main

import (
	"net"
	"sync"
	"sync/atomic"
	"time"
)

/*
UDP 直连（出口、中转收上一跳的数据包）的防重放。

以前防重放的窗口挂在会话上，会话按「来源地址 + 规则 + 会话号」找。抓一个包换个
（伪造的）来源地址再发，出口认成一个新会话，窗口是空的，包照样转给目标，
目标的回包还发到伪造的地址上 —— 重放 + 反射放大。现在：

  - 会话只按（规则, 会话号）找，和来源地址无关。同一会话从新地址来的包，先过
    认证和重放窗口，而且是这个会话目前最新的包，才把回程地址改到新地址（入口
    换了出口 IP / NAT 重新映射照样能用）。重放的旧包过不了窗口，挪不动回程。
    代价：路径上的攻击者抢在真包之前把一个还没到的新包从别处发来，能把回程
    暂时拐走，直到入口下一个包把它拐回来 —— 和 WireGuard 的漫游是一样的取舍，
    能这么做的人本来就能直接丢包。
  - 窗口放在这里（udpReplayGuard），会话结束后还留 2 倍时间窗：会话被空闲回收、
    容量回收、监听重启之后，同一会话号的包再来，接着用原来的窗口，旧包照样被拒。
  - 每个包头里带发出时间（秒，参与认证），只收 ±fxpUDPReplayWindow 以内的：
    超过窗口的旧包直接丢，所以窗口只需要记 2 倍时间窗。进程启动前发出的包一律
    不收（重启后内存里什么都没了，认不出它们是不是重放）。这要求入口、中转、
    出口的时钟误差在窗口以内，和 TCP 握手一样。
  - 记的会话数有上限。挤掉一条记录时，把「最低可接受时间」抬到那条会话见过的
    最新发出时间：那条会话的旧包从此一概不收，其余会话的新包不受影响。
*/

const (
	fxpUDPReplayWindow        = fxpHandshakeWindow
	fxpUDPReplayMemoryEntries = 65536
)

type udpReplayKey struct {
	role      string
	tunnelID  int
	port      int
	ruleID    int
	sessionID uint64
}

// udpReplayState 是一个（规则, 会话号）的防重放状态，活着的会话和刚结束的
// 会话共用它。
type udpReplayState struct {
	window    udpReplayWindow
	maxSentAt atomic.Uint32
	// 以下由 udpReplayGuard.mu 保护。
	live       int
	releasedAt time.Time
}

func (s *udpReplayState) observe(sentAt uint32) {
	for {
		current := s.maxSentAt.Load()
		if sentAt <= current || s.maxSentAt.CompareAndSwap(current, sentAt) {
			return
		}
	}
}

type udpReplayEnded struct {
	key        udpReplayKey
	state      *udpReplayState
	releasedAt time.Time
}

type udpReplayGuard struct {
	window time.Duration
	max    int
	// floor：发出时间不大于它的包一律不收。起点是进程启动时刻，挤掉记录时往上抬。
	floor  atomic.Uint32
	mu     sync.Mutex
	states map[udpReplayKey]*udpReplayState
	ended  []udpReplayEnded
}

func newUDPReplayGuard(window time.Duration, max int, startedAt time.Time) *udpReplayGuard {
	guard := &udpReplayGuard{window: window, max: max, states: map[udpReplayKey]*udpReplayState{}}
	if start := startedAt.Unix(); start > 1 {
		guard.floor.Store(uint32(start - 1))
	}
	return guard
}

var fxpUDPReplayGuard = newUDPReplayGuard(fxpUDPReplayWindow, fxpUDPReplayMemoryEntries, time.Now())

// udpReplayKeyFor 按监听的实际端口区分：同一进程里的几个监听互不串，监听重启
// （端口不变）之后还能接上原来的状态。
func udpReplayKeyFor(role string, conn *net.UDPConn, tunnelID, ruleID int, sessionID uint64) udpReplayKey {
	port := 0
	if conn != nil {
		if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok {
			port = addr.Port
		}
	}
	return udpReplayKey{role: role, tunnelID: tunnelID, port: port, ruleID: ruleID, sessionID: sessionID}
}

// fresh 判断一个认证过的包的发出时间能不能收。
func (g *udpReplayGuard) fresh(sentAt uint32, now time.Time) bool {
	if sentAt <= g.floor.Load() {
		return false
	}
	skew := time.Duration(now.Unix()-int64(sentAt)) * time.Second
	return skew <= g.window && skew >= -g.window
}

// acquire 拿到这个会话的防重放状态：会话刚结束不久的，接着用原来的窗口。
func (g *udpReplayGuard) acquire(key udpReplayKey, now time.Time) *udpReplayState {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sweepLocked(now)
	state := g.states[key]
	if state == nil {
		state = &udpReplayState{}
		g.states[key] = state
	}
	state.live++
	return state
}

// release 会话结束：状态再留 2 倍时间窗，之后这个会话的包都已经过了时间窗。
func (g *udpReplayGuard) release(key udpReplayKey, state *udpReplayState, now time.Time) {
	if state == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	state.live--
	if state.live > 0 {
		return
	}
	state.releasedAt = now
	g.ended = append(g.ended, udpReplayEnded{key: key, state: state, releasedAt: now})
	g.sweepLocked(now)
	for len(g.ended) > g.max {
		g.popEndedLocked(true)
	}
}

func (g *udpReplayGuard) sweepLocked(now time.Time) {
	for len(g.ended) > 0 && now.Sub(g.ended[0].releasedAt) >= 2*g.window {
		g.popEndedLocked(false)
	}
}

// popEndedLocked 丢掉最早结束的一条。evicted 表示是容量满了挤掉的（还没过期），
// 要把下限抬到它见过的最新发出时间。
func (g *udpReplayGuard) popEndedLocked(evicted bool) {
	entry := g.ended[0]
	g.ended[0] = udpReplayEnded{}
	g.ended = g.ended[1:]
	state := entry.state
	// 会话又活过来、或者后来又结束了一次的，这条是过期的引用，不动它。
	if g.states[entry.key] != state || state.live > 0 || !state.releasedAt.Equal(entry.releasedAt) {
		return
	}
	delete(g.states, entry.key)
	if !evicted {
		return
	}
	maxSentAt := state.maxSentAt.Load()
	for {
		floor := g.floor.Load()
		if maxSentAt <= floor || g.floor.CompareAndSwap(floor, maxSentAt) {
			return
		}
	}
}
