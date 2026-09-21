package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

/*
时段表的判定用例和面板共用一份。

两边各有一套实现是没办法的事 —— Agent 必须能在面板挂掉时照常按表走 —— 但漂移的
后果是「面板上显示走备线、机器上还在走主线」，而这种不一致没有任何地方会报错。
所以判定本身由 shared/failoverSchedule.cases.json 钉住：谁改出了偏差，谁那边红。
*/

type scheduleCase struct {
	Name     string                   `json:"name"`
	Timezone string                   `json:"timezone"`
	Windows  []failoverScheduleWindow `json:"windows"`
	At       string                   `json:"at"`
	Expected *int                     `json:"expected"`
}

func TestFailoverScheduleSharedCases(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "shared", "failoverSchedule.cases.json"))
	if err != nil {
		t.Fatalf("读共用用例表: %v", err)
	}
	var fixture struct {
		Cases []scheduleCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析共用用例表: %v", err)
	}
	// 锚点校验：读空了的话下面整轮断言会全部空转。
	if len(fixture.Cases) < 10 {
		t.Fatalf("用例表只读到 %d 条，路径大概不对", len(fixture.Cases))
	}

	for _, testCase := range fixture.Cases {
		at, err := time.Parse(time.RFC3339, testCase.At)
		if err != nil {
			t.Fatalf("%s: 时间格式不对 %q", testCase.Name, testCase.At)
		}
		schedule := &failoverSchedule{Timezone: testCase.Timezone, Windows: testCase.Windows}
		actual := failoverScheduleTargetIndexAt(schedule, at)
		expected := -1
		if testCase.Expected != nil {
			expected = *testCase.Expected
		}
		if actual != expected {
			t.Errorf("%s：期望 %d，拿到 %d", testCase.Name, expected, actual)
		}
	}
}

func TestFailoverScheduleNormalizationMatchesPanel(t *testing.T) {
	// 收不下的窗口一条都不留，不要半收 —— 半张表最危险：界面上像是配好了，
	// 实际什么都不会发生。
	schedule := normalizeFailoverSchedule(&failoverSchedule{
		Timezone: "Asia/Shanghai",
		Windows: []failoverScheduleWindow{
			{Days: nil, From: "18:00", To: "23:00", TargetIndex: 1},
			{Days: nil, From: "25:00", To: "26:00", TargetIndex: 1},
			{Days: nil, From: "10:00", To: "10:00", TargetIndex: 1},
			{Days: nil, From: "10:00", To: "11:00", TargetIndex: -1},
		},
	})
	if schedule == nil || len(schedule.Windows) != 1 {
		t.Fatalf("只有第一条是完整的，拿到 %+v", schedule)
	}

	// 七天全选等于每天，存成同一种写法。
	everyDay := normalizeFailoverSchedule(&failoverSchedule{
		Timezone: "Asia/Shanghai",
		Windows:  []failoverScheduleWindow{{Days: []int{0, 1, 2, 3, 4, 5, 6}, From: "18:00", To: "23:00", TargetIndex: 1}},
	})
	if everyDay == nil || len(everyDay.Windows[0].Days) != 0 {
		t.Fatalf("七天全选没被归一成每天：%+v", everyDay)
	}

	if normalizeFailoverSchedule(&failoverSchedule{Timezone: "", Windows: []failoverScheduleWindow{{From: "18:00", To: "23:00"}}}) != nil {
		t.Fatal("没有时区不该算一张表")
	}
	if normalizeFailoverSchedule(nil) != nil {
		t.Fatal("空的不该算一张表")
	}
}

func TestFailoverScheduleEmbedsTimezoneData(t *testing.T) {
	/*
		Agent 装在各种精简镜像上，很多根本没有 /usr/share/zoneinfo。缺了的话时段表
		会**静默不生效**：面板上配得好好的，机器上永远按主线路走，没有任何地方报错。
		所以 tzdata 是编进二进制的，这条盯着别哪天被当成"没用的依赖"删掉。
	*/
	for _, zone := range []string{"Asia/Shanghai", "America/Los_Angeles", "Europe/London"} {
		if _, err := time.LoadLocation(zone); err != nil {
			t.Fatalf("加载时区 %s 失败：%v —— time/tzdata 是不是被删了？", zone, err)
		}
	}
}

