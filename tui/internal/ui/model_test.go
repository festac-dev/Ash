package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"ash-tui/internal/api"
)

func readyModel() *Model {
	model := New(nil)
	model.ready = true
	model.width = 120
	model.height = 40
	model.styles = NewStyles(120)
	model.state = &api.State{Mode: "SIMULATION", Config: api.PublicConfig{ModelProvider: "demo"}}
	model.connected = true
	return model
}

func TestNumberKeysSwitchScreens(t *testing.T) {
	model := readyModel()
	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'3'}})
	next, ok := updated.(*Model)
	if !ok {
		t.Fatal("Update returned a different model type")
	}
	if next.screen != screenMarket {
		t.Fatalf("expected market screen, got %v", next.screen)
	}
}

func TestWindowResizeUpdatesLayout(t *testing.T) {
	model := readyModel()
	updated, _ := model.Update(tea.WindowSizeMsg{Width: 70, Height: 24})
	next := updated.(*Model)
	if next.width != 70 || next.height != 24 {
		t.Fatalf("unexpected dimensions %dx%d", next.width, next.height)
	}
	if next.styles.width != 70 {
		t.Fatalf("styles were not rebuilt")
	}
}

func TestMouseClickSelectsTab(t *testing.T) {
	model := readyModel()
	_ = model.View()
	var target *hit
	for index := range model.hits {
		if model.hits[index].action == "tab:3" {
			target = &model.hits[index]
			break
		}
	}
	if target == nil {
		t.Fatal("tab hit box was not registered")
	}
	updated, _ := model.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: target.x1, Y: target.y})
	next := updated.(*Model)
	if next.screen != screenExecution {
		t.Fatalf("click did not switch to execution screen")
	}
}

func TestHelpModalOpensAndCloses(t *testing.T) {
	model := readyModel()
	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'?'}})
	next := updated.(*Model)
	if next.modal == nil || next.modal.Kind != "help" {
		t.Fatal("help modal did not open")
	}
	updated, _ = next.Update(tea.KeyMsg{Type: tea.KeyEsc})
	next = updated.(*Model)
	if next.modal != nil {
		t.Fatal("help modal did not close")
	}
}

func TestTaskFormRequiresDescriptionAndBudget(t *testing.T) {
	form := NewTaskForm(100)
	if _, err := form.Input(); err == nil {
		t.Fatal("empty form should be invalid")
	}
	form.Description.SetValue("Build a launch checklist")
	form.Budget.SetValue("150.00")
	input, err := form.Input()
	if err != nil {
		t.Fatalf("valid form rejected: %v", err)
	}
	if input.Currency != "USDC" || input.Strategy != "plan_then_approve" {
		t.Fatalf("unexpected defaults: %+v", input)
	}
}

func TestViewFitsTerminalHeight(t *testing.T) {
	model := readyModel()
	model.height = 24
	view := model.View()
	if lines := len(strings.Split(view, "\n")); lines > 24 {
		t.Fatalf("view rendered %d lines for a 24-line terminal", lines)
	}
}

func TestHumanReviewModalUsesExactPhrase(t *testing.T) {
	model := readyModel()
	model.state.Task = &api.Task{ID: "task_1", Status: "executing", Subtasks: []api.SubtaskState{{ID: "st_2", Phase: "awaiting_human_review"}}}
	model.screen = screenExecution
	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'v'}})
	next := updated.(*Model)
	if next.modal == nil || next.modal.Kind != "review" {
		t.Fatal("review modal did not open")
	}
	if next.modal.Phrase != "REVIEW st_2 PASS" {
		t.Fatalf("unexpected review phrase %q", next.modal.Phrase)
	}
}

func TestNarrowTerminalStillRenders(t *testing.T) {
	model := readyModel()
	model.width = 40
	model.height = 24
	model.styles = NewStyles(40)
	view := model.View()
	if lines := len(strings.Split(view, "\n")); lines > 24 {
		t.Fatalf("narrow view rendered %d lines", lines)
	}
}

// Click the position that is actually drawn, rather than trusting the hit map.
func clickVisibleLabel(t *testing.T, model *Model, label string) {
	t.Helper()
	for y, line := range strings.Split(ansi.Strip(model.View()), "\n") {
		if index := strings.Index(line, label); index >= 0 {
			x := lipgloss.Width(line[:index]) + lipgloss.Width(label)/2
			model.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: x, Y: y})
			return
		}
	}
	t.Fatalf("visible control %q is missing", label)
}

func TestModalCloseCanBeClickedAtItsRenderedPosition(t *testing.T) {
	for _, width := range []int{40, 80, 120} {
		model := readyModel()
		model.width, model.height = width, 24
		model.styles = NewStyles(width)
		model.modal = &Modal{Kind: "info", Title: "Details", Body: strings.Repeat("Evidence\n", 40)}
		clickVisibleLabel(t, model, "Close")
		if model.modal != nil {
			t.Fatal("clicking the drawn Close control did not close the dialog")
		}
	}
}

