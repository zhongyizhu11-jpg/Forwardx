package main

import (
	"errors"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

// 主用出口「端口开着但进程不响应」：TCP 连得上，握手没有任何回音。
// 这是最常见的半死形态 —— 进程卡住、LB 把连接收下但后端已经没了、
// 中间设备静默丢包。问题是：切到备用要等多久？
func TestEntryFallsBackQuicklyWhenThePrimaryExitBlackHoles(t *testing.T) {
	// 回声目标
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	go func() {
		for {
			c, e := target.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	targetPort := target.Addr().(*net.TCPAddr).Port

	// 黑洞主用：只 accept，什么都不回
	hole, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer hole.Close()
	holePort := hole.Addr().(*net.TCPAddr).Port
	// 握着不放，一个字节都不回。用带缓冲的通道存着，既不让它们被回收关掉，
	// 也不引入跨协程共享的切片。
	held := make(chan net.Conn, 64)
	go func() {
		for {
			c, e := hole.Accept()
			if e != nil {
				return
			}
			select {
			case held <- c:
			default:
				_ = c.Close()
			}
		}
	}()

	key := "blackhole-exit-key"
	backupPort := freeTCPUDPPort(t)
	entryPort := freeTCPUDPPort(t)
	exitDone := make(chan struct{})
	entryDone := make(chan struct{})
	defer close(exitDone)
	defer close(entryDone)
	go func() {
		_ = runExit(exitDone, config{
			Role: "exit", TunnelID: 81, ListenPort: backupPort, Protocol: "tcp", Key: key,
		})
	}()
	waitForTCP(t, backupPort)
	go func() {
		_ = runEntry(entryDone, config{
			Role: "entry", TunnelID: 81, RuleID: 82,
			ListenPort: entryPort, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: holePort,
			ExitStrategy: "fallback",
			Exits:        []exitEndpoint{{Host: "127.0.0.1", Port: backupPort, Key: key}},
			TargetIP:     "127.0.0.1", TargetPort: targetPort,
			Key: key,
		})
	}()
	waitForTCP(t, entryPort)

	roundTrip := func(label string) time.Duration {
		start := time.Now()
		c, dialErr := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 60*time.Second)
		if dialErr != nil {
			t.Fatalf("%s dial: %v", label, dialErr)
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(60 * time.Second))
		if _, e := c.Write([]byte("ping")); e != nil {
			t.Fatalf("%s write: %v", label, e)
		}
		reply := make([]byte, 4)
		if _, e := io.ReadFull(c, reply); e != nil {
			t.Fatalf("%s read: %v", label, e)
		}
		if string(reply) != "ping" {
			t.Fatalf("%s reply %q", label, reply)
		}
		return time.Since(start)
	}

	first := roundTrip("第一条")
	second := roundTrip("第二条")
	t.Logf("主用是黑洞时：第一条连接 %v，紧接着第二条 %v", first.Round(time.Millisecond), second.Round(time.Millisecond))

	// 第一条必然要付一次握手超时 —— 主用是配置里的首选，总得先发现它死了。
	// 但只该付**一次**：以前会换个兼容上下文再等满一遍，硬生生翻倍。
	if first > fxpHandshakeTimeout+5*time.Second {
		t.Fatalf("切备用花了 %v，超过一次握手超时(%v)太多 —— 多半是又拿兼容上下文重等了一遍",
			first.Round(time.Millisecond), fxpHandshakeTimeout)
	}
	if second > time.Second {
		t.Fatalf("主用已经标记不健康了，第二条还花了 %v", second.Round(time.Millisecond))
	}

	// 过了重试窗口再来一条。以前这里会重新拿用户的连接去探那个死节点，
	// 于是又是满满一次 20 秒 —— 稳定流量下等于每隔几秒就有人卡二十秒。
	time.Sleep(fxpFallbackRetry + 500*time.Millisecond)
	third := roundTrip("窗口过后")
	t.Logf("健康重试窗口(%v)过后再来一条：%v", fxpFallbackRetry, third.Round(time.Millisecond))
	if third > time.Second {
		t.Fatalf("重试窗口过后那条连接花了 %v —— 探测又跑回用户路径上了", third.Round(time.Millisecond))
	}
}

func TestFallbackRetryBacksOffWhileAnEndpointStaysDown(t *testing.T) {
	// 探一次连得上但不回话的出口要等满一个握手超时。固定几秒去探一次，
	// 等于把时间都花在探一个死节点上。
	if got := fallbackRetryDelay(1); got != fxpFallbackRetry {
		t.Fatalf("第一次失败应该按基准等 %v，得到 %v", fxpFallbackRetry, got)
	}
	if fallbackRetryDelay(2) <= fallbackRetryDelay(1) {
		t.Fatal("连着失败，间隔应该越拉越长")
	}
	if got := fallbackRetryDelay(100); got != fxpFallbackRetryMax {
		t.Fatalf("退避要封顶在 %v，得到 %v", fxpFallbackRetryMax, got)
	}
	if fxpFallbackRetryMax <= fxpHandshakeTimeout {
		t.Fatalf("退避上限(%v)不该小于一次探测的代价(%v)，否则大半时间都在探死节点",
			fxpFallbackRetryMax, fxpHandshakeTimeout)
	}
}

func TestExitSelectorKeepsAFailedEndpointOffTheUserPath(t *testing.T) {
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 2}},
		exitEndpoint{Host: "127.0.0.1", Port: 1},
		"fallback",
	)
	selector.markFailure(0, errTestEndpointDown)

	// 「到点了」不等于「可以用了」：还有健康的可用时，坏节点不该再被派给用户。
	selector.mu.Lock()
	selector.retryAfter[0] = time.Now().Add(-time.Hour)
	selector.mu.Unlock()
	if _, index, ok := selector.pick(nil); !ok || index != 1 {
		t.Fatalf("坏节点又被派给用户连接了：index=%d ok=%v", index, ok)
	}

	// 但它必须能被后台探测认领，而且一次只认领一个。
	endpoint, index, ok := selector.claimProbe(time.Now())
	if !ok || index != 0 || endpoint.Port != 1 {
		t.Fatalf("后台探测没认领到那个坏节点：index=%d ok=%v", index, ok)
	}
	if _, _, again := selector.claimProbe(time.Now()); again {
		t.Fatal("同一个坏节点被认领了两次 —— 一堆连接会一起往死节点上撞")
	}
	selector.releaseProbe(index)

	// 探通了就该回到用户路径上；fallback 策略会重新优先用它。
	selector.markHealthy(0)
	if _, back, ok := selector.pick(nil); !ok || back != 0 {
		t.Fatalf("探通之后没有回到首选：index=%d ok=%v", back, ok)
	}
	selector.mu.Lock()
	failures := selector.failures[0]
	selector.mu.Unlock()
	if failures != 0 {
		t.Fatalf("恢复健康之后失败计数没清零：%d", failures)
	}
}

