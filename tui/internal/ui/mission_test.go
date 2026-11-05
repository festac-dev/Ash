package ui

import (
	"fmt"
	"strings"
	"testing"

	"ash-tui/internal/api"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

func missionFixture() *Model {
	m := readyModel()
	m.state.Task = &api.Task{ID: "task_demo", Description: "Freelancer launch pack", Currency: "USDC", Budget: "25.00", Status: "executing", Plan: &api.Plan{Subtasks: []api.Subtask{
		{ID: "st_4", Title: "Join both deliverables", Dependencies: []string{"st_2", "st_3"}},
		{ID: "st_1", Title: "Define requirements", Execution: "DIY"},
		{ID: "st_2", Title: "Independent review", Dependencies: []string{"st_1"}, Execution: "EXTERNAL", PlannedMax: "14.00"},
		{ID: "st_3", Title: "Local invoice plan", Dependencies: []string{"st_1"}, Execution: "DIY"},
	}}, Subtasks: []api.SubtaskState{{ID: "st_1", Phase: "completed"}, {ID: "st_2", Phase: "waiting_job"}, {ID: "st_3", Phase: "completed"}, {ID: "st_4", Phase: "pending"}}}
	m.state.Ledger = &api.Ledger{Authorized: "25.00", Committed: "14.00", Paid: "0.00", Available: "11.00", Currency: "USDC"}
	return m
}

func TestGraphOrdersDependenciesAndShowsAllJoinEdges(t *testing.T) {
	m := missionFixture()
	m.screen = screenExecution
	nodes := graphNodes(m.activeTask())
	if nodes[0].subtask.ID != "st_1" || nodes[3].subtask.ID != "st_4" || nodes[3].depth != 2 {
		t.Fatalf("wrong graph order: %+v", nodes)
	}
	view := ansi.Strip(m.View())
	if !strings.Contains(view, "st_2, st_3") {
		t.Fatal("join dependencies were omitted")
	}
	m.matrix = true
	view = ansi.Strip(m.View())
	if !strings.Contains(view, "DEPENDENCY MATRIX") || !strings.Contains(view, "◆") {
		t.Fatal("matrix did not render dependency edges")
	}
}

func TestClickGraphNodeInspectsThatNode(t *testing.T) {
	m := missionFixture()
	m.screen = screenExecution
	m.View()
	for _, area := range m.hits {
		if area.action == "node:1" {
			m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: area.x1, Y: area.y})
			if m.modal == nil || !strings.Contains(m.modal.Title, "st_2") {
				t.Fatal("wrong node selected")
			}
			return
		}
	}
	t.Fatal("node was not clickable")
}

func TestEveryScreenFitsAndHitsStayOnScreen(t *testing.T) {
	for _, size := range [][2]int{{28, 12}, {40, 24}, {80, 24}, {140, 40}} {
		for screenID := screenDashboard; screenID <= screenReplay; screenID++ {
			m := missionFixture()
			m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
			m.screen = screenID
			view := m.View()
			lines := strings.Split(view, "\n")
			if len(lines) > size[1] {
				t.Fatalf("screen %d height %d > %d", screenID, len(lines), size[1])
			}
			for _, line := range lines {
				if ansi.StringWidth(line) > size[0] {
					t.Fatalf("screen %d width %d > %d: %s", screenID, ansi.StringWidth(line), size[0], line)
				}
			}
			for _, hit := range m.hits {
				if hit.y >= size[1]-2 || hit.x2 >= size[0] {
					t.Fatalf("offscreen hit: %+v", hit)
				}
			}
		}
	}
}

func TestSearchCapturesNavigationLetters(t *testing.T) {
	m := missionFixture()
	m.screen = screenMarket
	m.agentFocus = true
	m.agentQuery.Focus()
	for _, r := range "payment" {
		m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	if m.agentQuery.Value() != "payment" || m.screen != screenMarket {
		t.Fatal("global shortcuts intercepted search input")
	}
}

func TestReplayNeverExecutesFinancialActions(t *testing.T) {
	m := missionFixture()
	m.screen = screenReplay
	m.timeline = &api.Timeline{TaskID: "task_demo", Events: []api.Event{{Code: "BEGIN"}, {Code: "JOB_FUNDED"}}}
	for _, key := range []rune{'e', 'p', 'x', 'b', 'v', 'f'} {
		_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{key}})
		if cmd != nil {
			t.Fatalf("replay action %c returned a command", key)
		}
	}
	m.activate("replay-play")
	m.Update(replayTickMsg{generation: m.replayGeneration})
	if m.replayCursor != 1 || m.state.Task.Status != "executing" {
		t.Fatal("replay changed live state or failed to step")
	}
	m.activate("replay-home")
	if m.replayCursor != 0 || m.replayPlaying {
		t.Fatal("rewind failed")
	}
}

