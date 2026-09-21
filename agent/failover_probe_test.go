package main

import (
	"net"
	"strconv"
	"testing"
	"time"
)

/*
主备的健康检查探哪儿。

检查就是对出站地址连一次 TCP。出站是 iptables/DNAT 类中转时，握手实际是和最终落地
完成的，这一连就是端到端的；出站是 gost、realm 这类用户态转发时，中转在本地就把连接
收下了 —— 连得上只能证明中转活着，证明不了它到落地那一段还通。

后一种情况下中转的上游断了，主备**不会切**：流量继续往一条死路里送，而面板上一切
正常。ProbeIP/ProbePort 就是给这个盲区留的出口：把探测指向一个能反映整条路径的端口。
*/

func TestFailoverProbeEndpointFallsBackToTarget(t *testing.T) {
	target := failoverTarget{TargetIP: "10.0.0.1", TargetPort: 80}
	host, port := target.probeEndpoint()
	if host != "10.0.0.1" || port != 80 {
		t.Fatalf("没填探测目标时应当探出站地址本身，拿到 %s:%d", host, port)
	}

	withProbe := failoverTarget{TargetIP: "10.0.0.1", TargetPort: 80, ProbeIP: "10.0.0.1", ProbePort: 9000}
	host, port = withProbe.probeEndpoint()
	if host != "10.0.0.1" || port != 9000 {
		t.Fatalf("填了探测目标就该探它，拿到 %s:%d", host, port)
	}
}

func TestNormalizeFailoverSpecDropsBadProbe(t *testing.T) {
	// 填错的探测地址退回「探出站本身」。不能因为一个填错的地址，
	// 就让这条出站永远探不通、被当成挂了 —— 那是把兜底功能变成故障源。
	spec := normalizeFailoverSpec(failoverSpec{
		Enabled:     true,
		ListenPort:  1234,
		BindAddress: "127.0.0.1",
		Targets: []failoverTarget{
			{TargetIP: "10.0.0.1", TargetPort: 80, ProbeIP: "10.0.0.1", ProbePort: 70000},
			{TargetIP: "10.0.0.2", TargetPort: 80, ProbeIP: "  ", ProbePort: 9000},
			{TargetIP: "10.0.0.3", TargetPort: 80, ProbeIP: "10.0.0.3", ProbePort: 9000},
		},
	})
	if len(spec.Targets) != 3 {
		t.Fatalf("出站本身是合法的，不该被探测地址连累掉，拿到 %d 个", len(spec.Targets))
	}
	for index, target := range spec.Targets[:2] {
		if target.ProbeIP != "" || target.ProbePort != 0 {
			t.Fatalf("第 %d 个出站的非法探测目标没被清掉：%+v", index, target)
		}
	}
	if spec.Targets[2].ProbePort != 9000 {
		t.Fatalf("合法的探测目标被清掉了：%+v", spec.Targets[2])
	}
}

func TestFailoverSignatureCoversProbe(t *testing.T) {
	/*
		签名里不带探测目标的话，只改探测地址不会触发重建 —— 面板上改完显示成功，
		机器上还在探老地址，而用户正是为了补盲区才去改的它。
	*/
	base := failoverSpec{
		ListenPort: 1234, BindAddress: "127.0.0.1", Protocol: "tcp", Strategy: "fallback",
		Targets: []failoverTarget{{TargetIP: "10.0.0.1", TargetPort: 80}},
	}
	changed := failoverSpec{
		ListenPort: 1234, BindAddress: "127.0.0.1", Protocol: "tcp", Strategy: "fallback",
		Targets: []failoverTarget{{TargetIP: "10.0.0.1", TargetPort: 80, ProbeIP: "10.0.0.1", ProbePort: 9000}},
	}
	if failoverSignature(base) == failoverSignature(changed) {
		t.Fatal("只改探测目标时签名没变，改动不会下发到已经在跑的主备代理")
	}
}