/*
时段表接进主备选路之后的行为。

三条不变量，每一条都是被现实逼出来的：
  · 时段表只改「谁是首选」，不重排剩下的兜底顺序
  · 首选那条不健康时，时段表说了不算 —— 切不切得过去由健康检查决定
  · 最短驻留拦的是「好线路之间来回切」，不是「逃离一条死路」
*/

func scheduleProxy(targets int, schedule *failoverSchedule, minHold int) *failoverProxy {
	list := make([]failoverTarget, 0, targets)
	for i := 0; i < targets; i++ {
		list = append(list, failoverTarget{TargetIP: "10.0.0." + strconv.Itoa(i+1), TargetPort: 80})
	}
	proxy := &failoverProxy{
		ruleID: 90, sourcePort: 21000,
		spec: normalizeFailoverSpec(failoverSpec{
			Enabled: true, ListenPort: 64000, BindAddress: "127.0.0.1", Strategy: "fallback",
			AutoFailback: true, Targets: list, Schedule: schedule, MinHoldSeconds: minHold,
		}),
	}
	proxy.ensureHealthStateLocked()
	return proxy
}

func eveningSchedule(targetIndex int) *failoverSchedule {
	return &failoverSchedule{
		Timezone: "Asia/Shanghai",
		Windows:  []failoverScheduleWindow{{From: "18:00", To: "23:00", TargetIndex: targetIndex}},
	}
}

func TestPriorityOrderFollowsSchedule(t *testing.T) {
	proxy := scheduleProxy(3, eveningSchedule(2), 0)
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, time.FixedZone("CST", 8*3600))
	morning := time.Date(2026, 9, 21, 9, 0, 0, 0, time.FixedZone("CST", 8*3600))

	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if got := proxy.priorityOrderLocked(evening); got[0] != 2 {
		t.Fatalf("晚高峰时首选应当是第 2 条，拿到 %v", got)
	}
	// 时段表只改首选，剩下的兜底顺序保持原样。
	if got := proxy.priorityOrderLocked(evening); got[1] != 0 || got[2] != 1 {
		t.Fatalf("兜底顺序被时段表重排了：%v", got)
	}
	if got := proxy.priorityOrderLocked(morning); got[0] != 0 || got[1] != 1 || got[2] != 2 {
		t.Fatalf("没有时段命中时应当还是数组顺序，拿到 %v", got)
	}
}

func TestScheduleDoesNotOverrideHealth(t *testing.T) {
	/*
		18 点到了而那条线正挂着，不该机械地切过去。时段表决定「首选是谁」，
		切不切得过去仍然由健康检查说了算 —— 这两件事是正交的。

		时刻必须显式传进去。读真实时钟的话这条用例只在真实时间落在 18-23 点时才
		走到判断，其余时候压根没有窗口命中 —— 测试照常绿，什么也没验证。第一版
		就是这么写的，反向验证没红才发现。
	*/
	proxy := scheduleProxy(3, eveningSchedule(2), 0)
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, time.FixedZone("CST", 8*3600))

	proxy.mu.Lock()
	// 先确认这个时刻时段表**确实**命中了，否则下面的断言是空的。
	if preferred := failoverScheduleTargetIndexAt(proxy.spec.Schedule, evening); preferred != 2 {
		proxy.mu.Unlock()
		t.Fatalf("用例前提没成立：这个时刻时段表该选第 2 条，拿到 %d", preferred)
	}
	proxy.targetHealth[2] = false
	proxy.updateFallbackActiveAtLocked(evening, "health check")
	active := proxy.activeIndex
	proxy.mu.Unlock()
	if active == 2 {
		t.Fatal("首选那条不健康时不该切过去 —— 那是把流量往死路里送")
	}
}

