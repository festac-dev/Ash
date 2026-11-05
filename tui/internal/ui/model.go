package ui

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/help"
	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"

	"ash-tui/internal/api"
)

type screen int

const (
	screenDashboard screen = iota
	screenTask
	screenMarket
	screenExecution
	screenTransactions
	screenSecurity
	screenSettings
	screenMoney
	screenReplay
)

var screenLabels = []string{"Dashboard", "New Task", "Market", "Execution", "Transactions", "Security", "Settings", "Money", "Replay"}

type Model struct {
	Client *api.Client
	ctx    context.Context
	cancel context.CancelFunc

	styles Styles
	width  int
	height int
	ready  bool

	navFocus        int
	screen          screen
	state           *api.State
	stateErr        string
	loading         bool
	refreshing      bool
	creating        bool
	frontendBusy    bool
	frontendRunning bool
	frontendNext    string
	connected       bool
	sseErr          string
	stream          <-chan api.StreamMessage
	statusMsg       string
	statusLevel     string
	statusUntil     time.Time

	logs        []string
	logViewport viewport.Model
	help        help.Model
	showHelp    bool
	spinner     spinner.Model
	progress    progress.Model
	form        TaskForm

	agents       []api.Agent
	agentQuery   textinput.Model
	agentFocus   bool
	agentCursor  int
	agentsLoaded bool
	agentErr     string
	jobs         []api.Job

	tx       *api.Transactions
	txCursor int
	txErr    string

	security         *api.Security
	settings         *api.Settings
	settingsCursor   int
	approvalCursor   int
	securityEvents   int
	securitySequence uint64
	settingsSequence uint64

	graphCursor      int
	matrix           bool
	timeline         *api.Timeline
	timelineLoading  bool
	moneyCursor      int
	replayCursor     int
	replayPlaying    bool
	replayGeneration uint64
	compared         []api.Agent
	modalScroll      int
	paletteCursor    int
	refreshQueued    bool
	animation        bool
	frame            int
	lastTaskID       string

	chatInput  textarea.Model
	chatFocus  bool
	chatTaskID string
	chats      map[string]*chatSession

	modal       *Modal
	hits        []hit
	moreActions []action
}

type hit struct {
	x1, x2, y int
	action    string
}

type Modal struct {
	Actions   []action
	Busy      bool
	Kind      string
	Title     string
	Body      string
	Prompt    string
	Phrase    string
	Action    string
	Key       string
	TaskID    string
	SubtaskID string
	Decision  string
	Approval  *api.Approval
	Input     textinput.Model
	Err       string
}

type refreshMsg struct {
	state *api.State
	err   error
}

type planMsg struct {
	response *api.PlanResponse
	err      error
}

type actionMsg struct {
	modal *Modal
	label string
	task  *api.Task
	err   error
	level string
}

type agentsMsg struct {
	agents []api.Agent
	err    error
}

type jobsMsg struct {
	jobs []api.Job
	err  error
}

type transactionsMsg struct {
	view *api.Transactions
	err  error
}

type securityMsg struct {
	taskID   string
	sequence uint64
	view     *api.Security
	err      error
}

type settingsMsg struct {
	taskID   string
	sequence uint64
	view     *api.Settings
	err      error
}

type receiptMsg struct {
	view *api.ReceiptView
	err  error
}

type streamMsg struct {
	message api.StreamMessage
}

type tickMsg time.Time

type statusExpiredMsg struct{}

type formSubmitMsg struct{}
type formCancelMsg struct{}

type modalResultMsg struct {
	text string
	err  error
}

func New(client *api.Client) *Model {
	ctx, cancel := context.WithCancel(context.Background())
	m := &Model{
		Client:      client,
		animation:   os.Getenv("ASH_ANIMATION") != "false" && os.Getenv("TERM") != "dumb",
		ctx:         ctx,
		cancel:      cancel,
		styles:      NewStyles(100),
		width:       100,
		height:      30,
		screen:      screenDashboard,
		navFocus:    -1,
		form:        NewTaskForm(100),
		logViewport: viewport.New(100, 14),
		help:        help.New(),
		spinner:     spinner.New(),
		progress:    progress.New(progress.WithSolidFill(string(green)), progress.WithWidth(28)),
	}
	m.chatInput = newChatInput()
	m.chats = map[string]*chatSession{}
	m.spinner.Spinner = spinner.Dot
	m.agentQuery = textinput.New()
	m.agentQuery.Placeholder = "search agents by skill, name or handle"
	m.agentQuery.CharLimit = 120
	m.stream = nil
	if client != nil {
		m.stream = client.Stream(ctx)
	}
	m.help.ShowAll = false
	return m
}

