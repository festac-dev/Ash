package main

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"

	"ash-tui/internal/api"
	"ash-tui/internal/ui"
)

var version = "1.1.0"

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Printf("Ash TUI %s\n", version)
		return
	}
	client, err := api.New()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Ash TUI: %v\nStart Ash with `ash` so the launcher can supply the local API URL and session token.\n", err)
		os.Exit(1)
	}
	model := ui.New(client)
	program := tea.NewProgram(
		model,
		tea.WithAltScreen(),
		tea.WithMouseCellMotion(),
	)
	if _, err := program.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Ash TUI stopped: %v\n", err)
		os.Exit(1)
	}
}