func TestScheduleSwitchesWhenPreferredIsHealthy(t *testing.T) {
	// 反过来也得成立：首选那条是健康的，到点就该走过去，否则时段表等于没配。
	proxy := scheduleProxy(3, eveningSchedule(2), 0)
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, time.FixedZone("CST", 8*3600))
	proxy.mu.Lock()
	proxy.updateFallbackActiveAtLocked(evening, "schedule")
	active := proxy.activeIndex
	proxy.mu.Unlock()
	if active != 2 {
		t.Fatalf("晚高峰该走第 2 条，拿到 %d", active)
	}
}

func TestScheduleReturnsToPriorityAfterWindow(t *testing.T) {
	// 窗口过了要自己回来。回不来的话「晚高峰错峰」就变成了「换了条线就不回来了」。
	proxy := scheduleProxy(3, eveningSchedule(2), 0)
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, time.FixedZone("CST", 8*3600))
	morning := time.Date(2026, 9, 22, 9, 0, 0, 0, time.FixedZone("CST", 8*3600))
	proxy.mu.Lock()
	proxy.updateFallbackActiveAtLocked(evening, "schedule")
	proxy.updateFallbackActiveAtLocked(morning, "schedule")
	active := proxy.activeIndex
	proxy.mu.Unlock()
	if active != 0 {
		t.Fatalf("窗口过了应当回到主出站，拿到 %d", active)
	}
}

func TestMinHoldBlocksFailbackButNotEscape(t *testing.T) {
	proxy := scheduleProxy(2, nil, 600)

	// 先制造一次切换：0 号挂了，逃到 1 号。
	proxy.mu.Lock()
	proxy.targetHealth[0] = false
	proxy.updateFallbackActiveLocked("health check")
	escaped := proxy.activeIndex
	proxy.mu.Unlock()
	if escaped != 1 {
		t.Fatalf("0 号挂了应当逃到 1 号，拿到 %d", escaped)
	}

	// 0 号马上恢复：在最短驻留时间里不许切回去，否则线路会来回抖。
	proxy.mu.Lock()
	proxy.targetHealth[0] = true
	proxy.updateFallbackActiveLocked("health check")
	held := proxy.activeIndex
	proxy.mu.Unlock()
	if held != 1 {
		t.Fatal("最短驻留时间里不该往回切")
	}

	// 但 1 号也挂了的话必须立刻逃 —— 守着一条死路比抖动更糟。
	proxy.mu.Lock()
	proxy.targetHealth[1] = false
	proxy.updateFallbackActiveLocked("health check")
	final := proxy.activeIndex
	proxy.mu.Unlock()
	if final != 0 {
		t.Fatal("当前这条挂了时，最短驻留不该拦住逃生")
	}
}

func TestMinHoldExpires(t *testing.T) {
	proxy := scheduleProxy(2, nil, 1)
	proxy.mu.Lock()
	proxy.targetHealth[0] = false
	proxy.updateFallbackActiveLocked("health check")
	proxy.targetHealth[0] = true
	proxy.lastSwitchAt = time.Now().Add(-2 * time.Second)
	proxy.updateFallbackActiveLocked("health check")
	active := proxy.activeIndex
	proxy.mu.Unlock()
	if active != 0 {
		t.Fatal("驻留时间过了就该按优先级切回主线路")
	}
}

func TestScheduleChangeRebuildsSignature(t *testing.T) {
	// 不带上时段表的话，只改时段表不触发重建：面板显示成功，机器还按老表走，
	// 而时段表恰恰是「到点才知道有没有生效」的东西。
	base := normalizeFailoverSpec(failoverSpec{
		ListenPort: 1, BindAddress: "127.0.0.1", Strategy: "fallback",
		Targets: []failoverTarget{{TargetIP: "10.0.0.1", TargetPort: 80}},
	})
	withSchedule := base
	withSchedule.Schedule = eveningSchedule(0)
	if failoverSignature(base) == failoverSignature(withSchedule) {
		t.Fatal("加了时段表签名没变")
	}
	moved := base
	moved.Schedule = eveningSchedule(1)
	if failoverSignature(withSchedule) == failoverSignature(moved) {
		t.Fatal("时段表改了首选出站，签名没变")
	}
	withHold := base
	withHold.MinHoldSeconds = 600
	if failoverSignature(base) == failoverSignature(withHold) {
		t.Fatal("改了最短驻留，签名没变")
	}
}
