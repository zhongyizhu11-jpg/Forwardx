package main

import (
	"strconv"
	"strings"
	"time"

	// 把时区数据编进二进制。
	//
	// time.LoadLocation 默认读 /usr/share/zoneinfo，而 Agent 要装在各种精简镜像上 ——
	// 那些镜像经常根本没有这个目录。缺了的话时段表会**静默不生效**：面板上配得好好的，
	// 机器上永远按主线路走，而且没有任何地方会报错。多几百 KB 换掉这一整类故障，值。
	_ "time/tzdata"
)

/*
主备的时段表：某几个时段里优先走哪一条出站。

判定必须在 Agent 本地做，不能等面板到点来改配置：面板挂了、网络断了，晚高峰照样
得切。代价是判定逻辑在面板（TS）和这里各有一份，而漂移的后果是「面板上显示走备线、
机器上还在走主线」—— 所以两边共用 shared/failoverSchedule.cases.json 那张用例表。

语义和面板那份逐字对齐：
  · 从上往下，第一条命中的说了算（例外写在前面才有意义）
  · 跨午夜的时段属于它**开始**的那一天
  · 认不出的时区一律当作没有时段表，绝不按猜出来的时区切线路
*/

type failoverScheduleWindow struct {
	// 0=周日 … 6=周六。空表示每天。
	Days []int `json:"days"`
	// "HH:MM"，24 小时制。
	From string `json:"from"`
	To   string `json:"to"`
	// 这个时段首选第几条出站；0 是主出站。
	TargetIndex int `json:"targetIndex"`
}

type failoverSchedule struct {
	Timezone string                   `json:"timezone"`
	Windows  []failoverScheduleWindow `json:"windows"`
}

const maxFailoverScheduleWindows = 8

// "HH:MM" → 当天第几分钟；不合法返回 -1。
func parseScheduleMinutes(value string) int {
	text := strings.TrimSpace(value)
	if len(text) != 5 || text[2] != ':' {
		return -1
	}
	hour, err := strconv.Atoi(text[0:2])
	if err != nil || hour < 0 || hour > 23 {
		return -1
	}
	minute, err := strconv.Atoi(text[3:5])
	if err != nil || minute < 0 || minute > 59 {
		return -1
	}
	return hour*60 + minute
}

func normalizeFailoverSchedule(schedule *failoverSchedule) *failoverSchedule {
	if schedule == nil || strings.TrimSpace(schedule.Timezone) == "" {
		return nil
	}
	cleaned := make([]failoverScheduleWindow, 0, len(schedule.Windows))
	for _, window := range schedule.Windows {
		from := parseScheduleMinutes(window.From)
		to := parseScheduleMinutes(window.To)
		// 起止相同的窗口没有长度，收下它等于收下一条永远不生效的设置。
		if from < 0 || to < 0 || from == to || window.TargetIndex < 0 {
			continue
		}
		days := make([]int, 0, len(window.Days))
		seen := map[int]bool{}
		for _, day := range window.Days {
			if day >= 0 && day <= 6 && !seen[day] {
				seen[day] = true
				days = append(days, day)
			}
		}
		// 七天全选等于每天，存成同一种写法。
		if len(days) == 7 {
			days = nil
		}
		cleaned = append(cleaned, failoverScheduleWindow{Days: days, From: window.From, To: window.To, TargetIndex: window.TargetIndex})
		if len(cleaned) >= maxFailoverScheduleWindows {
			break
		}
	}
	if len(cleaned) == 0 {
		return nil
	}
	return &failoverSchedule{Timezone: strings.TrimSpace(schedule.Timezone), Windows: cleaned}
}

func scheduleWindowMatches(window failoverScheduleWindow, weekday int, minutes int) bool {
	from := parseScheduleMinutes(window.From)
	to := parseScheduleMinutes(window.To)
	if from < 0 || to < 0 {
		return false
	}
	onDay := func(day int) bool {
		if len(window.Days) == 0 {
			return true
		}
		for _, allowed := range window.Days {
			if allowed == day {
				return true
			}
		}
		return false
	}
	if to > from {
		return onDay(weekday) && minutes >= from && minutes < to
	}
	// 跨午夜：属于它开始的那一天，所以凌晨那一段要回头看昨天有没有开这个窗口。
	if onDay(weekday) && minutes >= from {
		return true
	}
	return onDay((weekday+6)%7) && minutes < to
}

// 此刻首选第几条出站；没有时段命中返回 -1（按原来的优先级走）。
func failoverScheduleTargetIndexAt(schedule *failoverSchedule, at time.Time) int {
	normalized := normalizeFailoverSchedule(schedule)
	if normalized == nil {
		return -1
	}
	location, err := time.LoadLocation(normalized.Timezone)
	if err != nil {
		// 认不出的时区：宁可当作没有时段表，也不能按一个猜出来的时区切线路。
		return -1
	}
	local := at.In(location)
	weekday := int(local.Weekday())
	minutes := local.Hour()*60 + local.Minute()
	for _, window := range normalized.Windows {
		if scheduleWindowMatches(window, weekday, minutes) {
			return window.TargetIndex
		}
	}
	return -1
}

// 时段表的签名，进 failoverSignature。
//
// 不带上它的话，只改时段表不会触发重建：面板上改完显示成功，机器上还按老表走，
// 而时段表恰恰是「到点才知道有没有生效」的东西。
func failoverScheduleSignature(schedule *failoverSchedule) string {
	normalized := normalizeFailoverSchedule(schedule)
	if normalized == nil {
		return ""
	}
	parts := []string{normalized.Timezone}
	for _, window := range normalized.Windows {
		days := make([]string, 0, len(window.Days))
		for _, day := range window.Days {
			days = append(days, strconv.Itoa(day))
		}
		parts = append(parts, strings.Join(days, ",")+"|"+window.From+"|"+window.To+"|"+strconv.Itoa(window.TargetIndex))
	}
	return strings.Join(parts, ";")
}
