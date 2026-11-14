package ui

import (
	"fmt"
	"strings"
	"time"
	"unicode"

	"ash-tui/internal/api"
	"github.com/charmbracelet/bubbles/textarea"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

type chatSession struct {
	history     *api.ChatHistory
	draft       string
	err         string
	loadErr     string
	loading     bool
	sending     bool
	loaded      bool
	requestID   string
	requestText string
	scroll      int
	generation  uint64
}

type chatMsg struct {
	taskID     string
	history    *api.ChatHistory
	err        error
	sent       bool
	text       string
	generation uint64
}

func newChatInput() textarea.Model {
	input := textarea.New()
	input.Placeholder = "Message Ash…"
	input.Prompt = "› "
	input.SetPromptFunc(2, func(line int) string {
		if line == 0 {
			return "› "
		}
		return "  "
	})
	style := textarea.Style{
		Base:        lipgloss.NewStyle().Foreground(white).Background(panelBg),
		Text:        lipgloss.NewStyle().Foreground(white),
		Prompt:      lipgloss.NewStyle().Foreground(green),
		Placeholder: lipgloss.NewStyle().Foreground(muted),
		CursorLine:  lipgloss.NewStyle(),
		EndOfBuffer: lipgloss.NewStyle().Foreground(panelBg),
	}
	input.FocusedStyle = style
	input.BlurredStyle = style
	input.Cursor.Style = lipgloss.NewStyle().Foreground(white)
	input.ShowLineNumbers = false
	input.CharLimit = 4000
	input.SetHeight(2)
	input.SetWidth(80)
	return input
}

func (m *Model) conversation(taskID string) *chatSession {
	if m.chats == nil {
		m.chats = map[string]*chatSession{}
	}
	if m.chats[taskID] == nil {
		m.chats[taskID] = &chatSession{}
	}
	return m.chats[taskID]
}

func (m *Model) syncChat() {
	taskID := m.activeTaskID()
	if m.chatTaskID == taskID {
		return
	}
	m.conversation(m.chatTaskID).draft = m.chatInput.Value()
	m.chatTaskID = taskID
	m.chatInput.SetValue(m.conversation(taskID).draft)
}

func (m *Model) loadChat(force bool) tea.Cmd {
	m.syncChat()
	id := m.chatTaskID
	session := m.conversation(id)
	if m.Client == nil || session.loading || session.sending || (session.loaded && !force) {
		return nil
	}
	session.loading = true
	generation := session.generation
	return func() tea.Msg {
		history, err := m.Client.ChatHistory(m.ctx, id)
		return chatMsg{taskID: id, history: history, err: err, generation: generation}
	}
}

func (m *Model) receiveChat(msg chatMsg) tea.Cmd {
	session := m.conversation(msg.taskID)
	if msg.sent {
		session.sending = false
	} else {
		session.loading = false
	}
	// Ignore a GET issued before the current send, including its errors.
	if msg.generation != session.generation {
		return nil
	}
	if msg.err != nil {
		if msg.sent {
			session.err = safeChatText(msg.err.Error())
		} else {
			session.loadErr = safeChatText(msg.err.Error())
		}
		return nil
	}
	if msg.history != nil {
		session.history = msg.history
	}
	session.loadErr = ""
	session.loaded = true
	if msg.sent {
		session.err = ""
		session.scroll = 0
		if session.draft == msg.text {
			session.draft = ""
		}
		if m.chatTaskID == msg.taskID && m.chatInput.Value() == msg.text {
			m.chatInput.Reset()
		}
		session.requestID = ""
		session.requestText = ""
	}
	return nil
}

func (m *Model) focusChat() tea.Cmd {
	m.screen = screenDashboard
	m.stopReplay()
	m.modal = nil
	m.syncChat()
	m.chatFocus = true
	return tea.Batch(m.chatInput.Focus(), m.loadChat(false))
}

func (m *Model) blurChat() {
	m.chatFocus = false
	m.chatInput.Blur()
}

func (m *Model) sendChat() tea.Cmd {
	m.syncChat()
	session := m.conversation(m.chatTaskID)
	text := strings.TrimSpace(m.chatInput.Value())
	if text == "" || session.sending {
		return nil
	}
	if strings.Fields(text)[0] == "/task" {
		brief := strings.TrimSpace(strings.TrimPrefix(text, "/task"))
		if brief == "" {
			session.err = "Use /task followed by the brief you want to work on."
			return nil
		}
		m.blurChat()
		m.screen = screenTask
		m.form = NewTaskForm(m.width)
		m.form.Description.SetValue(brief)
		m.form.focusInput()
		return nil
	}
	if m.Client == nil {
		session.err = "The backend is not connected."
		return nil
	}
	if session.requestID == "" || session.requestText != text {
		session.requestID = fmt.Sprintf("chat_%d", time.Now().UnixNano())
		session.requestText = text
	}
	session.draft = m.chatInput.Value()
	session.sending = true
	session.generation++
	session.err = ""
	session.scroll = 0
	id, requestID, draft := m.chatTaskID, session.requestID, m.chatInput.Value()
	generation := session.generation
	return func() tea.Msg {
		history, err := m.Client.Chat(m.ctx, id, requestID, text)
		return chatMsg{taskID: id, history: history, err: err, sent: true, text: draft, generation: generation}
	}
}

func (m *Model) handleChatKey(msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "esc":
		m.blurChat()
		return nil
	case "enter":
		return m.sendChat()
	case "alt+enter", "ctrl+j":
		m.chatInput.InsertString("\n")
		m.conversation(m.chatTaskID).draft = m.chatInput.Value()
		return nil
	case "pgup":
		m.conversation(m.chatTaskID).scroll += 5
		return nil
	case "pgdown":
		s := m.conversation(m.chatTaskID)
		s.scroll = max(0, s.scroll-5)
		return nil
	}
	var cmd tea.Cmd
	m.chatInput, cmd = m.chatInput.Update(msg)
	m.conversation(m.chatTaskID).draft = m.chatInput.Value()
	return cmd
}

