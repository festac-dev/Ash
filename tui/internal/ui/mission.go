package ui

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"ash-tui/internal/api"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type timelineMsg struct {
	view   *api.Timeline
	err    error
	taskID string
}
type proofMsg struct {
	paths *api.ProofPaths
	err   error
}
type replayTickMsg struct{ generation uint64 }
type pulseMsg time.Time

type graphNode struct {
	subtask api.Subtask
	depth   int
	index   int
}

// The backend validates acyclicity; still guard recursion for malformed snapshots.
func graphNodes(task *api.Task) []graphNode {
	if task == nil || task.Plan == nil {
		return nil
	}
	depths := map[string]int{}
	visiting := map[string]bool{}
	var depth func(string) int
	depth = func(id string) int {
		if n, ok := depths[id]; ok {
			return n
		}
		if visiting[id] {
			return 0
		}
		visiting[id] = true
		n := 0
		if node := findSubtask(task.Plan, id); node != nil {
			for _, parent := range node.Dependencies {
				n = max(n, depth(parent)+1)
			}
		}
		visiting[id] = false
		depths[id] = n
		return n
	}
	nodes := make([]graphNode, 0, len(task.Plan.Subtasks))
	for i, sub := range task.Plan.Subtasks {
		nodes = append(nodes, graphNode{sub, depth(sub.ID), i})
	}
	sort.SliceStable(nodes, func(i, j int) bool { return nodes[i].depth < nodes[j].depth })
	return nodes
}

func (m *Model) taskGraph(width, height, x, y int) string {
	task := m.activeTask()
	nodes := graphNodes(task)
	if len(nodes) == 0 {
		return m.panel("TASK GRAPH", "Your plan appears here.", width)
	}
	m.graphCursor = clamp(m.graphCursor, 0, len(nodes)-1)
	rows := max(1, (height-4)/2)
	start := max(0, m.graphCursor-rows+1)
	lines := []string{m.styles.Muted.Render("Steps")}
	if m.matrix {
		return m.dependencyMatrix(nodes, width, height, x, y)
	}
	for i := start; i < min(len(nodes), start+rows); i++ {
		node := nodes[i]
		phase := "pending"
		state := findState(task, node.subtask.ID)
		if state != nil {
			phase = state.Phase
		}
		indent := strings.Repeat("│  ", min(node.depth, 4))
		mark := "◇"
		if phase == "completed" {
			mark = "◆"
		} else if phase == "failed" || phase == "blocked" {
			mark = "×"
		} else if strings.HasPrefix(phase, "awaiting") {
			mark = "◷"
		} else if phase != "pending" && phase != "ready" {
			mark = "◉"
		}
		label := fmt.Sprintf("%s├─%s %s %s", indent, mark, node.subtask.ID, truncate(node.subtask.Title, max(8, width-lipgloss.Width(indent)-32)))
		if i == m.graphCursor {
			label = m.styles.Cyan.Bold(true).Render(label)
		} else {
			label = m.styles.White.Render(label)
		}
		lines = append(lines, label+"  "+m.styles.Status(shortPhase(phase)))
		deps := "root"
		if len(node.subtask.Dependencies) > 0 {
			deps = "← " + strings.Join(node.subtask.Dependencies, ", ")
		}
		lines = append(lines, m.styles.Muted.Render(truncate(indent+"│    "+deps+" · "+node.subtask.Execution+" · max "+node.subtask.PlannedMax+" "+task.Currency, width-4)))
		m.addHit(y+2+len(lines)-2, x+1, x+width-2, fmt.Sprintf("node:%d", i))
		m.addHit(y+2+len(lines)-1, x+1, x+width-2, fmt.Sprintf("node:%d", i))
	}
	return m.panel(fmt.Sprintf("TASK GRAPH  %d/%d", m.graphCursor+1, len(nodes)), strings.Join(lines, "\n"), width)
}

