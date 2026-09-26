package main

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

/*
线路组的 UDP 调度（规格 protocol 为 udp 或 both 时由 startFailoverProxyLocked 开起来）。

TCP 那边一条连接挑一次路径（handleConn）。UDP 没有连接，这里用「会话」代替：以来源地址为键
（前面的转发工具连过来的 127.0.0.1:端口；gost / realm / socat / nginx 都是一个访客一个套接字），
会话第一次出现时挑一条路径、拨一个 UDP 套接字过去，之后这个来源的包都走它，回包原路写回去。
两个方向都安静够久就回收；回收以后再来包算新会话，重新挑。

和 TCP 一样的地方：
  - 挑路径的规则是同一份（pickTargetForKey）：主备走当前那条，权重 / 轮流 / 随机按会话分，
    按访客固定按来源地址哈希；
  - 会话的上游套接字记在 conns 上：面板上「这条路径几个连接」对 UDP 就是几个会话；快速故障
    转移 / 强制切换断旧连接时它们一起被关，关掉以后这个来源的下一个包重新挑路径 —— UDP 版的
    「断开让客户端重连」。

不一样的地方：拨 UDP 不会因为对端不通而失败（没有握手），真实流量给不出「这条不通」的信号，
健康只看探测：没填探测地址的路径 ping 拨号地址的主机（failoverProbeTarget）。
*/

const (
	// 两个方向都没包多久算会话结束。前面的 gost 自己的 UDP 会话 30 秒回收，这里放宽：
	// 回收早了只是多挑一次路径，回收晚了只是多占一个套接字。
	failoverUDPIdleTimeout = 2 * time.Minute
	// 会话上限。到了上限不丢新会话，而是回收最久没动静的那个：DNS 这类一问一答的流量每个
	// 请求都是新的来源端口，丢新会话等于整条规则停摆。
	failoverUDPMaxSessions  = 4096
	failoverUDPReapInterval = 30 * time.Second
	failoverUDPBufferSize   = 65535
	failoverUDPDialTimeout  = 5 * time.Second
	// 前面的转发工具连上调度器以后马上就发 PROXY 头；等这么久还没有，就当没有。
	failoverProxyHeaderTimeout = 5 * time.Second
)

type failoverUDPSession struct {
	key      string
	client   net.Addr
	upstream net.Conn
	index    int
	// 最近一次有包（两个方向都算）的时刻，UnixNano。
	last atomic.Int64
}

func (s *failoverUDPSession) touch(now time.Time) {
	s.last.Store(now.UnixNano())
}

func (s *failoverUDPSession) idleSince(now time.Time) time.Duration {
	return now.Sub(time.Unix(0, s.last.Load()))
}

// 规格里的协议，归一成 tcp / udp / both；没写的老规格是 tcp。
func failoverProtocol(spec failoverSpec) string {
	return normalizeRuntimeProtocol(spec.Protocol)
}

/*
收掉这个代理：停探测、关监听、关 UDP 会话。

TCP 上已经建立的连接不动，让它们自己走完 —— 和上一版一样。UDP 会话跟着监听一起死（回包
要从监听的那个套接字写回去），所以一并关掉。可以重复调用。
*/
func (p *failoverProxy) retire() {
	p.retireOnce.Do(func() {
		close(p.done)
		if p.ln != nil {
			_ = p.ln.Close()
		}
		if p.udp != nil {
			_ = p.udp.Close()
		}
		p.closeUDPSessions()
	})
}

func (p *failoverProxy) retired() bool {
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

func (p *failoverProxy) closeUDPSessions() {
	p.udpMu.Lock()
	sessions := make([]*failoverUDPSession, 0, len(p.udpSessions))
	for _, session := range p.udpSessions {
		sessions = append(sessions, session)
	}
	p.udpSessions = map[string]*failoverUDPSession{}
	p.udpMu.Unlock()
	for _, session := range sessions {
		p.untrackConn(session.index, session.upstream)
		_ = session.upstream.Close()
	}
}

func (p *failoverProxy) udpSessionCount() int {
	p.udpMu.Lock()
	defer p.udpMu.Unlock()
	return len(p.udpSessions)
}

func (p *failoverProxy) serveUDP() {
	stopReaper := make(chan struct{})
	defer close(stopReaper)
	go p.reapUDPSessions(stopReaper)
	buf := make([]byte, failoverUDPBufferSize)
	for {
		n, client, err := p.udp.ReadFrom(buf)
		if err != nil {
			if p.retired() || errors.Is(err, net.ErrClosed) {
				return
			}
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				continue
			}
			logf("failover udp read failed rule=%d source=%d: %v", p.ruleID, p.sourcePort, err)
			return
		}
		if n <= 0 || client == nil {
			continue
		}
		// 这个包在下一次 ReadFrom 之前就写出去了，buf 可以复用。
		p.forwardUDPPacket(client, buf[:n])
	}
}