func (m *Model) Init() tea.Cmd {
	return tea.Batch(m.refreshState(), m.observeFrontend(), m.waitStream(), m.spinner.Tick, m.tick(), m.pulse())
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch value := msg.(type) {
	case chatMsg:
		return m, m.receiveChat(value)
	case pulseMsg:
		m.frame++
		return m, m.pulse()
	case replayTickMsg:
		if value.generation != m.replayGeneration {
			return m, nil
		}
		if m.replayPlaying && m.screen == screenReplay && m.timeline != nil && m.replayCursor < len(m.timeline.Events)-1 {
			m.replayCursor++
			return m, m.replayTick()
		}
		m.stopReplay()
		return m, nil
	case timelineMsg:
		m.timelineLoading = false
		if value.taskID != m.activeTaskID() {
			return m, m.loadTimeline()
		}
		if value.err != nil {
			m.setStatus(value.err.Error(), "error")
		} else {
			m.updateTimeline(value.view)
		}
		return m, nil
	case proofMsg:
		if value.err != nil {
			m.setStatus("Export failed: "+value.err.Error(), "error")
		} else if value.paths != nil {
			m.modal = &Modal{Kind: "info", Title: "PROOF EXPORTED", Body: "HTML proof: " + value.paths.HTMLPath + "\n\nMarkdown: " + value.paths.MarkdownPath + "\nJSON: " + value.paths.JSONPath + "\n\nFiles are on the backend host. Review task details before sharing."}
			m.modalScroll = 0
		}
		return m, nil
	case tea.WindowSizeMsg:
		m.width = value.Width
		m.height = value.Height
		m.styles = NewStyles(value.Width)
		m.form.Width = value.Width
		m.form.Notes.SetWidth(max(20, value.Width-10))
		m.logViewport.Width = max(20, value.Width-6)
		m.logViewport.Height = max(4, value.Height-9)
		m.progress.Width = max(12, value.Width/3)
		m.ready = true
		return m, nil
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	case tickMsg:
		return m, tea.Batch(m.refreshState(), m.tick())
	case statusExpiredMsg:
		if time.Now().After(m.statusUntil) {
			m.statusMsg = ""
			m.statusLevel = ""
		}
		return m, nil
	case refreshMsg:
		m.refreshing = false
		if value.err != nil {
			m.stateErr = value.err.Error()
			m.setStatus("Backend error: "+value.err.Error(), "error")
		} else if value.state != nil {
			previousID := m.lastTaskID
			m.state = value.state
			m.lastTaskID = m.activeTaskID()
			if previousID != m.lastTaskID {
				m.logs = nil
				m.timeline = nil
				m.graphCursor = 0
				m.replayCursor = 0
				m.moneyCursor = 0
				m.security = nil
				m.settings = nil
				m.securitySequence++
				m.settingsSequence++
				m.stopReplay()
			}
			m.stateErr = ""
			m.ready = true
			if len(m.logs) == 0 {
				for _, event := range value.state.Events {
					m.appendEvent(event)
				}
			}
			if value.state.Task != nil && value.state.Task.Status == "awaiting_plan_approval" && m.statusMsg == "" {
				m.setStatus("Plan awaiting approval — press a to review and approve.", "warning")
			}
		}
		var next []tea.Cmd
		if m.refreshQueued {
			m.refreshQueued = false
			next = append(next, m.refreshState())
		}
		if m.screen == screenMoney || m.screen == screenReplay {
			next = append(next, m.loadTimeline())
		}
		if m.screen == screenDashboard {
			next = append(next, m.loadChat(false))
		}
		return m, tea.Batch(next...)
	case streamMsg:
		return m, m.handleStream(value.message)
	case formCancelMsg:
		m.screen = screenDashboard
		return m, nil
	case formSubmitMsg:
		return m, m.submitForm()
	case planMsg:
		m.creating = false
		if value.err != nil {
			m.setStatus("Plan failed: "+value.err.Error(), "error")
			return m, nil
		}
		m.setStatus("Plan ready. Review the dependency tree and approve it before execution.", "success")
		m.screen = screenExecution
		if value.response != nil && value.response.PlanSummary != "" {
			m.modal = &Modal{
				Kind:  "plan",
				Title: "Execution plan",
				Body:  planModalText(value.response),
			}
		}
		return m, tea.Batch(m.refreshState(), m.loadSecurity())
	case frontendObservedMsg:
		if value.status != nil && !m.frontendBusy && m.frontendNext == "" {
			m.frontendRunning = value.status.Running
			m.frontendNext = value.status.NextAction
		}
		return m, nil
	case frontendStateMsg:
		state := "OFF"
		if value.status.Running {
			state = "ON"
		}
		m.frontendRunning = value.status.Running
		m.frontendNext = value.status.NextAction
		m.setStatus(fmt.Sprintf("Frontend %s · port %d · %s · next: %s…", state, value.status.Port, value.status.URL, value.status.NextAction), "info")
		return m, m.applyFrontendToggle()
	case frontendMsg:
		m.frontendBusy = false
		if value.err != nil {
			m.setStatus("Frontend: "+value.err.Error(), "error")
		} else {
			m.frontendRunning = value.status.Running
			m.frontendNext = value.status.NextAction
			m.setStatus(frontendMessage(value.status, value.opened), "success")
			if value.status.Running {
				m.modal = &Modal{Kind: "frontend-access", Title: "Browser access", Body: frontendAccess(value.status)}
			} else {
				m.modal = nil
			}
		}
		return m, nil
	case actionMsg:
		if value.modal != nil {
			value.modal.Busy = false
		}
		if strings.HasPrefix(value.label, "Create task") {
			m.creating = false
		}
		if value.err != nil {
			m.setStatus(value.label+" failed: "+value.err.Error(), "error")
			if value.modal != nil && m.modal == value.modal {
				m.modal.Err = value.err.Error()
			}
			if value.task != nil && strings.HasPrefix(value.label, "Create task") {
				m.screen = screenExecution
				m.setStatus("Task created. Planning failed; retry Plan from Execution.", "warning")
				return m, m.refreshState()
			}
			return m, nil
		}
		if value.modal != nil && m.modal == value.modal {
			m.modal = nil
		}
		m.setStatus(value.label+" completed.", successLevel(value.level))
		return m, tea.Batch(m.refreshState(), m.loadSecurity(), m.loadTransactions())
	case agentsMsg:
		m.agentsLoaded = true
		if value.err != nil {
			m.agentErr = value.err.Error()
			m.setStatus("Marketplace: "+value.err.Error(), "error")
		} else {
			m.agents = value.agents
			m.agentErr = ""
			m.agentCursor = 0
		}
		return m, nil
	case jobsMsg:
		if value.err != nil {
			m.setStatus("Jobs: "+value.err.Error(), "warning")
		} else {
			m.jobs = value.jobs
		}
		return m, nil
	case transactionsMsg:
		if value.err != nil {
			m.txErr = value.err.Error()
			m.setStatus("Receipts: "+value.err.Error(), "error")
		} else {
			m.tx = value.view
			m.txErr = ""
			m.txCursor = min(m.txCursor, max(0, len(value.view.Receipts)-1))
		}
		return m, nil
	case securityMsg:
		if value.taskID != m.activeTaskID() || value.sequence != m.securitySequence {
			return m, nil
		}
		if value.err != nil {
			m.setStatus("Security: "+value.err.Error(), "error")
		} else {
			m.security = value.view
			m.approvalCursor = min(m.approvalCursor, max(0, len(value.view.Approvals)-1))
		}
		return m, nil
	case settingsMsg:
		if value.taskID != m.activeTaskID() || value.sequence != m.settingsSequence {
			return m, nil
		}
		if value.err != nil {
			m.setStatus("Settings: "+value.err.Error(), "error")
		} else {
			m.settings = value.view
			m.settingsCursor = min(m.settingsCursor, max(0, len(settingKeys)-1))
		}
		return m, nil
	case receiptMsg:
		if value.err != nil {
			m.setStatus("Receipt: "+value.err.Error(), "error")
		} else if value.view != nil {
			m.modal = &Modal{Kind: "receipt", Title: "Receipt " + value.view.File, Body: receiptModalText(value.view)}
		}
		return m, nil
	case modalResultMsg:
		if value.err != nil {
			if m.modal != nil {
				m.modal.Err = value.err.Error()
			}
		}
		return m, nil
	case tea.MouseMsg:
		return m, m.handleMouse(value)
	case tea.KeyMsg:
		if value.String() == "ctrl+c" {
			m.cancel()
			return m, tea.Quit
		}
		if m.modal != nil {
			return m, m.handleModalKey(value)
		}
		if m.screen == screenTask {
			if value.String() == "esc" {
				m.screen = screenDashboard
				return m, nil
			}
			var cmd tea.Cmd
			m.form, cmd = m.form.Update(value)
			return m, cmd
		}
		if m.chatFocus && m.screen == screenDashboard {
			return m, m.handleChatKey(value)
		}
		return m, m.handleKey(value)
	}
	if m.chatFocus && m.screen == screenDashboard && m.modal == nil {
		var cmd tea.Cmd
		m.chatInput, cmd = m.chatInput.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m *Model) handleKey(msg tea.KeyMsg) tea.Cmd {
	if !(m.agentFocus && m.screen == screenMarket) {
		if msg.String() == "tab" || msg.String() == "shift+tab" {
			delta := 1
			if msg.String() == "shift+tab" {
				delta = len(workspaceButtons) - 1
			}
			m.navFocus = (m.navFocus + delta + len(workspaceButtons)) % len(workspaceButtons)
			return nil
		}
		if m.navFocus >= 0 {
			switch msg.String() {
			case "enter":
				action := workspaceButtons[m.navFocus].action
				m.navFocus = -1
				return m.activate(action)
			case "esc":
				m.navFocus = -1
				return nil
			case "left":
				m.navFocus = (m.navFocus + len(workspaceButtons) - 1) % len(workspaceButtons)
				return nil
			case "right":
				m.navFocus = (m.navFocus + 1) % len(workspaceButtons)
				return nil
			default:
				m.navFocus = -1
			}
		}
	}

	if m.agentFocus && m.screen == screenMarket {
		return m.handleMarketKey(msg)
	}
	if msg.String() == "b" || msg.String() == "B" {
		return m.toggleFrontend()
	}
	if m.screen == screenReplay {
		switch msg.String() {
		case "enter":
			if m.timeline != nil && len(m.timeline.Events) > 0 {
				event := m.timeline.Events[clamp(m.replayCursor, 0, len(m.timeline.Events)-1)]
				m.modal = &Modal{Kind: "info", Title: event.Code, Body: event.At + "\nSubtask: " + ptr(event.SubtaskID) + "\n\n" + event.Message}
				m.modalScroll = 0
			}
			return nil

		case " ":
			return m.activate("replay-play")
		case "left", "up", "k":
			return m.activate("replay-prev")
		case "right", "down", "j":
			return m.activate("replay-next")
		case "home":
			return m.activate("replay-home")
		case "e", "p", "x", "b", "v", "f":
			m.setStatus("Replay is read-only. Switch screens to act on a task.", "info")
			return nil
		}
	}
	if m.screen == screenDashboard || m.screen == screenExecution {
		switch msg.String() {
		case " ":
			if task := m.activeTask(); task != nil {
				if task.Status == "executing" {
					return m.pauseActive()
				}
				if task.Status == "paused" {
					return m.resumeActive()
				}
			}
			return nil

		case "up", "k":
			m.graphCursor = max(0, m.graphCursor-1)
			return nil
		case "down", "j":
			m.graphCursor = min(max(0, len(graphNodes(m.activeTask()))-1), m.graphCursor+1)
			return nil
		case "enter":
			if m.screen == screenDashboard {
				return m.focusChat()
			}
			return m.inspectNode()
		case "g", "G":
			m.screen = screenExecution
			m.matrix = !m.matrix
			return nil
		}
	}
	if m.screen == screenMoney && m.timeline != nil {
		switch msg.String() {
		case "up", "k":
			m.moneyCursor = max(0, m.moneyCursor-1)
			return nil
		case "down", "j":
			m.moneyCursor = min(max(0, len(m.timeline.Entries)-1), m.moneyCursor+1)
			return nil
		case "enter":
			return m.activate(fmt.Sprintf("money:%d", m.moneyCursor))
		}
	}
	switch msg.String() {
	case "ctrl+c":
		m.cancel()
		return tea.Quit
	case "q":
		m.cancel()
		return tea.Quit
	case "?":
		m.showHelp = !m.showHelp
		if m.showHelp {
			m.modal = &Modal{Kind: "help", Title: "Keyboard & mouse", Body: helpText()}
		} else {
			m.modal = nil
		}
		return nil
	case "i", "I":
		return m.focusChat()
	case "o", "O":
		return m.exportProof()
	case ":", "ctrl+p":
		return m.openPalette()
	case "1", "2", "3", "4", "5", "6", "7", "8", "9":
		index := int(msg.String()[0] - '1')
		return m.switchScreen(screen(index))
	case "tab":
		return m.switchScreen(screen((int(m.screen) + 1) % len(screenLabels)))
	case "shift+tab":
		return m.switchScreen(screen((int(m.screen) + len(screenLabels) - 1) % len(screenLabels)))
	case "right", "l":
		return m.switchScreen(screen((int(m.screen) + 1) % len(screenLabels)))
	case "left", "h":
		return m.switchScreen(screen((int(m.screen) + len(screenLabels) - 1) % len(screenLabels)))
	case "r", "R":
		return m.switchScreen(screenReplay)
	case "f5":
		return m.refreshScreen()
	case "n":
		m.screen = screenTask
		m.form = NewTaskForm(m.width)
		m.form.Focus = 0
		m.form.focusInput()
		return nil
	case "p":
		return m.planActive()
	case "e":
		return m.executeActive()
	case "a":
		m.screen = screenSecurity
		return m.loadSecurity()
	case "t":
		m.screen = screenTransactions
		return m.loadTransactions()
	case "m", "M":
		return m.switchScreen(screenMoney)
	case "s":
		m.screen = screenSettings
		return m.loadSettings()
	case "x":
		return m.openCancelModal()
	case "esc":
		m.screen = screenDashboard
		return nil
	}
	switch m.screen {
	case screenMarket:
		return m.handleMarketKey(msg)
	case screenExecution:
		return m.handleExecutionKey(msg)
	case screenTransactions:
		return m.handleTransactionKey(msg)
	case screenSecurity:
		return m.handleSecurityKey(msg)
	case screenSettings:
		return m.handleSettingsKey(msg)
	}
	return nil
}

func (m *Model) switchScreen(next screen) tea.Cmd {
	if next < 0 || int(next) >= len(screenLabels) {
		return nil
	}
	m.blurChat()
	m.screen = next
	m.stopReplay()
	m.modal = nil
	switch next {
	case screenDashboard:
		return m.loadChat(true)
	case screenMoney, screenReplay:
		return m.loadTimeline()
	case screenMarket:
		if !m.agentsLoaded {
			return m.loadAgents("")
		}
	case screenTransactions:
		return m.loadTransactions()
	case screenSecurity:
		return m.loadSecurity()
	case screenSettings:
		return m.loadSettings()
	}
	return nil
}

func (m *Model) refreshScreen() tea.Cmd {
	switch m.screen {
	case screenDashboard:
		return tea.Batch(m.refreshState(), m.loadChat(true))
	case screenMoney, screenReplay:
		return tea.Batch(m.refreshState(), m.loadTimeline())
	case screenMarket:
		if m.agentFocus && strings.TrimSpace(m.agentQuery.Value()) != "" {
			return m.loadAgents(m.agentQuery.Value())
		}
		return m.loadAgents("")
	case screenTransactions:
		return m.loadTransactions()
	case screenSecurity:
		return m.loadSecurity()
	case screenSettings:
		return m.loadSettings()
	default:
		return m.refreshState()
	}
}

func (m *Model) handleStream(message api.StreamMessage) tea.Cmd {
	switch message.Kind {
	case "closed":
		m.stream = nil
		m.connected = false
		return nil
	case "connected":
		m.connected = true
		m.sseErr = ""
	case "disconnect":
		m.connected = false
		if message.Error != nil {
			m.sseErr = message.Error.Error()
		}
	case "engine":
		if message.Event.TaskID != m.activeTaskID() {
			return m.waitStream()
		}
		m.appendEvent(message.Event)
		if message.Event.Code == "SUBTASK_RECEIPT" || strings.HasPrefix(message.Event.Code, "TASK_") {
			return tea.Batch(m.waitStream(), m.refreshState(), m.loadTransactions(), m.loadSecurity())
		}
		return tea.Batch(m.waitStream(), m.refreshState())
	case "refresh":
		return tea.Batch(m.waitStream(), m.refreshState(), m.loadSecurity())
	case "server":
		m.appendRaw("SERVER", message.Message)
	}
	return m.waitStream()
}

func (m *Model) waitStream() tea.Cmd {
	if m.stream == nil {
		return nil
	}
	return func() tea.Msg {
		message, ok := <-m.stream
		if !ok {
			return streamMsg{message: api.StreamMessage{Kind: "closed"}}
		}
		return streamMsg{message: message}
	}
}

func (m *Model) tick() tea.Cmd {
	return tea.Tick(5*time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m *Model) refreshState() tea.Cmd {
	if m.Client == nil {
		return nil
	}
	if m.refreshing {
		m.refreshQueued = true
		return nil
	}
	m.refreshing = true
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 20*time.Second)
		defer cancel()
		state, err := m.Client.State(ctx)
		return refreshMsg{state: state, err: err}
	}
}