func (m *Model) dependencyMatrix(nodes []graphNode, width, height, x, y int) string {
	cols := min(len(nodes), max(1, (width-17)/5))
	colStart := max(0, min(m.graphCursor-cols/2, len(nodes)-cols))
	header := "           "
	for _, node := range nodes[colStart : colStart+cols] {
		header += fmt.Sprintf("%5s", truncate(node.subtask.ID, 5))
	}
	lines := []string{m.styles.Muted.Render("Row depends on column · ◆ edge"), m.styles.Cyan.Render(header)}
	rows := max(1, height-5)
	start := max(0, m.graphCursor-rows+1)
	for i := start; i < min(len(nodes), start+rows); i++ {
		node := nodes[i]
		row := fmt.Sprintf("%-10s ", node.subtask.ID)
		for _, col := range nodes[colStart : colStart+cols] {
			cell := "    ·"
			if col.subtask.ID == node.subtask.ID {
				cell = "    ○"
			}
			for _, dep := range node.subtask.Dependencies {
				if dep == col.subtask.ID {
					cell = "    ◆"
				}
			}
			row += cell
		}
		if i == m.graphCursor {
			row = m.styles.Cyan.Bold(true).Render(row)
		} else {
			row = m.styles.Green.Render(row)
		}
		m.addHit(y+2+len(lines), x+1, x+width-2, fmt.Sprintf("node:%d", i))
		lines = append(lines, row)
	}
	return m.panel("DEPENDENCY MATRIX", strings.Join(lines, "\n"), width)
}

func shortPhase(phase string) string {
	switch phase {
	case "awaiting_hire_approval", "awaiting_acceptance_approval", "awaiting_plan_approval":
		return "approval"
	case "awaiting_market_approval", "awaiting_market_award", "awaiting_market_acceptance":
		return "market gate"
	case "awaiting_human_review":
		return "review"
	case "running_diy":
		return "working"
	}
	return phase
}

func (m *Model) selectedSubtask() *api.Subtask {
	nodes := graphNodes(m.activeTask())
	if len(nodes) == 0 {
		return nil
	}
	return &nodes[clamp(m.graphCursor, 0, len(nodes)-1)].subtask
}

func (m *Model) inspectNode() tea.Cmd {
	sub := m.selectedSubtask()
	if sub == nil {
		return nil
	}
	task := m.activeTask()
	state := findState(task, sub.ID)
	lines := []string{sub.Description, "", "Dependencies: " + strings.Join(sub.Dependencies, ", "), "Deliverable: " + sub.Deliverable, "Maximum: " + sub.PlannedMax + " " + task.Currency}
	if state != nil {
		lines = append(lines, "Phase: "+state.Phase)
		if len(state.Attempts) > 0 {
			at := state.Attempts[len(state.Attempts)-1]
			if at.Vendor != nil {
				lines = append(lines, "Agent: "+at.Vendor.Name)
			}
			lines = append(lines, "Job: "+ptr(at.JobID), "Payment: "+ptr(at.PaymentStatus))
			if at.ApprovalURL != nil {
				lines = append(lines, "Market page: "+*at.ApprovalURL)
			}
			if at.Delivery != nil {
				lines = append(lines, "Delivery: "+ptr(at.Delivery.TextPath), "SHA-256: "+at.Delivery.SHA256)
			}
			if at.Verification != nil {
				lines = append(lines, "Verification: "+at.Verification.Status, "  "+at.Verification.Details)
			}
		}
		if state.LastError != nil {
			lines = append(lines, "Error: "+*state.LastError)
		}
	}
	lines = append(lines, "", "Acceptance criteria:")
	for _, criterion := range sub.AcceptanceCriteria {
		lines = append(lines, "• "+criterion.Description)
	}
	m.modal = &Modal{Kind: "info", Title: sub.ID + " / " + sub.Title, Body: strings.Join(lines, "\n")}
	m.modalScroll = 0
	return nil
}

