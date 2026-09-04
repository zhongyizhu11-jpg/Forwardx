package main

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestMultipathFrameRoundTrip(t *testing.T) {
	encoded := encodeMultipathFrame(multipathKindData, 42, []byte("hello"))
	if len(encoded) != multipathHeaderSize+5 {
		t.Fatalf("unexpected encoded length %d", len(encoded))
	}
	decoded, err := decodeMultipathFrame(encoded)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded.kind != multipathKindData || decoded.seq != 42 || string(decoded.payload) != "hello" {
		t.Fatalf("unexpected frame %+v", decoded)
	}
}

func TestMultipathFinFrameCarriesTotalCount(t *testing.T) {
	decoded, err := decodeMultipathFrame(encodeMultipathFrame(multipathKindFin, 7, nil))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded.kind != multipathKindFin || decoded.seq != 7 || len(decoded.payload) != 0 {
		t.Fatalf("unexpected fin frame %+v", decoded)
	}
}

func TestMultipathFrameRejectsMalformedInput(t *testing.T) {
	if _, err := decodeMultipathFrame([]byte{0, 1, 2}); !errors.Is(err, errMultipathShortFrame) {
		t.Fatalf("expected short frame error, got %v", err)
	}
	bad := encodeMultipathFrame(multipathKindData, 1, nil)
	bad[0] = 9
	if _, err := decodeMultipathFrame(bad); !errors.Is(err, errMultipathBadKind) {
		t.Fatalf("expected bad kind error, got %v", err)
	}
}

func TestReorderBufferDeliversInSequenceOrder(t *testing.T) {
	buffer := newReorderBuffer(16)
	// Push out of order, as separate legs would.
	if err := buffer.push(2, []byte("c")); err != nil {
		t.Fatalf("push: %v", err)
	}
	if err := buffer.push(0, []byte("a")); err != nil {
		t.Fatalf("push: %v", err)
	}
	if err := buffer.push(1, []byte("b")); err != nil {
		t.Fatalf("push: %v", err)
	}
	buffer.setFinal(3)

	for _, want := range []string{"a", "b", "c"} {
		got, err := buffer.pop()
		if err != nil {
			t.Fatalf("pop: %v", err)
		}
		if string(got) != want {
			t.Fatalf("expected %q, got %q", want, got)
		}
	}
	end, err := buffer.pop()
	if err != nil {
		t.Fatalf("pop end: %v", err)
	}
	if end == nil || len(end) != 0 {
		t.Fatalf("expected empty non-nil end marker, got %v", end)
	}
}

func TestReorderBufferDropsDuplicateAndAlreadyDeliveredChunks(t *testing.T) {
	buffer := newReorderBuffer(16)
	if err := buffer.push(0, []byte("a")); err != nil {
		t.Fatalf("push: %v", err)
	}
	// A leg retry can resend the same chunk before it is consumed.
	if err := buffer.push(0, []byte("different")); err != nil {
		t.Fatalf("duplicate push: %v", err)
	}
	if buffer.pendingCount() != 1 {
		t.Fatalf("expected the duplicate to be dropped, pending=%d", buffer.pendingCount())
	}
	got, err := buffer.pop()
	if err != nil {
		t.Fatalf("pop: %v", err)
	}
	if string(got) != "a" {
		t.Fatalf("expected the first copy to win, got %q", got)
	}
	// A retry that lands after delivery must not reappear in the stream.
	if err := buffer.push(0, []byte("late")); err != nil {
		t.Fatalf("late push: %v", err)
	}
	if buffer.pendingCount() != 0 {
		t.Fatalf("expected the late duplicate to be dropped, pending=%d", buffer.pendingCount())
	}
}

func TestReorderBufferCopiesPayloadSoCallerBuffersCanBeReused(t *testing.T) {
	buffer := newReorderBuffer(4)
	scratch := []byte("abc")
	if err := buffer.push(0, scratch); err != nil {
		t.Fatalf("push: %v", err)
	}
	copy(scratch, "xyz")
	got, err := buffer.pop()
	if err != nil {
		t.Fatalf("pop: %v", err)
	}
	if string(got) != "abc" {
		t.Fatalf("expected the buffer to keep its own copy, got %q", got)
	}
}