func safeChatText(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, ansi.Strip(text))
}

func (m *Model) chatHistoryView(width, height int) string {
	s := m.conversation(m.chatTaskID)
	lines := []string{}
	if s.history == nil || len(s.history.Messages) == 0 {
		lines = append(lines, m.styles.Cyan.Render("What would you like to work on?"), "",
			"Ask about a task, explore an idea, or draft a brief.", "",
			"Try: Why is this task waiting?", "Try: Help me plan a launch checklist.", "",
			"/task brief opens the task form with your text.")
	} else {
		if s.history.Truncated {
			lines = append(lines, "Showing the newest 200 messages.", "")
		}
		for _, message := range s.history.Messages {
			label, style := "You", m.styles.Muted
			if message.Role == "assistant" {
				label, style = "Ash", m.styles.White
			}
			lines = append(lines, style.Bold(true).Render(label), safeChatText(message.Content), "")
		}
	}
	if s.sending {
		lines = append(lines, m.styles.Cyan.Render("YOU"), safeChatText(s.requestText), m.spinner.View()+" Ash is thinking…")
	}
	if s.err != "" {
		lines = append(lines, m.styles.Red.Render("Chat: "+s.err), "Your draft is kept. Enter retries; Escape returns to controls.")
	}
	if s.loadErr != "" {
		lines = append(lines, m.styles.Red.Render("History: "+s.loadErr), "Escape, then F5 retries loading history.")
	}
	if s.loading {
		lines = append(lines, "Loading conversation…")
	}
	wrapped := strings.Split(lipgloss.NewStyle().Width(max(1, width)).Render(strings.Join(lines, "\n")), "\n")
	s.scroll = clamp(s.scroll, 0, max(0, len(wrapped)-height))
	end := max(0, len(wrapped)-s.scroll)
	start := max(0, end-height)
	return fitLines(strings.Join(wrapped[start:end], "\n"), height, width)
}

