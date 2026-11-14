package ui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"ash-tui/internal/api"
)

type action struct {
	key    string
	label  string
	action string
}

func (m *Model) View() string {
	if m.width < 28 || m.height < 12 {
		return fitLines("ASH\nEnlarge terminal to 28 × 12 or more.\nQ quit", max(1, m.height), max(1, m.width))
	}
	if !m.ready || (m.state == nil && m.stateErr == "") {
		return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center,
			m.styles.Title.Render("ASH")+"\n"+m.styles.Muted.Render("connecting to the local backend ")+m.spinner.View())
	}
	m.hits = nil
	link := "API / SSE"
	if m.animation && m.connected && m.state != nil && m.state.EngineRunning {
		link = []string{"░▒▓ LIVE", "▒▓░ LIVE", "▓░▒ LIVE"}[m.frame%3]
	}
	header := m.styles.Header(m.mode(), link, m.connected)
	headerLines := strings.Split(header, "\n")
	tabs := m.navigation()
	bodyHeight := max(1, m.height-6)
	bodyWidth := max(1, m.width-2)
	var body string
	if m.modal != nil {
		body = m.viewModal(bodyWidth, bodyHeight)
	} else if m.screen == screenTask {
		body = m.viewTaskForm(bodyWidth, bodyHeight)
	} else {
		switch m.screen {
		case screenDashboard:
			body = m.viewChatDashboard(bodyWidth, bodyHeight)
		case screenMarket:
			body = m.viewMarket(bodyWidth, bodyHeight)
		case screenExecution:
			body = m.viewMission(bodyWidth, bodyHeight)
		case screenTransactions:
			body = m.viewTransactions(bodyWidth, bodyHeight)
		case screenSecurity:
			body = m.viewSecurity(bodyWidth, bodyHeight)
		case screenSettings:
			body = m.viewSettings(bodyWidth, bodyHeight)
		case screenMoney:
			body = m.viewMoney(bodyWidth, bodyHeight)
		case screenReplay:
			body = m.viewReplay(bodyWidth, bodyHeight)
		}
	}
	body = fitLines(body, bodyHeight, bodyWidth)
	footer := m.viewFooter()
	return m.styles.App.Render(fitLines(strings.Join(append(append(headerLines, tabs), strings.Split(body, "\n")...), "\n")+"\n"+footer, m.height, m.width))
}

func (m *Model) mode() string {
	if m.state == nil {
		return "UNKNOWN"
	}
	return m.state.Mode
}

func (m *Model) viewFooter() string {
	status := m.statusMsg
	level := m.statusLevel
	if status == "" {
		if m.frontendBusy {
			status = "Preparing browser frontend… First launch may take a few minutes."
			level = "info"
		} else if m.stateErr != "" {
			status = "Backend: " + m.stateErr
			level = "error"
		} else if m.sseErr != "" {
			status = "Live stream: " + m.sseErr
			level = "warning"
		} else if !m.connected {
			status = "Live stream reconnecting…"
			level = "warning"
		} else {
			status = ""
			level = "success"
		}
	}
	style := m.styles.Muted
	switch level {
	case "success":
		style = m.styles.Green
	case "warning":
		style = m.styles.Amber
	case "error":
		style = m.styles.Red
	case "info":
		style = m.styles.Cyan
	}
	statusLine := style.Render(truncate(status, m.width-2))
	hints := m.footerHints()
	line := m.styles.Muted.Render(truncate(hints, m.width-2))
	return statusLine + "\n" + line
}

func (m *Model) footerHints() string {
	if m.modal != nil {
		if m.modal.Kind == "palette" {
			return "  Enter Open · Esc Back"
		}
		return "  Esc Back"
	}
	if m.chatFocus && m.screen == screenDashboard {
		return "  Enter send · Esc leave chat"
	}
	if m.screen == screenTask {
		return "  Tab next · Enter select"
	}
	if m.width < 40 {
		return "  : Menu · ? Help · Q Quit"
	}
	return "  : Commands · ? Help · Q Quit"
}