func (m *Model) submitForm() tea.Cmd {
	if m.creating {
		return nil
	}
	input, err := m.form.Input()
	if err != nil {
		m.form.Err = err.Error()
		return nil
	}
	m.form.Err = ""
	m.creating = true
	m.setStatus("Preparing plan…", "info")
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 90*time.Second)
		defer cancel()
		task, err := m.Client.CreateTask(ctx, input)
		if err != nil {
			return actionMsg{label: "Create task", err: err, level: "error"}
		}
		plan, err := m.Client.PlanTask(ctx, task.ID)
		if err != nil {
			return actionMsg{label: "Create task (plan failed)", task: task, err: err, level: "warning"}
		}
		return planMsg{response: plan}
	}
}

func (m *Model) planActive() tea.Cmd {
	if m.creating {
		return nil
	}
	taskID := m.activeTaskID()
	if taskID == "" {
		m.setStatus("Choose New task to begin.", "warning")
		return nil
	}
	m.setStatus("Planning…", "info")
	m.creating = true
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 120*time.Second)
		defer cancel()
		response, err := m.Client.PlanTask(ctx, taskID)
		if err != nil {
			return planMsg{err: err}
		}
		return planMsg{response: response}
	}
}

func (m *Model) executeActive() tea.Cmd {
	taskID := m.activeTaskID()
	if taskID == "" {
		m.setStatus("Choose New task to begin.", "warning")
		return nil
	}
	m.setStatus("Starting execution…", "info")
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 30*time.Second)
		defer cancel()
		task, err := m.Client.Execute(ctx, taskID)
		if err != nil {
			return actionMsg{label: "Execute", err: err, level: "error"}
		}
		return actionMsg{label: "Execution started", task: task, level: "success"}
	}
}

