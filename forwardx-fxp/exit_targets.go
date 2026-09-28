package main

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

/*
出口按 hello 拨目标之前的核对。

hello 是入口写的，握手只证明对端知道隧道密钥。以前出口 hello 说拨哪儿就拨哪儿，
拿到隧道密钥（或者控制了一台入口）的人就能把出口当开放代理用：拨出口本机的
管理端口、内网地址、随便什么公网服务。现在出口只认面板下发给它的目标表：

  - streamTargets：每条规则允许的 TCP 目标（走 TCP 流的 UDP 也用它）；
  - udpTargets：UDP 规则的目标，network=udp 的 hello 也认；
  - 出口配置本身写了 targetIp/targetPort 的（单规则出口、测试），那一个也认。

表里写死的 IP 照拨（面板明确配的，比如出口本机调度器的 127.0.0.1）；写的是
域名的，拨之前看解析结果，落到环回、链路本地、未指定、组播地址上的不拨 ——
否则把域名解析改一下就能绕过面板对目标地址的校验，摸到出口本机的服务。
*/

var errExitTargetNotAllowed = errors.New("exit target not allowed")

// authorizeExitTarget 核对 hello 的 (规则, 目标) 在不在出口的目标表里，通过时
// 顺带记下目标是不是写死的 IP。
func authorizeExitTarget(cfg config, hello *helloFrame) error {
	host := strings.TrimSpace(hello.TargetIP)
	port := hello.TargetPort
	if host == "" || port <= 0 || port > 65535 {
		return fmt.Errorf("%w: rule=%d target=%s:%d", errExitTargetNotAllowed, hello.RuleID, host, port)
	}
	allowed := cfg.TargetIP != "" && cfg.TargetPort == port && sameTargetHost(cfg.TargetIP, host)
	for _, target := range cfg.StreamTargets {
		if allowed {
			break
		}
		allowed = target.RuleID == hello.RuleID && target.TargetPort == port && sameTargetHost(target.TargetIP, host)
	}
	if strings.EqualFold(hello.Network, "udp") {
		for _, target := range cfg.UDPTargets {
			if allowed {
				break
			}
			allowed = target.RuleID == hello.RuleID && target.TargetPort == port && sameTargetHost(target.TargetIP, host)
		}
	}
	if !allowed {
		return fmt.Errorf("%w: rule=%d target=%s", errExitTargetNotAllowed, hello.RuleID, net.JoinHostPort(host, strconv.Itoa(port)))
	}
	hello.TargetIP = host
	hello.targetLiteral = net.ParseIP(strings.Trim(host, "[]")) != nil
	return nil
}

func sameTargetHost(configured, requested string) bool {
	configured = strings.Trim(strings.TrimSpace(configured), "[]")
	requested = strings.Trim(strings.TrimSpace(requested), "[]")
	if configured == "" || requested == "" {
		return false
	}
	if a, b := net.ParseIP(configured), net.ParseIP(requested); a != nil || b != nil {
		return a != nil && b != nil && a.Equal(b)
	}
	return strings.EqualFold(strings.TrimSuffix(configured, "."), strings.TrimSuffix(requested, "."))
}

// restrictedExitTargetIP 是出口不替域名目标拨的地址：本机、链路本地、未指定
// 和组播。
func restrictedExitTargetIP(ip net.IP) bool {
	return ip == nil || ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() || ip.IsMulticast()
}

func checkResolvedExitTarget(hello helloFrame, ip net.IP) error {
	if hello.targetLiteral || !restrictedExitTargetIP(ip) {
		return nil
	}
	return fmt.Errorf("%w: rule=%d target=%s resolved to restricted address %s", errExitTargetNotAllowed, hello.RuleID, hello.TargetIP, ip)
}

// dialExitTarget 拨一个核对过的 TCP 目标。拨的就是解析出来、查过的那个 IP，
// 查和拨之间不会再解析一次。
func dialExitTarget(hello helloFrame, timeout time.Duration) (net.Conn, error) {
	address, err := resolveHopAddress(hello.TargetIP, hello.TargetPort)
	if err != nil {
		return nil, err
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	if err := checkResolvedExitTarget(hello, net.ParseIP(host)); err != nil {
		return nil, err
	}
	d := net.Dialer{Timeout: timeout, KeepAlive: fxpTCPKeepAlive}
	conn, err := d.Dial("tcp", address)
	if err != nil {
		return nil, err
	}
	enableTCPKeepAlive(conn)
	return conn, nil
}

// resolveExitUDPTarget 解析一个核对过的 UDP 目标（走 TCP 流的 UDP 会话）。
func resolveExitUDPTarget(hello helloFrame) (*net.UDPAddr, error) {
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(strings.Trim(hello.TargetIP, "[]"), strconv.Itoa(hello.TargetPort)))
	if err != nil {
		return nil, err
	}
	if err := checkResolvedExitTarget(hello, addr.IP); err != nil {
		return nil, err
	}
	return addr, nil
}