func (m *Model) tasksPanel(width, startY int) string {
	if m.state == nil || len(m.state.Tasks) == 0 {
		return m.panel("RECENT TASKS", "No tasks yet.", width)
	}
	rows := make([]string, 0, 6)
	for index, task := range m.state.Tasks {
		if index >= 6 {
			break
		}
		marker := "  "
		style := m.styles.White
		if m.state.ActiveTaskID != nil && *m.state.ActiveTaskID == task.ID {
			marker = "▸ "
			style = m.styles.Cyan
		}
		line := fmt.Sprintf("%s%-28s %-18s %10s %s", marker, truncate(task.ID, 28), task.Status, task.Budget+" "+task.Currency, truncate(task.Description, max(16, width-86)))
		rows = append(rows, style.Render(line))
		m.addHit(startY+2+index, 0, width-1, "activate:"+task.ID)
	}
	return m.panel("RECENT TASKS", strings.Join(rows, "\n"), width)
}

// Keep the common task fields visible; optional controls expand in place.
func (m *Model) viewTaskForm(width, height int) string {
	f := &m.form
	if !f.Advanced {
		height = min(height, 20)
	}
	w := min(76, max(20, width-4))
	x := max(0, (width-w)/2)
	for _, input := range []*textinput.Model{&f.Description, &f.Budget, &f.Deadline, &f.Quality, &f.Preferred, &f.Parallel} {
		input.Width = max(5, w-6)
		input.Prompt = "› "
		input.TextStyle = m.styles.White
		input.PlaceholderStyle = m.styles.Muted
		input.PromptStyle = m.styles.Muted
	}
	f.Notes.SetWidth(max(5, w-4))
	f.Notes.SetHeight(2)
	type row struct {
		text  string
		field int
	}
	rows := []row{}
	field := func(id int, label, value string) {
		tone := m.styles.Muted
		if f.Focus == id {
			tone = m.styles.White.Bold(true)
		}
		value = lipgloss.NewStyle().Background(panelBg).Width(w-2).Padding(0, 1).Render(value)
		rows = append(rows, row{tone.Render(label), id}, row{value, id}, row{"", -1})
	}
	field(0, "Task", f.Description.View())
	field(1, "Budget", f.Budget.View())
	field(6, "Currency", m.styles.Button.Render(currencyLabels[f.Currency]+"  ‹ ›"))
	if f.Advanced {
		field(2, "Deadline · optional", f.Deadline.View())
		field(3, "Quality", f.Quality.View())
		field(4, "Agents", f.Preferred.View())
		field(5, "Private notes", f.Notes.View())
		field(7, "Execution strategy", strategyLabels[f.Strategy]+"  ‹ ›")
		for _, v := range []struct {
			id    int
			label string
			value bool
		}{{8, "External hiring", f.AllowExternal}, {9, "Try DIY first", f.DIYFirst}, {10, "Approve every hire", f.RequireApproval}} {
			rows = append(rows, row{f.option(m.styles, v.id, v.label, v.value), v.id})
		}
		field(11, "Parallel jobs", f.Parallel.View())
	}
	advanced := "Options  +"
	if f.Advanced {
		advanced = "Options  −"
	}
	button := m.styles.Button
	if f.Focus == 12 {
		button = m.styles.ButtonActive
	}
	rows = append(rows, row{button.Render(advanced), 12})
	// Flatten multiline fields before scrolling and mouse hit registration.
	flat := []row{}
	for _, r := range rows {
		for _, line := range strings.Split(r.text, "\n") {
			flat = append(flat, row{line, r.field})
		}
	}
	header := []string{"", m.styles.Title.Render("New task"), m.styles.Muted.Render("Plan first. You approve."), ""}
	if height < 14 {
		header = []string{m.styles.Title.Render("New task")}
	}
	room := max(1, height-len(header)-4)
	selected := 0
	for i, r := range flat {
		if r.field == f.Focus {
			selected = i
			break
		}
	}
	start := clamp(f.Scroll, 0, max(0, len(flat)-room))
	if f.Focus < 13 && f.Focus != f.viewFocus {
		if selected < start {
			start = selected
		}
		if selected >= start+room-1 {
			start = selected - room + 2
		}
	}
	f.Scroll = max(0, start)
	f.viewFocus = f.Focus
	content := []string{}
	for i := start; i < min(len(flat), start+room); i++ {
		r := flat[i]
		content = append(content, r.text)
		if r.field >= 0 {
			act := fmt.Sprintf("form-focus:%d", r.field)
			if r.field == 12 {
				act = "form-advanced"
			}
			m.addHit(4+len(header)+i-start, x, x+w-1, act)
		}
	}
	body := strings.Join(header, "\n") + "\n" + fitLines(strings.Join(content, "\n"), room, w)
	message := m.styles.Muted.Render("Your approval comes next.")
	if f.Err != "" {
		message = m.styles.Red.Render(truncate(f.Err, w))
	}
	body += "\n" + message + "\n\n"
	create, cancel := m.styles.Button, m.styles.Button
	if f.Focus == 13 {
		create = m.styles.ButtonActive
	}
	if f.Focus == 14 {
		cancel = m.styles.ButtonActive
	}
	first := create.Render("Plan task")
	second := cancel.Render("Cancel")
	y := 4 + lineCount(body) - 1
	m.addHit(y, x, x+lipgloss.Width(first)-1, "form-submit")
	m.addHit(y, x+lipgloss.Width(first)+2, x+lipgloss.Width(first)+2+lipgloss.Width(second)-1, "form-cancel")
	body += first + "  " + second
	return lipgloss.NewStyle().PaddingLeft(x).Render(fitLines(body, height, w))
}