func TestExitSelectorStillUsesADownEndpointWhenNothingElseIsLeft(t *testing.T) {
	// 全都挂了的时候不能挑不出来 —— 那就等于直接拒绝服务。
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 2}},
		exitEndpoint{Host: "127.0.0.1", Port: 1},
		"fallback",
	)
	selector.markFailure(0, errTestEndpointDown)
	selector.markFailure(1, errTestEndpointDown)
	if _, _, ok := selector.pick(nil); !ok {
		t.Fatal("所有出口都不健康时挑不出端点，等于直接断服")
	}
}

var errTestEndpointDown = errors.New("endpoint down")

func TestExitSelectorStillRecoversWhereNothingProbes(t *testing.T) {
	/*
	   不是每条路都有后台探测可用。

	   UDP 直连那条路根本不拨号 —— 它只做一次地址解析就发包，没有「握手」这回事，
	   也就没有探测可言。所以「挂过、但冷却已经到期」这一档不能干脆去掉：真去掉了，
	   一次 DNS 抖动就能把那条规则的出口**永久**停用，而且日志上只会看到一次很久
	   以前的失败。

	   这条钉的就是这一档确实还在：两个出口都不健康，只有一个冷却到期，那就必须
	   挑到期的那个，而不是靠「全都不健康就随便选一个」的兜底撞上去。
	*/
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 2}},
		exitEndpoint{Host: "127.0.0.1", Port: 1},
		"fallback",
	)
	selector.markFailure(0, errTestEndpointDown)
	selector.markFailure(1, errTestEndpointDown)
	selector.mu.Lock()
	selector.retryAfter[0] = time.Now().Add(time.Hour)  // 首选还在冷却里
	selector.retryAfter[1] = time.Now().Add(-time.Hour) // 备用冷却到期了
	selector.mu.Unlock()

	if _, index, ok := selector.pick(nil); !ok || index != 1 {
		t.Fatalf("冷却到期的那个没被挑中：index=%d ok=%v —— 没有探测的路子就再也回不来了", index, ok)
	}
}
