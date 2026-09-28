package main

import (
	"hash/fnv"
	"math/rand/v2"
	"time"
)

const agentPeriodicJitterPercent = 10

// stableIntervalJitter returns a deterministic interval in base +/- percent.
// A stable per-Agent key spreads periodic work without causing timer drift.
func stableIntervalJitter(base time.Duration, key string, percent int) time.Duration {
	if base <= 0 || percent <= 0 || key == "" {
		return base
	}
	if percent > 20 {
		percent = 20
	}
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(key))
	spreadBasisPoints := int64(percent * 100)
	span := uint64(spreadBasisPoints*2 + 1)
	offsetBasisPoints := int64(hash.Sum64()%span) - spreadBasisPoints
	jittered := base + time.Duration(int64(base)*offsetBasisPoints/10_000)
	if jittered < time.Millisecond {
		return time.Millisecond
	}
	return jittered
}

// stableIntervalJitterBelow spreads an interval across [base-percent, base].
// It is used where base is also a hard audit deadline.
func stableIntervalJitterBelow(base time.Duration, key string, percent int) time.Duration {
	if base <= 0 || percent <= 0 || key == "" {
		return base
	}
	if percent > 20 {
		percent = 20
	}
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(key))
	spreadBasisPoints := uint64(percent * 100)
	offsetBasisPoints := int64(hash.Sum64() % (spreadBasisPoints + 1))
	return base - time.Duration(int64(base)*offsetBasisPoints/10_000)
}

func agentPeriodicInterval(base time.Duration, scope string) time.Duration {
	return stableIntervalJitter(base, agentBootID+":"+scope, agentPeriodicJitterPercent)
}

// fullJitterDelay 在 [floor, base] 内均匀随机取一个等待时间（“full jitter”）。
// 面板重启后所有 Agent 会在同一时刻失败，固定的重试间隔会让它们在同一时刻一起回来，
// 把刚起来的面板再压垮一次；随机化把这一波请求摊开。floor 防止退化成 0 间隔空转。
func fullJitterDelay(base time.Duration, floor time.Duration) time.Duration {
	if floor < 0 {
		floor = 0
	}
	if base <= floor {
		return base
	}
	return floor + time.Duration(rand.Int64N(int64(base-floor)+1))
}

// fullJitterSeconds 是按秒计的 fullJitterDelay，结果不小于 floor 秒。
func fullJitterSeconds(base int, floor int) int {
	if base <= floor {
		return base
	}
	return floor + rand.IntN(base-floor+1)
}

// randomDelayUpTo 返回 [0, limit] 内的随机时长。
func randomDelayUpTo(limit time.Duration) time.Duration {
	if limit <= 0 {
		return 0
	}
	return time.Duration(rand.Int64N(int64(limit) + 1))
}
