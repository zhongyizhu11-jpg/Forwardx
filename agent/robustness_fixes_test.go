package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 一个把规则存成文本文件的假 iptables，用来真跑 Agent 生成的 shell。
const fakeIptablesScript = `#!/bin/sh
table=filter
while [ $# -gt 0 ]; do
  case "$1" in
    -w) shift; case "$1" in [0-9]*) shift ;; esac ;;
    -t) table=$2; shift 2 ;;
    *) break ;;
  esac
done
f="$FAKE_IPT_DIR/$table"; touch "$f"
op=$1; shift
case "$op" in
  -S) if [ -n "$1" ]; then grep "^-A $1 " "$f"; else cat "$f"; fi; exit 0 ;;
  -C) [ -n "$FAKE_IPT_CHECK_RC" ] && exit "$FAKE_IPT_CHECK_RC"; chain=$1; shift; grep -qxF -- "-A $chain $*" "$f" && exit 0; exit 1 ;;
  -A) chain=$1; shift; echo "-A $chain $*" >> "$f" ;;
  -D) chain=$1; shift
      if [ $# -eq 1 ] && echo "$1" | grep -qE '^[0-9]+$'; then
        awk -v c="-A $chain " -v n="$1" 'index($0, c) == 1 {k++; if (k == n) next} {print}' "$f" > "$f.tmp"
      else
        grep -qxF -- "-A $chain $*" "$f" || exit 1
        awk -v l="-A $chain $*" '!done && $0 == l {done = 1; next} {print}' "$f" > "$f.tmp"
      fi
      mv "$f.tmp" "$f" ;;
esac
exit 0
`

type fakeIptables struct {
	t     *testing.T
	bin   string
	state string
}

func newFakeIptables(t *testing.T) *fakeIptables {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	state := filepath.Join(dir, "state")
	if err := os.MkdirAll(bin, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(state, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "iptables"), []byte(fakeIptablesScript), 0755); err != nil {
		t.Fatal(err)
	}
	return &fakeIptables{t: t, bin: bin, state: state}
}

func (f *fakeIptables) run(commands []string, extraEnv ...string) {
	f.t.Helper()
	for _, command := range commands {
		if strings.TrimSpace(command) == "" {
			continue
		}
		cmd := exec.Command("sh", "-c", command)
		cmd.Env = append(os.Environ(),
			"PATH="+f.bin+":"+os.Getenv("PATH"),
			"FAKE_IPT_DIR="+f.state,
			iptablesWaitEnvName+"=-w 5",
		)
		cmd.Env = append(cmd.Env, extraEnv...)
		_, _ = cmd.CombinedOutput()
	}
}

func (f *fakeIptables) write(table string, lines ...string) {
	f.t.Helper()
	if err := os.WriteFile(filepath.Join(f.state, table), []byte(strings.Join(lines, "\n")+"\n"), 0644); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fakeIptables) read(table string) string {
	raw, _ := os.ReadFile(filepath.Join(f.state, table))
	return string(raw)
}

func withDesiredRunningRules(t *testing.T, rules []runningRule) {
	t.Helper()
	desiredRunningRuleMu.Lock()
	previousByPort, previousByRulePort := desiredRunningRulesByPort, desiredRunningRulesByRulePort
	desiredRunningRuleMu.Unlock()
	rememberDesiredRunningRules(rules)
	t.Cleanup(func() {
		desiredRunningRuleMu.Lock()
		desiredRunningRulesByPort, desiredRunningRulesByRulePort = previousByPort, previousByRulePort
		desiredRunningRuleMu.Unlock()
	})
}

func TestIptablesWaitFlagForVersion(t *testing.T) {
	cases := map[string]string{
		"iptables v1.8.7 (nf_tables)": "-w 5",
		"iptables v1.8.4 (legacy)":    "-w 5",
		"iptables v1.6.0":             "-w 5",
		"iptables v1.4.21":            "-w",
		"iptables v1.4.20":            "-w",
		"iptables v1.4.7":             "",
		"garbage":                     "",
	}
	for output, want := range cases {
		if got := iptablesWaitFlagForVersion(output); got != want {
			t.Fatalf("wait flag for %q = %q, want %q", output, got, want)
		}
	}
}

