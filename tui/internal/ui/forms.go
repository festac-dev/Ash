package ui

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"ash-tui/internal/api"
)

var budgetPattern = regexp.MustCompile(`^[0-9]+(?:\.[0-9]{1,6})?$`)

type TaskForm struct {
	Description     textinput.Model
	Budget          textinput.Model
	Deadline        textinput.Model
	Quality         textinput.Model
	Preferred       textinput.Model
	Notes           textarea.Model
	Parallel        textinput.Model
	Currency        int
	Strategy        int
	AllowExternal   bool
	DIYFirst        bool
	RequireApproval bool
	Advanced        bool
	Scroll          int
	viewFocus       int
	Focus           int
	Width           int
	Err             string
}

var strategyLabels = []string{"plan then approve", "autonomous", "DIY first"}
var currencyLabels = []string{"USDC", "USD"}

func NewTaskForm(width int) TaskForm {
	desc := textinput.New()
	desc.Placeholder = "Describe the result you want Ash to deliver"
	desc.CharLimit = 10000
	budget := textinput.New()
	budget.Placeholder = "Your spending limit"
	budget.CharLimit = 24
	deadline := textinput.New()
	deadline.Placeholder = "YYYY-MM-DD or blank"
	deadline.CharLimit = 40
	quality := textinput.New()
	quality.Placeholder = "optional quality requirements"
	quality.CharLimit = 500
	preferred := textinput.New()
	preferred.Placeholder = "optional agents, comma separated"
	preferred.CharLimit = 500
	notes := textarea.New()
	notes.Placeholder = "optional private instructions; not published to the market"
	notes.SetWidth(max(20, width-8))
	notes.SetHeight(3)
	parallel := textinput.New()
	parallel.Placeholder = "installation default"
	parallel.CharLimit = 2
	form := TaskForm{
		Description:     desc,
		Budget:          budget,
		Deadline:        deadline,
		Quality:         quality,
		Preferred:       preferred,
		Notes:           notes,
		Parallel:        parallel,
		AllowExternal:   true,
		DIYFirst:        true,
		RequireApproval: true,
		Width:           width,
		viewFocus:       -1,
	}
	form.focusInput()
	return form
}

func (f *TaskForm) focusInput() {
	f.Description.Blur()
	f.Budget.Blur()
	f.Deadline.Blur()
	f.Quality.Blur()
	f.Preferred.Blur()
	f.Notes.Blur()
	f.Parallel.Blur()
	switch f.Focus {
	case 0:
		f.Description.Focus()
	case 1:
		f.Budget.Focus()
	case 2:
		f.Deadline.Focus()
	case 3:
		f.Quality.Focus()
	case 4:
		f.Preferred.Focus()
	case 5:
		f.Notes.Focus()
	case 11:
		f.Parallel.Focus()
	}
}

func (f TaskForm) focusOrder() []int {
	if f.Advanced {
		return []int{0, 1, 6, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14}
	}
	return []int{0, 1, 6, 12, 13, 14}
}

func (f *TaskForm) moveFocus(delta int) {
	order := f.focusOrder()
	index := 0
	for i, v := range order {
		if v == f.Focus {
			index = i
			break
		}
	}
	f.Focus = order[(index+delta+len(order))%len(order)]
	f.focusInput()
}

