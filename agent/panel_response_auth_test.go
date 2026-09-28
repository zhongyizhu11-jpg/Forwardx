package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 面板响应必须是用本机 token 验过的信封。网络路径上的人（面板地址是 http:// 时）
// 回一个明文 JSON，里面的 desiredState.actions[].commands 会以 root 执行；回一个带
// panelUrl 的 4xx，这台 Agent 就会被永久迁到他的面板。
func TestPanelResponsesMustBeAuthenticated(t *testing.T) {
	const token = "real-agent-token"
	serve := func(status int, body func() []byte) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/sync" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write(body())
		}))
	}
	encrypted := func(payload any) func() []byte {
		return func() []byte {
			env, err := encrypt(payload, token)
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(env)
			return raw
		}
	}
	plain := func(raw string) func() []byte { return func() []byte { return []byte(raw) } }
	call := func(srv *httptest.Server, out any) error {
		return postOnceWithClientToPanelURL(srv.Client(), Config{Token: token}, srv.URL, "/api/agent/heartbeat", map[string]any{}, out)
	}

	t.Run("plaintext 2xx with commands is rejected", func(t *testing.T) {
		srv := serve(http.StatusOK, plain(`{"desiredState":{"version":1,"actions":[{"op":"apply","ruleId":1,"sourcePort":1234,"commands":["id > /tmp/pwned"]}]}}`))
		defer srv.Close()
		var resp heartbeatResp
		err := call(srv, &resp)
		if !errors.Is(err, errUnauthenticatedPanelResponse) {
			t.Fatalf("expected rejection, got err=%v", err)
		}
		if resp.DesiredState != nil {
			t.Fatal("unauthenticated desired state was parsed")
		}
	})

	t.Run("plaintext 410 does not migrate the agent", func(t *testing.T) {
		srv := serve(http.StatusGone, plain(`{"error":"Panel migrated","panelUrl":"http://attacker.example"}`))
		defer srv.Close()
		var migrated migratedPanelError
		if err := call(srv, &map[string]any{}); errors.As(err, &migrated) {
			t.Fatalf("plaintext response migrated the agent to %s", migrated.PanelURL)
		}
	})

	t.Run("authenticated 2xx is accepted", func(t *testing.T) {
		srv := serve(http.StatusOK, encrypted(map[string]any{"success": true}))
		defer srv.Close()
		var out map[string]any
		if err := call(srv, &out); err != nil || out["success"] != true {
			t.Fatalf("authenticated response rejected: out=%v err=%v", out, err)
		}
	})

	t.Run("authenticated 410 still migrates", func(t *testing.T) {
		srv := serve(http.StatusGone, encrypted(map[string]any{"error": "Panel migrated", "panelUrl": "https://new-panel.example"}))
		defer srv.Close()
		var migrated migratedPanelError
		if err := call(srv, &map[string]any{}); !errors.As(err, &migrated) || migrated.PanelURL != "https://new-panel.example" {
			t.Fatalf("authenticated migration not honoured: err=%v", err)
		}
	})
}