// The home screen keeps conversation primary. Operational detail lives in Execution.
func (m *Model) viewChatDashboard(width, height int) string {
	m.syncChat()
	if height < 10 {
		m.chatInput.SetHeight(1)
		m.chatInput.SetWidth(max(1, width-4))
		historyHeight := max(1, height-4)
		send := m.styles.Button.Render("Send")
		title := "Message" + strings.Repeat(" ", max(1, width-11-lipgloss.Width(send))) + send
		m.addHit(5+historyHeight, width-2-lipgloss.Width(send), width-3, "chat-send")
		for y := 4 + historyHeight; y < 4+height; y++ {
			m.addHit(y, 0, width-1, "chat")
		}
		return m.chatHistoryView(width, historyHeight) + "\n" + m.panel(title, m.chatInput.View(), width)
	}
	padding := 2
	inner := max(1, width-padding*2)
	contentHeight := height - 7
	chatWidth := inner
	sidebar := width >= 112 && contentHeight >= 14
	if sidebar {
		chatWidth = inner - 36
	}
	s := m.conversation(m.chatTaskID)
	var conversation string
	if (s.history == nil || len(s.history.Messages) == 0) && !s.sending && s.err == "" && s.loadErr == "" {
		intro := []string{
			m.styles.Title.Render("Your next task starts here."), "",

			m.styles.Button.Render("N  Create a task"),
		}
		if s.loading {
			intro = append(intro, "", m.styles.Muted.Render("Loading conversation…"))
		}
		block := lipgloss.NewStyle().Width(max(1, chatWidth-4)).Render(strings.Join(intro, "\n"))
		conversation = strings.Repeat("\n", max(1, (contentHeight-lineCount(block))/2)) + block
	} else {
		conversation = "\n" + m.styles.Muted.Render("CHAT") + "\n\n" + m.chatHistoryView(chatWidth-2, max(1, contentHeight-4))
	}
	conversation = lipgloss.NewStyle().Width(chatWidth).Render(fitLines(conversation, contentHeight, chatWidth))
	if sidebar {
		right := m.workspaceSummary(32, contentHeight)
		divider := lipgloss.NewStyle().Foreground(forest).Render(strings.TrimSuffix(strings.Repeat("│\n", contentHeight), "\n"))
		conversation = lipgloss.JoinHorizontal(lipgloss.Top, conversation, "  ", divider, " ", right)
	}
	lines := []string{"", lipgloss.NewStyle().PaddingLeft(padding).Render(conversation)}
	// The empty-state action is a real button; register its rendered position
	// before the surrounding history area, which handles scrolling.
	if (s.history == nil || len(s.history.Messages) == 0) && !s.sending && s.err == "" && s.loadErr == "" {
		for row, line := range strings.Split(conversation, "\n") {
			plain := ansi.Strip(line)
			if index := strings.Index(plain, "N  Create a task"); index >= 0 {
				x := padding + lipgloss.Width(plain[:index])
				m.addHit(5+row, x, x+len("N  Create a task")-1, "new")
			}
		}
	}
	for y := 5; y < 5+contentHeight; y++ {
		m.addHit(y, padding, padding+chatWidth-1, "chat-history")
	}
	if sidebar {
		m.addHit(5+contentHeight-1, padding+chatWidth+4, width-1, "tab:3")
	}
	m.chatInput.SetHeight(2)
	m.chatInput.SetWidth(max(1, inner-4))
	title := "Message Ash"
	sendLabel := "Send"
	if s.sending {
		sendLabel = "Sending…"
	}
	send := m.styles.Button.Render(sendLabel)
	header := m.styles.Muted.Render(title) + strings.Repeat(" ", max(1, inner-4-len(title)-lipgloss.Width(send))) + send
	border := forest
	if m.chatFocus {
		border = green
	}
	input := m.styles.Panel.BorderForeground(border).Width(max(1, inner-2)).Render(header + "\n" + m.chatInput.View())
	inputY := 4 + lineCount(strings.Join(lines, "\n"))
	// Register the explicit Send control before the surrounding input hit area.
	m.addHit(inputY+1, padding+inner-2-lipgloss.Width(send), padding+inner-3, "chat-send")
	for y := inputY; y < inputY+lineCount(input); y++ {
		m.addHit(y, padding, width-padding-1, "chat")
	}

	lines = append(lines, lipgloss.NewStyle().PaddingLeft(padding).Render(input))
	return strings.Join(lines, "\n")
}

func (m *Model) workspaceSummary(width, height int) string {
	lines := []string{"", m.styles.Muted.Render("TASK"), ""}
	task := m.activeTask()
	if task == nil {
		lines = append(lines, "No task yet.")
	} else {
		description := lipgloss.NewStyle().Width(width).Render(safeChatText(task.Description))
		parts := strings.Split(description, "\n")
		if len(parts) > 3 {
			parts = append(parts[:2], truncate(strings.Join(parts[2:], " "), width))
		}
		lines = append(lines, parts...)
		lines = append(lines, m.styles.Status(shortPhase(task.Status)), "")
		completed, waiting := 0, 0
		for _, sub := range task.Subtasks {
			if sub.Phase == "completed" {
				completed++
			}
			if strings.HasPrefix(sub.Phase, "awaiting") {
				waiting++
			}
		}
		if len(task.Subtasks) > 0 {
			lines = append(lines, m.styles.Muted.Render("PROGRESS"), fmt.Sprintf("%d of %d steps complete", completed, len(task.Subtasks)), m.styles.Bar(float64(completed), float64(len(task.Subtasks)), width-6, green), "")
		}
		if waiting > 0 {
			lines = append(lines, m.styles.Amber.Render(fmt.Sprintf("%d waiting for a decision", waiting)), "")
		}
		if m.state != nil && m.state.Ledger != nil && height >= 21 {
			l := m.state.Ledger
			lines = append(lines, m.styles.Muted.Render("BUDGET"))
			for _, row := range [][2]string{{"Limit", l.Authorized}, {"Available", l.Available}} {
				lines = append(lines, m.styles.Muted.Render(row[0])+strings.Repeat(" ", max(1, width-len(row[0])-len(row[1])))+m.styles.White.Render(row[1]))
			}
		}
	}
	return fitLines(strings.Join(lines, "\n"), height-1, width) + "\n" + m.styles.Button.Render("Details →")
}
