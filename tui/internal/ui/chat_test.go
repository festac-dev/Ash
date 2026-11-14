package ui

import (
	"errors"
	"strings"
	"testing"

	"ash-tui/internal/api"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

func TestChatTypingDoesNotTriggerCommands(t *testing.T) {
	m := missionFixture()
	m.focusChat()
	for _, r := range "money replay execute quit M R" {
		m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	if m.chatInput.Value() != "money replay execute quit M R" || m.screen != screenDashboard || m.modal != nil {
		t.Fatal("chat text triggered an application command")
	}
	m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'M'}})
	if m.screen != screenMoney {
		t.Fatal("Money shortcut did not work after leaving chat")
	}
	m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'R'}})
	if m.screen != screenReplay {
		t.Fatal("Replay shortcut did not work after leaving chat")
	}
}

func TestChatTaskCommandOpensEditableFormWithoutExecution(t *testing.T) {
	m := missionFixture()
	m.focusChat()
	m.chatInput.SetValue("/task Create a launch checklist")
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil || m.screen != screenTask || m.form.Description.Value() != "Create a launch checklist" {
		t.Fatal("task brief did not open the form without executing")
	}
	if m.form.Budget.Value() != "" {
		t.Fatal("chat invented a budget")
	}
}

func TestChatRepliesAndDraftsStayWithTheirOriginalTask(t *testing.T) {
	m := missionFixture()
	m.focusChat()
	m.chatInput.SetValue("First task draft")
	m.conversation("task_demo").sending = true
	m.state.Task = &api.Task{ID: "task_other"}
	m.syncChat()
	m.chatInput.SetValue("Second task draft")
	first := "task_demo"
	m.receiveChat(chatMsg{taskID: first, sent: true, text: "First task draft", history: &api.ChatHistory{TaskID: &first, Messages: []api.ChatMessage{{Role: "assistant", Content: "Original task answer"}}}})
	if m.chatInput.Value() != "Second task draft" || m.conversation("task_other").history != nil {
		t.Fatal("reply leaked into the newly active task")
	}
	m.receiveChat(chatMsg{taskID: "task_other", sent: true, err: errors.New("offline")})
	if m.chatInput.Value() != "Second task draft" {
		t.Fatal("provider error lost the draft")
	}
}

func TestChatContentIsReadableAndCannotInjectTerminalControls(t *testing.T) {
	m := missionFixture()
	m.syncChat()
	s := m.conversation(m.chatTaskID)
	s.history = &api.ChatHistory{Messages: []api.ChatMessage{{Role: "assistant", Content: "Hello\x1b[2J\x07 world\n" + strings.Repeat("Long response line\n", 50)}}}
	m.focusChat()
	view := ansi.Strip(m.View())
	if !strings.Contains(view, "Message Ash") || strings.Contains(view, "\x07") {
		t.Fatal("chat input missing or terminal controls escaped")
	}
	if s.scroll != 0 {
		t.Fatal("new reply did not follow the bottom")
	}
	m.handleChatKey(tea.KeyMsg{Type: tea.KeyPgUp})
	if s.scroll == 0 {
		t.Fatal("chat history did not scroll")
	}
}

func TestSmallChatDashboardKeepsInputVisible(t *testing.T) {
	m := missionFixture()
	m.Update(tea.WindowSizeMsg{Width: 28, Height: 12})
	m.focusChat()
	m.chatInput.SetValue("Visible draft")
	if !strings.Contains(ansi.Strip(m.View()), "Visible draft") {
		t.Fatal("small terminal clipped the input")
	}
}