func (m *Model) activeTaskID() string {
	if m.state == nil {
		return ""
	}
	if m.state.ActiveTaskID != nil {
		return *m.state.ActiveTaskID
	}
	if m.state.Task != nil {
		return m.state.Task.ID
	}
	return ""
}

func (m *Model) activeTask() *api.Task {
	if m.state == nil {
		return nil
	}
	return m.state.Task
}

func (m *Model) loadAgents(query string) tea.Cmd {
	m.loading = true
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 25*time.Second)
		defer cancel()
		agents, err := m.Client.Agents(ctx, query)
		return agentsMsg{agents: agents, err: err}
	}
}

func (m *Model) loadTransactions() tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 20*time.Second)
		defer cancel()
		view, err := m.Client.Transactions(ctx, 250)
		return transactionsMsg{view: view, err: err}
	}
}

func (m *Model) loadSecurity() tea.Cmd {
	m.securitySequence++
	sequence, taskID := m.securitySequence, m.activeTaskID()
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 20*time.Second)
		defer cancel()
		view, err := m.Client.Security(ctx)
		return securityMsg{taskID: taskID, sequence: sequence, view: view, err: err}
	}
}

func (m *Model) loadSettings() tea.Cmd {
	m.settingsSequence++
	sequence, taskID := m.settingsSequence, m.activeTaskID()
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 20*time.Second)
		defer cancel()
		view, err := m.Client.Settings(ctx)
		return settingsMsg{taskID: taskID, sequence: sequence, view: view, err: err}
	}
}

func (m *Model) loadReceipt(file string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 20*time.Second)
		defer cancel()
		view, err := m.Client.Receipt(ctx, file)
		return receiptMsg{view: view, err: err}
	}
}

func (m *Model) setStatus(message, level string) {
	m.statusMsg = safeChatText(message)
	m.statusLevel = level
	m.statusUntil = time.Now().Add(8 * time.Second)
}

func (m *Model) appendEvent(event api.Event) {
	ts := event.At
	if len(ts) >= 19 {
		ts = ts[11:19]
	}
	level := event.Level
	if level == "" {
		level = "info"
	}
	line := fmt.Sprintf("%s %-5s %-28s %s", ts, strings.ToUpper(level), event.Code, event.Message)
	m.appendRaw("", line)
}

func (m *Model) appendRaw(prefix, line string) {
	line = safeChatText(line)
	if prefix != "" {
		line = prefix + " " + line
	}
	m.logs = append(m.logs, line)
	if len(m.logs) > 400 {
		m.logs = m.logs[len(m.logs)-400:]
	}
	follow := m.logViewport.AtBottom()
	m.logViewport.SetContent(strings.Join(m.logs, "\n"))
	if follow {
		m.logViewport.GotoBottom()
	}
}

func (m *Model) handleMarketKey(msg tea.KeyMsg) tea.Cmd {
	if m.agentFocus {
		switch msg.String() {
		case "esc":
			m.agentFocus = false
			m.agentQuery.Blur()
			return nil
		case "enter":
			m.agentFocus = false
			m.agentQuery.Blur()
			return m.loadAgents(m.agentQuery.Value())
		}
		var cmd tea.Cmd
		m.agentQuery, cmd = m.agentQuery.Update(msg)
		return cmd
	}
	switch msg.String() {
	case "c", "C":
		return m.toggleCompare()
	case "v", "V":
		return m.compareAgents()
	case "/":
		m.agentFocus = true
		m.agentQuery.Focus()
		return nil
	case "enter":
		if len(m.agents) > 0 {
			m.modal = agentModal(m.agents[min(m.agentCursor, len(m.agents)-1)])
		}
	case "up", "k":
		if m.agentCursor > 0 {
			m.agentCursor--
		}
	case "down", "j":
		if m.agentCursor < len(m.agents)-1 {
			m.agentCursor++
		}
	}
	return nil
}

func (m *Model) handleExecutionKey(msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "up", "k":
		m.logViewport.LineUp(2)
	case "down", "j":
		m.logViewport.LineDown(2)
	case "pgup":
		m.logViewport.HalfViewUp()
	case "pgdown":
		m.logViewport.HalfViewDown()
	case "g":
		m.logViewport.GotoTop()
	case "G":
		m.logViewport.GotoBottom()
	case " ":
		task := m.activeTask()
		if task == nil {
			return nil
		}
		if task.Status == "executing" {
			return m.pauseActive()
		}
		if task.Status == "paused" {
			return m.resumeActive()
		}
	case "enter":
		return m.openNextApproval()
	case "v":
		return m.openReviewModal("pass")
	case "f":
		return m.openReviewModal("fail")
	}
	return nil
}

