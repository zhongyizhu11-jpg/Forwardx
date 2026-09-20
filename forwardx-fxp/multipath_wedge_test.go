package main

// 重排缓冲的「卡死」回归测试。
//
// 背景：每条腿只有一个读取者，一旦它挂在 push 里等空位，这条腿上的后续帧就没人
// 收了。要是所有腿的读取者同时挂着，而下一个该交付的分片恰好排在其中一条腿的
// 队列里 —— 它永远到不了缓冲，消费者永远等不到它，发送端又被读不走的数据顶死。
// 整条流就此静止，没有超时，没有报错，连接一直挂着。
//
// 这几条钉住的是：这种局面一定能自己走出来，而正常的背压不受影响。

import (
	"bytes"
	"errors"
	"fmt"
	"math/rand"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

// setStallTuning moves the three constants behind the stall check so a test can
// reach an edge in milliseconds instead of minutes. It takes the lock because
// the leg readers are already running by the time a session hands one out.
func (b *reorderBuffer) setStallTuning(grace time.Duration, overdraft int, gap time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.stallGrace = grace
	b.overdraftLimit = overdraft
	b.gapTimeout = gap
	b.space.Broadcast()
}

func TestReorderBufferKeepsMovingWhenTheNextChunkIsBehindABlockedReader(t *testing.T) {
	// 卡死的形状：缓冲满了，下一个该交付的分片(0)还没到，而它就排在**某条腿
	// 已经挂住的读取者后面** —— 读取者一天不返回，0 号就一天交不出来。
	//
	// 这里用一个协程按顺序推 [4, 0, ...] 来还原那条腿上的队列：4 号推不进去,
	// 0 号就轮不到。老实现会在 4 号上无限等，整条流从此不动。
	buffer := newReorderBuffer(2)
	buffer.setStallTuning(20*time.Millisecond, multipathReorderOverdraftChunks, multipathReorderGapTimeout)
	for _, seq := range []uint64{1, 2} {
		if err := buffer.push(seq, []byte{byte(seq)}); err != nil {
			t.Fatalf("push %d: %v", seq, err)
		}
	}

	go func() {
		for _, seq := range []uint64{4, 0, 3, 5, 6} {
			if err := buffer.push(seq, []byte{byte(seq)}); err != nil {
				t.Errorf("push %d: %v", seq, err)
				return
			}
		}
		buffer.setFinal(7)
	}()

	drained := make(chan []uint64, 1)
	go func() {
		var order []uint64
		for {
			chunk, err := buffer.pop()
			if err != nil {
				t.Errorf("pop: %v", err)
				drained <- order
				return
			}
			if len(chunk) == 0 {
				drained <- order
				return
			}
			order = append(order, uint64(chunk[0]))
		}
	}()

	select {
	case order := <-drained:
		want := []uint64{0, 1, 2, 3, 4, 5, 6}
		if fmt.Sprint(order) != fmt.Sprint(want) {
			t.Fatalf("stream came out as %v, want %v", order, want)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("流卡死了：0 号分片排在挂住的读取者后面，缓冲一直没让出位置")
	}

	// 走出僵局靠的就是越界收下 4 号。这里要是 0，说明用例没逼出那个局面,
	// 上面的通过也就不算证据。
	if buffer.overdraftCount() == 0 {
		t.Fatal("没有一次越界：这条用例已经盯不住那个卡死点了")
	}
}

func TestReorderBufferCapsHowFarPastTheBoundItWillGo(t *testing.T) {
	// 越界是为了别把健康的链路一起冻住，不是无限收：到顶了就回去等，由超时兜底。
	// 这条钉的是上限本身 —— 超时设得足够长，确保这里量到的是越界上限不是超时。
	buffer := newReorderBuffer(4)
	const overdraft = 8
	buffer.setStallTuning(5*time.Millisecond, overdraft, time.Minute)
	ceiling := 4 + overdraft

	// 0 号永远不来，1..ceiling 全靠越界收下。
	for seq := 1; seq <= ceiling; seq++ {
		if err := buffer.push(uint64(seq), []byte{byte(seq)}); err != nil {
			t.Fatalf("push %d: %v", seq, err)
		}
	}
	blocked := make(chan error, 1)
	go func() { blocked <- buffer.push(uint64(ceiling+1), []byte{0}) }()
	select {
	case err := <-blocked:
		t.Fatalf("越界没有上限：缓冲又收下了一片（%v）", err)
	case <-time.After(200 * time.Millisecond):
	}
	if got := buffer.pendingCount(); got != ceiling {
		t.Fatalf("the buffer should stop at %d chunks, held %d", ceiling, got)
	}

	// 0 号一到，消费者就能把缓冲排回上限以内，顶在这儿的那片也就该放行了 ——
	// 这时候它退回的是**普通背压**，等的是空位，不再是那个永远不来的序号。
	if err := buffer.push(0, []byte{0}); err != nil {
		t.Fatalf("push of the next-due chunk: %v", err)
	}
	for popped := 0; popped < ceiling; popped++ {
		if _, err := buffer.pop(); err != nil {
			t.Fatalf("pop: %v", err)
		}
	}
	select {
	case err := <-blocked:
		if err != nil {
			t.Fatalf("blocked push: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("排空之后，顶在越界上限的生产者始终没被放行")
	}
}

func TestReorderBufferGivesUpOnceALegStopsDeliveringAltogether(t *testing.T) {
	// 那一片永远不会来的时候，唯一的出路是认账：带着原因收掉，让上层重连。
	// 两端一起干挂着、连个错都没有，才是最糟的结果。
	buffer := newReorderBuffer(4)
	buffer.setStallTuning(5*time.Millisecond, 8, 150*time.Millisecond)

	consumed := make(chan error, 1)
	go func() {
		_, err := buffer.pop()
		consumed <- err
	}()

	pushed := make(chan error, 1)
	go func() {
		for seq := 1; seq <= 4+8+2; seq++ {
			if err := buffer.push(uint64(seq), []byte{byte(seq)}); err != nil {
				pushed <- err
				return
			}
		}
		pushed <- nil
	}()
	select {
	case err := <-pushed:
		if !errors.Is(err, errMultipathReorderGap) {
			t.Fatalf("expected the buffer to give up, got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("那一片永远不会来了，缓冲却还在等：这条流没有任何结局")
	}
	// 消费者也要拿到同一个原因，而不是继续干等。
	select {
	case err := <-consumed:
		if !errors.Is(err, errMultipathReorderGap) {
			t.Fatalf("expected the consumer to see the same reason, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("给出去的原因没有叫醒消费者")
	}
}

// tightBoundExchange runs one whole stream over a deliberately cramped session
// and reports how often the reorder buffer had to exceed its bound.
func tightBoundExchange(t *testing.T, seed int64, chunkCount int) uint64 {
	t.Helper()
	pair := newMultipathTestPair(t, 4, 2)

	source := rand.New(rand.NewSource(seed))
	var expected bytes.Buffer
	chunks := make([][]byte, 0, chunkCount)
	for i := 0; i < chunkCount; i++ {
		chunk := make([]byte, 1+source.Intn(700))
		source.Read(chunk)
		chunks = append(chunks, chunk)
		expected.Write(chunk)
	}
	killAt := chunkCount / 4 * (1 + int(seed%3))

	received := make(chan []byte, 1)
	go func() {
		data, _ := drainStream(pair.server)
		received <- data
	}()
	sent := make(chan error, 1)
	go func() {
		for i, chunk := range chunks {
			if i == killAt {
				// 半路掐掉一条腿：它手上的分片会被退回队列重派，接收端于是拿到
				// 一个**落在后面**的序号 —— 正是把下一个该交付的分片顶到挂住的
				// 读取者身后的那一手。
				_ = pair.client.legs[2].sec.conn.Close()
				_ = pair.server.legs[2].sec.conn.Close()
			}
			if err := pair.client.writeFrame(chunk); err != nil {
				sent <- fmt.Errorf("writeFrame %d: %w", i, err)
				return
			}
		}
		sent <- pair.client.writeFrame(nil)
	}()

	select {
	case err := <-sent:
		if err != nil {
			t.Fatalf("seed %d: send: %v", seed, err)
		}
	case <-time.After(20 * time.Second):
		t.Fatalf("seed %d: 发送端卡死了：接收端的读取者全挂在重排缓冲上，链路再也吞不下东西", seed)
	}
	select {
	case got := <-received:
		if !bytes.Equal(got, expected.Bytes()) {
			t.Fatalf("seed %d: stream corrupted under a tight bound: got %d bytes, want %d", seed, len(got), expected.Len())
		}
	case <-time.After(20 * time.Second):
		t.Fatalf("seed %d: 接收端卡死了：下一个该交付的分片排在挂住的读取者后面", seed)
	}
	return pair.server.reorder.overdraftCount()
}

func TestMultipathSessionSurvivesATightReorderBound(t *testing.T) {
	// 端到端的同一件事：四条腿、缓冲只放得下 2 片、中途掐掉一条腿。
	//
	// 这是修复前会挂死的那个形状。挂不挂得看调度怎么排 —— 单跑一轮只有约四分之一
	// 的概率撞上，所以这里换一批种子连跑 24 轮，漏检率压到千分之一以下。挂死时
	// 连发送端的 writeFrame 都退不出来，所以收发都放在协程里，由超时来判。
	var overdrafts uint64
	for round := 0; round < 24; round++ {
		overdrafts += tightBoundExchange(t, int64(20260920+round), 400)
	}
	// 一次都没越界，说明这批用例已经逼不出那个局面了 —— 上面的「全都过了」
	// 也就不能再当作证据。
	if overdrafts == 0 {
		t.Fatal("没有一轮把缓冲逼到越界：这组用例已经盯不住那个卡死点了")
	}
	t.Logf("tight-bound rounds exceeded the reorder bound %d times", overdrafts)
}

// blackHoleConn is a leg that stays up but stops reading: the TCP connection
// is fine, the peer just never takes anything off it again. A congested relay,
// a hung process behind one, or a middlebox that drops the flow without an RST
// all look like this from here, and none of them surface as a read or write
// error at either end.
type blackHoleConn struct {
	net.Conn
	swallow atomic.Bool
	forever chan struct{}
}

func (c *blackHoleConn) Read(p []byte) (int, error) {
	if c.swallow.Load() {
		<-c.forever
	}
	return c.Conn.Read(p)
}

// newBlackHolePair wires up a multipath pair whose leg `blackHole` can be told
// to stop reading mid-stream.
func newBlackHolePair(t *testing.T, legCount, maxPending, blackHole int) (*multipathSession, *multipathSession, *blackHoleConn) {
	t.Helper()
	salt := make([]byte, fxpSaltSize)
	for i := range salt {
		salt[i] = byte(i + 3)
	}
	var clientConns, serverConns []*secureConn
	var labels []string
	var hole *blackHoleConn
	for i := 0; i < legCount; i++ {
		clientSide, serverSide := net.Pipe()
		var exitSide net.Conn = serverSide
		if i == blackHole {
			hole = &blackHoleConn{Conn: serverSide, forever: make(chan struct{})}
			exitSide = hole
		}
		entrySec, err := newSessionSecureConn(clientSide, "black-hole-test-key", salt, true)
		if err != nil {
			t.Fatalf("entry secure conn %d: %v", i, err)
		}
		exitSec, err := newSessionSecureConn(exitSide, "black-hole-test-key", salt, false)
		if err != nil {
			t.Fatalf("exit secure conn %d: %v", i, err)
		}
		clientConns = append(clientConns, entrySec)
		serverConns = append(serverConns, exitSec)
		labels = append(labels, fmt.Sprintf("leg-%d", i))
	}
	client := newMultipathSession(multipathLegsFromSecureConns(clientConns, labels), maxPending)
	server := newMultipathSession(multipathLegsFromSecureConns(serverConns, labels), maxPending)
	t.Cleanup(func() {
		client.closeTransport()
		server.closeTransport()
	})
	return client, server, hole
}

func TestMultipathSessionResetsWhenOneLegBlackHolesAtTheDefaultBound(t *testing.T) {
	/*
	   这条盯的是**出厂默认**下的行为，不是极端参数。

	   面板从来不下发 multipathMaxPending，所以线上跑的永远是默认的 1024。一条腿
	   活着但不再读（拥堵的中转、卡死的进程、静默丢包的中间设备），另外几条腿照跑，
	   重排缓冲很快就被顶满 —— 从此：
	     · 消费者等着那条腿欠的分片；
	     · 各腿的读取者等着缓冲让位；
	     · 对端的写入者等着没人读的链路。
	   三头互相等，两端都不报错，连接就这么一直挂着。

	   现在的要求是：一定要有个结局。要么继续把流拼完，要么带着原因收掉让上层重连，
	   但不能没有下文。
	*/
	client, server, hole := newBlackHolePair(t, 4, multipathMaxPendingChunks, 2)
	// 超时缩短到两秒，量的是「会不会有结局」，不是要等满 15 秒。
	server.reorder.setStallTuning(multipathReorderStallGrace, multipathReorderOverdraftChunks, 2*time.Second)

	drained := make(chan error, 1)
	go func() {
		_, err := drainStream(server)
		drained <- err
	}()

	sent := make(chan error, 1)
	go func() {
		payload := bytes.Repeat([]byte("x"), 64)
		for i := 0; i < 8000; i++ {
			if i == 20 {
				hole.swallow.Store(true)
			}
			if err := client.writeFrame(payload); err != nil {
				sent <- err
				return
			}
		}
		sent <- client.writeFrame(nil)
	}()

	select {
	case <-sent:
		// 送完了也算有结局：说明缓冲没把发送端顶死。
	case <-time.After(30 * time.Second):
		t.Fatalf("发送端永久卡死：默认上限 %d，缓冲里 %d 片，还在等 seq %d",
			multipathMaxPendingChunks, server.reorder.pendingCount(), server.reorder.delivered())
	}
	select {
	case err := <-drained:
		if err != nil && !errors.Is(err, errMultipathReorderGap) {
			t.Fatalf("expected the stream to finish or to report the gap, got %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("接收端永久卡死：缓冲里 %d 片，还在等 seq %d，越界 %d 次",
			server.reorder.pendingCount(), server.reorder.delivered(), server.reorder.overdraftCount())
	}
}

func TestMultipathPendingLimitFloorsATinyPanelValue(t *testing.T) {
	// 面板那边看不见链路上压着多少分片，填个 1、2 只会让接收端每片都越界收，
	// 省不下内存反而更慢。
	if got := multipathPendingLimit(config{MultipathMaxPending: 2}); got != multipathMinPendingChunks {
		t.Fatalf("a bound of 2 should be floored to %d, got %d", multipathMinPendingChunks, got)
	}
	if got := multipathPendingLimit(config{MultipathMaxPending: 0}); got != multipathMaxPendingChunks {
		t.Fatalf("an unset bound should default to %d, got %d", multipathMaxPendingChunks, got)
	}
	if got := multipathPendingLimit(config{MultipathMaxPending: 4096}); got != 4096 {
		t.Fatalf("a deliberate large bound must be honoured, got %d", got)
	}
}