func TestShellCommandEnvAddsStandardPathAndIptablesWait(t *testing.T) {
	env := shellCommandEnv([]string{"PATH=/opt/custom:/usr/bin", "FOO=bar", iptablesWaitEnvName + "=stale"})
	var path, wait string
	waitCount := 0
	for _, item := range env {
		switch {
		case strings.HasPrefix(item, "PATH="):
			path = strings.TrimPrefix(item, "PATH=")
		case strings.HasPrefix(item, iptablesWaitEnvName+"="):
			wait = strings.TrimPrefix(item, iptablesWaitEnvName+"=")
			waitCount++
		}
	}
	if !strings.HasPrefix(path, "/opt/custom:/usr/bin:") || !strings.Contains(path, "/usr/sbin") || !strings.Contains(path, "/sbin") {
		t.Fatalf("PATH = %q", path)
	}
	if strings.Count(path, "/usr/bin") != 1 {
		t.Fatalf("PATH has duplicate entries: %q", path)
	}
	if waitCount != 1 || wait == "stale" {
		t.Fatalf("iptables wait env not replaced: count=%d value=%q", waitCount, wait)
	}
}

func TestShellCommandDoesNotHangOnBackgroundGrandchild(t *testing.T) {
	previous := shellCommandWaitDelay
	shellCommandWaitDelay = 200 * time.Millisecond
	t.Cleanup(func() { shellCommandWaitDelay = previous })

	started := time.Now()
	// 后台 sleep 继承了输出管道；以前 CombinedOutput 要等它退出（30 秒）才返回。
	ok, _ := runShellWithOutput("sleep 30 & echo started")
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("shell command blocked on a background grandchild for %s", elapsed)
	}
	_ = ok
}