func (m *Model) handleTransactionKey(msg tea.KeyMsg) tea.Cmd {
	if m.tx == nil {
		return nil
	}
	switch msg.String() {
	case "up", "k":
		if m.txCursor > 0 {
			m.txCursor--
		}
	case "down", "j":
		if m.txCursor < len(m.tx.Receipts)-1 {
			m.txCursor++
		}
	case "enter":
		if len(m.tx.Receipts) > 0 {
			return m.loadReceipt(m.tx.Receipts[m.txCursor].File)
		}
	}
	return nil
}

func (m *Model) handleSecurityKey(msg tea.KeyMsg) tea.Cmd {
	if m.security == nil {
		return nil
	}
	switch msg.String() {
	case "up", "k":
		if m.approvalCursor > 0 {
			m.approvalCursor--
		}
	case "down", "j":
		if m.approvalCursor < len(m.security.Approvals)-1 {
			m.approvalCursor++
		}
	case "enter":
		if len(m.security.Approvals) > 0 {
			m.modal = approvalModal(m.security.Approvals[m.approvalCursor], true)
		}
	case "d":
		if len(m.security.Approvals) > 0 {
			m.modal = approvalModal(m.security.Approvals[m.approvalCursor], false)
		}
	}
	return nil
}

func (m *Model) handleSettingsKey(msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "up", "k":
		if m.settingsCursor > 0 {
			m.settingsCursor--
		}
	case "down", "j":
		if m.settingsCursor < len(settingKeys)-1 {
			m.settingsCursor++
		}
	case "enter":
		return m.openSettingModal()
	}
	return nil
}

func (m *Model) activateTask(taskID string) tea.Cmd {
	m.setStatus("Switching active task…", "info")
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 20*time.Second)
		defer cancel()
		task, err := m.Client.Activate(ctx, taskID)
		return actionMsg{label: "Activate task", task: task, err: err, level: "success"}
	}
}

func (m *Model) pauseActive() tea.Cmd {
	taskID := m.activeTaskID()
	m.setStatus("Pausing…", "info")
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 20*time.Second)
		defer cancel()
		task, err := m.Client.Pause(ctx, taskID)
		return actionMsg{label: "Pause", task: task, err: err, level: "warning"}
	}
}

func (m *Model) resumeActive() tea.Cmd {
	taskID := m.activeTaskID()
	m.setStatus("Resuming…", "info")
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 20*time.Second)
		defer cancel()
		task, err := m.Client.Resume(ctx, taskID)
		return actionMsg{label: "Resume", task: task, err: err, level: "success"}
	}
}

func (m *Model) openCancelModal() tea.Cmd {
	task := m.activeTask()
	if task == nil {
		return nil
	}
	input := textinput.New()
	input.Placeholder = "CANCEL " + task.ID
	input.CharLimit = 120
	input.Focus()
	m.modal = &Modal{
		Input:  input,
		Kind:   "cancel",
		Title:  "Cancel task",
		Body:   "This stops new work and records CANCELLED receipts for started subtasks. It does not call the marketplace cancel tool; any escrow remains for you to resolve.",
		Phrase: "CANCEL " + task.ID,
		TaskID: task.ID,
	}
	return nil
}

func (m *Model) openBudgetModal() tea.Cmd {
	task := m.activeTask()
	if task == nil {
		return nil
	}
	input := textinput.New()
	input.Placeholder = "new authorized amount"
	input.CharLimit = 24
	input.Focus()
	m.modal = &Modal{
		Kind:   "budget",
		Title:  "Request budget change",
		Body:   fmt.Sprintf("Current budget: %s %s. A budget change needs explicit approval.", task.Budget, task.Currency),
		Prompt: "Amount",
		TaskID: task.ID,
		Input:  input,
	}
	return textinput.Blink
}

func (m *Model) openSettingModal() tea.Cmd {
	if m.settings == nil || m.settings.Task == nil || m.settings.Task.ID != m.activeTaskID() {
		return m.loadSettings()
	}
	if m.settingsCursor < 0 || m.settingsCursor >= len(settingKeys) {
		return nil
	}
	key := settingKeys[m.settingsCursor]
	input := textinput.New()
	input.Placeholder = currentSettingValue(m.settings, key)
	input.SetValue(currentSettingValue(m.settings, key))
	input.CharLimit = 500
	input.Focus()
	m.modal = &Modal{
		Kind:   "edit",
		TaskID: m.settings.Task.ID,
		Title:  "Edit " + key,
		Body:   settingHelp(key),
		Key:    key,
		Input:  input,
	}
	return textinput.Blink
}

func (m *Model) openReviewModal(decision string) tea.Cmd {
	task := m.activeTask()
	if task == nil {
		return nil
	}
	var target *api.SubtaskState
	if selected := m.selectedSubtask(); selected != nil {
		candidate := findState(task, selected.ID)
		if candidate != nil && (candidate.Phase == "awaiting_human_review" || candidate.Phase == "verifying") {
			target = candidate
		} else {
			m.setStatus("The selected subtask is not awaiting human review.", "warning")
			return nil
		}
	}
	if target == nil {
		for index := range task.Subtasks {
			if task.Subtasks[index].Phase == "awaiting_human_review" || task.Subtasks[index].Phase == "verifying" {
				target = &task.Subtasks[index]
				break
			}
		}
	}
	if target == nil {
		m.setStatus("No subtask is awaiting human review.", "warning")
		return nil
	}
	phrase := "REVIEW " + target.ID + " " + strings.ToUpper(decision)
	input := textinput.New()
	input.Placeholder = phrase
	input.CharLimit = 120
	input.Focus()
	m.modal = &Modal{
		Kind:      "review",
		Title:     "Human review " + strings.ToUpper(decision),
		Body:      "Subtask " + target.ID + " is " + target.Phase + ". Inspect the stored deliverable before deciding. A pass can lead to acceptance; a fail rejects it.",
		Phrase:    phrase,
		SubtaskID: target.ID,
		TaskID:    task.ID,
		Decision:  decision,
		Input:     input,
	}
	return textinput.Blink
}

func (m *Model) openNextApproval() tea.Cmd {
	if m.security == nil || len(m.security.Approvals) == 0 {
		return nil
	}
	m.modal = approvalModal(m.security.Approvals[0], true)
	return nil
}

