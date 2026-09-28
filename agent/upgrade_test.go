package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// 和 server/agentInstallScriptSignature.test.ts 用同一组向量，保证两端算法一致。
func TestAgentInstallScriptSignatureMatchesPanelVector(t *testing.T) {
	got := agentInstallScriptSignature("vector-token", []byte("#!/bin/bash\necho forwardx\n"))
	want := "v1.522a96b8b68fbe851a7f4310ae42d2b5e64447820c6dc6d15b91bc26a5804d6d"
	if got != want {
		t.Fatalf("signature = %s, want %s", got, want)
	}
}

func TestVerifyAgentInstallScriptPolicy(t *testing.T) {
	script := []byte("#!/bin/bash\necho ok\n")
	signed := agentInstallScriptSignature("host-token", script)
	cases := []struct {
		name      string
		panel     string
		signature string
		ok        bool
	}{
		{"http signed", "http://panel.example", signed, true},
		{"https signed", "https://panel.example", signed, true},
		{"http unsigned refused", "http://panel.example", "", false},
		{"https unsigned old panel", "https://panel.example", "", true},
		{"http wrong signature", "http://panel.example", agentInstallScriptSignature("other-token", script), false},
		{"https wrong signature", "https://panel.example", "v1.deadbeef", false},
	}
	for _, tc := range cases {
		err := verifyAgentInstallScript(tc.panel, "host-token", script, tc.signature)
		if (err == nil) != tc.ok {
			t.Fatalf("%s: err=%v, want ok=%v", tc.name, err, tc.ok)
		}
	}
	if err := verifyAgentInstallScript("http://panel.example", "host-token", []byte("#!/bin/bash\nrm -rf /\n"), signed); err == nil {
		t.Fatal("a replaced script must not verify with the original signature")
	}
}

func TestDownloadVerifiedInstallScriptOverHTTP(t *testing.T) {
	resetAgentAuthChallengeCacheForTests()
	defer resetAgentAuthChallengeCacheForTests()
	const token = "download-token"
	script := "#!/bin/bash\necho upgrade\n"
	mode := "signed"
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/install.sh" {
			http.NotFound(w, r)
			return
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer v1.") {
			t.Errorf("install script request must carry an Agent auth proof, got %q", r.Header.Get("Authorization"))
		}
		body := script
		switch mode {
		case "signed":
			w.Header().Set(agentInstallScriptSignatureHeader, agentInstallScriptSignature(token, []byte(script)))
		case "tampered":
			w.Header().Set(agentInstallScriptSignatureHeader, agentInstallScriptSignature(token, []byte(script)))
			body = "#!/bin/bash\necho pwned\n"
		}
		_, _ = w.Write([]byte(body))
	}))
	defer panel.Close()

	path, err := downloadVerifiedInstallScript(context.Background(), panel.Client(), panel.URL, token)
	if err != nil {
		t.Fatalf("signed script over http should be accepted: %v", err)
	}
	defer os.Remove(path)
	data, err := os.ReadFile(path)
	if err != nil || string(data) != script {
		t.Fatalf("downloaded script = %q err=%v", data, err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("downloaded script must not be group/world accessible: %v %v", info.Mode(), err)
	}

	for _, m := range []string{"unsigned", "tampered"} {
		mode = m
		if path, err := downloadVerifiedInstallScript(context.Background(), panel.Client(), panel.URL, token); err == nil {
			os.Remove(path)
			t.Fatalf("%s script over http must be refused", m)
		}
	}
}

func TestDownloadVerifiedInstallScriptAcceptsUnsignedHTTPSFromOldPanel(t *testing.T) {
	resetAgentAuthChallengeCacheForTests()
	defer resetAgentAuthChallengeCacheForTests()
	panel := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("#!/bin/bash\necho old-panel\n"))
	}))
	defer panel.Close()
	path, err := downloadVerifiedInstallScript(context.Background(), panel.Client(), panel.URL, "old-panel-token")
	if err != nil {
		t.Fatalf("unsigned script from an https panel should stay compatible: %v", err)
	}
	os.Remove(path)
}