func TestFocusedNavigationControlIsVisibleAtEveryWidth(t *testing.T) {
	for _, width := range []int{28, 40, 60, 80, 120} {
		for index, item := range workspaceButtons {
			model := readyModel()
			model.width, model.navFocus = width, index
			model.styles = NewStyles(width)
			view := strings.Split(ansi.Strip(model.View()), "\n")
			found := false
			for _, area := range model.hits {
				if area.action == item.action && area.y == 3 {
					found = true
					if area.x2 >= lipgloss.Width(view[3]) {
						t.Fatalf("%d-column hit extends past the visible control", width)
					}
				}
			}
			if !found {
				t.Fatalf("%d-column focused navigation item %s is not clickable", width, item.label)
			}
		}
	}
}

func TestOverflowActionsRemainClickable(t *testing.T) {
	model := readyModel()
	model.width, model.height = 28, 24
	model.styles = NewStyles(28)
	model.screen = screenExecution
	// The navigation also has More; select the action-row hit explicitly by its
	// visible position on the following row, not by an assumed target rectangle.
	view := strings.Split(ansi.Strip(model.View()), "\n")
	x := strings.Index(view[4], "More")
	if x < 0 {
		t.Fatal("overflowed execution actions have no More control")
	}
	model.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: x + 1, Y: 4})
	if model.modal == nil || model.modal.Title != "Actions" {
		t.Fatal("action overflow did not open")
	}
	clickVisibleLabel(t, model, "Matrix")
	if !model.matrix || model.modal != nil {
		t.Fatal("hidden Matrix action cannot be selected by clicking")
	}
}

func TestBrowserAccessHasClickableCodeAndStopActions(t *testing.T) {
	for _, next := range []string{"code", "stop"} {
		model := readyModel()
		model.Client = &api.Client{}
		model.frontendRunning, model.frontendNext = true, next
		model.modal = &Modal{Kind: "frontend-access", Title: "Browser access", Body: "Frontend ON"}
		label := "Get code"
		if next == "stop" {
			label = "Stop web"
		}
		// At wide sizes the toolbar uses the same words; both visible controls
		// must work while the access dialog is open.
		clickVisibleLabel(t, model, label)
		if !model.frontendBusy || model.modal != nil {
			t.Fatalf("%s click did not trigger the access action", label)
		}
	}
}

func TestEmptyWorkspaceCreateActionIsClickable(t *testing.T) {
	model := readyModel()
	clickVisibleLabel(t, model, "N  Create a task")
	if model.screen != screenTask {
		t.Fatal("the visible Create task action did not open the form")
	}
}

func TestRenderedSendButtonWorksAcrossTerminalSizes(t *testing.T) {
	for _, size := range [][2]int{{40, 24}, {80, 24}, {120, 40}, {40, 16}} {
		model := readyModel()
		model.width, model.height = size[0], size[1]
		model.styles = NewStyles(model.width)
		model.chatInput.SetValue("/task Clickable send regression")
		clickVisibleLabel(t, model, "Send")
		if model.screen != screenTask || model.form.Description.Value() != "Clickable send regression" {
			t.Fatalf("Send button did not activate at %v", size)
		}
	}
}

func TestFooterStaysOnLastRowsAcrossScreensAndResizes(t *testing.T) {
	for _, size := range [][2]int{{28, 12}, {40, 16}, {80, 24}, {100, 32}, {160, 60}, {80, 24}} {
		for _, active := range []screen{screenDashboard, screenTask, screenMarket, screenExecution, screenTransactions, screenSecurity, screenSettings, screenMoney, screenReplay} {
			model := readyModel()
			model.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
			model.screen = active
			model.statusMsg = "Footer status"
			lines := strings.Split(ansi.Strip(model.View()), "\n")
			if len(lines) != size[1] || !strings.Contains(lines[size[1]-2], "Footer status") || strings.TrimSpace(lines[size[1]-1]) == "" {
				t.Fatalf("footer is not at the bottom on screen %d at %v", active, size)
			}
			for _, line := range lines {
				if lipgloss.Width(line) > size[0] {
					t.Fatalf("screen %d exceeds the terminal width at %v", active, size)
				}
			}
		}
	}
}

func TestVisibleAgentSearchCanBeClicked(t *testing.T) {
	model := readyModel()
	model.screen = screenMarket
	clickVisibleLabel(t, model, "Search:")
	if !model.agentFocus || !model.agentQuery.Focused() {
		t.Fatal("clicking Search did not focus the existing agent search input")
	}
}