func (m *Model) viewMission(width, height int) string {
	task := m.activeTask()
	actions := []action{{"", "Run", "execute"}, {"", "Approvals", "approvals"}, {"", "Matrix", "matrix"}, {"", "Details", "inspect"}}
	if m.matrix {
		actions[2].label = "Graph"
	}
	if task != nil && task.Plan == nil {
		actions[0] = action{"", "Plan", "plan"}
	} else if task != nil && task.Status == "executing" {
		actions[0] = action{"", "Pause", "pause"}
	} else if task != nil && task.Status == "paused" {
		actions[0] = action{"", "Resume", "resume"}
	}
	lines := []string{m.actionLine(4, actions)}
	if task == nil {
		lines = append(lines, m.panel("Execution", "No task yet. Choose New task to begin.", width))
		lines = append(lines, m.tasksPanel(width, 4+lineCount(strings.Join(lines, "\n"))))
		return strings.Join(lines, "\n")
	}
	completed, active, gates := 0, 0, 0
	for _, s := range task.Subtasks {
		switch s.Phase {
		case "completed":
			completed++
		case "pending", "ready", "failed", "cancelled", "blocked":
		default:
			active++
		}
		if strings.HasPrefix(s.Phase, "awaiting") {
			gates++
		}
	}
	title := fmt.Sprintf("%s  %s  ·  %d/%d complete  ·  %d active  ·  %d gates", truncate(task.Description, max(12, width-65)), m.styles.Status(task.Status), completed, len(task.Subtasks), active, gates)
	lines = append(lines, title)
	graphHeight := max(7, height-7)
	if width >= 100 {
		left := width * 3 / 5
		graph := m.taskGraph(left, graphHeight, 0, 6)
		spare := graphHeight - lineCount(graph) - 1
		if spare >= 6 {
			graph += "\n" + m.panel("DETAILS", fitLines(m.nodePreview(left-4), spare-3, left-4), left)
		}
		status := m.panel("BUDGET", m.budgetText(task, width-left-6), width-left-1)
		if graphHeight >= 14 {
			status += "\n" + m.panel("EVIDENCE", m.securityText(task, width-left-6), width-left-1)
		}
		lines = append(lines, fitLines(lipgloss.JoinHorizontal(lipgloss.Top, graph, " ", status), graphHeight, width))
	} else {
		if m.state.Ledger != nil {
			l := m.state.Ledger
			lines = append(lines, m.styles.Amber.Render("Escrow "+l.Committed)+" · "+m.styles.Green.Render("Paid "+l.Paid)+" · Free "+l.Available+" "+l.Currency)
			graphHeight--
		}
		lines = append(lines, m.taskGraph(width, graphHeight, 0, 4+len(lines)))
	}
	remaining := height - lineCount(strings.Join(lines, "\n"))
	if remaining >= 3 {
		m.logViewport.Width = max(10, width-4)
		m.logViewport.Height = max(1, remaining-3)
		lines = append(lines, m.panel("LIVE EVENTS  "+m.activitySparkline(), m.logViewport.View(), width))
	}
	return strings.Join(lines, "\n")
}

func lineCount(text string) int { return len(strings.Split(text, "\n")) }

func (m *Model) activitySparkline() string {
	counts := make([]float64, 20)
	now := time.Now()
	if m.state != nil {
		for _, event := range m.state.Events {
			at, err := time.Parse(time.RFC3339Nano, event.At)
			if err == nil {
				i := 19 - int(now.Sub(at).Seconds()/3)
				if i >= 0 && i < 20 {
					counts[i]++
				}
			}
		}
	}
	return m.styles.Green.Render(sparkline(counts)) + m.styles.Muted.Render(" 60s")
}

func sparkline(values []float64) string {
	glyphs := []rune("▁▂▃▄▅▆▇█")
	peak := 0.0
	for _, v := range values {
		peak = math.Max(peak, v)
	}
	var out strings.Builder
	for _, v := range values {
		index := 0
		if peak > 0 {
			index = int(v / peak * 7)
		}
		out.WriteRune(glyphs[clamp(index, 0, 7)])
	}
	return out.String()
}