func (m *Model) viewMarket(width, height int) string {
	m.addHit(4, 0, width-1, "agent-search")
	lines := []string{}
	if m.agentFocus {
		lines = append(lines, m.styles.Cyan.Render("/ ")+m.agentQuery.View())
	} else {
		query := m.agentQuery.Value()
		if query == "" {
			query = "all agents"
		}
		lines = append(lines, m.styles.Muted.Render("/ Search: ")+m.styles.White.Render(query))
	}
	lines = append(lines, m.actionLine(5, []action{{"F5", "refresh", "market"}, {"C", "pin", "compare-pin"}, {"V", "compare", "compare"}}))
	lines = append(lines, m.styles.Muted.Render(fmt.Sprintf("%d agents · %d pinned", len(m.agents), len(m.compared))))
	if m.agentErr != "" {
		lines = append(lines, m.styles.Red.Render(truncate(m.agentErr, width-4)))
	}
	if len(m.agents) == 0 {
		lines = append(lines, m.styles.Muted.Render("No agents found."))
		return strings.Join(lines, "\n")
	}
	start := max(0, m.agentCursor-max(1, height-len(lines)-2)+1)
	end := min(len(m.agents), start+max(1, height-len(lines)))
	for index := start; index < end; index++ {
		agent := m.agents[index]
		selected := index == m.agentCursor
		marker := "  "
		nameStyle := m.styles.White
		if selected {
			marker = "▸ "
			nameStyle = m.styles.Cyan
		}
		price := "no live price"
		if agent.Price != nil {
			price = *agent.Price + " " + agent.Currency
		}
		success := "unrated"
		if agent.SuccessRate != nil {
			success = fmt.Sprintf("%.0f%%", *agent.SuccessRate)
		}
		rails := strings.Join(agent.PayableWith, "/")
		if rails == "" {
			rails = "—"
		}
		for _, pinned := range m.compared {
			if pinned.ID == agent.ID {
				marker = "◆ "
			}
		}
		line := fmt.Sprintf("%s%-26s %-14s %-13s %-8s %4d jobs", marker, truncate(agent.Name, 26), price, rails, success, agent.DeliveredJobs)
		m.addHit(4+len(lines), 0, width-1, fmt.Sprintf("agent:%d", index))
		lines = append(lines, nameStyle.Render(truncate(line, width-2)))
	}
	return strings.Join(lines, "\n")
}