func TestPaletteFindsTaskAndMoneyCommands(t *testing.T) {
	m := missionFixture()
	m.state.Tasks = []api.TaskSummary{{ID: "task_old", Description: "Previous launch"}}
	m.openPalette()
	m.modal.Input.SetValue("money")
	if got := m.paletteMatches(); len(got) != 1 || got[0].action != "money" {
		t.Fatal("money command missing")
	}
	m.modal.Input.SetValue("previous")
	if got := m.paletteMatches(); len(got) != 1 || got[0].action != "activate:task_old" {
		t.Fatal("task switch missing")
	}
}

func TestTaskSwitchClearsEventsAndReplay(t *testing.T) {
	m := missionFixture()
	m.lastTaskID = "task_demo"
	m.logs = []string{"old log"}
	m.timeline = &api.Timeline{TaskID: "task_demo"}
	m.replayPlaying = true
	m.Update(refreshMsg{state: &api.State{Task: &api.Task{ID: "task_other"}, Events: []api.Event{{TaskID: "task_other", Code: "NEW"}}}})
	if m.timeline != nil || m.replayPlaying || len(m.logs) != 1 || strings.Contains(m.logs[0], "old log") {
		t.Fatal("old task evidence leaked into the new task")
	}
}

func TestAgentComparisonPinsByIdentity(t *testing.T) {
	m := missionFixture()
	for i := 0; i < 4; i++ {
		m.agents = append(m.agents, api.Agent{ID: fmt.Sprint(i), Name: fmt.Sprint(i)})
	}
	for i := 0; i < 4; i++ {
		m.agentCursor = i
		m.toggleCompare()
	}
	if len(m.compared) != 3 {
		t.Fatal("comparison limit not enforced")
	}
	m.agentCursor = 0
	m.toggleCompare()
	if len(m.compared) != 2 {
		t.Fatal("unpin failed")
	}
	m.compareAgents()
	if m.modal == nil || !strings.Contains(m.modal.Body, "unrated") {
		t.Fatal("unknown performance should not become a fabricated score")
	}
}

func TestReviewNeverTargetsAnotherSelectedNode(t *testing.T) {
	m := missionFixture()
	m.state.Task.Subtasks[1].Phase = "awaiting_human_review"
	m.graphCursor = 0
	m.openReviewModal("fail")
	if m.modal != nil {
		t.Fatal("review targeted a different subtask than the selected node")
	}
	m.graphCursor = 1
	m.openReviewModal("fail")
	if m.modal == nil || m.modal.SubtaskID != "st_2" {
		t.Fatal("selected eligible subtask was not reviewed")
	}
}

func TestHTTPRefreshDoesNotPretendEventStreamReconnected(t *testing.T) {
	m := missionFixture()
	m.connected = false
	m.Update(refreshMsg{state: m.state})
	if m.connected {
		t.Fatal("HTTP response incorrectly marked the event stream connected")
	}
}

func TestReplaySelectionSurvivesRollingHistory(t *testing.T) {
	m := missionFixture()
	m.screen = screenReplay
	first := api.Event{At: "1", Code: "FIRST"}
	selected := api.Event{At: "2", Code: "SELECTED"}
	next := api.Event{At: "3", Code: "NEXT"}
	m.timeline = &api.Timeline{Events: []api.Event{first, selected, next}}
	m.replayCursor = 1
	m.Update(timelineMsg{taskID: "task_demo", view: &api.Timeline{Events: []api.Event{selected, next}, EventsTruncated: true}})
	if m.timeline.Events[m.replayCursor].Code != "SELECTED" {
		t.Fatal("history refresh changed the selected event")
	}
	m.replayPlaying = true
	m.Update(timelineMsg{taskID: "task_demo", view: &api.Timeline{Events: []api.Event{next}, EventsTruncated: true}})
	if m.replayPlaying || m.replayCursor != 0 {
		t.Fatal("evicted event should stop playback with a notice")
	}
}

func TestReplayPaletteDoesNotExecuteTasks(t *testing.T) {
	for _, action := range []string{"execute", "plan", "pause", "resume", "cancel", "budget"} {
		m := missionFixture()
		m.screen = screenReplay
		if cmd := m.activate(action); cmd != nil || m.modal != nil {
			t.Fatalf("replay allowed palette action %s", action)
		}
	}
}

func TestReplayIgnoresTimersFromAnEarlierPlayback(t *testing.T) {
	m := missionFixture()
	m.screen = screenReplay
	m.timeline = &api.Timeline{Events: []api.Event{{Code: "FIRST"}, {Code: "SECOND"}, {Code: "THIRD"}}}
	m.activate("replay-play")
	oldTick := replayTickMsg{generation: m.replayGeneration}
	m.activate("replay-play")
	m.activate("replay-play")
	if _, cmd := m.Update(oldTick); cmd != nil || m.replayCursor != 0 {
		t.Fatal("old timer accelerated the new playback")
	}
	m.Update(replayTickMsg{generation: m.replayGeneration})
	if m.replayCursor != 1 {
		t.Fatal("current timer did not advance")
	}
}