func (m *Model) loadTimeline() tea.Cmd {
	id := m.activeTaskID()
	if id == "" || m.Client == nil || m.timelineLoading {
		return nil
	}
	m.timelineLoading = true
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 20*time.Second)
		defer cancel()
		v, e := m.Client.Timeline(ctx, id)
		return timelineMsg{v, e, id}
	}
}

func (m *Model) exportProof() tea.Cmd {
	id := m.activeTaskID()
	if id == "" || m.Client == nil {
		m.setStatus("Create a task before exporting proof.", "warning")
		return nil
	}
	m.setStatus("Exporting local evidence…", "info")
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 30*time.Second)
		defer cancel()
		v, e := m.Client.ExportProof(ctx, id)
		return proofMsg{v, e}
	}
}

func (m *Model) viewMoney(width, height int) string {
	lines := []string{m.actionLine(4, []action{{"", "budget", "budget"}, {"O", "export proof", "proof"}, {"F5", "refresh", "timeline"}})}
	if m.activeTask() == nil {
		return lines[0] + "\nNo active task."
	}
	lines = append(lines, m.styles.Cyan.Render("AUTHORIZED → ESCROW → RELEASE / REFUND"))
	if m.state.Ledger != nil {
		l := m.state.Ledger
		lines = append(lines, "Authorized "+l.Authorized+" · Escrow "+l.Committed+" · Paid "+l.Paid+" · Available "+l.Available+" "+l.Currency)
	}
	if m.timeline == nil {
		return strings.Join(lines, "\n") + "\nLoading ledger history…"
	}
	paid, escrow := 0.0, 0.0
	payments, commitments := []float64{}, []float64{}
	for _, entry := range m.timeline.Entries {
		amount := parseMoney(entry.Amount)
		switch entry.Kind {
		case "COMMIT":
			escrow += amount
		case "RELEASE":
			escrow -= amount
			paid += amount
		case "REFUND":
			escrow -= amount
		}
		payments = append(payments, paid)
		commitments = append(commitments, escrow)
	}
	n := max(1, min(width-18, 60))
	if len(payments) > n {
		payments = payments[len(payments)-n:]
		commitments = commitments[len(commitments)-n:]
	}
	lines = append(lines, m.styles.Green.Render("Paid   "+sparkline(payments))+"  "+m.styles.Amber.Render("Escrow "+sparkline(commitments)), m.styles.Muted.Render("Trend scaled to each series · each point is a ledger entry"))
	room := max(1, height-len(lines)-1)
	m.moneyCursor = clamp(m.moneyCursor, 0, max(0, len(m.timeline.Entries)-1))
	start := max(0, m.moneyCursor-room+1)
	for i := start; i < min(len(m.timeline.Entries), start+room); i++ {
		e := m.timeline.Entries[i]
		marker := "  "
		if i == m.moneyCursor {
			marker = "▸ "
		}
		text := fmt.Sprintf("%s%s %-11s %12s %s · %s", marker, shortTime(e.At), e.Kind, e.Amount, e.Currency, e.Reference)
		tone := m.styles.White
		if e.Kind == "RELEASE" {
			tone = m.styles.Green
		} else if e.Kind == "COMMIT" {
			tone = m.styles.Amber
		} else if e.Kind == "REFUND" {
			tone = m.styles.Cyan
		}
		m.addHit(4+len(lines), 0, width-1, fmt.Sprintf("money:%d", i))
		lines = append(lines, tone.Render(truncate(text, width)))
	}
	return strings.Join(lines, "\n")
}