func (p *failoverProxy) forwardUDPPacket(client net.Addr, packet []byte) {
	key := client.String()
	for attempt := 0; attempt < 2; attempt++ {
		session := p.udpSessionFor(key, client)
		if session == nil {
			return
		}
		session.touch(time.Now())
		_, err := session.upstream.Write(packet)
		if err == nil || !errors.Is(err, net.ErrClosed) {
			// 别的写错误（对端回过 ICMP 不可达之类）只丢这一个包：UDP 本来就不保证送达。
			return
		}
		// 上游套接字刚被关掉（强制切换断旧连接、或者刚好被回收）：丢掉这个会话，
		// 按现在的状态重新挑一条路径再发。
		p.dropUDPSession(session)
	}
}

func (p *failoverProxy) udpSessionFor(key string, client net.Addr) *failoverUDPSession {
	p.udpMu.Lock()
	session := p.udpSessions[key]
	p.udpMu.Unlock()
	if session != nil {
		return session
	}
	upstream, index := p.dialUDPPath(key)
	if upstream == nil {
		return nil
	}
	session = &failoverUDPSession{key: key, client: client, upstream: upstream, index: index}
	session.touch(time.Now())
	// 先记到路径名下再放进会话表：中间要是正好切换、断旧连接，这个会话也在被断的名单里。
	p.trackConn(index, upstream)
	var evicted *failoverUDPSession
	p.udpMu.Lock()
	if p.retired() {
		p.udpMu.Unlock()
		p.untrackConn(index, upstream)
		_ = upstream.Close()
		return nil
	}
	if p.udpSessions == nil {
		p.udpSessions = map[string]*failoverUDPSession{}
	}
	if len(p.udpSessions) >= failoverUDPMaxSessions {
		if evicted = p.oldestUDPSessionLocked(); evicted != nil {
			delete(p.udpSessions, evicted.key)
		}
	}
	p.udpSessions[key] = session
	p.udpMu.Unlock()
	if evicted != nil {
		p.untrackConn(evicted.index, evicted.upstream)
		_ = evicted.upstream.Close()
		if shouldLogAgentReport(fmt.Sprintf("failover-udp-session-limit:%d:%d", p.ruleID, p.sourcePort), agentReportLogInterval) {
			logf("failover udp session limit reached rule=%d source=%d sessions=%d; recycling the idlest", p.ruleID, p.sourcePort, failoverUDPMaxSessions)
		}
	}
	go p.copyUDPToClient(session)
	return session
}

func (p *failoverProxy) oldestUDPSessionLocked() *failoverUDPSession {
	var oldest *failoverUDPSession
	var oldestAt int64
	for _, session := range p.udpSessions {
		at := session.last.Load()
		if oldest == nil || at < oldestAt {
			oldest, oldestAt = session, at
		}
	}
	return oldest
}

// 给新会话挑路径并拨过去；拨不了（多半是地址解析失败）就记一次失败换下一条，和 TCP 一样。
func (p *failoverProxy) dialUDPPath(key string) (net.Conn, int) {
	attempted := map[int]bool{}
	for {
		target, index := p.pickTargetForKey(key, attempted)
		if index < 0 {
			if shouldLogAgentReport(fmt.Sprintf("failover-udp-no-target:%d:%d", p.ruleID, p.sourcePort), agentReportLogInterval) {
				logf("failover udp no target available rule=%d source=%d", p.ruleID, p.sourcePort)
			}
			return nil, -1
		}
		upstream, err := net.DialTimeout("udp", net.JoinHostPort(target.TargetIP, strconv.Itoa(target.TargetPort)), failoverUDPDialTimeout)
		if err == nil {
			return upstream, index
		}
		attempted[index] = true
		p.markTargetFailure(index, "dial failed")
		if shouldLogAgentReport(fmt.Sprintf("failover-udp-dial:%d:%d:%d", p.ruleID, p.sourcePort, index), agentReportLogInterval) {
			logf("failover udp dial failed rule=%d source=%d target=%s:%d: %v", p.ruleID, p.sourcePort, target.TargetIP, target.TargetPort, err)
		}
	}
}

func (p *failoverProxy) copyUDPToClient(session *failoverUDPSession) {
	defer p.dropUDPSession(session)
	buf := getAgentByteBuffer(failoverUDPBufferSize)
	defer putAgentByteBuffer(buf)
	failures := 0
	for {
		_ = session.upstream.SetReadDeadline(time.Now().Add(failoverUDPIdleTimeout))
		n, err := session.upstream.Read(buf)
		if n > 0 {
			failures = 0
			session.touch(time.Now())
			if _, werr := p.udp.WriteTo(buf[:n], session.client); werr != nil && (p.retired() || errors.Is(werr, net.ErrClosed)) {
				return
			}
		}
		if err == nil {
			continue
		}
		if p.retired() || errors.Is(err, net.ErrClosed) {
			return
		}
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			// 路径那头一直没回包，但访客还在发（只进不出的 UDP 很常见）：会话还活着。
			if session.idleSince(time.Now()) < failoverUDPIdleTimeout {
				continue
			}
			return
		}
		// 其余的读错误（对端回 ICMP 端口不可达之类）只报这一次，下一个包照样能走；连着出错就算了。
		failures++
		if failures >= 8 {
			return
		}
	}
}

