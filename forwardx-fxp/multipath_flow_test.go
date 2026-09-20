package main

// 多路径流控的回归测试。
//
// 这一组都用**真 TCP** 建腿，不用 net.Pipe：net.Pipe 是同步零缓冲的，每条腿上
// 顶多压着一片，于是「腿断了会丢掉内核队列里那一批」这件事在它上面根本复现不出来。
// 换成真 socket 之后，不加流控的话一条腿被 RST 能带走十几兆数据。

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

// 用真 TCP 建腿：内核发送缓冲是真的，和 net.Pipe（同步、零缓冲）不一样。
func newTCPMultipathPair(t *testing.T, legCount, maxPending int) (*multipathSession, *multipathSession, []*net.TCPConn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	salt := make([]byte, fxpSaltSize)
	for i := range salt {
		salt[i] = byte(i + 3)
	}
	var clientConns, serverConns []*secureConn
	var labels []string
	var clientRaw []*net.TCPConn
	for i := 0; i < legCount; i++ {
		accepted := make(chan net.Conn, 1)
		go func() {
			c, _ := listener.Accept()
			accepted <- c
		}()
		c, err := net.Dial("tcp", listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		s := <-accepted
		tcpC := c.(*net.TCPConn)
		_ = tcpC.SetWriteBuffer(1 << 20)
		clientRaw = append(clientRaw, tcpC)
		cs, err := newSessionSecureConn(c, "k", salt, true)
		if err != nil {
			t.Fatal(err)
		}
		ss, err := newSessionSecureConn(s, "k", salt, false)
		if err != nil {
			t.Fatal(err)
		}
		clientConns = append(clientConns, cs)
		serverConns = append(serverConns, ss)
		labels = append(labels, fmt.Sprintf("leg-%d", i))
	}
	client := newMultipathSession(multipathLegsFromSecureConns(clientConns, labels), maxPending)
	server := newMultipathSession(multipathLegsFromSecureConns(serverConns, labels), maxPending)
	t.Cleanup(func() { client.closeTransport(); server.closeTransport() })
	return client, server, clientRaw
}

// markedChunk 让每一片都认得出来，这样比对的是内容不是长度。
func markedChunk(index int, size int) []byte {
	out := make([]byte, size)
	for i := range out {
		out[i] = byte('a' + (index+i)%26)
	}
	out[0] = byte(index)
	out[1] = byte(index >> 8)
	out[2] = byte(index >> 16)
	return out
}

func (s *multipathSession) setLegStallTuning(timeout, check time.Duration) {
	s.legStallTimeout.Store(int64(timeout))
	s.legStallCheck.Store(int64(check))
}

func TestMultipathSessionKeepsEveryByteWhenALegDiesAtTheWindow(t *testing.T) {
	const chunks = 8000
	const chunkSize = 2048
	client, server, raw := newTCPMultipathPair(t, 3, 1024)
	server.enableExtended() // 出口侧：入口在 hello 里声明过，于是回 ready 并开流控

	var expected bytes.Buffer
	for i := 0; i < chunks; i++ {
		expected.Write(markedChunk(i, chunkSize))
	}

	var progress atomic.Int64
	sent := make(chan error, 1)
	go func() {
		for i := 0; i < chunks; i++ {
			if err := client.writeFrame(markedChunk(i, chunkSize)); err != nil {
				sent <- fmt.Errorf("write %d: %w", i, err)
				return
			}
			progress.Add(1)
		}
		sent <- client.writeFrame(nil)
	}()

	// 一直不消费，等到发送端**真的写不动了**为止。到这一刻，在途的分片要么在
	// 重排缓冲里，要么还压在两端的内核队列里 —— 后者正是一条腿断掉会带走的那批。
	deadline := time.Now().Add(20 * time.Second)
	var stuckAt int64
	for {
		if time.Now().After(deadline) {
			t.Fatalf("发送端一直没写满，写了 %d 片", progress.Load())
		}
		before := progress.Load()
		time.Sleep(400 * time.Millisecond)
		if progress.Load() == before && before > 0 {
			stuckAt = before
			break
		}
	}
	t.Logf("发送端堵住：已写 %d 片，重排缓冲 %d 片", stuckAt, server.reorder.pendingCount())

	// 腿 1 直接 RST：内核缓冲里还没被对端读走的数据全丢。
	_ = raw[1].SetLinger(0)
	_ = raw[1].Close()

	type result struct {
		data []byte
		err  error
	}
	received := make(chan result, 1)
	go func() {
		d, err := drainStream(server)
		received <- result{data: d, err: err}
	}()

	select {
	case got := <-received:
		if got.err != nil {
			t.Fatalf("流没能拼完：%v（收到 %d 字节，应为 %d）", got.err, len(got.data), expected.Len())
		}
		if !bytes.Equal(got.data, expected.Bytes()) {
			t.Fatalf("数据对不上：收到 %d 字节，应为 %d", len(got.data), expected.Len())
		}
		t.Logf("一条腿被 RST 掉，仍然一个字节不少地收全了 %d 字节", len(got.data))
	case <-time.After(60 * time.Second):
		t.Fatalf("接收端卡住：缓冲 %d 片，等 seq %d", server.reorder.pendingCount(), server.reorder.delivered())
	}
	if err := <-sent; err != nil {
		t.Fatalf("send: %v", err)
	}
}

// RST 发生在**数据正跑着**的时候：这一刻内核队列里确实压着已经写出去、
// 但对端还没读走的东西。
func TestMultipathSessionKeepsEveryByteWhenALegDiesMidFlight(t *testing.T) {
	const chunks = 20000
	const chunkSize = 2048
	client, server, raw := newTCPMultipathPair(t, 3, 1024)
	server.enableExtended()

	var expected bytes.Buffer
	for i := 0; i < chunks; i++ {
		expected.Write(markedChunk(i, chunkSize))
	}

	type result struct {
		data []byte
		err  error
	}
	received := make(chan result, 1)
	go func() {
		d, err := drainStream(server)
		received <- result{data: d, err: err}
	}()

	var progress atomic.Int64
	sent := make(chan error, 1)
	go func() {
		for i := 0; i < chunks; i++ {
			if err := client.writeFrame(markedChunk(i, chunkSize)); err != nil {
				sent <- fmt.Errorf("write %d: %w", i, err)
				return
			}
			progress.Add(1)
		}
		sent <- client.writeFrame(nil)
	}()

	// 等数据真的跑起来，在流中间掐掉一条腿。
	deadline := time.Now().Add(10 * time.Second)
	for progress.Load() < chunks/3 {
		if time.Now().After(deadline) {
			t.Fatalf("数据没跑起来，只写了 %d 片", progress.Load())
		}
		time.Sleep(2 * time.Millisecond)
	}
	_ = raw[1].SetLinger(0)
	_ = raw[1].Close()

	select {
	case got := <-received:
		if got.err != nil {
			t.Fatalf("流没能拼完：%v（收到 %d 字节，应为 %d）", got.err, len(got.data), expected.Len())
		}
		if !bytes.Equal(got.data, expected.Bytes()) {
			t.Fatalf("数据对不上：收到 %d 字节，应为 %d", len(got.data), expected.Len())
		}
	case <-time.After(60 * time.Second):
		t.Fatalf("接收端卡住：缓冲 %d 片，等 seq %d", server.reorder.pendingCount(), server.reorder.delivered())
	}
	if err := <-sent; err != nil {
		t.Fatalf("send: %v", err)
	}
}

// 一条腿「还连着但对端不再读」：写入者永远卡在 Write 里，手上那片再也交不出去。
// 要求是整条流**无损**跑完 —— 靠把那条腿摘掉、把它手上的那片交给别的腿。
func TestMultipathSessionRecoversLosslesslyFromABlackHoledLeg(t *testing.T) {
	const chunks = 4000
	const chunkSize = 2048
	client, server, hole := newBlackHolePair(t, 3, 1024, 1)
	server.enableExtended()
	client.setLegStallTuning(300*time.Millisecond, 50*time.Millisecond)
	server.setLegStallTuning(300*time.Millisecond, 50*time.Millisecond)

	var expected bytes.Buffer
	for i := 0; i < chunks; i++ {
		expected.Write(markedChunk(i, chunkSize))
	}
	type result struct {
		data []byte
		err  error
	}
	received := make(chan result, 1)
	go func() {
		d, err := drainStream(server)
		received <- result{data: d, err: err}
	}()

	var progress atomic.Int64
	sent := make(chan error, 1)
	go func() {
		for i := 0; i < chunks; i++ {
			if i == 50 {
				hole.swallow.Store(true)
			}
			if err := client.writeFrame(markedChunk(i, chunkSize)); err != nil {
				sent <- fmt.Errorf("write %d: %w", i, err)
				return
			}
			progress.Add(1)
		}
		sent <- client.writeFrame(nil)
	}()

	select {
	case got := <-received:
		if got.err != nil {
			t.Fatalf("流没能拼完：%v（收到 %d 字节，应为 %d）", got.err, len(got.data), expected.Len())
		}
		if !bytes.Equal(got.data, expected.Bytes()) {
			t.Fatalf("数据对不上：收到 %d 字节，应为 %d", len(got.data), expected.Len())
		}
	case <-time.After(40 * time.Second):
		t.Fatalf("卡死：写了 %d 片，缓冲 %d 片，等 seq %d",
			progress.Load(), server.reorder.pendingCount(), server.reorder.delivered())
	}
	if err := <-sent; err != nil {
		t.Fatalf("send: %v", err)
	}
	if client.aliveLegCount() != 2 {
		t.Fatalf("黑洞腿应该被摘掉，还剩 %d 条", client.aliveLegCount())
	}
}

func TestMultipathSessionStaysSilentWithAPeerThatNeverAskedForExtendedFrames(t *testing.T) {
	// 老版本对端听不懂 ready/ack 这两种帧，收到就会当成协议错误把会话掐掉。
	// 所以这一条钉的是：**没确认对端听得懂之前，一帧都不发**。
	//
	// 这里两端都不调 enableExtended，正是入口对上老出口时的样子：出口不会回
	// ready，入口也就永远不知道对方听得懂，于是谁都不发新类型的帧。
	pair := newMultipathTestPair(t, 3, 64)

	received := make(chan []byte, 1)
	go func() {
		data, _ := drainStream(pair.server)
		received <- data
	}()
	var expected bytes.Buffer
	for i := 0; i < 200; i++ {
		chunk := markedChunk(i, 256)
		expected.Write(chunk)
		if err := pair.client.writeFrame(chunk); err != nil {
			t.Fatalf("writeFrame %d: %v", i, err)
		}
	}
	if err := pair.client.writeFrame(nil); err != nil {
		t.Fatalf("fin: %v", err)
	}
	select {
	case got := <-received:
		if !bytes.Equal(got, expected.Bytes()) {
			t.Fatalf("老对端下的流都传不对：收到 %d 字节，应为 %d", len(got), expected.Len())
		}
	case <-time.After(20 * time.Second):
		t.Fatal("老对端下的流没跑完")
	}

	for name, session := range map[string]*multipathSession{"entry": pair.client, "exit": pair.server} {
		if session.peerExtended.Load() {
			t.Fatalf("%s 侧凭空认定对端听得懂扩展帧", name)
		}
		if got := session.ackedSeq.Load(); got != 0 {
			t.Fatalf("%s 侧给老对端发了回执（acked=%d）—— 老对端会直接掐掉会话", name, got)
		}
	}
	// 没有回执，窗口就该一直不生效，行为退回改动之前。
	if _, active, _, _ := pair.client.sendWin.limit(); active {
		t.Fatal("没收到任何回执，发送窗口却生效了")
	}
}

func TestSendWindowStaysDormantUntilTheFarSideReports(t *testing.T) {
	window := newSendWindow()
	done := make(chan struct{})
	// 一个回执都没有的时候，窗口不该拦任何东西。
	if err := window.reserve(1<<40, done, time.Second); err != nil {
		t.Fatalf("dormant window must not hold anything back: %v", err)
	}
	window.update(0, 4)
	if err := window.reserve(3, done, time.Second); err != nil {
		t.Fatalf("seq inside the window: %v", err)
	}

	blocked := make(chan error, 1)
	go func() { blocked <- window.reserve(4, done, 5*time.Second) }()
	select {
	case err := <-blocked:
		t.Fatalf("seq 4 是窗口外的第一个，不该放行（%v）", err)
	case <-time.After(100 * time.Millisecond):
	}
	window.update(1, 4) // 对端交付了一片，窗口往前挪一格
	select {
	case err := <-blocked:
		if err != nil {
			t.Fatalf("window advanced: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("窗口挪了，等在外面的那片却没被放行")
	}
}

func TestSendWindowGivesUpWhenTheFarSideGoesSilent(t *testing.T) {
	// 对端彻底没声音的时候，发送端不能永远挂着 —— 那正是「两端都不报错」的
	// 那种卡死。宁可带着原因收掉，让上层重连。
	window := newSendWindow()
	window.update(0, 1)
	err := window.reserve(1, make(chan struct{}), 150*time.Millisecond)
	if !errors.Is(err, errMultipathSendStalled) {
		t.Fatalf("expected the sender to give up, got %v", err)
	}
	// 窗口只要还在动，等多久都算正常背压，不该报错。
	moving := newSendWindow()
	moving.update(0, 1)
	go func() {
		for i := uint64(1); i <= 6; i++ {
			time.Sleep(40 * time.Millisecond)
			moving.update(i, 1)
		}
	}()
	if err := moving.reserve(5, make(chan struct{}), 150*time.Millisecond); err != nil {
		t.Fatalf("窗口一直在动，不该判成卡死：%v", err)
	}
}

// 结束标记要发给每一条腿。原来是**串行**发的，一条腿还连着但对端不再读的时候，
// 这次写永远回不来，后面的腿根本轮不到 —— 整条会话就挂在收尾这一步，两端都不报错。
//
// 看门狗也救不了这种：它判「这条腿卡住了」靠的是别的腿还在往前走，而串行的写法
// 根本不给别的腿走的机会。
func TestMultipathSessionEndsTheStreamEvenWhenOneLegBlackHoles(t *testing.T) {
	client, server, hole := newBlackHolePair(t, 3, 64, 1)
	server.enableExtended()
	client.setLegStallTuning(200*time.Millisecond, 50*time.Millisecond)
	server.setLegStallTuning(200*time.Millisecond, 50*time.Millisecond)

	drained := make(chan struct{})
	go func() { _, _ = drainStream(server); close(drained) }()

	// 先正常跑几片，确认链路是通的。
	for i := 0; i < 5; i++ {
		if err := client.writeFrame(markedChunk(i, 64)); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	// 这一刻一条腿不读了，紧接着就结束流。
	hole.swallow.Store(true)
	time.Sleep(50 * time.Millisecond)

	done := make(chan error, 1)
	go func() { done <- client.writeFrame(nil) }()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("writeFin 永久挂住：结束标记是挨个腿直接写的，看门狗看不见它")
	}
	<-drained
}

func TestMultipathSessionEndsAnIdleStreamWhenOneLegBlackHoles(t *testing.T) {
	// 上一条里那条腿是先卡在一次数据写上的，看门狗从那儿就看得见它。
	// 这一条更刁：连接一开就结束，那条腿**只**卡在结束标记这一次写上。
	//
	// 串行地挨个腿写，在这里必然挂死：看门狗判一条腿坏掉，靠的是「别的腿还在
	// 往前走」，而卡住的那条腿之后的腿根本轮不到写。只有同时发才走得出去。
	// 开关必须在会话起来之前就打开，否则那条腿的读取者会先正常读掉一帧。
	client, server, _ := newBlackHolePairArmed(t, 3, 64, 1, true)
	server.enableExtended()
	client.setLegStallTuning(200*time.Millisecond, 50*time.Millisecond)
	server.setLegStallTuning(200*time.Millisecond, 50*time.Millisecond)

	drained := make(chan struct{})
	go func() { _, _ = drainStream(server); close(drained) }()

	done := make(chan error, 1)
	go func() { done <- client.writeFrame(nil) }()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("空流收不了尾：结束标记卡在那条不读的腿上，后面的腿一直轮不到")
	}
	select {
	case <-drained:
	case <-time.After(15 * time.Second):
		t.Fatal("接收端没等到结束标记")
	}
}
