package main

import (
	"math/rand"
	"testing"
	"time"
)

// 预算的不变量：任何时刻
//
//	已占用 == 各队列里排着的字节 + 已取出但还没 done() 的字节 + 重组中的字节
//
// 只要有一条路径借了不还，规则的 16MB 额度就会一点点缩水，直到这条规则再也
// 转发不了 UDP —— 而界面上什么都看不出来。
func TestUDPQueueBudgetNeverLeaksOrOvercharges(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(1 << 20)
	budget := newFXPUDPQueueRuleBudget(process, 1<<20)
	queues := []*fxpUDPQueue{
		newFXPUDPQueueWithBudget(8, 4096, budget),
		newFXPUDPQueueWithBudget(4, 2048, budget),
	}
	done := make(chan struct{})
	var leases []fxpUDPQueuedPacket
	var enqueued, dequeued, dropped int

	source := rand.New(rand.NewSource(11))
	for step := 0; step < 20000; step++ {
		switch source.Intn(10) {
		case 0, 1, 2, 3, 4, 5:
			q := queues[source.Intn(len(queues))]
			size := 1 + source.Intn(900)
			enqueued++
			if q.enqueue(make([]byte, size)) {
				dropped++
			}
		case 6, 7:
			q := queues[source.Intn(len(queues))]
			if q.pending() == 0 {
				continue
			}
			if packet, ok := q.nextTracked(done, nil); ok {
				dequeued++
				if source.Intn(2) == 0 {
					packet.done()
				} else {
					leases = append(leases, packet)
				}
			}
		case 8:
			if len(leases) > 0 {
				i := source.Intn(len(leases))
				leases[i].done()
				leases = append(leases[:i], leases[i+1:]...)
			}
		case 9:
			queues[source.Intn(len(queues))].clear()
		}

		queued := 0
		for _, q := range queues {
			queued += q.bytes()
		}
		outstanding := 0
		for i := range leases {
			if !leases[i].leaseDone {
				outstanding += leases[i].leaseBytes
			}
		}
		if got, want := budget.usedBytes(), int64(queued+outstanding); got != want {
			t.Fatalf("第 %d 步账就对不上了：已占用 %d，实际持有 %d（排队 %d + 在途 %d）",
				step, got, want, queued, outstanding)
		}
	}

	for _, q := range queues {
		q.close()
	}
	for i := range leases {
		leases[i].done()
	}
	if got := budget.usedBytes(); got != 0 {
		t.Fatalf("全部收干净之后还欠着 %d 字节 —— 这条规则的额度就这么缩水了", got)
	}
	if got := process.usedBytes(); got != 0 {
		t.Fatalf("进程级预算还欠着 %d 字节", got)
	}
	// 没跑到溢出丢包那条路，这组随机就白跑了：借还不平最容易出在那儿。
	if enqueued < 1000 || dequeued < 200 || dropped < 200 {
		t.Fatalf("这组随机没把该走的路走到：入队 %d、出队 %d、挤掉 %d", enqueued, dequeued, dropped)
	}
}

func TestUDPFragmentBudgetNeverLeaksOrOvercharges(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(1 << 20)
	budget := newFXPUDPQueueRuleBudget(process, 1<<20)
	r := &udpFragmentReassembler{}
	r.bindBudget(budget)
	replay := &udpReplayWindow{}

	// 造**连贯**的分片组：序号递增（否则重放窗口一挡就永远拼不成），每组的
	// 分片数固定（否则每来一包都和已有的对不上，当场作废）。几组交错着发，
	// 再时不时掺进重复片、分片数对不上的片、超长片、过期和清空。
	type pendingSet struct {
		sequence  uint64
		fragments uint8
		left      []uint8
	}
	var inFlight []*pendingSet
	var nextSequence uint64
	var completed, held, mismatched, duplicated int

	source := rand.New(rand.NewSource(23))
	emit := func(packet fxpUDPPacket) {
		if _, ok := r.accept(packet, replay); ok {
			completed++
		}
		r.mu.Lock()
		want := 0
		for _, assembly := range r.pending {
			want += assembly.total
		}
		pending := len(r.pending)
		r.mu.Unlock()
		if pending > 0 {
			held++
		}
		if got := budget.usedBytes(); got != int64(want) {
			t.Fatalf("账对不上：已占用 %d，重组里实际压着 %d", got, want)
		}
	}

	for step := 0; step < 20000; step++ {
		if len(inFlight) < 4 && source.Intn(3) == 0 {
			count := uint8(1 + source.Intn(5))
			set := &pendingSet{sequence: nextSequence, fragments: count}
			nextSequence++
			for i := uint8(0); i < count; i++ {
				set.left = append(set.left, i)
			}
			inFlight = append(inFlight, set)
		}
		if len(inFlight) == 0 {
			continue
		}
		pick := source.Intn(len(inFlight))
		set := inFlight[pick]
		index := source.Intn(len(set.left))
		fragment := set.left[index]
		packet := fxpUDPPacket{
			sequence:  set.sequence,
			fragment:  fragment,
			fragments: set.fragments,
			payload:   make([]byte, 1+source.Intn(400)),
		}
		switch source.Intn(24) {
		case 0: // 分片数对不上：整组当场作废
			packet.fragments = set.fragments%5 + 1
			if packet.fragments != set.fragments {
				mismatched++
				emit(packet)
				inFlight = append(inFlight[:pick], inFlight[pick+1:]...)
				continue
			}
		case 1: // 重复片
			duplicated++
			emit(packet)
			emit(packet)
		case 2:
			r.expire(time.Now().Add(2 * fxpUDPFragmentTimeout))
			inFlight = nil
			continue
		case 3:
			r.clear()
			inFlight = nil
			continue
		case 4: // 超长片
			packet.payload = make([]byte, fxpUDPFragmentPayloadSize+1)
			emit(packet)
			continue
		}
		emit(packet)
		set.left = append(set.left[:index], set.left[index+1:]...)
		if len(set.left) == 0 {
			inFlight = append(inFlight[:pick], inFlight[pick+1:]...)
		}
	}
	// 没真的拼成过整包、没攒过、没走过那几条出错路，这组就是空转。
	if completed < 200 || held < 2000 || mismatched < 20 || duplicated < 20 {
		t.Fatalf("这组随机没把该走的路走到：拼成 %d、攒过 %d、分片数对不上 %d、重复 %d",
			completed, held, mismatched, duplicated)
	}
	r.clear()
	if got := budget.usedBytes(); got != 0 {
		t.Fatalf("重组器收干净之后还欠着 %d 字节（还挂着 %d 组）", got, r.pendingCount())
	}
	if got := process.usedBytes(); got != 0 {
		t.Fatalf("进程级预算还欠着 %d 字节", got)
	}
}
