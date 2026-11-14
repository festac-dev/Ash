import type { Theme } from "./theme.js";

export const LOGO_LINES = [
  "   ▄▄▄▄▄    ▄▄▄▄▄▄▄   ▄▄   ▄▄",
  "  ██   ██  ██▀▀▀▀▀   ██   ██",
  "  ███████  ▀██████   ███████",
  "  ██   ██       ██   ██   ██",
  "  ██   ██  ███████   ██   ██",
];

export const ASCII_LOGO_LINES = [
  "   /\\      / ____| |  | |",
  "  /  \\    | (___   |  | |",
  " / /\\ \\    \\___ \\  |  | |",
  "/ ____ \\   ____) | |  | |",
  "/_/    \\_\\ |_____/  |__|_|",
];

export function renderLogo(theme: Theme): string[] {
  return [
    "",
    theme.bold("ASH") + theme.dim("  Task execution & settlement"),
    theme.dim("─".repeat(Math.min(theme.width, 64))),
    "",
  ];
}

export function compactLogo(theme: Theme): string {
  return `${theme.bold("ASH")} ${theme.dim("· TASK EXECUTION & SETTLEMENT")}`;
}
