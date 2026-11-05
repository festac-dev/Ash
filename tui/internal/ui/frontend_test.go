package ui

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ash-tui/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

func TestBrowserShortcutCyclesStartCodeStopIncludingInsideAccessDialog(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			if r.URL.Path != "/api/frontend/cycle" {
				t.Errorf("unexpected mutation: %s", r.URL.Path)
			}
			calls++
		} else if r.URL.Path != "/api/frontend" {
			t.Errorf("unexpected read: %s", r.URL.Path)
		}
		next := []string{"start", "code", "stop", "start"}[calls]
		code := ""
		if calls == 2 && r.Method == http.MethodPost {
			code = "ABCD-1234-EF56-7890"
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"running":%t,"url":"https://ash.example.test","port":443,"next_action":%q,"code":%q}`, calls == 1 || calls == 2, next, code)
	}))
	defer server.Close()
	t.Setenv("ASH_API_URL", server.URL)
	t.Setenv("ASH_API_TOKEN", "test-token")
	client, err := api.New()
	if err != nil {
		t.Fatal(err)
	}
	m := missionFixture()
	m.Client = client
	for i, key := range []rune{'b', 'B', 'b'} {
		_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{key}})
		if cmd == nil || !m.frontendBusy {
			t.Fatal("B did not start its action")
		}
		if m.toggleFrontend() != nil {
			t.Fatal("overlapping action accepted")
		}
		_, next := m.Update(cmd())
		if next == nil {
			t.Fatal("state read did not apply action")
		}
		m.Update(next())
		if m.frontendBusy {
			t.Fatal("action did not complete")
		}
		switch i {
		case 0:
			if !m.frontendRunning || m.frontendNext != "code" || m.modal == nil || strings.Contains(m.modal.Body, "ABCD") {
				t.Fatal("first B must start without a code")
			}
		case 1:
			if m.modal == nil || !strings.Contains(m.modal.Body, "ABCD-1234-EF56-7890") || m.frontendNext != "stop" {
				t.Fatal("second B must display the code")
			}
			if strings.Contains(m.statusMsg, "ABCD") {
				t.Fatal("code leaked into status history")
			}
		case 2:
			if m.frontendRunning || m.modal != nil || m.frontendNext != "start" {
				t.Fatal("third B must stop and clear access dialog")
			}
		}
	}
	if calls != 3 {
		t.Fatalf("got %d mutations, want 3", calls)
	}
	m.focusChat()
	m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'B'}})
	if m.frontendBusy || !strings.Contains(m.chatInput.Value(), "B") {
		t.Fatal("B intercepted chat input")
	}
}

func TestBrowserDoesNotOpenUntrustedSchemes(t *testing.T) {
	for _, raw := range []string{"file:///tmp/test", "javascript:alert(1)", "https://example.com", "http://evil.example/#ticket=test"} {
		if launchFrontendBrowser(raw) {
			t.Fatalf("opened unsafe URL %q", raw)
		}
	}
}

func TestFrontendCodeResponseDisplaysCodeWithoutLogging(t *testing.T) {
	m := missionFixture()
	status := &api.FrontendStatus{Running: true, URL: "http://127.0.0.1:5050", Port: 5050, Code: "ABCD-1234-EF56-7890", ExpiresAt: "2026-11-04T15:00:00Z"}
	m.Update(frontendMsg{status: status})
	if m.modal == nil || !strings.Contains(m.modal.Body, status.Code) || !strings.Contains(m.modal.Body, status.URL) || !strings.Contains(m.modal.Body, "ssh -L 5050:localhost:5050 user@vps") {
		t.Fatal("activation did not display the code, URL and SSH tunnel")
	}
	if strings.Contains(m.statusMsg, status.Code) {
		t.Fatal("code leaked into status history")
	}
}
