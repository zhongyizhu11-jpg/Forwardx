package main

import (
	"net"
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
