package main

import (
	"path/filepath"
	"testing"
	"time"
)

func failoverActiveReportFor(ruleID int, sourcePort int) *failoverActiveReport {
	for _, report := range failoverActiveSnapshot() {
		if report.RuleID == ruleID && report.SourcePort == sourcePort {
			found := report
			return &found
		}
	}
	return nil
}

// 面板上「现在走哪条」以这份快照为准，所以它必须跟得上代理自己的三种变化：
// 起来、切换、换规格。第三种最要紧 —— 它不报事件。
func TestFailoverActiveSnapshotFollowsTheLine(t *testing.T) {
	oldPersistentDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldPersistentDir })

	const ruleID = 920001
	const sourcePort = 62001
	t.Cleanup(func() { stopFailoverProxy(ruleID, sourcePort) })

	spec := failoverTestSpec(failoverTestPort(t))
	if !startFailoverProxy(ruleID, sourcePort, spec, nil) {
		t.Fatal("代理没起来")
	}
	started := failoverActiveReportFor(ruleID, sourcePort)
	if started == nil {
		t.Fatal("代理起来之后，快照里没有它")
	}
	if started.Target != "127.0.0.1:9" {
		t.Fatalf("刚起来走的应当是主出站，快照写的是 %s", started.Target)
	}
	if started.Since <= 0 {
		t.Fatal("快照没带「从什么时候起」")
	}

	proxy := currentFailoverProxy(ruleID, sourcePort)
	time.Sleep(2 * time.Millisecond)
	proxy.mu.Lock()
	proxy.setActiveLocked(1, "test")
	proxy.mu.Unlock()
	switched := failoverActiveReportFor(ruleID, sourcePort)
	if switched == nil || switched.Target != "127.0.0.1:10" {
		t.Fatalf("切到备用 1 之后快照没跟上：%+v", switched)
	}
	if switched.Since <= started.Since {
		t.Fatal("切换之后要重新计时")
	}

	// 换规格：代理原地换，活跃线路回到第 0 条，而且不报任何事件 —— 面板只靠事件的话
	// 会一直写着「走 备用 1」。这正是要每次心跳报快照的原因。
	drainFailoverEvents()
	time.Sleep(2 * time.Millisecond)
	respec := spec
	respec.FailoverSeconds = 90
	if !startFailoverProxy(ruleID, sourcePort, respec, nil) {
		t.Fatal("换规格失败")
	}
	for _, event := range drainFailoverEvents() {
		if event.RuleID == ruleID && event.Kind == "switch" {
			t.Fatalf("前提变了：换规格时报了切换事件 %+v —— 那快照就不是唯一的办法了，回头看看这条用例还该不该这么写", event)
		}
	}
	reset := failoverActiveReportFor(ruleID, sourcePort)
	if reset == nil || reset.Target != "127.0.0.1:9" {
		t.Fatalf("换规格之后代理回到了主出站，快照写的却是 %+v", reset)
	}
	if reset.Since <= switched.Since {
		t.Fatal("回到主出站要重新计时")
	}
}

func TestFailoverActiveSnapshotSkipsNonFallback(t *testing.T) {
	oldPersistentDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldPersistentDir })

	const ruleID = 920002
	const sourcePort = 62002
	t.Cleanup(func() { stopFailoverProxy(ruleID, sourcePort) })

	// 轮询本来就没有「现在走哪条」：每条连接走的都可能不一样，报一个出来只会误导。
	spec := failoverTestSpec(failoverTestPort(t))
	spec.Strategy = "round_robin"
	if !startFailoverProxy(ruleID, sourcePort, spec, nil) {
		t.Fatal("代理没起来")
	}
	if report := failoverActiveReportFor(ruleID, sourcePort); report != nil {
		t.Fatalf("轮询的代理不该出现在快照里：%+v", report)
	}
}