func (f TaskForm) Update(msg tea.Msg) (TaskForm, tea.Cmd) {
	key, ok := msg.(tea.KeyMsg)
	if !ok {
		return f.UpdateText(msg)
	}
	switch key.String() {
	case "tab":
		f.moveFocus(1)
		return f, nil
	case "shift+tab":
		f.moveFocus(-1)
		return f, nil
	case "ctrl+s":
		return f, func() tea.Msg { return formSubmitMsg{} }
	case "left", "right":
		if f.Focus == 6 {
			f.Currency = (f.Currency + 1) % len(currencyLabels)
			return f, nil
		}
		if f.Focus == 7 {
			delta := 1
			if key.String() == "left" {
				delta = len(strategyLabels) - 1
			}
			f.Strategy = (f.Strategy + delta) % len(strategyLabels)
			return f, nil
		}
	case "enter", " ":
		switch f.Focus {
		case 6:
			f.Currency = (f.Currency + 1) % len(currencyLabels)
			return f, nil
		case 7:
			f.Strategy = (f.Strategy + 1) % len(strategyLabels)
			return f, nil
		case 8:
			f.AllowExternal = !f.AllowExternal
			return f, nil
		case 9:
			f.DIYFirst = !f.DIYFirst
			return f, nil
		case 10:
			f.RequireApproval = !f.RequireApproval
			return f, nil
		case 12:
			f.Advanced = !f.Advanced
			f.Scroll = 0
			if f.Advanced {
				f.Focus = 2
			}
			f.focusInput()
			return f, nil
		case 13:
			return f, func() tea.Msg { return formSubmitMsg{} }
		case 14:
			return f, func() tea.Msg { return formCancelMsg{} }
		}
		if key.String() == "enter" && f.Focus != 5 {
			f.moveFocus(1)
			return f, nil
		}
	}
	return f.UpdateText(msg)
}

func (f TaskForm) UpdateText(msg tea.Msg) (TaskForm, tea.Cmd) {
	var cmd tea.Cmd
	switch f.Focus {
	case 0:
		f.Description, cmd = f.Description.Update(msg)
	case 1:
		f.Budget, cmd = f.Budget.Update(msg)
	case 2:
		f.Deadline, cmd = f.Deadline.Update(msg)
	case 3:
		f.Quality, cmd = f.Quality.Update(msg)
	case 4:
		f.Preferred, cmd = f.Preferred.Update(msg)
	case 5:
		f.Notes, cmd = f.Notes.Update(msg)
	case 11:
		f.Parallel, cmd = f.Parallel.Update(msg)
	}
	return f, cmd
}

func (f TaskForm) Input() (api.CreateTaskInput, error) {
	description := strings.TrimSpace(f.Description.Value())
	if len(description) < 3 {
		return api.CreateTaskInput{}, fmt.Errorf("describe the task in at least a few words")
	}
	budget := strings.TrimSpace(f.Budget.Value())
	if !budgetPattern.MatchString(budget) || strings.Trim(budget, "0.") == "" {
		return api.CreateTaskInput{}, fmt.Errorf("budget must be a positive decimal, e.g. 150.00")
	}
	if value, _ := strconv.ParseFloat(budget, 64); value <= 0 {
		return api.CreateTaskInput{}, fmt.Errorf("budget must be greater than zero")
	}
	var parallel *int
	if raw := strings.TrimSpace(f.Parallel.Value()); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 {
			return api.CreateTaskInput{}, fmt.Errorf("parallel jobs must be a positive whole number")
		}
		parallel = &value
	}
	deadline := optionalPtr(strings.TrimSpace(f.Deadline.Value()))
	quality := optionalPtr(strings.TrimSpace(f.Quality.Value()))
	notes := optionalPtr(strings.TrimSpace(f.Notes.Value()))
	preferred := splitCSV(f.Preferred.Value())
	return api.CreateTaskInput{
		Description:     description,
		Budget:          budget,
		Currency:        currencyLabels[f.Currency],
		Deadline:        deadline,
		Quality:         quality,
		PreferredAgents: preferred,
		Strategy:        []string{"plan_then_approve", "autonomous", "diy_first"}[f.Strategy],
		AllowExternal:   f.AllowExternal,
		DIYFirst:        f.DIYFirst,
		RequireApproval: f.RequireApproval,
		MaxParallelJobs: parallel,
		AdditionalNotes: notes,
	}, nil
}

func (f TaskForm) option(styles Styles, index int, label string, value bool) string {
	prefix := "  "
	style := styles.Muted
	if f.Focus == index {
		prefix = "▸ "
		style = styles.Cyan
	}
	box := "[ ]"
	if value {
		box = "[x]"
	}
	return style.Render(prefix+label) + " " + styles.Green.Render(box)
}

func optionalPtr(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}