func (m *Model) viewReplay(width, height int) string {
	label := "play"
	if m.replayPlaying {
		label = "pause"
	}
	lines := []string{m.actionLine(4, []action{{"Space", label, "replay-play"}, {"←", "previous", "replay-prev"}, {"→", "next", "replay-next"}, {"Home", "rewind", "replay-home"}}), m.styles.Violet.Render("EVENT REPLAY / READ ONLY — no jobs or payments are repeated")}
	if m.timeline == nil || len(m.timeline.Events) == 0 {
		return strings.Join(lines, "\n") + "\nNo recorded events for this task."
	}
	m.replayCursor = clamp(m.replayCursor, 0, len(m.timeline.Events)-1)
	event := m.timeline.Events[m.replayCursor]
	detail := safeChatText(fmt.Sprintf("%s · %d/%d · %s\n%s\n\n%s", event.At, m.replayCursor+1, len(m.timeline.Events), ptr(event.SubtaskID), event.Code, event.Message))
	lines = append(lines, m.panel("RECORDED EVENT", detail, width))
	if m.timeline.EventsTruncated {
		lines = append(lines, m.styles.Amber.Render("Showing the newest 2,000 persisted events."))
	}
	remaining := max(0, height-lineCount(strings.Join(lines, "\n")))
	start := max(0, m.replayCursor-remaining+1)
	for i := start; i <= m.replayCursor; i++ {
		e := m.timeline.Events[i]
		m.addHit(4+lineCount(strings.Join(lines, "\n")), 0, width-1, fmt.Sprintf("event:%d", i))
		lines = append(lines, m.styles.Muted.Render(truncate(shortTime(e.At)+"  "+e.Code+"  "+e.Message, width)))
	}
	return strings.Join(lines, "\n")
}

func (m *Model) replayTick() tea.Cmd {
	generation := m.replayGeneration
	return tea.Tick(900*time.Millisecond, func(time.Time) tea.Msg { return replayTickMsg{generation: generation} })
}

func (m *Model) stopReplay() {
	m.replayPlaying = false
	m.replayGeneration++
}

func (m *Model) updateTimeline(next *api.Timeline) {
	if m.timeline != nil && next != nil && len(m.timeline.Events) > 0 {
		selected := m.timeline.Events[clamp(m.replayCursor, 0, len(m.timeline.Events)-1)]
		found := false
		for i, event := range next.Events {
			if event.At == selected.At && event.Code == selected.Code && event.TaskID == selected.TaskID &&
				ptr(event.SubtaskID) == ptr(selected.SubtaskID) && event.Message == selected.Message && event.Level == selected.Level {
				m.replayCursor = i
				found = true
				break
			}
		}
		if !found {
			m.replayCursor = 0
			m.stopReplay()
			if m.screen == screenReplay {
				m.setStatus("Selected event is no longer in the loaded history. Playback paused at the oldest available event.", "warning")
			}
		}
	}
	m.timeline = next
}
func (m *Model) pulse() tea.Cmd {
	if !m.animation {
		return nil
	}
	return tea.Tick(400*time.Millisecond, func(t time.Time) tea.Msg { return pulseMsg(t) })
}

func (m *Model) toggleCompare() tea.Cmd {
	if len(m.agents) == 0 {
		return nil
	}
	agent := m.agents[clamp(m.agentCursor, 0, len(m.agents)-1)]
	for i, pinned := range m.compared {
		if pinned.ID == agent.ID {
			m.compared = append(m.compared[:i], m.compared[i+1:]...)
			return nil
		}
	}
	if len(m.compared) >= 3 {
		m.setStatus("Three agents pinned. Unpin one with C.", "warning")
		return nil
	}
	m.compared = append(m.compared, agent)
	return nil
}

func (m *Model) compareAgents() tea.Cmd {
	if len(m.compared) < 2 {
		m.setStatus("Pin two or three agents with C, then press V.", "warning")
		return nil
	}
	lines := []string{"Marketplace observations; no invented quality scores.", ""}
	for _, a := range m.compared {
		price := ptr(a.Price) + " " + a.Currency
		rate := "unrated"
		if a.SuccessRate != nil {
			rate = fmt.Sprintf("%.1f%%", *a.SuccessRate)
		}
		response := "unknown"
		if a.ResponseSeconds != nil {
			response = fmt.Sprintf("%.0fs", *a.ResponseSeconds)
		}
		lines = append(lines, a.Name, "  Price: "+price+" · delivered: "+fmt.Sprint(a.DeliveredJobs), "  Success: "+rate+" · median response: "+response, "  Rails: "+strings.Join(a.PayableWith, ", "), "")
	}
	m.modal = &Modal{Kind: "info", Title: "AGENT COMPARISON", Body: strings.Join(lines, "\n")}
	m.modalScroll = 0
	return nil
}