func TestReorderBufferBlocksProducersAtTheBound(t *testing.T) {
	buffer := newReorderBuffer(2)
	// Seq 0 is missing, so these two occupy the whole bound.
	if err := buffer.push(1, []byte("b")); err != nil {
		t.Fatalf("push: %v", err)
	}
	if err := buffer.push(2, []byte("c")); err != nil {
		t.Fatalf("push: %v", err)
	}

	blocked := make(chan error, 1)
	go func() { blocked <- buffer.push(3, []byte("d")) }()
	select {
	case <-blocked:
		t.Fatal("push past the bound should block")
	case <-time.After(50 * time.Millisecond):
	}

	// The chunk due next is accepted even at the bound, so delivery can drain.
	if err := buffer.push(0, []byte("a")); err != nil {
		t.Fatalf("push of the next-due chunk: %v", err)
	}
	// Draining back below the bound is what releases the producer; a single pop
	// only undoes the over-bound admission above.
	for i := 0; i < 2; i++ {
		if _, err := buffer.pop(); err != nil {
			t.Fatalf("pop: %v", err)
		}
	}
	select {
	case err := <-blocked:
		if err != nil {
			t.Fatalf("blocked push: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("draining the buffer should release the blocked producer")
	}
}

func TestReorderBufferCloseWakesBlockedCallers(t *testing.T) {
	buffer := newReorderBuffer(1)
	popped := make(chan error, 1)
	go func() {
		_, err := buffer.pop()
		popped <- err
	}()
	// Let the consumer reach its wait before closing.
	time.Sleep(20 * time.Millisecond)
	sentinel := errors.New("leg loss")
	buffer.close(sentinel)

	select {
	case err := <-popped:
		if !errors.Is(err, sentinel) {
			t.Fatalf("expected the close reason, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("close should wake a blocked consumer")
	}
	if err := buffer.push(5, []byte("x")); !errors.Is(err, sentinel) {
		t.Fatalf("expected push after close to report the reason, got %v", err)
	}
}

func TestReorderBufferEndsStreamWhenFinalArrivesBeforeChunks(t *testing.T) {
	buffer := newReorderBuffer(8)
	buffer.setFinal(1)
	done := make(chan []byte, 1)
	go func() {
		got, err := buffer.pop()
		if err != nil {
			t.Errorf("pop: %v", err)
		}
		done <- got
	}()
	// The consumer must wait for the outstanding chunk, not end early.
	select {
	case <-done:
		t.Fatal("stream ended before the final chunk arrived")
	case <-time.After(50 * time.Millisecond):
	}
	if err := buffer.push(0, []byte("a")); err != nil {
		t.Fatalf("push: %v", err)
	}
	select {
	case got := <-done:
		if string(got) != "a" {
			t.Fatalf("expected the outstanding chunk, got %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("the outstanding chunk should be delivered")
	}
}

func TestReorderBufferHandlesConcurrentLegProducers(t *testing.T) {
	const total = 2000
	buffer := newReorderBuffer(64)
	var wg sync.WaitGroup
	// Three legs pushing interleaved chunks, as the real striping does.
	for leg := 0; leg < 3; leg++ {
		wg.Add(1)
		go func(leg int) {
			defer wg.Done()
			for seq := leg; seq < total; seq += 3 {
				payload := []byte{byte(seq), byte(seq >> 8)}
				if err := buffer.push(uint64(seq), payload); err != nil {
					t.Errorf("push %d: %v", seq, err)
					return
				}
			}
		}(leg)
	}
	go func() {
		wg.Wait()
		buffer.setFinal(total)
	}()

	for seq := 0; seq < total; seq++ {
		got, err := buffer.pop()
		if err != nil {
			t.Fatalf("pop %d: %v", seq, err)
		}
		if len(got) != 2 || got[0] != byte(seq) || got[1] != byte(seq>>8) {
			t.Fatalf("chunk %d arrived out of order: %v", seq, got)
		}
	}
	end, err := buffer.pop()
	if err != nil {
		t.Fatalf("pop end: %v", err)
	}
	if len(end) != 0 {
		t.Fatalf("expected the end marker, got %v", end)
	}
	if buffer.delivered() != total {
		t.Fatalf("expected %d delivered, got %d", total, buffer.delivered())
	}
}
