package ui

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ash-tui/internal/api"
	"github.com/charmbracelet/x/ansi"
)

func TestReviewStaysWithOriginalTaskAndCannotSubmitTwice(t *testing.T) {
	paths := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths <- r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"task":{"id":"task_demo"}}`))
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
	m.graphCursor = 1
	m.state.Task.Subtasks[1].Phase = "awaiting_human_review"
	m.openReviewModal("fail")
	m.modal.Input.SetValue(m.modal.Phrase)
	m.state.Task = &api.Task{ID: "task_other"}
	cmd := m.submitModal()
	if cmd == nil || m.submitModal() != nil {
		t.Fatal("review was missing or submitted twice")
	}
	m.Update(cmd())
	if got := <-paths; got != "/api/tasks/task_demo/review" {
		t.Fatalf("review targeted %s", got)
	}
	if m.modal != nil {
		t.Fatal("completed review dialog did not close")
	}
}

func TestCreateSuccessAndPlanFailureLeavesTaskForm(t *testing.T) {
	m := missionFixture()
	m.screen = screenTask
	m.creating = true
	m.Update(actionMsg{label: "Create task (plan failed)", task: &api.Task{ID: "new_task"}, err: errors.New("provider offline")})
	if m.screen != screenExecution || m.creating || !strings.Contains(m.statusMsg, "Task created") {
		t.Fatal("planning failure offered task creation again")
	}
}

func TestClosedStreamDoesNotRescheduleItself(t *testing.T) {
	m := missionFixture()
	stream := make(chan api.StreamMessage)
	close(stream)
	m.stream = stream
	_, cmd := m.Update(m.waitStream()())
	if cmd != nil || m.stream != nil || m.connected {
		t.Fatal("closed stream kept polling")
	}
}

func TestReceiptSelectionRemainsVisibleInShortTerminal(t *testing.T) {
	m := missionFixture()
	m.tx = &api.Transactions{}
	for i := 0; i < 40; i++ {
		m.tx.Receipts = append(m.tx.Receipts, api.ReceiptView{File: fmt.Sprintf("receipt-%02d", i)})
	}
	m.txCursor = 25
	view := ansi.Strip(m.viewTransactions(100, 12))
	if !strings.Contains(view, "receipt-25") || len(strings.Split(view, "\n")) > 13 {
		t.Fatal("selected receipt is clipped")
	}
}

func TestBlankSettingsAndTerminalControls(t *testing.T) {
	for _, key := range []string{"deadline", "quality_requirements", "additional_instructions"} {
		if currentSettingValue(&api.Settings{Task: &api.Task{}}, key) != "" {
			t.Fatal("empty setting became placeholder data")
		}
	}
	m := missionFixture()
	m.modal = &Modal{Kind: "info", Title: "Title\x07", Body: "Text\x1b[2J\x07End"}
	view := m.View()
	if strings.Contains(view, "\x07") || strings.Contains(view, "\x1b[2J") {
		t.Fatal("evidence injected terminal controls")
	}
}

func TestAuxiliaryResponsesCannotRestoreAnotherTaskOrOlderRequest(t *testing.T) {
	m := missionFixture()
	m.securitySequence = 2
	m.settingsSequence = 2
	for _, taskID := range []string{"task_other", m.activeTaskID()} {
		sequence := uint64(2)
		if taskID == m.activeTaskID() {
			sequence = 1
		}
		m.Update(securityMsg{taskID: taskID, sequence: sequence, view: &api.Security{}})
		m.Update(settingsMsg{taskID: taskID, sequence: sequence, view: &api.Settings{}})
		if m.security != nil || m.settings != nil {
			t.Fatal("stale response restored discarded task data")
		}
	}
	m.Update(securityMsg{taskID: m.activeTaskID(), sequence: 2, view: &api.Security{}})
	m.Update(settingsMsg{taskID: m.activeTaskID(), sequence: 2, view: &api.Settings{}})
	if m.security == nil || m.settings == nil {
		t.Fatal("current response was discarded")
	}
}