func (m *Model) viewTransactions(width, height int) string {
	lines := []string{m.actionLine(4, []action{{"F5", "refresh", "transactions"}, {"Enter", "inspect", "tx:" + fmt.Sprint(m.txCursor)}, {"A", "security", "approvals"}})}
	if m.tx == nil {
		lines = append(lines, m.styles.Muted.Render("Loading receipts…"))
		return strings.Join(lines, "\n")
	}
	integrity := "NOT CHECKED"
	tone := m.styles.Amber
	if m.tx.Integrity.OK {
		integrity = "VERIFIED"
		tone = m.styles.Green
	} else if m.tx.Integrity.Exists {
		integrity = "BROKEN"
		tone = m.styles.Red
	}
	lines = append(lines, m.styles.Muted.Render("CHAIN ")+tone.Render(integrity)+
		m.styles.Muted.Render(fmt.Sprintf(" · %d receipts · head %s", m.tx.Integrity.ReceiptCount, shortHash(m.tx.Integrity.LastHash))))
	if m.txErr != "" {
		lines = append(lines, m.styles.Red.Render(truncate(m.txErr, width-4)))
	}
	if len(m.tx.Receipts) == 0 {
		lines = append(lines, m.styles.Muted.Render("No receipts yet."))
		return strings.Join(lines, "\n")
	}
	header := fmt.Sprintf("%-24s %-10s %-24s %-10s %-13s %s", "FILE", "STATUS", "ITEM", "PAYMENT", "AGREED", "HASH")
	lines = append(lines, m.styles.Cyan.Render(truncate(header, width-2)))
	room := max(1, height-len(lines))
	startIndex := max(0, m.txCursor-room+1)
	endIndex := min(len(m.tx.Receipts), startIndex+room)
	for index := startIndex; index < endIndex; index++ {
		view := m.tx.Receipts[index]
		selected := index == m.txCursor
		marker := "  "
		style := m.styles.White
		if selected {
			marker = "▸ "
			style = m.styles.Cyan
		}
		r := view.Receipt
		agreed := "—"
		if r.AgreedPrice != nil {
			agreed = *r.AgreedPrice + " " + r.Currency
		}
		line := fmt.Sprintf("%s%-24s %-10s %-24s %-10s %-13s %s", marker,
			truncate(view.File, 24), truncate(r.Status, 10), truncate(r.Item, 24),
			truncate(r.PaymentStatus, 10), truncate(agreed, 13), shortHash(&r.Hash))
		m.addHit(4+len(lines), 0, width-1, fmt.Sprintf("tx:%d", index))
		lines = append(lines, style.Render(truncate(line, width-2)))
	}
	if startIndex > 0 {
		lines = append(lines, m.styles.Muted.Render(fmt.Sprintf("… showing receipts %d-%d of %d", startIndex+1, endIndex, len(m.tx.Receipts))))
	}
	return strings.Join(lines, "\n")
}

func (m *Model) viewSecurity(width, height int) string {
	lines := []string{m.actionLine(4, []action{{"Enter", "approve", "approval:" + fmt.Sprint(m.approvalCursor)}, {"D", "deny", "deny:" + fmt.Sprint(m.approvalCursor)}, {"F5", "refresh", "approvals"}})}
	if m.security == nil {
		return lines[0] + "\nLoading security state…"
	}
	chain := "NOT VERIFIED"
	if m.security.Integrity.OK {
		chain = "VERIFIED"
	}
	lines = append(lines, m.styles.Cyan.Render(fmt.Sprintf("%s · chain %s · %d receipts · %d approval gates", m.security.Mode, chain, m.security.Integrity.ReceiptCount, len(m.security.Approvals))))
	if len(m.security.Approvals) == 0 {
		lines = append(lines, "No pending approvals.")
		return strings.Join(lines, "\n")
	}
	room := max(1, (height-len(lines))/3)
	start := max(0, m.approvalCursor-room+1)
	for i := start; i < min(len(m.security.Approvals), start+room); i++ {
		a := m.security.Approvals[i]
		marker := "  "
		if i == m.approvalCursor {
			marker = "▸ "
		}
		y := 4 + len(lines)
		m.addHit(y, 0, width-1, fmt.Sprintf("approval:%d", i))
		m.addHit(y+1, 0, width-1, fmt.Sprintf("approval:%d", i))
		lines = append(lines, m.styles.Amber.Render(marker+a.Kind+" · "+ptr(a.Amount)+" "+a.Currency), truncate(a.Summary, width), m.styles.Muted.Render("  expires "+a.ExpiresAt))
	}
	return strings.Join(lines, "\n")
}