func TestTaskButtonsWorkWithoutRememberingShortcuts(t *testing.T) {
	m := missionFixture()
	m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if m.screen != screenTask || m.form.Focus != 0 {
		t.Fatal("Tab and Enter did not open the New task button")
	}
	m.form.Description.SetValue("Build a launch checklist")
	m.form.Budget.SetValue("25")
	m.View()
	for _, h := range m.hits {
		if h.action == "form-advanced" {
			m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: h.x1, Y: h.y})
			break
		}
	}
	if !m.form.Advanced || m.form.Description.Value() != "Build a launch checklist" || !m.form.RequireApproval {
		t.Fatal("expanding options lost the draft or changed approval defaults")
	}
	m.View()
	for _, h := range m.hits {
		if h.action == "form-cancel" {
			m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: h.x1, Y: h.y})
			if m.screen != screenDashboard || m.state.Task.ID != "task_demo" {
				t.Fatal("Cancel did not return safely to the workspace")
			}
			return
		}
	}
	t.Fatal("Cancel button was not visible")
}

func TestTaskFieldsNeverSubmitBeforeCreateButton(t *testing.T) {
	f := NewTaskForm(80)
	f.Description.SetValue("A useful outcome")
	f.Budget.SetValue("20")
	for _, id := range []int{0, 1, 6, 7, 8, 9, 10, 11, 12} {
		f.Focus = id
		var cmd tea.Cmd
		f, cmd = f.Update(tea.KeyMsg{Type: tea.KeyEnter})
		if cmd != nil {
			t.Fatalf("Enter on field %d submitted the task", id)
		}
	}
	f.Focus = 13
	_, cmd := f.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("Create & plan button did not submit")
	}
}

func TestDialogConfirmButtonPreservesApprovalPhrase(t *testing.T) {
	m := missionFixture()
	m.modal = &Modal{Kind: "approval", Title: "Approval", Approval: &api.Approval{ID: "approval_test"}, Decision: "approve", Input: m.agentQuery}
	m.modal.Input.Focus()
	m.View()
	for _, h := range m.hits {
		if h.action == "modal-submit" {
			_, cmd := m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: h.x1, Y: h.y})
			if cmd != nil || m.modal == nil || m.modal.Err == "" {
				t.Fatal("Confirm bypassed the required approval phrase")
			}
			return
		}
	}
	t.Fatal("Confirm button was not rendered")
}

func TestLongChatBriefSurvivesTaskFormHandoff(t *testing.T) {
	m := missionFixture()
	m.focusChat()
	brief := strings.Repeat("Detailed acceptance requirement. ", 90)
	m.chatInput.SetValue("/task\t" + brief)
	m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if m.screen != screenTask || m.form.Description.Value() != strings.TrimSpace(brief) {
		t.Fatal("long task brief was truncated or not recognized")
	}
}

func TestHistoryRefreshCannotOverwriteANewerChatTurn(t *testing.T) {
	m := missionFixture()
	m.syncChat()
	s := m.conversation(m.chatTaskID)
	s.generation = 1
	m.receiveChat(chatMsg{taskID: m.chatTaskID, sent: true, generation: 1, history: &api.ChatHistory{Messages: []api.ChatMessage{{Role: "assistant", Content: "New reply", At: "2026-11-03T14:00:00Z"}}}})
	m.receiveChat(chatMsg{taskID: m.chatTaskID, generation: 0, history: &api.ChatHistory{Messages: []api.ChatMessage{{Role: "assistant", Content: "Old reply", At: "2026-11-03T14:00:00Z"}}}})
	if s.history.Messages[0].Content != "New reply" {
		t.Fatal("late history response replaced the reply")
	}
}

func TestHistoryRecoveryClearsOnlyHistoryErrors(t *testing.T) {
	m := missionFixture()
	m.syncChat()
	s := m.conversation(m.chatTaskID)
	s.err = "Provider unavailable"
	m.receiveChat(chatMsg{taskID: m.chatTaskID, err: errors.New("History offline")})
	m.receiveChat(chatMsg{taskID: m.chatTaskID, history: &api.ChatHistory{}})
	if s.loadErr != "" || s.err != "Provider unavailable" {
		t.Fatal("history refresh left a stale error or hid a failed send")
	}
}
