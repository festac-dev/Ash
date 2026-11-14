package ui

import (
	"context"
	"fmt"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"ash-tui/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

type frontendMsg struct {
	status *api.FrontendStatus
	err    error
	opened bool
}

func (m *Model) toggleFrontend() tea.Cmd {
	if m.Client == nil || m.frontendBusy {
		return nil
	}
	m.frontendBusy = true
	m.setStatus("Checking frontend ON/OFF state…", "info")
	return func() tea.Msg {
		before, err := m.Client.FrontendStatus(m.ctx)
		if err != nil {
			return frontendMsg{err: err}
		}
		return frontendStateMsg{status: before}
	}
}

type frontendObservedMsg struct{ status *api.FrontendStatus }

func (m *Model) observeFrontend() tea.Cmd {
	if m.Client == nil {
		return nil
	}
	return func() tea.Msg {
		status, err := m.Client.FrontendStatus(m.ctx)
		if err != nil {
			return frontendObservedMsg{}
		}
		return frontendObservedMsg{status: status}
	}
}

type frontendStateMsg struct{ status *api.FrontendStatus }

func (m *Model) applyFrontendToggle() tea.Cmd {
	return func() tea.Msg {
		status, err := m.Client.CycleFrontend(m.ctx)
		opened := false
		if err == nil && status.Running && status.Code == "" {
			opened = launchFrontendBrowser(workspaceURL(status.URL))
		}
		return frontendMsg{status: status, err: err, opened: opened}
	}
}

func launchFrontendBrowser(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1") {
		return false
	}
	var command string
	var args []string
	switch runtime.GOOS {
	case "windows":
		command, args = "rundll32", []string{"url.dll,FileProtocolHandler", raw}
	case "darwin":
		command, args = "open", []string{raw}
	default:
		command, args = "xdg-open", []string{raw}
		if termux, err := exec.LookPath("termux-open-url"); err == nil {
			command = termux
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, command, args...).Run() == nil
}

func workspaceURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	u.Path = "/workspace"
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

func frontendMessage(status *api.FrontendStatus, _ bool) string {
	if !status.Running {
		return "Frontend stopped. Access revoked."
	}
	if status.Code != "" {
		return "Access code ready."
	}
	message := fmt.Sprintf("Frontend ON · %s · B generates an access code", strings.TrimRight(status.URL, "/"))
	return message
}

func frontendAccess(status *api.FrontendStatus) string {
	if status == nil {
		return "Frontend status unavailable."
	}
	heading := fmt.Sprintf("Frontend ON · port %d\n%s\n\n", status.Port, workspaceURL(status.URL))
	if status.Code == "" {
		return heading + fmt.Sprintf("ssh -L %d:localhost:%d user@vps\n\nB: Get code · Esc: Back", status.Port, status.Port)
	}
	return heading + fmt.Sprintf("%s\nExpires %s\n\nssh -L %d:localhost:%d user@vps\n\nB: Close frontend · Esc: Back", status.Code, status.ExpiresAt, status.Port, status.Port)
}