func (m *Model) viewSettings(width, height int) string {
	lines := []string{m.actionLine(4, []action{{"Enter", "edit", "settings:" + fmt.Sprint(m.settingsCursor)}, {"", "budget", "budget"}, {"F5", "refresh", "settings"}})}
	if m.settings == nil {
		return lines[0] + "\nLoading settings…"
	}
	c := m.settings.Config
	lines = append(lines, m.styles.Cyan.Render("RUNTIME / "+c.ModelProvider+" / "+ptr(c.ModelName)), truncate("Market: "+c.MarketMode+" · "+c.HiringMode+" · token "+configured(c.MarketTokenConfigured), width), "")
	if m.settings.Task == nil {
		return strings.Join(lines, "\n") + "\nNo active task preferences."
	}
	room := max(1, height-len(lines))
	start := max(0, m.settingsCursor-room+1)
	for i := start; i < min(len(settingKeys), start+room); i++ {
		key := settingKeys[i]
		marker := "  "
		style := m.styles.White
		if i == m.settingsCursor {
			marker = "▸ "
			style = m.styles.Cyan
		}
		m.addHit(4+len(lines), 0, width-1, fmt.Sprintf("settings:%d", i))
		lines = append(lines, style.Render(truncate(fmt.Sprintf("%s%-28s %s", marker, key, currentSettingValue(m.settings, key)), width)))
	}
	return strings.Join(lines, "\n")
}

func (m *Model) viewModal(width, height int) string {
	modal := m.modal
	if modal.Kind == "palette" {
		lines := []string{m.styles.Title.Render(modal.Title), modal.Input.View(), ""}
		matches := m.paletteMatches()
		room := max(1, height-5)
		m.paletteCursor = clamp(m.paletteCursor, 0, max(0, len(matches)-1))
		start := max(0, m.paletteCursor-room+1)
		for i := start; i < min(len(matches), start+room); i++ {
			cmd := matches[i]
			style := m.styles.White
			if i == m.paletteCursor {
				style = m.styles.Cyan.Bold(true)
			}
			m.addHit(4+len(lines), 0, width-1, "command:"+cmd.action)
			lines = append(lines, style.Render(safeChatText(cmd.label)))
		}
		if len(matches) == 0 {
			lines = append(lines, "No matching command.")
		}
		return m.modalControls(strings.Join(lines, "\n"), width, height, false)
	}
	lines := []string{m.styles.Cyan.Bold(true).Render(safeChatText(modal.Title))}
	editable := modal.Input.Focused()
	reserve := 3
	if editable {
		reserve = 7
	}
	// Wrap long URLs, hashes and evidence before scrolling so every line is reachable.
	wrapped := lipgloss.NewStyle().Width(max(1, width-2)).Render(safeChatText(modal.Body))
	content := strings.Split(wrapped, "\n")
	room := max(1, height-reserve)
	m.modalScroll = clamp(m.modalScroll, 0, max(0, len(content)-room))
	lines = append(lines, content[m.modalScroll:min(len(content), m.modalScroll+room)]...)
	if editable {
		if modal.Prompt != "" {
			lines = append(lines, m.styles.Muted.Render(modal.Prompt))
		}
		if modal.Phrase != "" {
			lines = append(lines, m.styles.Amber.Render("Type: "+modal.Phrase))
		}
		lines = append(lines, modal.Input.View())
	}
	if modal.Err != "" {
		lines = append(lines, m.styles.Red.Render(safeChatText(modal.Err)))
	}
	return m.modalControls(strings.Join(lines, "\n"), width, height, editable)
}

func (m *Model) modalControls(body string, width, height int, editable bool) string {
	labels := []action{{"", "Close", "modal-close"}}
	if m.modal.Kind == "frontend-access" {
		label := "Get code"
		if m.frontendNext == "stop" {
			label = "Stop web"
		}
		labels = []action{{"B", label, "modal-frontend"}, {"", "Back", "modal-close"}}
	}
	if editable {
		labels = []action{{"", "Confirm", "modal-submit"}, {"", "Cancel", "modal-close"}}
		if m.modal.Busy {
			labels[0].label = "Waiting…"
		}
	}
	labels = append(labels, action{"", "↑", "modal-up"}, action{"", "↓", "modal-down"})
	return fitLines(body, max(1, height-2), width) + "\n\n" + m.actionLine(4+height-1, labels)
}

// One-row navigation keeps mouse coordinates stable, including narrow terminals.
var workspaceButtons = []action{{"I", "Chat", "chat"}, {"N", "New task", "new"}, {"4", "Execution", "tab:3"}, {"M", "Money", "money"}, {"R", "Replay", "replay"}, {"B", "Browser", "frontend"}, {":", "More", "palette"}}