var commands = []action{{"?", "Help", "help"}, {"I", "Chat with Ash", "chat"}, {"1", "Dashboard", "tab:0"}, {"2", "New task", "new"}, {"3", "Agent market", "market"}, {"4", "Live execution graph", "tab:3"}, {"5", "Receipts", "transactions"}, {"6", "Approval queue", "approvals"}, {"7", "Settings", "settings"}, {"M", "Money timeline", "money"}, {"R", "Execution replay", "replay"}, {"O", "Export proof report", "proof"}, {"E", "Execute active task", "execute"}, {"Space", "Pause active task", "pause"}, {"Space", "Resume active task", "resume"}, {"", "Request budget change", "budget"}, {"B", "Frontend: start / code / close", "frontend"}, {"X", "Cancel active task", "cancel"}}

func (m *Model) paletteMatches() []action {
	query := ""
	if m.modal != nil {
		query = strings.ToLower(m.modal.Input.Value())
	}
	matches := []action{}
	all := append([]action{}, commands...)
	custom := m.modal != nil && len(m.modal.Actions) > 0
	if custom {
		all = m.modal.Actions
	}
	if !custom && m.state != nil {
		for _, task := range m.state.Tasks {
			all = append(all, action{"", "Switch task: " + task.Description, "activate:" + task.ID})
		}
	}
	for _, cmd := range all {
		if !custom && query == "" && !strings.HasPrefix(cmd.action, "activate:") {
			switch cmd.action {
			case "market", "transactions", "approvals", "settings", "proof", "help":
			case "chat", "new", "tab:3", "money", "replay", "frontend":
				visible := false
				for _, area := range m.hits {
					if area.y == 3 && area.action == cmd.action {
						visible = true
						break
					}
				}
				if visible {
					continue
				}
			default:
				continue
			}
		}
		if strings.Contains(strings.ToLower(cmd.label), query) {
			matches = append(matches, cmd)
		}
	}
	return matches
}
func (m *Model) openPalette() tea.Cmd {
	input := m.agentQuery
	input.Reset()
	input.Placeholder = "Search…"
	input.Focus()
	m.modal = &Modal{Kind: "palette", Title: "More", Input: input}
	m.paletteCursor = 0
	return nil
}

func (m *Model) nodePreview(width int) string {
	sub := m.selectedSubtask()
	if sub == nil {
		return "Select a graph node."
	}
	task := m.activeTask()
	state := findState(task, sub.ID)
	lines := []string{m.styles.Cyan.Render(safeChatText(sub.Title)), truncate(sub.Description, width), "Dependencies: " + strings.Join(sub.Dependencies, ", "), "Maximum: " + sub.PlannedMax + " " + task.Currency}
	if state != nil && len(state.Attempts) > 0 {
		at := state.Attempts[len(state.Attempts)-1]
		if at.Vendor != nil {
			lines = append(lines, "Agent: "+safeChatText(at.Vendor.Name))
		}
		lines = append(lines, "Payment: "+ptr(at.PaymentStatus))
		if at.Verification != nil {
			lines = append(lines, "Check: "+m.styles.Status(at.Verification.Status), truncate(at.Verification.Details, width))
		}
		if at.Delivery != nil {
			lines = append(lines, "Artifact SHA-256: "+shortHash(&at.Delivery.SHA256))
		}
	}
	lines = append(lines, "", "Enter / click for evidence, criteria and market link.")
	return strings.Join(lines, "\n")
}