func (m *Model) handleModalKey(msg tea.KeyMsg) tea.Cmd {
	if m.modal == nil {
		return nil
	}
	if m.modal.Kind == "frontend-access" && (msg.String() == "b" || msg.String() == "B") {
		m.modal = nil
		return m.toggleFrontend()
	}
	if m.modal.Kind == "palette" {
		switch msg.String() {
		case "esc":
			m.modal = nil
			return nil
		case "up":
			m.paletteCursor = max(0, m.paletteCursor-1)
			return nil
		case "down":
			m.paletteCursor = min(max(0, len(m.paletteMatches())-1), m.paletteCursor+1)
			return nil
		case "enter":
			matches := m.paletteMatches()
			if len(matches) > 0 {
				action := matches[clamp(m.paletteCursor, 0, len(matches)-1)].action
				m.modal = nil
				return m.activate(action)
			}
			return nil
		}
		var cmd tea.Cmd
		m.modal.Input, cmd = m.modal.Input.Update(msg)
		m.paletteCursor = 0
		return cmd
	}
	if !m.modal.Input.Focused() {
		switch msg.String() {
		case "down", "j":
			m.modalScroll++
			return nil
		case "up", "k":
			m.modalScroll = max(0, m.modalScroll-1)
			return nil
		case "pgdown":
			m.modalScroll += max(1, m.height/2)
			return nil
		case "pgup":
			m.modalScroll = max(0, m.modalScroll-m.height/2)
			return nil
		}
	}
	switch msg.String() {
	case "esc":
		m.modal = nil
		return nil
	case "enter", "ctrl+s":
		return m.submitModal()
	}
	if m.modal.Input.Focused() {
		var cmd tea.Cmd
		m.modal.Input, cmd = m.modal.Input.Update(msg)
		return cmd
	}
	return nil
}

func (m *Model) submitModal() tea.Cmd {
	if m.modal == nil || m.modal.Busy {
		return nil
	}
	modal := m.modal
	switch modal.Kind {
	case "approval":
		if modal.Approval == nil {
			m.modal = nil
			return nil
		}
		expected := "APPROVE " + modal.Approval.ID
		if modal.Decision == "deny" {
			expected = "DENY " + modal.Approval.ID
		}
		if strings.TrimSpace(modal.Input.Value()) != expected {
			modal.Err = "Type the exact phrase: " + expected
			return nil
		}
		taskID := modal.Approval.TaskID
		modal.Busy = true
		return func() tea.Msg {
			ctx, cancel := context.WithTimeout(m.ctx, 20*time.Second)
			defer cancel()
			var task *api.Task
			var err error
			if modal.Decision == "deny" {
				task, err = m.Client.Deny(ctx, taskID, modal.Approval.ID, expected)
			} else {
				task, err = m.Client.Approve(ctx, taskID, modal.Approval.ID, expected)
			}
			return actionMsg{modal: modal, label: "Approval " + modal.Decision, task: task, err: err, level: "success"}
		}
	case "cancel":
		if strings.TrimSpace(modal.Input.Value()) != modal.Phrase {
			modal.Err = "Type the exact phrase: " + modal.Phrase
			return nil
		}
		taskID := modal.TaskID
		modal.Busy = true
		return func() tea.Msg {
			ctx, cancel := context.WithTimeout(m.ctx, 30*time.Second)
			defer cancel()
			task, err := m.Client.Cancel(ctx, taskID, modal.Phrase)
			return actionMsg{modal: modal, label: "Cancel task", task: task, err: err, level: "warning"}
		}
	case "budget":
		amount := strings.TrimSpace(modal.Input.Value())
		if !budgetPattern.MatchString(amount) {
			modal.Err = "Use a positive decimal amount, e.g. 175.00"
			return nil
		}
		taskID := modal.TaskID
		modal.Busy = true
		return func() tea.Msg {
			ctx, cancel := context.WithTimeout(m.ctx, 20*time.Second)
			defer cancel()
			approval, err := m.Client.RequestBudget(ctx, taskID, amount, "")
			if err != nil {
				return actionMsg{modal: modal, label: "Budget request", err: err, level: "error"}
			}
			return actionMsg{modal: modal, label: "Budget approval " + approval.ID + " requested; approve it in Security", level: "warning"}
		}
	case "edit":
		value := modal.Input.Value()
		taskID := modal.TaskID
		modal.Busy = true
		key := modal.Key
		return func() tea.Msg {
			ctx, cancel := context.WithTimeout(m.ctx, 20*time.Second)
			defer cancel()
			task, err := m.Client.UpdateSetting(ctx, taskID, key, value)
			return actionMsg{modal: modal, label: "Setting " + key, task: task, err: err, level: "success"}
		}
	case "review":
		if strings.TrimSpace(modal.Input.Value()) != modal.Phrase {
			modal.Err = "Type the exact phrase: " + modal.Phrase
			return nil
		}
		taskID := modal.TaskID
		modal.Busy = true
		return func() tea.Msg {
			ctx, cancel := context.WithTimeout(m.ctx, 20*time.Second)
			defer cancel()
			task, err := m.Client.Review(ctx, taskID, modal.SubtaskID, modal.Decision, modal.Phrase, "Human review from the TUI.")
			return actionMsg{modal: modal, label: "Review " + modal.Decision, task: task, err: err, level: "success"}
		}
	default:
		m.modal = nil
	}
	return nil
}

func approvalModal(approval api.Approval, approve bool) *Modal {
	action := "approve"
	title := "Approve " + approval.Kind
	if !approve {
		action = "deny"
		title = "Deny " + approval.Kind
	}
	input := textinput.New()
	input.Placeholder = action + " phrase"
	input.CharLimit = 120
	input.Focus()
	phrase := "APPROVE " + approval.ID
	if !approve {
		phrase = "DENY " + approval.ID
	}
	return &Modal{
		Kind:     "approval",
		Title:    title,
		Body:     approvalBody(approval) + "\n\nType the exact confirmation phrase to continue.",
		Phrase:   phrase,
		Approval: &approval,
		Decision: action,
		Input:    input,
	}
}

func planModalText(response *api.PlanResponse) string {
	if response == nil {
		return "No plan returned."
	}
	var builder strings.Builder
	builder.WriteString(response.PlanSummary + "\n\n")
	if response.Task.Plan != nil {
		plan := response.Task.Plan
		builder.WriteString(fmt.Sprintf("External %s %s · reserve %s %s\n\n", plan.ExternalPlanned, plan.Currency, plan.Contingency, plan.Currency))
		for _, task := range plan.Subtasks {
			builder.WriteString(fmt.Sprintf("%-5s %-36s %-9s %s %s\n", task.ID, truncate(task.Title, 36), task.Execution, task.PlannedMax, plan.Currency))
		}
	}
	if response.Approval != nil {
		builder.WriteString("\nApproval required: " + response.Approval.ID + "\nOpen Security (6) and press Enter on the request.")
	}
	return builder.String()
}

func approvalBody(approval api.Approval) string {
	amount := ""
	if approval.Amount != nil {
		amount = " · " + *approval.Amount + " " + approval.Currency
	}
	return fmt.Sprintf("%s\nKind: %s%s\nExpires: %s\n\n%s", approval.Summary, approval.Kind, amount, approval.ExpiresAt, formatScope(approval.Scope))
}

func formatScope(scope map[string]string) string {
	if len(scope) == 0 {
		return ""
	}
	parts := make([]string, 0, len(scope))
	for key, value := range scope {
		parts = append(parts, key+"="+value)
	}
	return strings.Join(parts, "  ")
}