func (m *Model) navigation() string {
	selected := []bool{m.screen == screenDashboard, m.screen == screenTask, m.screen == screenExecution, m.screen == screenMoney, m.screen == screenReplay, false, false}
	buttons := make([]string, len(workspaceButtons))
	for i, item := range workspaceButtons {
		style := m.styles.Tab
		if selected[i] {
			style = m.styles.TabActive
		}
		if m.navFocus == i {
			style = m.styles.ButtonActive.Underline(true)
		}
		label := item.label
		if item.action == "frontend" {
			label = "B Start web"
			if m.frontendRunning {
				label = "B Get code"
			}
			if m.frontendNext == "stop" {
				label = "B Close web"
			}
		}
		buttons[i] = style.Render(label)
	}
	const gap = 2
	more := m.styles.Tab.Render("More")
	limit := m.width - 2
	start := 0
	// Measure the exact rendered labels, including the changing Browser action.
	for start < m.navFocus {
		needed := 2
		for i := start; i <= m.navFocus; i++ {
			needed += lipgloss.Width(buttons[i]) + gap
		}
		if m.navFocus < len(buttons)-1 {
			needed += lipgloss.Width(more)
		}
		if needed <= limit {
			break
		}
		start++
	}
	parts := []string{"  "}
	x := 2
	for i := start; i < len(buttons); i++ {
		w := lipgloss.Width(buttons[i])
		reserve := 0
		if i < len(buttons)-1 {
			reserve = gap + lipgloss.Width(more)
		}
		if x+w+reserve > limit {
			m.addHit(3, x, x+lipgloss.Width(more)-1, "palette")
			parts = append(parts, more)
			break
		}
		m.addHit(3, x, x+w-1, workspaceButtons[i].action)
		parts = append(parts, buttons[i], strings.Repeat(" ", gap))
		x += w + gap
	}
	return strings.Join(parts, "")
}

func (m *Model) panel(title, body string, width int) string {
	if body == "" {
		body = " "
	}
	return m.styles.PanelBox(title, body, width)
}

func (m *Model) actionLine(y int, actions []action) string {
	parts := make([]string, 0, len(actions))
	x, gap := 0, 2
	modal := len(actions) > 0 && strings.HasPrefix(actions[0].action, "modal-")
	if modal {
		gap = 1
	}
	more := m.styles.Button.Render("More")
	for i, item := range actions {
		label := item.label
		if label == "new" {
			label = "New task"
		}
		if label == "gates" {
			label = "Approvals"
		}
		if len(label) > 0 && label[0] >= 'a' && label[0] <= 'z' {
			label = strings.ToUpper(label[:1]) + label[1:]
		}
		rendered := m.styles.Button.Render(label)
		width, reserve := lipgloss.Width(rendered), 0
		if !modal && i < len(actions)-1 {
			reserve = gap + lipgloss.Width(more)
		}
		if x+width+reserve > m.width-2 {
			if !modal {
				m.moreActions = append([]action{}, actions[i:]...)
				m.addHit(y, x, x+lipgloss.Width(more)-1, "more-actions")
				parts = append(parts, more)
			}
			break
		}
		m.addHit(y, x, x+width-1, item.action)
		parts = append(parts, rendered)
		x += width + gap
	}
	return strings.Join(parts, strings.Repeat(" ", gap))
}

func (m *Model) budgetText(task *api.Task, width int) string {
	if m.state == nil || m.state.Ledger == nil {
		return "Ledger not loaded."
	}
	l := m.state.Ledger
	lines := []string{
		"Authorized " + m.styles.Value.Render(l.Authorized+" "+l.Currency),
		"Committed  " + m.styles.Amber.Render(l.Committed+" "+l.Currency),
		"Paid       " + m.styles.Green.Render(l.Paid+" "+l.Currency),
		"Refunded   " + m.styles.Cyan.Render(l.Refunded+" "+l.Currency),
		"Available  " + m.styles.Green.Render(l.Available+" "+l.Currency),
	}
	lines = append(lines, "  "+m.progressView(parseMoney(l.Committed)+parseMoney(l.Paid), parseMoney(l.Authorized), max(12, width-8)))
	if task.MarketSnapshot != nil {
		balance := task.MarketSnapshot.Balances[task.Currency]
		source := task.MarketSnapshot.Source
		lines = append(lines, "", "Market balance "+m.styles.Cyan.Render(balance+" "+task.Currency)+m.styles.Muted.Render(" ("+source+", account not budget)"))
	}
	if task.Plan != nil {
		lines = append(lines, "Plan external "+task.Plan.ExternalPlanned+" · reserve "+task.Plan.Contingency)
	}
	return strings.Join(lines, "\n")
}

