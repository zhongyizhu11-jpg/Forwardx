package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
下一跳地址的解析缓存。

面板把目标地址解析成 IP 再下发，但中转和出口的「连接地址」可以是域名（DDNS）。
以前每拨一次 TCP、每建一个 UDP 会话都现查一次 DNS —— 标准库不缓存，
每条连接每一跳都多一次 DNS 往返。这里按域名缓存 30 秒；过期后先接着用旧地址、
在后台刷新（DDNS 切换最多晚 30 秒被看到），解析失败时旧地址继续用到 5 分钟。
*/

const (
	fxpHopResolveTTL      = 30 * time.Second
	fxpHopResolveStaleMax = 5 * time.Minute
	fxpHopResolveTimeout  = 5 * time.Second
)

type hopResolveEntry struct {
	ips        []net.IP
	resolvedAt time.Time
	refreshing bool
}

var fxpHopResolver = struct {
	mu      sync.Mutex
	entries map[string]*hopResolveEntry
}{entries: map[string]*hopResolveEntry{}}

// resolveHopAddress 返回可直接拨号的 ip:port。已经是 IP 的原样返回。
func resolveHopAddress(host string, port int) (string, error) {
	host = strings.TrimSpace(host)
	portText := strconv.Itoa(port)
	if host == "" || net.ParseIP(strings.Trim(host, "[]")) != nil {
		return net.JoinHostPort(strings.Trim(host, "[]"), portText), nil
	}
	ip, err := lookupHopIP(host)
	if err != nil {
		return "", err
	}
	return net.JoinHostPort(ip.String(), portText), nil
}

func lookupHopIP(host string) (net.IP, error) {
	now := time.Now()
	fxpHopResolver.mu.Lock()
	entry := fxpHopResolver.entries[host]
	if entry != nil && len(entry.ips) > 0 {
		age := now.Sub(entry.resolvedAt)
		if age < fxpHopResolveTTL {
			ip := entry.ips[0]
			fxpHopResolver.mu.Unlock()
			return ip, nil
		}
		if age < fxpHopResolveStaleMax {
			ip := entry.ips[0]
			if !entry.refreshing {
				entry.refreshing = true
				go refreshHopIP(host)
			}
			fxpHopResolver.mu.Unlock()
			return ip, nil
		}
	}
	fxpHopResolver.mu.Unlock()
	ips, err := queryHopIPs(host)
	if err != nil {
		return nil, err
	}
	storeHopIPs(host, ips)
	return ips[0], nil
}

// errHopResolvePending：域名还没有可用的解析结果，已经在后台去查了。
var errHopResolvePending = errors.New("hop address resolution pending")

// resolveHopAddressNonBlocking 和 resolveHopAddress 一样，但绝不在调用方这里
// 等 DNS：缓存里有（哪怕过期不超过 fxpHopResolveStaleMax）就用，没有就在后台
// 查、先返回 errHopResolvePending。UDP 的读循环一个监听只有一个协程，在里面
// 现查一次慢 DNS（最长 fxpHopResolveTimeout）会让这个监听上所有 UDP 会话一起
// 停摆；丢掉新会话的头一两个包、等后台查完再建，代价小得多。
func resolveHopAddressNonBlocking(host string, port int) (string, error) {
	host = strings.TrimSpace(host)
	portText := strconv.Itoa(port)
	if host == "" || net.ParseIP(strings.Trim(host, "[]")) != nil {
		return net.JoinHostPort(strings.Trim(host, "[]"), portText), nil
	}
	ip, ok := lookupHopIPNonBlocking(host)
	if !ok {
		return "", fmt.Errorf("%w: %s", errHopResolvePending, host)
	}
	return net.JoinHostPort(ip.String(), portText), nil
}

func lookupHopIPNonBlocking(host string) (net.IP, bool) {
	now := time.Now()
	fxpHopResolver.mu.Lock()
	defer fxpHopResolver.mu.Unlock()
	entry := fxpHopResolver.entries[host]
	if entry != nil && len(entry.ips) > 0 {
		age := now.Sub(entry.resolvedAt)
		if age < fxpHopResolveTTL {
			return entry.ips[0], true
		}
		if age < fxpHopResolveStaleMax {
			if !entry.refreshing {
				entry.refreshing = true
				go refreshHopIP(host)
			}
			return entry.ips[0], true
		}
	}
	if entry == nil {
		entry = &hopResolveEntry{}
		fxpHopResolver.entries[host] = entry
	}
	// 同一个域名同时只查一次；查失败了下一个包再触发一次。
	if !entry.refreshing {
		entry.refreshing = true
		go refreshHopIP(host)
	}
	return nil, false
}

func refreshHopIP(host string) {
	ips, err := queryHopIPs(host)
	fxpHopResolver.mu.Lock()
	defer fxpHopResolver.mu.Unlock()
	entry := fxpHopResolver.entries[host]
	if entry == nil {
		return
	}
	entry.refreshing = false
	if err == nil {
		entry.ips = ips
		entry.resolvedAt = time.Now()
	}
}

func storeHopIPs(host string, ips []net.IP) {
	fxpHopResolver.mu.Lock()
	defer fxpHopResolver.mu.Unlock()
	fxpHopResolver.entries[host] = &hopResolveEntry{ips: ips, resolvedAt: time.Now()}
}

// queryHopIPs 优先 IPv4（和标准库拨号时的默认顺序一致），其次 IPv6。
func queryHopIPs(host string) ([]net.IP, error) {
	ctx, cancel := context.WithTimeout(context.Background(), fxpHopResolveTimeout)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, addr := range addrs {
		if addr.IP.To4() != nil {
			ips = append(ips, addr.IP)
		}
	}
	for _, addr := range addrs {
		if addr.IP.To4() == nil {
			ips = append(ips, addr.IP)
		}
	}
	if len(ips) == 0 {
		return nil, &net.DNSError{Err: "no addresses", Name: host, IsNotFound: true}
	}
	return ips, nil
}

// flushHopResolverCache 在配置重载时清掉缓存：面板 bump DNSGeneration 的意思
// 就是「这些域名该重新解析了」。
func flushHopResolverCache() {
	fxpHopResolver.mu.Lock()
	fxpHopResolver.entries = map[string]*hopResolveEntry{}
	fxpHopResolver.mu.Unlock()
}
