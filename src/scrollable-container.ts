/**
 * ScrollableContainer — themed, auto-refreshing log viewer for PI's TUI.
 * Supports live tail for running processes, keyboard navigation, and kill action.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import * as pi from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";

const LIVE_REFRESH_MS = 2_000;

export class ScrollableContainer implements pi.Component {
  #lines: string[] = [];
  #scrollTop = 0;
  #visibleHeight = 20;
  #title = "";
  #theme: Theme;
  #tui: pi.TUI;
  #refreshTimer: ReturnType<typeof setInterval> | null = null;

  onDone: ((result: undefined) => void) | null = null;
  onKill: (() => void) | null = null;
  logFile: string | null = null;
  watchPid: number | null = null;

  constructor(lines: string[], title: string, visibleHeight: number, theme: Theme, tui: pi.TUI) {
    this.#lines = lines;
    this.#title = title;
    this.#visibleHeight = visibleHeight;
    this.#theme = theme;
    this.#tui = tui;
  }

  startLiveRefresh() {
    if (this.#refreshTimer) return;
    this.#refreshTimer = setInterval(() => {
      if (this.logFile && existsSync(this.logFile)) {
        try {
          const content = readFileSync(this.logFile, "utf-8");
          this.#lines = content.split("\n");
          this.#scrollTop = Math.max(0, this.#lines.length - this.#visibleHeight);
        } catch { /* ignore */ }
      }
      this.#tui.requestRender();
    }, LIVE_REFRESH_MS);
    this.#refreshTimer.unref?.();
  }

  dispose(): void {
    if (this.#refreshTimer) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = null;
    }
  }

  handleInput(keyData: string): void {
    if (matchesKey(keyData, "escape") || matchesKey(keyData, "q")) {
      this.dispose();
      this.onDone?.(undefined);
      return;
    }
    if (matchesKey(keyData, "k")) {
      this.dispose();
      this.onKill?.();
      return;
    }
    if (matchesKey(keyData, "up")) {
      this.#scrollTop = Math.max(0, this.#scrollTop - 1);
    } else if (matchesKey(keyData, "down")) {
      this.#scrollTop = Math.min(Math.max(0, this.#lines.length - this.#visibleHeight), this.#scrollTop + 1);
    } else if (matchesKey(keyData, "pageup")) {
      this.#scrollTop = Math.max(0, this.#scrollTop - this.#visibleHeight + 2);
    } else if (matchesKey(keyData, "pagedown")) {
      this.#scrollTop = Math.min(Math.max(0, this.#lines.length - this.#visibleHeight), this.#scrollTop + this.#visibleHeight - 2);
    } else if (matchesKey(keyData, "home") || matchesKey(keyData, "g")) {
      this.#scrollTop = 0;
    } else if (matchesKey(keyData, "end") || matchesKey(keyData, "shift+g")) {
      this.#scrollTop = Math.max(0, this.#lines.length - this.#visibleHeight);
    } else {
      return;
    }
    this.#tui.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const th = this.#theme;
    const w = width;

    if (this.#title) {
      const titleText = this.#title.length > w - 4
        ? this.#title.slice(0, w - 7) + "..."
        : this.#title;
      const padding = w - visibleWidth(titleText) - 4;
      lines.push(th.fg("border", "╭─ ") + th.fg("accent", titleText) + th.fg("border", " " + "─".repeat(Math.max(0, padding)) + "╮"));
    }

    const startIdx = this.#scrollTop;
    const endIdx = Math.min(startIdx + this.#visibleHeight, this.#lines.length);

    for (let i = startIdx; i < endIdx; i++) {
      const line = this.#lines[i] ?? "";
      const innerW = w - 2;
      const truncated = truncateToWidth(line, innerW);
      const padded = truncated + " ".repeat(Math.max(0, innerW - visibleWidth(truncated)));
      lines.push(th.fg("border", "│") + padded.slice(0, innerW) + th.fg("border", "│"));
    }

    const remaining = this.#visibleHeight - (endIdx - startIdx);
    for (let i = 0; i < remaining; i++) {
      lines.push(th.fg("border", "│") + " ".repeat(w - 2) + th.fg("border", "│"));
    }

    const above = this.#scrollTop;
    const below = Math.max(0, this.#lines.length - (this.#scrollTop + this.#visibleHeight));
    const scrollParts: string[] = [];
    if (above > 0) scrollParts.push(`↑ ${above} more`);
    if (below > 0) scrollParts.push(`↓ ${below} more`);
    const scrollInfo = scrollParts.length > 0 ? scrollParts.join("  ") : `${this.#lines.length} lines`;

    const isLive = this.#refreshTimer !== null;
    const liveTag = isLive ? th.fg("warning", "● LIVE") + "  " : "";
    const helpText = "[↑↓] Scroll  [PgUp/PgDn] Page  [q] Quit  [k] Kill";

    const footerText = `${liveTag}${scrollInfo}  ${th.fg("dim", helpText)}`;
    const footerInnerW = w - 2;
    const footerPadded = footerText + " ".repeat(Math.max(0, footerInnerW - visibleWidth(footerText)));
    lines.push(th.fg("border", "╰─ ") + footerPadded.slice(0, footerInnerW - 2) + th.fg("border", " ╯"));

    return lines;
  }
}