func (m *Model) securityText(task *api.Task, width int) string {
	chain := "not checked"
	tone := m.styles.Amber
	if m.state != nil && m.state.Integrity != nil {
		if m.state.Integrity.OK {
			chain = "VERIFIED"
			tone = m.styles.Green
		} else {
			chain = "BROKEN"
			tone = m.styles.Red
		}
	}
	lines := []string{
		"Receipt chain " + tone.Render(chain),
		"Receipts      " + fmt.Sprint(receiptCount(m.state)),
		"Approvals     " + fmt.Sprintf("%d pending", pendingCount(m.state)),
		"Market        " + marketState(m.state),
		"Last receipt  " + shortHash(lastReceiptHash(m.state)),
	}
	if m.state != nil && len(m.state.Receipts) > 0 {
		lines = append(lines, "")
		for _, view := range m.state.Receipts[:min(4, len(m.state.Receipts))] {
			lines = append(lines, fmt.Sprintf("%s %-10s %s", shortHash(&view.Receipt.Hash), view.Receipt.Status, truncate(view.Receipt.Item, max(12, width-30))))
		}
	}
	return strings.Join(lines, "\n")
}

func (m *Model) progressView(value, total float64, width int) string {
	if total <= 0 {
		total = 1
	}
	bar := m.progress
	bar.Width = max(8, width)
	return bar.ViewAs(value / total)
}

func findSubtask(plan *api.Plan, id string) *api.Subtask {
	if plan == nil {
		return nil
	}
	for index := range plan.Subtasks {
		if plan.Subtasks[index].ID == id {
			return &plan.Subtasks[index]
		}
	}
	return nil
}

func findState(task *api.Task, id string) *api.SubtaskState {
	for index := range task.Subtasks {
		if task.Subtasks[index].ID == id {
			return &task.Subtasks[index]
		}
	}
	return nil
}

func project(task *api.Task) string {
	if task.TrackID == nil {
		return "custom"
	}
	return *task.TrackID
}

func receiptCount(state *api.State) int {
	if state == nil || state.Integrity == nil {
		return 0
	}
	return state.Integrity.ReceiptCount
}

func pendingCount(state *api.State) int {
	if state == nil {
		return 0
	}
	return len(state.Approvals)
}

func marketState(state *api.State) string {
	if state == nil {
		return "unknown"
	}
	if state.Market.Connected {
		return state.Market.Mode
	}
	if state.Market.Error != nil {
		return truncate(*state.Market.Error, 40)
	}
	return "offline"
}

func lastReceiptHash(state *api.State) *string {
	if state == nil || state.Integrity == nil {
		return nil
	}
	return state.Integrity.LastHash
}

func shortHash(hash *string) string {
	if hash == nil || *hash == "" {
		return "none"
	}
	value := *hash
	if len(value) > 12 {
		return value[:12] + "…"
	}
	return value
}

func shortTime(value string) string {
	if len(value) >= 19 {
		return value[11:19]
	}
	return value
}

func configured(value bool) string {
	if value {
		return "configured"
	}
	return "not configured"
}

func onOff(value bool) string {
	if value {
		return "ONLINE"
	}
	return "IDLE"
}

func parseMoney(value string) float64 {
	cleaned := strings.ReplaceAll(value, ",", "")
	result := 0.0
	fmt.Sscanf(cleaned, "%f", &result)
	return result
}

func fitLines(body string, height, width int) string {
	lines := strings.Split(body, "\n")
	out := make([]string, 0, height)
	for index := 0; index < height; index++ {
		if index < len(lines) {
			out = append(out, ansi.Truncate(lines[index], max(1, width), ""))
		} else {
			out = append(out, "")
		}
	}
	return strings.Join(out, "\n")
}
