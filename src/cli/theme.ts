import type { AppConfig } from "../config.js";
import { stripAnsi } from "../util/strings.js";

const PALETTE = {
  matrix: 250,
  green: 114,
  lime: 114,
  mint: 151,
  cyan: 252,
  electric: 250,
  blue: 250,
  purple: 248,
  magenta: 248,
  violet: 248,
  amber: 179,
  orange: 179,
  red: 174,
  crimson: 174,
  white: 255,
  grey: 245,
  dark: 238,
  black: 234,
};

export type Tone = "matrix" | "green" | "cyan" | "blue" | "purple" | "magenta" | "amber" | "red" | "white" | "grey";

const TONE_INDEX: Record<Tone, number> = {
  matrix: PALETTE.matrix,
  green: PALETTE.green,
  cyan: PALETTE.cyan,
  blue: PALETTE.electric,
  purple: PALETTE.purple,
  magenta: PALETTE.magenta,
  amber: PALETTE.amber,
  red: PALETTE.red,
  white: PALETTE.white,
  grey: PALETTE.grey,
};

export class Theme {
  readonly color: boolean;
  readonly unicode: boolean;
  readonly width: number;
  readonly height: number;

  constructor(config: Pick<AppConfig, "colorMode" | "unicodeMode">, stream: NodeJS.WriteStream = process.stdout) {
    const envNoColor = process.env.NO_COLOR !== undefined || process.env.TERM === "dumb";
    this.color = !envNoColor && Boolean(stream.isTTY) && config.colorMode !== "never";
    if (config.unicodeMode === "always") this.unicode = true;
    else if (config.unicodeMode === "never" || process.env.TERM === "dumb") this.unicode = false;
    else {
      const locale =
        `${process.env.LC_ALL ?? ""} ${process.env.LC_CTYPE ?? ""} ${process.env.LANG ?? ""}`.toLowerCase();
      this.unicode =
        process.platform !== "win32" && (!locale.trim() || locale.includes("utf-8") || locale.includes("utf8"));
    }
    this.width = Math.min(120, Math.max(40, stream.columns ?? 80));
    this.height = Math.max(20, stream.rows ?? 30);
  }

  paint(tone: Tone, text: string): string {
    if (!this.color) return text;
    return `\u001b[38;5;${TONE_INDEX[tone]}m${text}\u001b[39m`;
  }

  bold(text: string): string {
    return this.color ? `\u001b[1m${text}\u001b[22m` : text;
  }

  dim(text: string): string {
    return this.color ? `\u001b[2m${text}\u001b[22m` : text;
  }

  bg(tone: Tone, text: string): string {
    if (!this.color) return text;
    return `\u001b[48;5;${TONE_INDEX[tone]}m\u001b[38;5;${PALETTE.black}m${text}\u001b[49m\u001b[39m`;
  }

  gradient(text: string, tones: Tone[] = ["matrix", "green", "cyan", "blue", "purple", "magenta"]): string {
    if (!this.color) return text;
    const chars = [...text];
    return (
      chars
        .map((char, index) => {
          if (char === " ") return char;
          const tone = tones[Math.floor((index / Math.max(1, chars.length)) * tones.length)] ?? tones[0] ?? "green";
          return `\u001b[38;5;${TONE_INDEX[tone]}m${char}`;
        })
        .join("") + "\u001b[39m"
    );
  }

  status(value: string, tone: Tone): string {
    return this.paint(tone, value);
  }

  line(tone: Tone, char = "─"): string {
    return this.paint(tone, char.repeat(this.width));
  }

  symbol(name: "ok" | "fail" | "warn" | "pending" | "bullet" | "arrow" | "tree" | "lastTree"): string {
    if (this.unicode) {
      switch (name) {
        case "ok":
          return "✔";
        case "fail":
          return "✘";
        case "warn":
          return "▲";
        case "pending":
          return "◌";
        case "bullet":
          return "•";
        case "arrow":
          return "❯";
        case "tree":
          return "├─";
        case "lastTree":
          return "└─";
      }
    }
    switch (name) {
      case "ok":
        return "[OK]";
      case "fail":
        return "[X]";
      case "warn":
        return "[!]";
      case "pending":
        return "[ ]";
      case "bullet":
        return "*";
      case "arrow":
        return ">";
      case "tree":
        return "|-";
      case "lastTree":
        return "`-";
    }
  }

  visibleLength(text: string): number {
    return stripAnsi(text).length;
  }
}

export function progressBar(theme: Theme, value: number, total: number, width = 28, tone: Tone = "green"): string {
  const ratio = total <= 0 ? 0 : Math.min(1, Math.max(0, value / total));
  const cells = Math.max(4, width);
  const filled = Math.round(ratio * cells);
  const empty = cells - filled;
  const block = theme.unicode ? "█" : "#";
  const rest = theme.unicode ? "░" : "-";
  return `${theme.paint(tone, block.repeat(filled))}${theme.dim(rest.repeat(empty))} ${Math.round(ratio * 100)
    .toString()
    .padStart(3, " ")}%`;
}