func TestFailoverHealthUsesProbeEndpoint(t *testing.T) {
	/*
		这条是整件事的落点：出站端口开着、探测端口关着时，这条出站必须被判成不健康。

		它模拟的就是那个盲区 —— 用户态中转自己活着（出站端口连得上），但它到落地
		那一段断了（探测端口连不上）。没有探测目标的话这条出站会一直被当成健康的。
	*/
	openListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer openListener.Close()
	openPort := openListener.Addr().(*net.TCPAddr).Port
	closedPort := failoverTestPort(t) // 预留后立刻释放，所以这个端口是关着的

	proxy := &failoverProxy{
		spec: normalizeFailoverSpec(failoverSpec{
			Enabled: true, ListenPort: 65000, BindAddress: "127.0.0.1", Strategy: "fallback",
			FailoverSeconds: 1, RecoverSeconds: 1,
			Targets: []failoverTarget{
				{TargetIP: "127.0.0.1", TargetPort: openPort, ProbeIP: "127.0.0.1", ProbePort: closedPort},
				{TargetIP: "127.0.0.1", TargetPort: openPort},
			},
		}),
	}
	proxy.ensureHealthStateLocked()

	proxy.checkHealth()
	time.Sleep(1100 * time.Millisecond)
	proxy.checkHealth()

	proxy.mu.RLock()
	defer proxy.mu.RUnlock()
	if proxy.targetHealth[0] {
		t.Fatal("探测端口是关着的，这条出站应当被判成不健康 —— 否则那个盲区还在")
	}
	if !proxy.targetHealth[1] {
		t.Fatal("没填探测目标的出站探的是它自己，端口开着就该是健康的")
	}
}

/*
切换这件事必须让面板知道。

规则级主备是数据面的：Agent 自己探、自己切，毫秒级，不经过面板。代价是切换原来
只留在机器本地的日志里 —— 而主备恰恰是「平时看不出来、出事才知道有没有用」的东西，
切了没人知道，没切更没人知道。所以攒起来随心跳带回去。
*/

func drainFailoverEvents() []failoverProxyEvent {
	return failoverProxyEventsSnapshot()
}

func TestFailoverSwitchIsReportedWithLatency(t *testing.T) {
	drainFailoverEvents() // 清掉别的用例留下的

	openListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer openListener.Close()
	openPort := openListener.Addr().(*net.TCPAddr).Port
	closedPort := failoverTestPort(t)

	proxy := &failoverProxy{
		ruleID: 42, sourcePort: 20001,
		spec: normalizeFailoverSpec(failoverSpec{
			Enabled: true, ListenPort: 65001, BindAddress: "127.0.0.1", Strategy: "fallback",
			FailoverSeconds: 1, RecoverSeconds: 1, AutoFailback: true,
			Targets: []failoverTarget{
				{TargetIP: "127.0.0.1", TargetPort: closedPort},
				{TargetIP: "127.0.0.1", TargetPort: openPort},
			},
		}),
	}
	proxy.ensureHealthStateLocked()

	proxy.checkHealth()
	time.Sleep(1100 * time.Millisecond)
	proxy.checkHealth()

	events := drainFailoverEvents()
	var unhealthy, switched *failoverProxyEvent
	for i := range events {
		if events[i].RuleID != 42 {
			continue
		}
		switch events[i].Kind {
		case "unhealthy":
			unhealthy = &events[i]
		case "switch":
			switched = &events[i]
		}
	}
	if unhealthy == nil {
		t.Fatalf("主出站探不通，应当报一条 unhealthy，拿到 %+v", events)
	}
	if switched == nil {
		t.Fatalf("应当报一条切换事件，拿到 %+v", events)
	}
	if switched.ToTarget != "127.0.0.1:"+strconv.Itoa(openPort) {
		t.Fatalf("切换的目的地不对：%+v", switched)
	}
	if switched.FromTarget != "127.0.0.1:"+strconv.Itoa(closedPort) {
		t.Fatalf("切换的来源不对：%+v", switched)
	}
	if switched.Reason == "" {
		t.Fatal("切换事件没带原因 —— 面板上只会显示「切了」，而查不出为什么")
	}
	if switched.OccurredAt <= 0 {
		t.Fatal("切换事件没有时间戳")
	}
}