func agentModal(agent api.Agent) *Modal {
	price := "no live price"
	if agent.Price != nil {
		price = *agent.Price + " " + agent.Currency
	}
	success := "unrated"
	if agent.SuccessRate != nil {
		success = fmt.Sprintf("%.1f%%", *agent.SuccessRate)
	}
	body := fmt.Sprintf("%s\n\n%s\n\nPrice: %s\nRails: %s\nSuccess: %s\nDelivered: %d\nRuntime: %s\nCategory: %s",
		agent.Name, agent.Description, price, strings.Join(agent.PayableWith, "/"), success, agent.DeliveredJobs, ptr(agent.Runtime), ptr(agent.Category))
	return &Modal{Kind: "info", Title: "Agent " + agent.Name, Body: body}
}

func receiptModalText(view *api.ReceiptView) string {
	r := view.Receipt
	vendor := "—"
	if r.Vendor != nil {
		vendor = r.Vendor.Name
	}
	agreed := "—"
	if r.AgreedPrice != nil {
		agreed = *r.AgreedPrice + " " + r.Currency
	}
	check := r.CheckResult.Status
	if r.CheckResult.Passed {
		check = "passed"
	}
	criteria := ""
	for _, result := range r.CheckResult.Criteria {
		mark := "FAIL"
		if result.Passed {
			mark = "PASS"
		}
		criteria += fmt.Sprintf("\n  %s %s — %s", mark, result.Criterion, result.Details)
	}
	return fmt.Sprintf("%s\n\nTask: %s\nSubtask: %s\nStatus: %s\nPayment: %s\nVendor: %s\nAgreed: %s\nPlanned max: %s %s\nJob: %s\n\nVerification: %s — %s%s\n\nSHA-256: %s\nPrevious: %s\nTimestamp: %s\nMode: %s",
		r.Item, r.TaskID, r.SubtaskID, r.Status, r.PaymentStatus, vendor, agreed, r.PlannedMax, r.Currency, ptr(r.MarketplaceJobID), check, r.CheckResult.Details, criteria, r.Hash, r.PreviousHash, r.Timestamp, r.Mode)
}

func ptr(value *string) string {
	if value == nil {
		return "—"
	}
	return *value
}

func successLevel(level string) string {
	if level == "" {
		return "success"
	}
	return level
}

func (m *Model) handleMouse(msg tea.MouseMsg) tea.Cmd {
	if m.modal == nil && m.screen == screenDashboard && (msg.Button == tea.MouseButtonWheelUp || msg.Button == tea.MouseButtonWheelDown) {
		for _, area := range m.hits {
			if area.action != "chat-history" || msg.X < area.x1 || msg.X > area.x2 || msg.Y != area.y {
				continue
			}
			s := m.conversation(m.chatTaskID)
			if msg.Button == tea.MouseButtonWheelUp {
				s.scroll += 3
			} else {
				s.scroll = max(0, s.scroll-3)
			}
			return nil
		}
	}

	if msg.Action == tea.MouseActionPress {
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			return m.scroll(-2)
		case tea.MouseButtonWheelDown:
			return m.scroll(2)
		case tea.MouseButtonLeft:
			if m.modal != nil {
				if m.modal.Kind == "frontend-access" && msg.Y == 3 {
					for _, area := range m.hits {
						if area.action == "frontend" && area.y == msg.Y && msg.X >= area.x1 && msg.X <= area.x2 {
							m.modal = nil
							return m.toggleFrontend()
						}
					}
				}
				for _, area := range m.hits {
					if strings.HasPrefix(area.action, "modal-") && msg.Y == area.y && msg.X >= area.x1 && msg.X <= area.x2 {
						switch area.action {
						case "modal-frontend":
							m.modal = nil
							return m.toggleFrontend()
						case "modal-close":
							m.modal = nil
							return nil
						case "modal-submit":
							return m.submitModal()
						case "modal-up":
							return m.scroll(-3)
						case "modal-down":
							return m.scroll(3)
						}
					}
				}
				if m.modal.Kind == "palette" {
					for _, area := range m.hits {
						if strings.HasPrefix(area.action, "command:") && msg.Y == area.y && msg.X >= area.x1 && msg.X <= area.x2 {
							m.modal = nil
							return m.activate(strings.TrimPrefix(area.action, "command:"))
						}
					}
				}
				if msg.Y >= m.height-4 {
					m.modal = nil
				}
				return nil
			}
			for _, area := range m.hits {
				if msg.Y == area.y && msg.X >= area.x1 && msg.X <= area.x2 {
					return m.activate(area.action)
				}
			}
		}
	}
	return nil
}

func (m *Model) scroll(delta int) tea.Cmd {
	if m.modal != nil {
		if m.modal.Kind == "palette" {
			m.paletteCursor = clamp(m.paletteCursor+delta, 0, max(0, len(m.paletteMatches())-1))
			return nil
		}
		m.modalScroll = max(0, m.modalScroll+delta)
		return nil
	}
	switch m.screen {
	case screenTask:
		m.form.Scroll = max(0, m.form.Scroll+delta)
	case screenDashboard, screenExecution:
		m.graphCursor = clamp(m.graphCursor+delta, 0, max(0, len(graphNodes(m.activeTask()))-1))
	case screenMoney:
		if m.timeline != nil {
			m.moneyCursor = clamp(m.moneyCursor+delta, 0, max(0, len(m.timeline.Entries)-1))
		}
	case screenReplay:
		if m.timeline != nil {
			m.replayCursor = clamp(m.replayCursor+delta, 0, max(0, len(m.timeline.Events)-1))
			m.stopReplay()
		}
	case screenMarket:
		m.agentCursor = clamp(m.agentCursor+delta, 0, max(0, len(m.agents)-1))
	case screenTransactions:
		if m.tx != nil {
			m.txCursor = clamp(m.txCursor+delta, 0, max(0, len(m.tx.Receipts)-1))
		}
	case screenSecurity:
		if m.security != nil {
			m.approvalCursor = clamp(m.approvalCursor+delta, 0, max(0, len(m.security.Approvals)-1))
		}
	}
	return nil
}

