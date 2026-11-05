import type { Theme } from "./theme.js";
import { stripAnsi } from "../util/strings.js";

export interface BoxOptions {
  tone?: Parameters<Theme["paint"]>[0];
  shadow?: boolean;
  width?: number;
  padding?: number;
}

export function panel(theme: Theme, title: string, lines: string[], options: BoxOptions = {}): string[] {
  const tone = options.tone ?? "cyan";
  const padding = options.padding ?? 1;
  const width = Math.max(36, Math.min(options.width ?? theme.width, theme.width));
  const inner = width - 2;
  const box = theme.unicode
    ? { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", shadow: "░" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", shadow: ":" };
  const titleText = title ? ` ${title} ` : "";
  const topFill = Math.max(0, inner - titleText.length);
  const top = theme.paint(tone, `${box.tl}${titleText}${box.h.repeat(topFill)}${box.tr}`);
  const bottom = theme.paint(tone, `${box.bl}${box.h.repeat(inner)}${box.br}`);
  const side = theme.paint(tone, box.v);
  const output: string[] = [top];
  const contentWidth = inner - padding * 2;
  for (const raw of lines) {
    const plain = stripAnsi(raw);
    const clipped = plain.length > contentWidth ? `${plain.slice(0, Math.max(0, contentWidth - 1))}…` : raw;
    const vis = stripAnsi(clipped).length;
    const pad = " ".repeat(Math.max(0, contentWidth - vis));
    const body = ` ${" ".repeat(padding - 1)}${clipped}${pad}${" ".repeat(padding - 1)} `;
    output.push(`${side}${body}${side}${options.shadow ? theme.dim(box.shadow) : ""}`);
  }
  output.push(bottom);
  if (options.shadow) {
    output.push(theme.dim(` ${box.shadow.repeat(Math.min(width, inner))}`));
  }
  return output;
}

export function table(
  theme: Theme,
  headers: string[],
  rows: string[][],
  options: { maxWidth?: number; tones?: Parameters<Theme["paint"]>[0][] } = {},
): string[] {
  if (headers.length === 0) return [];
  const total = Math.max(30, Math.min(options.maxWidth ?? theme.width - 2, theme.width - 2));
  const bold = headers.map((header) => header.toUpperCase());
  const natural = bold.map((header, index) => {
    const cells = rows.map((row) => stripAnsi(row[index] ?? ""));
    return Math.max(header.length, ...cells.map((cell) => cell.length), 3);
  });
  const gaps = headers.length - 1;
  let widths = [...natural];
  const sum = widths.reduce((a, b) => a + b, 0) + gaps;
  if (sum > total) {
    const scale = (total - gaps) / (sum - gaps);
    widths = widths.map((width) => Math.max(4, Math.floor(width * scale)));
  }
  const fit = (text: string, width: number): string => {
    const plain = stripAnsi(text);
    if (plain.length <= width) return text + " ".repeat(width - plain.length);
    return `${plain.slice(0, Math.max(0, width - 1))}…`;
  };
  const line = (cells: string[]): string =>
    cells
      .map((cell, index) => {
        const tone = options.tones?.[index];
        const fitted = fit(cell, widths[index] ?? 4);
        return tone ? theme.paint(tone, fitted) : fitted;
      })
      .join(" ");
  const out = [line(bold.map((header) => theme.bold(header)))];
  out.push(theme.dim("─".repeat(Math.min(total, widths.reduce((a, b) => a + b, 0) + gaps))));
  for (const row of rows) out.push(line(row.map((cell) => cell ?? "")));
  return out;
}

export function keyValue(
  theme: Theme,
  label: string,
  value: string,
  tone: Parameters<Theme["paint"]>[0] = "white",
): string {
  return `${theme.dim(label.padEnd(18))}${theme.paint(tone, value)}`;
}

export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) lines.push(current);
  return lines;
}