func (p *failoverProxy) dropUDPSession(session *failoverUDPSession) {
	p.udpMu.Lock()
	if current := p.udpSessions[session.key]; current == session {
		delete(p.udpSessions, session.key)
	}
	p.udpMu.Unlock()
	p.untrackConn(session.index, session.upstream)
	_ = session.upstream.Close()
}

func (p *failoverProxy) reapUDPSessions(stop <-chan struct{}) {
	ticker := time.NewTicker(failoverUDPReapInterval)
	defer ticker.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-stop:
			return
		case <-ticker.C:
			p.reapIdleUDPSessions(time.Now())
		}
	}
}

func (p *failoverProxy) reapIdleUDPSessions(now time.Time) int {
	p.udpMu.Lock()
	idle := make([]*failoverUDPSession, 0)
	for key, session := range p.udpSessions {
		if session.idleSince(now) >= failoverUDPIdleTimeout {
			idle = append(idle, session)
			delete(p.udpSessions, key)
		}
	}
	p.udpMu.Unlock()
	for _, session := range idle {
		p.untrackConn(session.index, session.upstream)
		_ = session.upstream.Close()
	}
	return len(idle)
}

// ---- 健康探测 ----

// 测试里换掉它，免得真去 ping。
var failoverPingLatency = pingLatencyWithCount

func (t failoverTarget) hasExplicitProbe() bool {
	host := strings.TrimSpace(t.ProbeIP)
	return host != "" && t.ProbePort >= 1 && t.ProbePort <= 65535
}

/*
这条路径的健康探测怎么做。

TCP（含 TCP+UDP）照旧拨探测地址。只转 UDP 的路径没有握手可拨：拨号地址上多半只有 UDP
服务，拨 TCP 只会一直失败，所有路径都会被判成挂了。没单独填探测地址的话就 ping 拨号地址的
主机 —— 中转机上探 UDP 中继规则用的也是这个办法（buildRuleLatencyProbeTask）。填了探测地址
就照填的拨 TCP：用户填它，就是要探落地上某个确定开着的 TCP 端口。
*/
func failoverProbeTarget(protocol string, target failoverTarget) (int, bool) {
	if protocol == "udp" && !target.hasExplicitProbe() {
		latency, ok, _ := failoverPingLatency(target.TargetIP, 2*time.Second, 1)
		return latency, ok
	}
	host, port := target.probeEndpoint()
	return tcpLatency(host, port, 2*time.Second)
}

// ---- 按访客固定：从 PROXY 头里读访客地址 ----

/*
「按访客固定」要知道访客是谁。调度器只监听 127.0.0.1，连进来的永远是前面那个转发工具，
RemoteAddr 全是本机 —— 拿它哈希，所有访客都会被分到同一条路径（2.2.198 就是这样）。访客
地址只能从前面的转发工具加的 PROXY 头里读：

  - ProxyProtocolReceive：规则本来就往目标发 PROXY 头，头是给落地的，读完原样转过去；
  - ProxyProtocolStrip：规则不发 PROXY 头，头是面板专门让前面加给调度器的，读完扔掉。

两样都没有就按连接的来源地址（老行为）。返回访客地址（哈希用）和要先补发给路径的字节。
*/
func (p *failoverProxy) readVisitor(client net.Conn) (string, []byte) {
	p.mu.RLock()
	strategy := p.spec.Strategy
	receive := p.spec.ProxyProtocolReceive
	strip := p.spec.ProxyProtocolStrip
	p.mu.RUnlock()
	visitor := failoverRemoteIP(client)
	if !strip && !(receive && strategy == "ip_hash") {
		return visitor, nil
	}
	raw, headerLen, source := readFailoverProxyHeader(client, failoverProxyHeaderTimeout)
	if source != "" {
		visitor = source
	}
	if strip {
		return visitor, raw[headerLen:]
	}
	return visitor, raw
}

// 把读过的字节都记下来：解析 PROXY 头时多读到的数据还要原样补给路径。
type failoverRecordingConn struct {
	net.Conn
	read []byte
}

func (c *failoverRecordingConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if n > 0 {
		c.read = append(c.read, b[:n]...)
	}
	return n, err
}

// 从连接开头读一个 PROXY 头（v1 / v2）。返回读到的全部字节、其中头占多少、头里的访客地址。
// 开头不是 PROXY 头（或者读不全、读超时）时头长度为 0，读到的字节全部当数据转出去。
func readFailoverProxyHeader(conn net.Conn, timeout time.Duration) ([]byte, int, string) {
	rec := &failoverRecordingConn{Conn: conn}
	first := make([]byte, 256)
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	n, _ := rec.Read(first)
	_ = conn.SetReadDeadline(time.Time{})
	if n <= 0 {
		return nil, 0, ""
	}
	info, remaining, found, err := consumeProxyProtocolFromConn(rec, first[:n], timeout)
	raw := rec.read
	if err != nil || !found {
		return raw, 0, ""
	}
	headerLen := len(raw) - len(remaining)
	if headerLen < 0 || headerLen > len(raw) {
		return raw, 0, ""
	}
	return raw, headerLen, strings.TrimSpace(info.SourceIP)
}
