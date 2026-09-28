package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

/*
出口按规则记流量。

以前 NEX 隧道的流量只有入口报：面板只认入口机的上报，出口 FXP 连面板地址和令牌
都没有。入口机是租户自己的机器时，改一下入口上的 Agent/FXP 让它报 0，流量就白走
管理员的出口，配额和计费都不动。

现在出口也按 hello 里的规则记一份，面板决定按哪边算（入口全是管理员的机器时照旧
按入口，否则按出口，两边只算一边，见 server/agentReportRoutes.ts）。记法和入口
对齐：入口 → 目标是 in，目标 → 入口是 out。

出口只替目标表里放行过的规则记（hello.accountingRuleID，authorizeExitTarget 填的），
入口在 hello 里写个别人的规则号，出口不会替那条规则报流量。中转不是记账点，不记。
*/

const trafficReportSideExit = "exit"

// exitTrafficReportConfig 是出口替一条规则上报用的配置：规则号是核对目标时放行的
// 那条，面板地址和令牌用出口自己的。ok=false 表示这趟不记。
func exitTrafficReportConfig(cfg config, ruleID int) (config, bool) {
	// 没有面板地址或令牌（单独跑的出口、测试）就不记，也不刷「上报跳过」的日志：
	// 出口每个会话都会走到这里。Agent 起出口时总会给这两样。
	if ruleID <= 0 || strings.TrimSpace(cfg.PanelURL) == "" || strings.TrimSpace(cfg.Token) == "" {
		return config{}, false
	}
	return config{
		Role:       "exit",
		TunnelID:   cfg.TunnelID,
		RuleID:     ruleID,
		ListenPort: cfg.ListenPort,
		PanelURL:   cfg.PanelURL,
		Token:      cfg.Token,
	}, true
}

// fxpExitTrafficProducerID 是出口上报的 producer id。和入口的分开：同一台机器
// 既跑入口又跑出口时，两边的上报各自去重、各自重试，不会串到一个批次里。一个出口
// 监听只有一个，里面按规则分。
func fxpExitTrafficProducerID(cfg config) string {
	identity := fmt.Sprintf(
		"exit-accounting\x00%s\x00%s\x00%d\x00%d",
		strings.TrimRight(strings.TrimSpace(cfg.PanelURL), "/"),
		strings.TrimSpace(cfg.Token),
		cfg.TunnelID,
		cfg.ListenPort,
	)
	hash := sha256.Sum256([]byte(identity))
	return "fxp-exit-" + hex.EncodeToString(hash[:])
}

// startExitTrafficReporter 给出口的一个会话（或一条规则的 UDP 直连会话们）开上报。
// 这趟不记账时返回 nil 计数器和空的 stop，调用方照常转发。
func startExitTrafficReporter(cfg config, ruleID int) (*trafficCounter, func()) {
	reportCfg, ok := exitTrafficReportConfig(cfg, ruleID)
	if !ok {
		return nil, func() {}
	}
	counter := &trafficCounter{}
	stop := startTrafficReporterWith(counter, func(bytesIn, bytesOut, connections uint64) {
		enqueueTrafficForSide(reportCfg, trafficReportSideExit, bytesIn, bytesOut, connections)
	})
	return counter, stop
}
