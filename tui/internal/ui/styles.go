package ui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

var (
	bg      = lipgloss.Color("#0a0b0d")
	panelBg = lipgloss.Color("#121416")
	green   = lipgloss.Color("#c7c9cd")
	forest  = lipgloss.Color("#34373c")
	cyan    = lipgloss.Color("#d6d9df")
	blue    = lipgloss.Color("#aeb8c9")
	violet  = lipgloss.Color("#a7a9ad")
	amber   = lipgloss.Color("#d7b28c")
	red     = lipgloss.Color("#e0a39c")
	white   = lipgloss.Color("#f0f0ef")
	muted   = lipgloss.Color("#95999f")
	black   = lipgloss.Color("#15171a")
)

type Styles struct {
	width        int
	App          lipgloss.Style
	Title        lipgloss.Style
	Sub          lipgloss.Style
	Panel        lipgloss.Style
	Label        lipgloss.Style
	Value        lipgloss.Style
	Green        lipgloss.Style
	Cyan         lipgloss.Style
	Blue         lipgloss.Style
	Violet       lipgloss.Style
	Amber        lipgloss.Style
	Red          lipgloss.Style
	Muted        lipgloss.Style
	White        lipgloss.Style
	Tab          lipgloss.Style
	TabActive    lipgloss.Style
	Button       lipgloss.Style
	ButtonActive lipgloss.Style
	Danger       lipgloss.Style
	Modal        lipgloss.Style
	Badge        lipgloss.Style
}

func NewStyles(width int) Styles {
	if width < 40 {
		width = 40
	}
	return Styles{
		width: width,
		App:   lipgloss.NewStyle().Background(bg).Foreground(white),
		Title: lipgloss.NewStyle().Foreground(green).Bold(true),
		Sub:   lipgloss.NewStyle().Foreground(muted),
		Panel: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(forest).
			Background(panelBg).
			Padding(0, 1),
		Label:        lipgloss.NewStyle().Foreground(muted),
		Value:        lipgloss.NewStyle().Foreground(white).Bold(true),
		Green:        lipgloss.NewStyle().Foreground(green),
		Cyan:         lipgloss.NewStyle().Foreground(cyan),
		Blue:         lipgloss.NewStyle().Foreground(blue),
		Violet:       lipgloss.NewStyle().Foreground(violet),
		Amber:        lipgloss.NewStyle().Foreground(amber),
		Red:          lipgloss.NewStyle().Foreground(red),
		Muted:        lipgloss.NewStyle().Foreground(muted),
		White:        lipgloss.NewStyle().Foreground(white),
		Tab:          lipgloss.NewStyle().Foreground(white).Background(panelBg).Padding(0, 1),
		TabActive:    lipgloss.NewStyle().Foreground(black).Background(green).Bold(true).Padding(0, 1),
		Button:       lipgloss.NewStyle().Foreground(white).Background(lipgloss.Color("#25282d")).Padding(0, 1),
		ButtonActive: lipgloss.NewStyle().Foreground(black).Background(cyan).Bold(true).Padding(0, 1),
		Danger:       lipgloss.NewStyle().Foreground(red).Bold(true),
		Modal: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(cyan).
			Background(lipgloss.Color("#121416")).
			Padding(1, 2),
		Badge: lipgloss.NewStyle().Foreground(black).Background(green).Bold(true).Padding(0, 1),
	}
}

func (s Styles) Header(mode, connection string, connected bool) string {
	left := "  " + s.Title.Render("ASH.")
	environment := "Live mode"
	if mode == "SIMULATION" {
		environment = "Simulation"
	} else if mode != "LIVE" {
		environment = "Connecting"
	}
	link := "Connected"
	if !connected {
		link = "Reconnecting"
	}
	right := s.Muted.Render(environment+"  ·  "+link) + "  "
	if s.width < 45 {
		right = s.Muted.Render(environment) + "  "
	}
	gap := max(1, s.width-lipgloss.Width(left)-lipgloss.Width(right))
	divider := "  " + lipgloss.NewStyle().Foreground(forest).Render(strings.Repeat("─", max(1, s.width-4)))
	return "\n" + left + strings.Repeat(" ", gap) + right + "\n" + divider
}

func (s Styles) Tabs(active int, labels []string) string {
	parts := make([]string, 0, len(labels))
	for index, label := range labels {
		text := fmt.Sprintf("%d %s", index+1, label)
		if index == active {
			parts = append(parts, s.TabActive.Render(text))
		} else {
			parts = append(parts, s.Tab.Render(text))
		}
	}
	line := strings.Join(parts, " ")
	if lipgloss.Width(line) > s.width-2 {
		line = lipgloss.NewStyle().MaxWidth(s.width - 2).Render(line)
	}
	return line
}

func (s Styles) PanelBox(title, body string, width int) string {
	if width < 20 {
		width = 20
	}
	panel := s.Panel.Width(max(10, width-2))
	header := s.Cyan.Bold(true).Render(title)
	return panel.Render(header + "\n" + body)
}

func (s Styles) Bar(value, total float64, width int, tone lipgloss.Color) string {
	if width < 8 {
		width = 8
	}
	ratio := 0.0
	if total > 0 {
		ratio = value / total
	}
	if ratio < 0 {
		ratio = 0
	}
	if ratio > 1 {
		ratio = 1
	}
	filled := int(ratio * float64(width))
	return lipgloss.NewStyle().Foreground(tone).Render(strings.Repeat("━", filled)) +
		lipgloss.NewStyle().Foreground(forest).Render(strings.Repeat("─", width-filled)) +
		fmt.Sprintf(" %3.0f%%", ratio*100)
}

func (s Styles) KeyHint(keys string) string {
	return s.Muted.Render(keys)
}

func (s Styles) Pill(text string, tone lipgloss.Color) string {
	return lipgloss.NewStyle().Foreground(black).Background(tone).Bold(true).Padding(0, 1).Render(text)
}

func (s Styles) Status(text string) string {
	switch text {
	case "completed", "planned", "passed", "approved":
		return s.Green.Bold(true).Render(strings.ToUpper(text))
	case "executing", "running", "working", "verifying", "waiting_job":
		return s.Cyan.Bold(true).Render(strings.ToUpper(text))
	case "approval", "review", "market gate", "paused", "awaiting_plan_approval", "awaiting_acceptance_approval", "awaiting_hire_approval":
		return s.Amber.Bold(true).Render(strings.ToUpper(text))
	case "failed", "blocked", "cancelled", "rejected", "error":
		return s.Red.Bold(true).Render(strings.ToUpper(text))
	default:
		return s.White.Render(strings.ToUpper(text))
	}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func truncate(text string, width int) string {
	if width <= 0 {
		return ""
	}
	text = strings.ReplaceAll(safeChatText(text), "\n", " ")
	return ansi.Truncate(text, width, "…")
}