func TestShellCommandTimeoutKillsProcessGroup(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	c, cleanup, _, err := shellCommand(ctx, "sleep 30 & echo $! > "+shellQuote(pidFile)+"; wait")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	started := time.Now()
	_ = c.Run()
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("timed out shell command took %s to return", elapsed)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if exec.Command("kill", "-0", strconv.Itoa(pid)).Run() != nil {
			return
		}
		// 容器里的 init 未必及时回收孤儿：已被杀、只剩僵尸的也算结束。
		if stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat"); err == nil {
			if fields := strings.Fields(string(stat)); len(fields) > 2 && fields[2] == "Z" {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("background grandchild pid=%d survived the timeout", pid)
}

func TestIptablesTargetRuleLinePresentParsesSaveFormat(t *testing.T) {
	nat := strings.Join([]string{
		"-P POSTROUTING ACCEPT",
		"-A POSTROUTING -d 10.0.0.9/32 -p tcp -m tcp --dport 80 -m comment --comment fwx-rule-5 -j MASQUERADE",
		"-A POSTROUTING -d 2001:db8::9/128 -p udp -m udp --dport 53 -j MASQUERADE",
	}, "\n")
	if !iptablesTargetRuleLinePresent(nat, "POSTROUTING", "MASQUERADE", "tcp", "10.0.0.9", 80) {
		t.Fatal("tagged IPv4 MASQUERADE not detected")
	}
	if !iptablesTargetRuleLinePresent(nat, "POSTROUTING", "MASQUERADE", "udp", "[2001:DB8::9]", 53) {
		t.Fatal("untagged IPv6 MASQUERADE not detected")
	}
	if iptablesTargetRuleLinePresent(nat, "POSTROUTING", "MASQUERADE", "udp", "10.0.0.9", 80) {
		t.Fatal("protocol mismatch treated as present")
	}
	if iptablesTargetRuleLinePresent(nat, "POSTROUTING", "MASQUERADE", "tcp", "10.0.0.9", 81) {
		t.Fatal("port mismatch treated as present")
	}
	forward := "-A FORWARD -d 10.0.0.0/24 -p tcp -m tcp --dport 80 -j ACCEPT"
	if iptablesTargetRuleLinePresent(forward, "FORWARD", "ACCEPT", "tcp", "10.0.0.9", 80) {
		t.Fatal("subnet rule treated as the per-target FORWARD accept")
	}
}

func TestIptablesCounterSnapshotIgnoresDuplicateRules(t *testing.T) {
	text := strings.Join([]string{
		"Chain FORWARD (policy ACCEPT 0 packets, 0 bytes)",
		"    pkts      bytes target     prot opt in     out     source               destination",
		"      10     1000            tcp  --  *      *       0.0.0.0/0            10.0.0.9             ctorigdstport 22022 tcp dpt:80 /* fwx-stat-22022:in */",
		"      10     1000            tcp  --  *      *       0.0.0.0/0            10.0.0.9             ctorigdstport 22022 tcp dpt:80 /* fwx-stat-22022:in */",
		"       5      500            udp  --  *      *       0.0.0.0/0            10.0.0.9             ctorigdstport 22022 udp dpt:80 /* fwx-stat-22022:in */",
	}, "\n")
	counters := map[string]map[string]uint64{}
	markers := map[string]bool{}
	parseIptablesCounterText(text, counters, markers)
	if got := counters["22022:in"]["FORWARD"]; got != 1500 {
		t.Fatalf("duplicate counting rule was summed: got %d, want 1500", got)
	}
	if !markers["22022"+iptablesCountingDuplicateSuffix] {
		t.Fatal("duplicate counting rule was not flagged for cleanup")
	}
}

func TestTrafficDeltaTreatsDecreaseAsReset(t *testing.T) {
	// ip6tables 被单独清空时 v4+v6 的和会变小：以前返回 cur，把 v4 的全部历史重报一遍。
	if got := delta(700, 1000); got != 0 {
		t.Fatalf("decreasing counter delta = %d, want 0", got)
	}
	if got := delta(1200, 1000); got != 200 {
		t.Fatalf("increasing counter delta = %d, want 200", got)
	}
}

func TestIptablesSnapshotFailureSkipsDependentStates(t *testing.T) {
	diagnostics := trafficDiagnosticsSnapshot{iptablesSnapshotFailed: true}
	kernelV4 := localRuleState{Port: "1", ForwardType: "iptables", TargetIP: "10.0.0.9"}
	kernelV6 := localRuleState{Port: "2", ForwardType: "iptables", TargetIP: "2001:db8::9"}
	process := localRuleState{Port: "3", ForwardType: "gost", Protocol: "tcp"}
	native := localRuleState{Port: "4", ForwardType: "nftables"}
	if !trafficStateIptablesSnapshotUnreliable(kernelV4, diagnostics) {
		t.Fatal("IPv4 iptables rule used a failed iptables snapshot")
	}
	if trafficStateIptablesSnapshotUnreliable(kernelV6, diagnostics) {
		t.Fatal("IPv6 iptables rule was skipped although ip6tables succeeded")
	}
	if !trafficStateIptablesSnapshotUnreliable(process, diagnostics) {
		t.Fatal("process rule on the iptables fallback used a failed snapshot")
	}
	diagnostics.nftProcessMarkers = map[string]bool{"3:tcp:in": true, "3:tcp:out": true}
	if trafficStateIptablesSnapshotUnreliable(process, diagnostics) {
		t.Fatal("process rule counted by nft was skipped")
	}
	if trafficStateIptablesSnapshotUnreliable(native, diagnostics) {
		t.Fatal("native nftables rule was skipped")
	}
}

func TestIptablesEnsureDoesNotAppendWhenCheckFailsForOtherReasons(t *testing.T) {
	fake := newFakeIptables(t)
	rule := `FORWARD -p tcp -m conntrack --ctorigdstport 22022 -d 10.0.0.9 --dport 80 -m comment --comment "fwx-stat-22022:in"`
	ensure := iptablesAgentEnsure("iptables", "mangle", rule)
	fake.run([]string{ensure}, "FAKE_IPT_CHECK_RC=4")
	if strings.TrimSpace(fake.read("mangle")) != "" {
		t.Fatalf("lock-busy check appended a rule: %q", fake.read("mangle"))
	}
	fake.run([]string{ensure, ensure})
	if got := strings.Count(fake.read("mangle"), "fwx-stat-22022:in"); got != 1 {
		t.Fatalf("ensure appended %d copies, want 1", got)
	}
}

func TestIptablesTargetCleanupKeepsSharedLegacyRules(t *testing.T) {
	legacyNat := []string{
		"-A PREROUTING -p tcp --dport 1001 -j DNAT --to-destination 10.0.0.9:80",
		"-A PREROUTING -p tcp --dport 1002 -j DNAT --to-destination 10.0.0.9:80",
		"-A POSTROUTING -p tcp -d 10.0.0.9 --dport 80 -j MASQUERADE",
		"-A POSTROUTING -p tcp -d 10.0.0.9 --dport 80 -m comment --comment fwx-rule-1 -j MASQUERADE",
		"-A POSTROUTING -p tcp -d 10.0.0.9 --dport 80 -m comment --comment fwx-rule-2 -j MASQUERADE",
		"-A POSTROUTING -p tcp -d 10.0.0.9 --dport 80 -m comment --comment fwx-rule-10 -j MASQUERADE",
	}
	legacyFilter := []string{
		"-A FORWARD -p tcp -d 10.0.0.9 --dport 80 -j ACCEPT",
		"-A FORWARD -p tcp -s 10.0.0.9 --sport 80 -m state --state ESTABLISHED,RELATED -j ACCEPT",
		"-A FORWARD -p tcp -d 10.0.0.9 --dport 80 -m comment --comment fwx-rule-1 -j ACCEPT",
	}

	t.Run("another DNAT still references the target", func(t *testing.T) {
		withDesiredRunningRules(t, nil)
		fake := newFakeIptables(t)
		fake.write("nat", legacyNat...)
		fake.write("filter", legacyFilter...)
		fake.run(iptablesAgentTargetCleanupCmds(1, "1001", "10.0.0.9", 80, "tcp"))
		nat, filter := fake.read("nat"), fake.read("filter")
		if strings.Contains(nat, "--dport 1001 -j DNAT") {
			t.Fatal("own DNAT was not removed")
		}
		if strings.Contains(nat, "fwx-rule-1 ") || strings.Contains(filter, "fwx-rule-1 ") {
			t.Fatal("own tagged rules were not removed")
		}
		if !strings.Contains(nat, "fwx-rule-2 ") || !strings.Contains(nat, "fwx-rule-10 ") {
			t.Fatalf("other rules' tagged MASQUERADE removed:\n%s", nat)
		}
		if !strings.Contains(nat, "-A POSTROUTING -p tcp -d 10.0.0.9 --dport 80 -j MASQUERADE") ||
			!strings.Contains(filter, "-A FORWARD -p tcp -d 10.0.0.9 --dport 80 -j ACCEPT") {
			t.Fatal("legacy shared rules removed while rule 1002 still forwards to the target")
		}
	})

	t.Run("desired state still references the target", func(t *testing.T) {
		withDesiredRunningRules(t, []runningRule{{RuleID: 2, SourcePort: 1002, ForwardType: "iptables", TargetIP: "10.0.0.9", TargetPort: 80, Protocol: "tcp"}})
		fake := newFakeIptables(t)
		fake.write("nat", "-A POSTROUTING -p tcp -d 10.0.0.9 --dport 80 -j MASQUERADE")
		fake.write("filter", legacyFilter[:2]...)
		fake.run(iptablesAgentTargetCleanupCmds(1, "1001", "10.0.0.9", 80, "tcp"))
		if !strings.Contains(fake.read("nat"), "-j MASQUERADE") {
			t.Fatal("legacy MASQUERADE removed while the desired state still uses the target")
		}
	})

	t.Run("unreferenced legacy rules are removed", func(t *testing.T) {
		withDesiredRunningRules(t, nil)
		fake := newFakeIptables(t)
		fake.write("nat", legacyNat[0], legacyNat[2])
		fake.write("filter", legacyFilter[:2]...)
		fake.run(iptablesAgentTargetCleanupCmds(1, "1001", "10.0.0.9", 80, "tcp"))
		if strings.TrimSpace(fake.read("nat")) != "" || strings.TrimSpace(fake.read("filter")) != "" {
			t.Fatalf("unreferenced legacy rules left behind:\nnat=%s\nfilter=%s", fake.read("nat"), fake.read("filter"))
		}
	})
}

func TestIptablesDedupeCountingRulesKeepsFirstCopy(t *testing.T) {
	fake := newFakeIptables(t)
	fake.write("mangle",
		"-A FORWARD -p tcp --dport 80 -m comment --comment fwx-stat-22022:in",
		"-A FORWARD -p tcp --dport 80 -m comment --comment fwx-stat-22022:in",
		"-A FORWARD -p udp --dport 80 -m comment --comment fwx-stat-22022:in",
		"-A FORWARD -p tcp --dport 80 -m comment --comment fwx-stat-220220:in",
		"-A FORWARD -p tcp --dport 80 -m comment --comment fwx-stat-220220:in",
	)
	fake.run([]string{iptablesAgentDedupeCountingRules("iptables", "22022")})
	mangle := fake.read("mangle")
	if got := strings.Count(mangle, "-p tcp --dport 80 -m comment --comment fwx-stat-22022:in"); got != 1 {
		t.Fatalf("tcp copies = %d, want 1:\n%s", got, mangle)
	}
	if !strings.Contains(mangle, "-p udp --dport 80 -m comment --comment fwx-stat-22022:in") {
		t.Fatal("distinct udp counting rule removed")
	}
	if got := strings.Count(mangle, "fwx-stat-220220:in"); got != 2 {
		t.Fatalf("another port's rules touched: %d", got)
	}
}

func TestAccessLimitPatternsAcceptIptablesWaitArgument(t *testing.T) {
	commands := strings.Join([]string{
		"iptables $FWX_IPT_WAIT -A FWX_LIMIT_u7_t3 -p tcp -m connlimit --connlimit-above 100 --connlimit-mask 0 -j REJECT --reject-with tcp-reset",
		"ip6tables -w 5 -A FWX_LIMIT_u7_t3 -j RETURN",
		"iptables -w -C INPUT -p tcp --dport 22022 -j FWX_LIMIT_u7_t3",
	}, "\n")
	if len(accessLimitRejectPattern.FindAllStringSubmatch(commands, -1)) != 1 ||
		len(accessLimitReturnPattern.FindAllStringSubmatch(commands, -1)) != 1 ||
		len(accessLimitJumpPattern.FindAllStringSubmatch(commands, -1)) != 1 {
		t.Fatal("access limit patterns do not tolerate the iptables wait argument")
	}
}

func TestServeLoopBackoffDoublesAndThrottlesLogs(t *testing.T) {
	var backoff serveLoopBackoff
	now := time.Unix(1000, 0)
	delay, logged, _ := backoff.failure(now)
	if delay != serveLoopRetryMinDelay || !logged {
		t.Fatalf("first failure delay=%s logged=%v", delay, logged)
	}
	for i := 0; i < 20; i++ {
		delay, logged, _ = backoff.failure(now.Add(time.Second))
		if logged {
			t.Fatal("repeated failures inside the throttle window were logged")
		}
	}
	if delay != serveLoopRetryMaxDelay {
		t.Fatalf("backoff did not cap at %s: %s", serveLoopRetryMaxDelay, delay)
	}
	_, logged, suppressed := backoff.failure(now.Add(serveLoopErrorLogInterval + time.Second))
	if !logged || suppressed != 20 {
		t.Fatalf("throttled log logged=%v suppressed=%d", logged, suppressed)
	}
	backoff.success()
	if delay, _, _ := backoff.failure(now.Add(time.Hour)); delay != serveLoopRetryMinDelay {
		t.Fatalf("success did not reset backoff: %s", delay)
	}
}

func TestServeLoopHandleErrorClassifiesErrors(t *testing.T) {
	done := make(chan struct{})
	var backoff serveLoopBackoff
	if exit, fatal := serveLoopHandleError(done, &backoff, errors.New("accept: too many open files"), nil); exit || fatal {
		t.Fatalf("temporary error exit=%v fatal=%v", exit, fatal)
	}
	if exit, fatal := serveLoopHandleError(done, &backoff, net.ErrClosed, nil); !exit || !fatal {
		t.Fatalf("closed listener exit=%v fatal=%v", exit, fatal)
	}
	close(done)
	if exit, fatal := serveLoopHandleError(done, &backoff, net.ErrClosed, nil); !exit || fatal {
		t.Fatalf("shutdown exit=%v fatal=%v", exit, fatal)
	}
}

func TestFailoverAcceptLoopAbandonsProxyWhenListenerDies(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &failoverProxy{ruleID: 987654, sourcePort: 45678, ln: ln, done: make(chan struct{})}
	id := failoverID(p.ruleID, p.sourcePort)
	failoverMu.Lock()
	failoverProxies[id] = p
	failoverMu.Unlock()
	t.Cleanup(func() {
		failoverMu.Lock()
		delete(failoverProxies, id)
		failoverMu.Unlock()
	})
	finished := make(chan struct{})
	go func() {
		p.acceptLoop()
		close(finished)
	}()
	_ = ln.Close()
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("accept loop kept spinning on a closed listener")
	}
	failoverMu.Lock()
	_, stillRegistered := failoverProxies[id]
	failoverMu.Unlock()
	if stillRegistered || !p.retired() {
		t.Fatal("dead failover proxy was left registered, reconcile would never rebuild it")
	}
}