func TestFailoverEventQueueIsBounded(t *testing.T) {
	// 心跳之间攒太多会把请求体撑大。丢最老的：面板更关心刚刚发生了什么。
	drainFailoverEvents()
	for i := 0; i < failoverEventQueueMax+20; i++ {
		recordFailoverProxyEvent(failoverProxyEvent{RuleID: 1, Kind: "switch", ToTarget: "10.0.0.1:80"})
	}
	events := drainFailoverEvents()
	if len(events) > failoverEventQueueMax {
		t.Fatalf("队列没有上限，攒了 %d 条", len(events))
	}
	if len(drainFailoverEvents()) != 0 {
		t.Fatal("取过快照之后队列该空了，否则同一批会被反复上报")
	}
}

func TestFailoverTargetLabelBracketsIPv6(t *testing.T) {
	// `2001:db8::1:443` 分不清哪段是端口，面板上会显示成一个看不懂的串。
	if got := failoverTargetLabel(failoverTarget{TargetIP: "2001:db8::1", TargetPort: 443}); got != "[2001:db8::1]:443" {
		t.Fatalf("IPv6 没加方括号：%s", got)
	}
	if got := failoverTargetLabel(failoverTarget{TargetIP: "10.0.0.1", TargetPort: 80}); got != "10.0.0.1:80" {
		t.Fatalf("IPv4 不该被改动：%s", got)
	}
}

func TestFailoverCheckHealthStoresLatency(t *testing.T) {
	/*
		tcpLatency 的返回值原来是直接丢掉的（`_, results[i] = ...`）—— 数据一直在采，
		白扔了，而它正是「哪条线路更快」唯一的现成原料。

		本地回环的往返耗时会四舍五入成 0 毫秒，所以不能靠「大于 0」来验证这件事：
		那样既分不清「很快」和「没记」，还会在慢机器上飘。改成先塞一个哨兵值，
		跑完看它有没有被覆盖 —— 丢掉返回值的话哨兵会原样留在那儿。
	*/
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port

	proxy := &failoverProxy{
		ruleID: 43, sourcePort: 20002,
		spec: normalizeFailoverSpec(failoverSpec{
			Enabled: true, ListenPort: 65002, BindAddress: "127.0.0.1", Strategy: "fallback",
			FailoverSeconds: 60, RecoverSeconds: 60,
			Targets: []failoverTarget{
				{TargetIP: "127.0.0.1", TargetPort: port},
				{TargetIP: "127.0.0.1", TargetPort: port},
			},
		}),
	}
	proxy.ensureHealthStateLocked()
	const sentinel = -12345
	for i := range proxy.lastLatencyMs {
		proxy.lastLatencyMs[i] = sentinel
	}

	proxy.checkHealth()

	proxy.mu.RLock()
	defer proxy.mu.RUnlock()
	for i, latency := range proxy.lastLatencyMs {
		if latency == sentinel {
			t.Fatalf("第 %d 条出站的探测耗时没被记下来 —— tcpLatency 的返回值又被丢掉了", i)
		}
		if latency < 0 {
			t.Fatalf("第 %d 条出站的探测耗时是负数：%d", i, latency)
		}
	}
}

func TestFailoverEventCarriesRecordedLatency(t *testing.T) {
	// 记下来了还得带出去：事件里没有延迟的话，面板上只看得到「切了」。
	drainFailoverEvents()
	proxy := &failoverProxy{
		ruleID: 44, sourcePort: 20003,
		spec: normalizeFailoverSpec(failoverSpec{
			Enabled: true, ListenPort: 65003, BindAddress: "127.0.0.1", Strategy: "fallback",
			Targets: []failoverTarget{
				{TargetIP: "10.0.0.1", TargetPort: 80},
				{TargetIP: "10.0.0.2", TargetPort: 80},
			},
		}),
	}
	proxy.ensureHealthStateLocked()
	proxy.lastLatencyMs[1] = 87

	proxy.mu.Lock()
	proxy.setActiveLocked(1, "health check")
	proxy.mu.Unlock()

	events := drainFailoverEvents()
	if len(events) != 1 || events[0].Kind != "switch" {
		t.Fatalf("应当正好一条切换事件，拿到 %+v", events)
	}
	if events[0].LatencyMs != 87 {
		t.Fatalf("事件里没带上那条出站记下来的延迟，拿到 %d", events[0].LatencyMs)
	}
}
