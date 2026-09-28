package main

import "testing"

func TestUDPWireLimitFollowsTransport(t *testing.T) {
	defer configureFXPUDPWireLimit(config{})
	cases := []struct {
		cfg  config
		want int
	}{
		{config{}, fxpUDPDefaultWirePacketSize},
		{config{TransportVersion: "v1"}, fxpUDPDefaultWirePacketSize},
		{config{TransportVersion: "v2"}, fxpUDPWireGuardWirePacketSize},
		{config{UDPWirePacketSize: 900}, fxpUDPMinWirePacketSize},
		{config{UDPWirePacketSize: 9000}, fxpUDPMaxWirePacketSize},
	}
	for _, tc := range cases {
		if got := configureFXPUDPWireLimit(tc.cfg); got != tc.want {
			t.Fatalf("%+v: limit=%d want %d", tc.cfg, got, tc.want)
		}
	}
	// QUIC 常见的 1350 字节以内不该再被拆片。
	configureFXPUDPWireLimit(config{})
	if count, err := fxpUDPFragmentCount(1350); err != nil || count != 1 {
		t.Fatalf("1350 字节被拆成 %d 片 (err=%v)", count, err)
	}
	// 最小上限下最大的数据报也拆得开，接收端的分片数校验要能容纳。
	configureFXPUDPWireLimit(config{UDPWirePacketSize: fxpUDPMinWirePacketSize})
	if count, err := fxpUDPFragmentCount(fxpUDPMaxDatagramPayload); err != nil || count > fxpUDPMaxFragments {
		t.Fatalf("最小上限下拆最大数据报失败：count=%d err=%v", count, err)
	}
}
