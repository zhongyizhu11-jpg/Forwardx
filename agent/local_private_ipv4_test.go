package main

import (
	"net"
	"testing"
)

func TestFirstPrivateIPv4PicksPrivateAddressOnly(t *testing.T) {
	mustCIDR := func(value string) net.Addr {
		ip, ipNet, err := net.ParseCIDR(value)
		if err != nil {
			t.Fatalf("parse %s: %v", value, err)
		}
		ipNet.IP = ip
		return ipNet
	}
	cases := []struct {
		name  string
		addrs []net.Addr
		want  string
	}{
		{"public only", []net.Addr{mustCIDR("203.0.113.9/24"), mustCIDR("2001:db8::9/64")}, ""},
		{"nat 10/8", []net.Addr{mustCIDR("fe80::1/64"), mustCIDR("10.0.0.8/24")}, "10.0.0.8"},
		{"public then 172.16/12", []net.Addr{mustCIDR("198.51.100.4/24"), mustCIDR("172.20.1.5/16")}, "172.20.1.5"},
		{"192.168", []net.Addr{mustCIDR("192.168.1.20/24")}, "192.168.1.20"},
		{"cgnat 100.64/10", []net.Addr{mustCIDR("100.100.1.2/10")}, "100.100.1.2"},
		{"not cgnat 100.128", []net.Addr{mustCIDR("100.128.0.1/16")}, ""},
	}
	for _, tc := range cases {
		if got := firstPrivateIPv4(tc.addrs); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}