func (m *Model) activate(action string) tea.Cmd {
	m.navFocus = -1
	if m.screen == screenTask {
		if strings.HasPrefix(action, "form-focus:") {
			fmt.Sscanf(action, "form-focus:%d", &m.form.Focus)
			m.form.focusInput()
			if m.form.Focus >= 6 && m.form.Focus <= 10 {
				var cmd tea.Cmd
				m.form, cmd = m.form.Update(tea.KeyMsg{Type: tea.KeyEnter})
				return cmd
			}
			return nil
		}
		switch action {
		case "form-advanced":
			m.form.Advanced = !m.form.Advanced
			m.form.Focus = 12
			m.form.Scroll = 0
			if m.form.Advanced {
				m.form.Focus = 2
			}
			m.form.focusInput()
			return nil
		case "form-submit":
			return m.submitForm()
		case "form-cancel":
			m.screen = screenDashboard
			return nil
		}
	}

	if action == "frontend" {
		return m.toggleFrontend()
	}
	if m.screen == screenReplay {
		switch action {
		case "execute", "plan", "pause", "resume", "cancel", "budget":
			m.setStatus("Replay is read-only. Switch screens to act on a task.", "info")
			return nil
		}
	}

	if action == "chat-send" {
		return m.sendChat()
	}
	if action == "matrix" {
		m.matrix = !m.matrix
		return nil
	}
	if action == "inspect" {
		return m.inspectNode()
	}
	if action == "chat" {
		return m.focusChat()
	}
	if action == "chat-history" {
		m.blurChat()
		return nil
	}
	m.blurChat()

	if strings.HasPrefix(action, "node:") {
		fmt.Sscanf(action, "node:%d", &m.graphCursor)
		return m.inspectNode()
	}
	if strings.HasPrefix(action, "money:") && m.timeline != nil {
		fmt.Sscanf(action, "money:%d", &m.moneyCursor)
		if m.moneyCursor >= 0 && m.moneyCursor < len(m.timeline.Entries) {
			e := m.timeline.Entries[m.moneyCursor]
			m.modal = &Modal{Kind: "info", Title: "LEDGER / " + e.Kind, Body: e.At + "\n" + e.Amount + " " + e.Currency + "\n" + e.Reference + "\n\n" + e.Description}
			m.modalScroll = 0
		}
		return nil
	}
	if strings.HasPrefix(action, "event:") {
		fmt.Sscanf(action, "event:%d", &m.replayCursor)
		m.stopReplay()
		return nil
	}
	switch action {
	case "more-actions":
		m.openPalette()
		m.modal.Title = "Actions"
		m.modal.Actions = append(m.modal.Actions, m.moreActions...)
		return nil
	case "palette":
		return m.openPalette()
	case "proof":
		return m.exportProof()
	case "timeline":
		return m.loadTimeline()
	case "money":
		return m.switchScreen(screenMoney)
	case "replay":
		return m.switchScreen(screenReplay)
	case "compare-pin":
		return m.toggleCompare()
	case "compare":
		return m.compareAgents()
	case "replay-play":
		if m.timeline == nil || len(m.timeline.Events) == 0 {
			return nil
		}
		m.replayPlaying = !m.replayPlaying
		m.replayGeneration++
		if m.replayPlaying {
			if m.replayCursor >= len(m.timeline.Events)-1 {
				m.replayCursor = 0
			}
			return m.replayTick()
		}
		return nil
	case "replay-prev":
		m.stopReplay()
		m.replayCursor = max(0, m.replayCursor-1)
		return nil
	case "replay-next":
		m.stopReplay()
		if m.timeline != nil {
			m.replayCursor = min(max(0, len(m.timeline.Events)-1), m.replayCursor+1)
		}
		return nil
	case "replay-home":
		m.stopReplay()
		m.replayCursor = 0
		return nil
	}
	if strings.HasPrefix(action, "tab:") {
		index := 0
		fmt.Sscanf(action, "tab:%d", &index)
		return m.switchScreen(screen(index))
	}
	if strings.HasPrefix(action, "agent:") {
		index := 0
		fmt.Sscanf(action, "agent:%d", &index)
		if index >= 0 && index < len(m.agents) {
			m.agentCursor = index
			m.modal = agentModal(m.agents[index])
		}
		return nil
	}
	if strings.HasPrefix(action, "tx:") {
		index := 0
		fmt.Sscanf(action, "tx:%d", &index)
		if m.tx != nil && index >= 0 && index < len(m.tx.Receipts) {
			m.txCursor = index
			return m.loadReceipt(m.tx.Receipts[index].File)
		}
		return nil
	}
	if strings.HasPrefix(action, "approval:") {
		index := 0
		fmt.Sscanf(action, "approval:%d", &index)
		if m.security != nil && index >= 0 && index < len(m.security.Approvals) {
			m.approvalCursor = index
			m.modal = approvalModal(m.security.Approvals[index], true)
		}
		return nil
	}
	if strings.HasPrefix(action, "deny:") {
		index := 0
		fmt.Sscanf(action, "deny:%d", &index)
		if m.security != nil && index >= 0 && index < len(m.security.Approvals) {
			m.approvalCursor = index
			m.modal = approvalModal(m.security.Approvals[index], false)
		}
		return nil
	}
	if strings.HasPrefix(action, "settings:") {
		index := 0
		fmt.Sscanf(action, "settings:%d", &index)
		m.settingsCursor = clamp(index, 0, len(settingKeys)-1)
		return m.openSettingModal()
	}
	if strings.HasPrefix(action, "activate:") {
		return m.activateTask(strings.TrimPrefix(action, "activate:"))
	}
	if strings.HasPrefix(action, "review:") {
		return m.openReviewModal(strings.TrimPrefix(action, "review:"))
	}
	switch action {
	case "new":
		m.screen = screenTask
		m.form = NewTaskForm(m.width)
		return nil
	case "plan":
		return m.planActive()
	case "execute":
		return m.executeActive()
	case "pause":
		return m.pauseActive()
	case "resume":
		return m.resumeActive()
	case "cancel":
		return m.openCancelModal()
	case "approvals":
		m.screen = screenSecurity
		return m.loadSecurity()
	case "agent-search":
		m.agentFocus = true
		return m.agentQuery.Focus()
	case "market":
		m.screen = screenMarket
		return m.loadAgents("")
	case "transactions":
		m.screen = screenTransactions
		return m.loadTransactions()
	case "settings":
		m.screen = screenSettings
		return m.loadSettings()
	case "budget":
		return m.openBudgetModal()
	case "help":
		m.modal = &Modal{Kind: "help", Title: "Keyboard & mouse", Body: helpText()}
		return nil
	}
	return nil
}

func (m *Model) addHit(y, x1, x2 int, action string) {
	if y < 0 || y >= m.height-2 || x1 >= m.width || x2 < 0 {
		return
	}
	m.hits = append(m.hits, hit{x1: max(0, x1), x2: min(m.width-1, x2), y: y, action: action})
}

func clamp(value, low, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func helpText() string {
	return strings.Join([]string{
		"NAVIGATION",
		"  : / Ctrl+P              search command palette",
		"  I chat · M money · R replay · O export proof",
		"  Chat: Enter send · Alt+Enter newline · Esc controls",
		"  /task brief opens the editable task form",
		"  Graph: ↑/↓ select · Enter inspect · G matrix",
		"  Market: C pin agent · V compare (up to 3)",
		"  1-9 / Tab / Shift+Tab   switch screens (3 market)",
		"  H / L or ← / →          previous / next screen",
		"  F5                      refresh current screen",
		"  ?                       open this help",
		"  Q or Ctrl+C             quit Ash",
		"",
		"TASKS",
		"  N   new task             P   create/refresh plan",
		"  E   execute plan         Space pause/resume execution",
		"  X   cancel task          B   frontend: start / code / close",
		"  Budget changes: Money screen button or : command palette",
		"",
		"MARKET",
		"  /   focus search         Enter inspect selected agent",
		"  J/K or ↑/↓              move selection",
		"",
		"TRANSACTIONS",
		"  J/K or ↑/↓              move through receipts",
		"  Enter                   inspect a receipt",
		"",
		"SECURITY / SETTINGS",
		"  Enter approve or edit    D deny selected approval",
		"  ↑/↓ or J/K              select a row",
		"",
		"MOUSE",
		"  Click tabs, list rows and action buttons.",
		"  Wheel scrolls the execution log or active list.",
	}, "\n")
}