func TestFailoverCheckHealthSharedJoinsInFlightCheck(t *testing.T) {
	p := &failoverProxy{done: make(chan struct{})}
	flight := make(chan struct{})
	p.healthFlight = flight
	returned := make(chan struct{})
	go func() {
		p.checkHealthShared()
		close(returned)
	}()
	select {
	case <-returned:
		t.Fatal("concurrent health check did not wait for the in-flight one")
	case <-time.After(50 * time.Millisecond):
	}
	close(flight)
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("waiter was not released when the in-flight check finished")
	}
}

func TestFailoverUDPResolveUsesBackgroundCache(t *testing.T) {
	previousLookup := failoverUDPLookup
	var lookups atomic.Int32
	release := make(chan struct{})
	failoverUDPLookup = func(ctx context.Context, host string) ([]net.IPAddr, error) {
		lookups.Add(1)
		<-release
		return []net.IPAddr{{IP: net.ParseIP("2001:db8::7")}, {IP: net.ParseIP("192.0.2.7")}}, nil
	}
	failoverUDPResolveMu.Lock()
	failoverUDPResolveCache = map[string]failoverUDPResolveEntry{}
	failoverUDPResolveInflight = map[string]bool{}
	failoverUDPResolveMu.Unlock()
	t.Cleanup(func() { failoverUDPLookup = previousLookup })

	if addr, pending, err := failoverUDPResolve("192.0.2.1", 53); pending || err != nil || addr.String() != "192.0.2.1:53" {
		t.Fatalf("IP literal resolve = %v pending=%v err=%v", addr, pending, err)
	}
	for i := 0; i < 3; i++ {
		if _, pending, _ := failoverUDPResolve("udp.example.test", 53); !pending {
			t.Fatal("hostname was resolved synchronously in the read loop")
		}
	}
	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for {
		addr, pending, err := failoverUDPResolve("udp.example.test", 53)
		if !pending {
			if err != nil || addr.String() != "192.0.2.7:53" {
				t.Fatalf("cached resolve = %v err=%v, want IPv4 first", addr, err)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background resolution never completed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := lookups.Load(); got != 1 {
		t.Fatalf("lookups = %d, want a single in-flight resolution", got)
	}
}

func TestPendingTrafficReportRetryBacksOffWithCap(t *testing.T) {
	pendingTrafficReportRetryFailures.Store(0)
	t.Cleanup(func() { pendingTrafficReportRetryFailures.Store(0) })
	base := 3 * time.Second
	maxSeen := time.Duration(0)
	for i := 0; i < 10; i++ {
		delay := pendingTrafficReportRetryDelay(base)
		if delay < base || delay > pendingTrafficReportRetryMaxDelay {
			t.Fatalf("retry delay %s outside [%s, %s]", delay, base, pendingTrafficReportRetryMaxDelay)
		}
		if delay > maxSeen {
			maxSeen = delay
		}
	}
	if maxSeen <= base {
		t.Fatal("retry delay never backed off")
	}
	if got := pendingTrafficReportRetryDelay(5 * time.Minute); got != 5*time.Minute {
		t.Fatalf("idle interval changed by retry backoff: %s", got)
	}
}

func TestFullJitterDelayStaysInRange(t *testing.T) {
	for i := 0; i < 200; i++ {
		if got := fullJitterDelay(10*time.Second, time.Second); got < time.Second || got > 10*time.Second {
			t.Fatalf("jitter %s outside [1s, 10s]", got)
		}
		if got := fullJitterSeconds(30, 2); got < 2 || got > 30 {
			t.Fatalf("jitter seconds %d outside [2, 30]", got)
		}
		if got := randomDelayUpTo(10 * time.Second); got < 0 || got > 10*time.Second {
			t.Fatalf("random delay %s outside [0, 10s]", got)
		}
	}
	if got := fullJitterDelay(time.Second, 2*time.Second); got != time.Second {
		t.Fatalf("base below floor = %s", got)
	}
}

func TestCommitTrafficBaselinesSyncsOnceForAllPorts(t *testing.T) {
	useIsolatedTrafficState(t)
	previousFS := trafficStateFilesystemSync
	t.Cleanup(func() { trafficStateFilesystemSync = previousFS })
	var fsSyncs, dirSyncs atomic.Int32
	trafficStateFilesystemSync = func(string) error {
		fsSyncs.Add(1)
		return nil
	}
	trafficStateDirectorySync = func(string) error {
		dirSyncs.Add(1)
		return nil
	}
	updates := []trafficBaselineUpdate{}
	for port := 30001; port <= 30010; port++ {
		updates = append(updates, trafficBaselineUpdate{port: strconv.Itoa(port), state: trafficPrevState{ruleID: port, in: 10, out: 20}})
	}
	if err := commitTrafficBaselines(true, updates); err != nil {
		t.Fatal(err)
	}
	if fsSyncs.Load() != 1 || dirSyncs.Load() != 0 {
		t.Fatalf("syncs fs=%d dir=%d, want one filesystem sync for ten baselines", fsSyncs.Load(), dirSyncs.Load())
	}
	for _, update := range updates {
		invalidateTrafficPrev(update.port)
		if got := readPrevState(update.port); got.in != 10 || got.out != 20 || got.ruleID != update.state.ruleID {
			t.Fatalf("baseline port %s = %#v", update.port, got)
		}
	}

	// syncfs 不可用：逐个 fsync 文件，目录只 fsync 一次。
	trafficStateFilesystemSync = func(string) error { return errors.New("unsupported") }
	next := make([]trafficBaselineUpdate, 0, len(updates))
	for _, update := range updates {
		update.state.in = 11
		next = append(next, update)
	}
	if err := commitTrafficBaselines(true, next); err != nil {
		t.Fatal(err)
	}
	if dirSyncs.Load() != 1 {
		t.Fatalf("fallback directory syncs = %d, want 1", dirSyncs.Load())
	}

	// 落盘失败必须报错（调用方据此保留待确认报告），并让缓存失效以便下次重写。
	trafficStateDirectorySync = func(string) error { return errors.New("disk gone") }
	failing := next[0]
	failing.state.in = 12
	if err := commitTrafficBaselines(true, []trafficBaselineUpdate{failing}); err == nil {
		t.Fatal("baseline sync failure was not reported")
	}
	trafficPrevMu.Lock()
	_, cached := trafficPrevCache[failing.port]
	trafficPrevMu.Unlock()
	if cached {
		t.Fatal("unsynced baseline stayed cached; the next commit would skip rewriting it")
	}
}

func TestWriteFileAtomicDurableReplacesContent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unit.service")
	if err := os.WriteFile(path, []byte("old"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomicDurable(path, []byte("new"), 0755); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	info, _ := os.Stat(path)
	if string(raw) != "new" || info.Mode().Perm() != 0755 {
		t.Fatalf("content=%q mode=%v", raw, info.Mode().Perm())
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %d entries", len(entries))
	}
}

func TestDNSWatchTreatsRotatingPoolAsStable(t *testing.T) {
	resetDNSWatchTestState()
	defer resetDNSWatchTestState()
	items := []dnsWatchItem{{Host: "pool.example.com", Scope: "forward-rule-target", RefID: 7}}
	lookup := dnsWatchLookupSequence(
		[]string{"192.0.2.1", "192.0.2.2"},
		[]string{"192.0.2.2", "192.0.2.3"},
		[]string{"192.0.2.1", "192.0.2.3"},
	)
	start := time.Unix(500, 0)
	updateDNSWatchWithLookupAt(items, lookup, start)
	if updateDNSWatchWithLookupAt(items, lookup, start.Add(2*time.Second)) {
		t.Fatal("overlapping pool answer started fast confirmation polling")
	}
	if updateDNSWatchWithLookupAt(items, lookup, start.Add(4*time.Second)) {
		t.Fatal("overlapping pool answer started fast confirmation polling")
	}
	if changes := takePendingDNSChanges(); len(changes) != 0 {
		t.Fatalf("rotating pool reported as a change: %#v", changes)
	}
}

func TestDNSWatchDualStackIPv6ChangeIsNotHiddenByIPv4Overlap(t *testing.T) {
	if dnsAnswerSetsOverlap([]string{"192.0.2.1", "2001:db8::1"}, []string{"192.0.2.1", "2001:db8:ffff::1"}) {
		t.Fatal("IPv6 renumbering hidden by an unchanged IPv4 address")
	}
	if !dnsAnswerSetsOverlap([]string{"192.0.2.1", "192.0.2.2"}, []string{"192.0.2.2", "192.0.2.9"}) {
		t.Fatal("overlapping IPv4 pools not treated as the same set")
	}
}

func TestDNSWatchCapsUnstableConfirmation(t *testing.T) {
	resetDNSWatchTestState()
	defer resetDNSWatchTestState()
	items := []dnsWatchItem{{Host: "flappy.example.com", Scope: "forward-rule-target", RefID: 8}}
	answers := [][]string{{"192.0.2.1"}}
	for i := 10; i < 20; i++ {
		answers = append(answers, []string{"198.51.100." + strconv.Itoa(i)})
	}
	lookup := dnsWatchLookupSequence(answers...)
	start := time.Unix(600, 0)
	updateDNSWatchWithLookupAt(items, lookup, start)
	reported := false
	for i := 1; i <= 8; i++ {
		updateDNSWatchWithLookupAt(items, lookup, start.Add(time.Duration(i)*2*time.Second))
		if len(takePendingDNSChanges()) > 0 {
			reported = true
			if i < dnsChangeMaxConfirmationAttempts {
				t.Fatalf("unstable answer reported after only %d attempts", i)
			}
			break
		}
	}
	if !reported {
		t.Fatal("never-stable DNS answers stayed pending forever")
	}
}

func TestResolveDNSWatchHostsBoundsConcurrency(t *testing.T) {
	watched := map[string]string{}
	for i := 0; i < 40; i++ {
		host := "h" + strconv.Itoa(i) + ".example.com"
		watched[host] = host
	}
	var active, peak atomic.Int32
	resolved := resolveDNSWatchHosts(watched, func(host string) []string {
		current := active.Add(1)
		for {
			previous := peak.Load()
			if current <= previous || peak.CompareAndSwap(previous, current) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		active.Add(-1)
		return []string{"192.0.2.1"}
	})
	if len(resolved) != len(watched) {
		t.Fatalf("resolved %d of %d hosts", len(resolved), len(watched))
	}
	if peak.Load() > dnsWatchLookupConcurrency {
		t.Fatalf("peak concurrent lookups = %d, limit %d", peak.Load(), dnsWatchLookupConcurrency)
	}
}

func TestFXPAdoptedPIDAliveRejectsReusedPID(t *testing.T) {
	previous := fxpProcCmdlineReader
	t.Cleanup(func() { fxpProcCmdlineReader = previous })
	pid := os.Getpid()
	configPath := "/run/forwardx-agent/fxp-entry-1-20001.json"
	fxpProcCmdlineReader = func(int) ([]byte, error) {
		return []byte("/usr/sbin/nginx\x00-g\x00daemon off;\x00"), nil
	}
	if fxpAdoptedPIDAlive(pid, configPath) {
		t.Fatal("a reused PID running another program was treated as the adopted FXP")
	}
	fxpProcCmdlineReader = func(int) ([]byte, error) {
		return []byte("/usr/local/bin/forwardx-fxp\x00-config\x00" + configPath + "\x00"), nil
	}
	if !fxpAdoptedPIDAlive(pid, configPath) {
		t.Fatal("the adopted FXP process was not recognised")
	}
	if fxpAdoptedPIDAlive(pid, "/run/forwardx-agent/fxp-entry-2-20002.json") {
		t.Fatal("an FXP process with another config was treated as the adopted one")
	}
}

type collectingWriter struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (w *collectingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func (w *collectingWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

func TestFXPLogTailDeliversCompleteLinesAndSurvivesTruncation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fxp-entry-1-20001.log")
	file, offset, err := openFXPRuntimeLogFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	sink := &collectingWriter{}
	tail := newFXPLogTail(path, offset, func() io.Writer { return sink })
	_, _ = file.WriteString("exit endpoint unhealthy index=1 endpoint=203.0.113.8:62444\npartial")
	tail.poll()
	if got := sink.String(); got != "exit endpoint unhealthy index=1 endpoint=203.0.113.8:62444\n" {
		t.Fatalf("first poll delivered %q", got)
	}
	_, _ = file.WriteString(" line\n")
	tail.poll()
	if !strings.HasSuffix(sink.String(), "partial line\n") {
		t.Fatalf("partial line was not joined: %q", sink.String())
	}
	// 日志维护原地截断文件后继续跟读新内容。
	if err := os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	tail.poll()
	_, _ = file.WriteString("after truncate\n")
	tail.poll()
	if !strings.HasSuffix(sink.String(), "after truncate\n") {
		t.Fatalf("tail stopped after truncation: %q", sink.String())
	}
	if got := fxpRuntimeLogPath("/run/forwardx-agent/fxp-entry-1-20001.json"); got != filepath.Join(agentLogDir, "fxp-entry-1-20001.log") {
		t.Fatalf("log path = %s", got)
	}
}
