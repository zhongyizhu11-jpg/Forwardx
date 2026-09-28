package main

import "testing"

// NEX 隧道的入口是租户机器时面板按出口记账，出口 FXP 也得拿到面板地址和令牌；
// 中转不是记账点，不给。
func TestFXPExitGetsPanelCredentialsForTrafficReports(t *testing.T) {
	cfg := Config{PanelURL: "https://panel.example.test/", Token: "agent-token"}
	exit := fxpSpecWithPanelCredentials(cfg, fxpSpec{Role: "exit", TunnelID: 1, ListenPort: 30001})
	if exit.PanelURL == "" || exit.Token != "agent-token" {
		t.Fatalf("exit spec missing panel credentials: url=%q token=%q", exit.PanelURL, exit.Token)
	}
	entry := fxpSpecWithPanelCredentials(cfg, fxpSpec{Role: "entry", TunnelID: 1, RuleID: 2, ListenPort: 10002})
	if entry.PanelURL == "" || entry.Token != "agent-token" {
		t.Fatalf("entry spec missing panel credentials: url=%q token=%q", entry.PanelURL, entry.Token)
	}
	relay := fxpSpecWithPanelCredentials(cfg, fxpSpec{Role: "relay", TunnelID: 1, ListenPort: 30002})
	if relay.PanelURL != "" || relay.Token != "" {
		t.Fatalf("relay spec must not carry panel credentials: url=%q token=%q", relay.PanelURL, relay.Token)
	}

	if !fxpSpecNeedsPanelCredentials(fxpSpec{Role: "exit"}) {
		t.Fatal("exit runtime must be rebuilt when panel credentials change")
	}
	if fxpSpecNeedsPanelCredentials(fxpSpec{Role: "relay"}) {
		t.Fatal("relay runtime does not carry panel credentials")
	}
	// 老出口配置没有凭据：换上新 Agent 后按「凭据对不上」重建，出口才开始报流量。
	if digest, ok := fxpSpecPanelCredentialDigest(fxpSpec{Role: "exit"}); ok || digest != "" {
		t.Fatalf("exit spec without credentials must not match any digest: %q %v", digest, ok)
	}
	digest, ok := fxpSpecPanelCredentialDigest(exit)
	if !ok || digest != fxpPanelCredentialDigest(exit.PanelURL, exit.Token) {
		t.Fatalf("exit credential digest = %q %v", digest, ok)
	}
}
