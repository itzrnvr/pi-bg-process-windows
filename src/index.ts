/*
 * PURPOSE: Robust auto-backgrounding for PI Coding Agent on Windows
 *
 * SHADOWS the built-in Bash tool via pi.registerTool({ name: "bash" }):
 * - Commands run via Git Bash (same as built-in tool)
 * - After timeout, process is backgrounded (not killed) and continues running
 * - Memory-bounded: after backgrounding, streams to log file only
 * - Ctrl+B: manually background currently running foreground process
 * - Completion auto-notifies the LLM via pi.sendMessage()
 * - Stall watchdog: detects (y/n), "Press Enter", "Continue?" prompts
 * - Progress streaming: emits updates via EventBus
 * - Process tree kill via SIGKILL + PowerShell orphan cleanup
 * - AbortSignal support for cancellation
 * - Shutdown-safe: guards against late pi.sendMessage()
 *
 * Tools: win_bg_status (LLM), /win_tasks (user TUI)
 * Events: user_bash (! prefix), session_shutdown (cleanup), session_start (restore)
 */

import type {
  ExtensionAPI,
  UserBashEvent,
  UserBashEventResult,
  BashResult,
} from "@mariozechner/pi-coding-agent";
import * as pi from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, createWriteStream, readdirSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Sync-mode timeout - auto-background after this (milliseconds) */
const SYNC_TIMEOUT_MS = 60_000;

/** Max in-memory buffer before backgrounding (bytes) */
const MAX_BUFFER = 512 * 1024;

/** Temp directory for background process logs */
const BG_TEMP_DIR = path.join(os.tmpdir(), "pi-bg");

/** Stall detection: time without output before checking for interactive prompt */
const STALL_THRESHOLD_MS = 30_000;

/** Patterns indicating process waiting for user input */
const PROMPT_PATTERNS = [
  /\(y\/n\?\)/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
  /password:/i,
  /passphrase:/i,
  /confirm/i,
];

/** Debounce for progress updates (ms) */
const PROGRESS_DEBOUNCE_MS = 2_000;

// ============================================================================
// FORMAT HELPERS
// ============================================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Status icon for process state */
function statusIcon(finished: boolean, exitCode: number | null, stalled: boolean): string {
  if (finished) return exitCode === 0 ? "✓" : "✗";
  if (stalled) return "⚠";
  return "●";
}

// ============================================================================
// TYPES
// ============================================================================

interface BgProcess {
  pid: number;
  command: string;
  logFile: string;
  startedAt: number;
  finished: boolean;
  exitCode: number | null;
  cwd: string;
  lastOutputAt: number;
  lastOutputSize: number;
  isStalled: boolean;
  stallWarningSent: boolean;
  // For delta tracking
  previousOutputHash?: string;
  // Internal: cleanup timers + streams + listeners (set by executeWithTimeout)
  _cleanup?: () => void;
  // Internal: whether completion notification was already sent
  _notified?: boolean;
}

interface PersistedBgState {
  customType: "bgProcessPersisted";
  processes: Array<{
    pid: number;
    command: string;
    logFile: string;
    startedAt: number;
    cwd: string;
  }>;
}

interface ExecResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

interface ActiveForegroundProcess {
  pid: number;
  command: string;
  cwd: string;
  child: ReturnType<typeof spawn>;
  onManualBackground: () => void;
  abortController: AbortController;
}

// ============================================================================
// SCROLLABLE CONTAINER COMPONENT
// Themed, auto-refreshing log viewer for PI's TUI
// ============================================================================

/** Auto-refresh interval for running processes (ms) */
const LIVE_REFRESH_MS = 2_000;

class ScrollableContainer implements pi.Component {
  #lines: string[] = [];
  #scrollTop = 0;
  #visibleHeight = 20;
  #title = "";
  #theme: Theme;
  #tui: pi.TUI;
  #refreshTimer: ReturnType<typeof setInterval> | null = null;

  /** Set by factory — called to close overlay */
  onDone: ((result: undefined) => void) | null = null;
  /** Set by factory — called to kill process */
  onKill: (() => void) | null = null;
  /** Optional: log file path for auto-refresh (live tail) */
  logFile: string | null = null;
  /** Optional: process pid for live status */
  watchPid: number | null = null;

  constructor(lines: string[], title: string, visibleHeight: number, theme: Theme, tui: pi.TUI) {
    this.#lines = lines;
    this.#title = title;
    this.#visibleHeight = visibleHeight;
    this.#theme = theme;
    this.#tui = tui;
  }

  /** Start auto-refresh for live process output */
  startLiveRefresh() {
    if (this.#refreshTimer) return;
    this.#refreshTimer = setInterval(() => {
      if (this.logFile && existsSync(this.logFile)) {
        try {
          const content = readFileSync(this.logFile, "utf-8");
          this.#lines = content.split("\n");
          // Auto-scroll to bottom on new output
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

  private clampScroll() {
    const maxScroll = Math.max(0, this.#lines.length - this.#visibleHeight);
    this.#scrollTop = Math.max(0, Math.min(this.#scrollTop, maxScroll));
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
      return; // no state change
    }
    this.#tui.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const th = this.#theme;
    const w = width;

    // Header with themed border
    if (this.#title) {
      const titleText = this.#title.length > w - 4
        ? this.#title.slice(0, w - 7) + "..."
        : this.#title;
      const padding = w - visibleWidth(titleText) - 4;
      lines.push(th.fg("border", "╭─ ") + th.fg("accent", titleText) + th.fg("border", " " + "─".repeat(Math.max(0, padding)) + "╮"));
    }

    // Visible range
    const startIdx = this.#scrollTop;
    const endIdx = Math.min(startIdx + this.#visibleHeight, this.#lines.length);

    // Render lines with dim border
    for (let i = startIdx; i < endIdx; i++) {
      const line = this.#lines[i] ?? "";
      const innerW = w - 2;
      const truncated = truncateToWidth(line, innerW);
      const padded = truncated + " ".repeat(Math.max(0, innerW - visibleWidth(truncated)));
      lines.push(th.fg("border", "│") + padded.slice(0, innerW) + th.fg("border", "│"));
    }

    // Fill remaining
    const remaining = this.#visibleHeight - (endIdx - startIdx);
    for (let i = 0; i < remaining; i++) {
      lines.push(th.fg("border", "│") + " ".repeat(w - 2) + th.fg("border", "│"));
    }

    // Scroll indicators (like pi-subagents: ↑ N more / ↓ N more)
    const above = this.#scrollTop;
    const below = Math.max(0, this.#lines.length - (this.#scrollTop + this.#visibleHeight));
    const scrollParts: string[] = [];
    if (above > 0) scrollParts.push(`↑ ${above} more`);
    if (below > 0) scrollParts.push(`↓ ${below} more`);
    const scrollInfo = scrollParts.length > 0 ? scrollParts.join("  ") : `${this.#lines.length} lines`;

    // Live indicator for running processes
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

// ============================================================================
// GLOBAL STATE
// ============================================================================

const bgProcesses = new Map<number, BgProcess>();
let activeForegrounds = new Map<number, ActiveForegroundProcess>();

// Shutdown flag — prevents late pi.sendMessage() after teardown
let shuttingDown = false;

// Ensure temp directory exists
try { mkdirSync(BG_TEMP_DIR, { recursive: true }); } catch {}

// ============================================================================
// SHELL RESOLUTION — Use Git Bash (same as built-in tool)
// ============================================================================

let _cachedShell: string | null = null;

function resolveShell(): string {
  if (_cachedShell) return _cachedShell;

  // 1. Git Bash (standard location)
  const gitBash = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
  if (existsSync(gitBash)) { _cachedShell = gitBash; return gitBash; }

  // 2. Git Bash (x86)
  const gitBash86 = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe");
  if (existsSync(gitBash86)) { _cachedShell = gitBash86; return gitBash86; }

  // 3. bash on PATH (Cygwin, MSYS2, etc.)
  try {
    const which = execSync("where bash.exe", { windowsHide: true, encoding: "utf-8", timeout: 3000 }).trim();
    const first = which.split("\n")[0].trim();
    if (first) { _cachedShell = first; return first; }
  } catch {}

  // 4. Last resort — rely on PATH at spawn time
  _cachedShell = "bash";
  return "bash";
}

// ============================================================================
// PATH CONVERSION HELPERS
// ============================================================================

function toGitBashPath(input: string): string {
  // file:///C:/Users/name → /c/Users/name
  const fileUrlMatch = /^file:\/\/\/([a-zA-Z]):\/(.*)$/.exec(input.replace(/\\/g, "/"));
  if (fileUrlMatch) {
    return `/${fileUrlMatch[1].toLowerCase()}/${fileUrlMatch[2]}`;
  }
  // C:\Users\name or C:/Users/name → /c/Users/name
  const winMatch = /^([a-zA-Z]):[\\\/](.*)$/.exec(input);
  if (winMatch) {
    return `/${winMatch[1].toLowerCase()}/${winMatch[2].replace(/\\/g, "/")}`;
  }
  // Already git-bash style or relative
  return input.replace(/\\/g, "/");
}

function toWin32Path(input: string): string {
  // file:///C:/Users/name → C:\Users\name
  const fileUrlMatch = /^file:\/\/\/([a-zA-Z]):\/(.*)$/.exec(input.replace(/\\/g, "/"));
  if (fileUrlMatch) {
    return `${fileUrlMatch[1].toUpperCase()}:\\${fileUrlMatch[2].replace(/\//g, "\\")}`;
  }
  // /c/Users/name → C:\Users\name
  const bashMatch = /^\/([a-zA-Z])\/(.*)$/.exec(input.replace(/\\/g, "/"));
  if (bashMatch) {
    return `${bashMatch[1].toUpperCase()}:\\${bashMatch[2].replace(/\//g, "\\")}`;
  }
  // Already Windows style
  return input.replace(/\//g, "\\");
}

function toFileUrl(input: string): string {
  const win = toWin32Path(input);
  const withSlashes = win.replace(/\\/g, "/");
  const match = /^([a-zA-Z]):\/(.*)$/.exec(withSlashes);
  if (match) {
    return `file:///${match[1].toUpperCase()}:/${match[2]}`;
  }
  // UNC or relative — best effort
  return `file:///${withSlashes.replace(/^\//, "")}`;
}

function convertPath(input: string): { gitBash: string; win32: string; fileUrl: string } {
  const gitBash = toGitBashPath(input);
  const win32 = toWin32Path(input);
  const fileUrl = toFileUrl(input);
  return { gitBash, win32, fileUrl };
}

// ============================================================================
// PROCESS TREE KILL — SIGKILL parent + orphan cleanup via PowerShell
// ============================================================================

function killTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;

  // 1. Kill parent instantly via TerminateProcess (SIGKILL on Windows)
  try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }

  // 2. Find and kill orphaned child processes (fire-and-forget)
  try {
    spawn("powershell.exe", [
      "-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { windowsHide: true, stdio: "ignore", detached: true }).unref();
  } catch { /* best effort */ }
}

// ============================================================================
// HELPERS
// ============================================================================

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function getLogContent(logFile: string, maxChars: number = 5000): string {
  if (!existsSync(logFile)) return "(no log file)";
  try {
    const content = readFileSync(logFile, "utf-8");
    if (content.length <= maxChars) return content || "(empty)";
    return `[...truncated, showing last ${maxChars} chars]\n${content.slice(-maxChars)}`;
  } catch (e: any) {
    return `Error reading log: ${e.message}`;
  }
}

function getLogContentFull(logFile: string): string {
  if (!existsSync(logFile)) return "(no log file)";
  try {
    return readFileSync(logFile, "utf-8") || "(empty)";
  } catch (e: any) {
    return `Error reading log: ${e.message}`;
  }
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/** Check output for interactive prompt patterns */
function detectStall(output: string): boolean {
  return PROMPT_PATTERNS.some(pattern => pattern.test(output));
}

/** Remove finished entries from the map after a delay (PID reuse protection).
 *  Also deletes the log file from disk. */
function scheduleCleanup(pid: number, delayMs: number = 60_000) {
  setTimeout(() => {
    const proc = bgProcesses.get(pid);
    if (proc) {
      try { if (existsSync(proc.logFile)) unlinkSync(proc.logFile); } catch { /* ignore */ }
      bgProcesses.delete(pid); updateFooterBadge();
    }
  }, delayMs);
}

/** Guard against unbounded Map growth */
const MAX_BG_PROCESSES = 50;
function trimBgProcesses() {
  if (bgProcesses.size > MAX_BG_PROCESSES) {
    const finished = [...bgProcesses.entries()]
      .filter(([, p]) => p.finished)
      .sort((a, b) => a[1].startedAt - b[1].startedAt);
    for (const [pid] of finished.slice(0, bgProcesses.size - MAX_BG_PROCESSES)) {
      bgProcesses.delete(pid); updateFooterBadge();
    }
  }
}

// ============================================================================
// EXTENSION
// ============================================================================

export default function (pi: ExtensionAPI) {

  // ==========================================================================
  // SESSION START: Note on restoration
  // ==========================================================================
  // Background processes are NOT restored on session start because:
  // 1. ExtensionAPI does not expose sessionManager.getEntries()
  // 2. PID reuse on Windows makes restoration risky without additional guards
  // 3. Log files may have been cleaned up
  //
  // Persisted state via appendEntry() serves as audit trail only.
  // Agents should use win_bg_status with action "list" to check for any
  // still-running processes from previous sessions.

  // ==========================================================================
  // FOOTER INDICATOR: Show active background process count
  // ==========================================================================
  let requestRender: (() => void) | null = null;
  let footerCtx: any = null;

  function updateFooterBadge() {
    requestRender?.();
  }

  pi.on("session_start", async (_event, ctx) => {
    footerCtx = ctx;
    ctx.ui.setFooter((tui: pi.TUI, theme: any, _footerData: any) => {
      const localRequestRender = () => tui.requestRender();
      requestRender = localRequestRender;

      return {
        dispose() {
          if (requestRender === localRequestRender) requestRender = null;
        },
        invalidate() {},
        render(_width: number): string[] {
          const running = [...bgProcesses.values()].filter(p => !p.finished && isAlive(p.pid)).length;
          const finished = [...bgProcesses.values()].filter(p => p.finished).length;
          if (running === 0 && finished === 0) return []; // No line when nothing happening
          const runningBadge = running > 0 ? theme.fg("accent", `\u23f3 ${running} bg${running > 1 ? "s" : ""}`) : theme.fg("dim", `\u2713 0 bg`);
          const doneBadge = finished > 0 ? theme.fg("dim", ` ${finished} done`) : "";
          return [`${runningBadge}${doneBadge}  ${theme.fg("dim", "/win_tasks to inspect")}`];
        },
      };
    });
  });

  pi.on("session_switch", async (_event, ctx) => {
    footerCtx = ctx;
  });

  // ==========================================================================
  // CTRL+B SHORTCUT: Manually background foreground process
  // ==========================================================================

  pi.registerShortcut("ctrl+b", {
    description: "Background all running foreground processes",
    handler: async (ctx) => {
      if (activeForegrounds.size === 0) {
        ctx.ui.notify("No active foreground processes to background", "warning");
        return;
      }

      const entries = [...activeForegrounds.values()];
      for (const fg of entries) {
        fg.onManualBackground();
      }
      const pids = entries.map(e => e.pid).join(", ");
      ctx.ui.notify(`Backgrounded PID(s): ${pids}`, "info");
    },
  });

  // ==========================================================================
  // BASH TOOL — SHADOWS built-in Bash with auto-backgrounding
  // ==========================================================================

  pi.registerTool({
    name: "bash",
    label: "Bash",
    description: [
      `Execute a shell command via Git Bash on Windows.`,
      `sync: true (default) — blocks up to ${SYNC_TIMEOUT_MS / 1000}s, then auto-backgrounds.`,
      `sync: false — runs in background immediately, returns right away.`,
      `When a backgrounded command finishes, you will be auto-notified with the result.`,
      `Press Ctrl+B to background all running foreground processes.`,
    ].join("\n"),
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
      sync: Type.Optional(Type.Boolean({ description: "true = block until completion or 60s timeout (default). false = run in background immediately." })),
    }),
    async execute(toolCallId, params, signal, _onUpdate) {
      const { command } = params;
      const cwd = params.cwd || process.cwd();
      const sync = params.sync ?? true;

      // Note: _onUpdate is PI's internal callback. Extensions should NOT synthesize
      // ToolExecutionUpdateEvent. We use pi.events.emit() for progress instead.
      return executeWithTimeout(command, cwd, SYNC_TIMEOUT_MS, pi, signal, sync, toolCallId);
    },
  });

  // ==========================================================================
  // user_bash EVENT HOOK — intercept `!` prefix user commands
  // ==========================================================================

  pi.events.on("user_bash", async (event: UserBashEvent): Promise<UserBashEventResult | undefined> => {
    const { command, cwd } = event;
    const result = await executeWithTimeout(command, cwd, SYNC_TIMEOUT_MS, pi, undefined, true);

    const output = result.content.map((c) => c.text).join("");
    const actualExitCode = (result.details?.exitCode as number) ?? (result.isError ? 1 : 0);
    const bashResult: BashResult = {
      output,
      exitCode: actualExitCode,
      cancelled: false,
      truncated: false,
      totalLines: output.split("\n").length,
      totalBytes: output.length,
      outputLines: output.split("\n").length,
      outputBytes: output.length,
    };

    return { result: bashResult };
  });

  // ==========================================================================
  // win_bg_status TOOL — manage backgrounded processes with delta support
  // ==========================================================================

  pi.registerTool({
    name: "win_bg_status",
    label: "Background Status",
    description: "List, view logs, check progress, or stop backgrounded processes. Use 'delta' to get only changed processes since last check (efficient polling).",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("delta"),
        Type.Literal("log"),
        Type.Literal("stop"),
        Type.Literal("progress"),
      ], { description: "list=all processes, delta=only changed since last check, log=view output, stop=kill process, progress=check if running/stalled" }),
      pid: Type.Optional(Type.Number({ description: "PID of the process (required for log/stop/progress)" })),
      lastKnownHash: Type.Optional(Type.String({ description: "For delta action: hash from previous list response" })),
    }),
    async execute(_toolCallId, params) {
      const { action, pid, lastKnownHash } = params;

      // LIST: All processes
      if (action === "list") {
        if (bgProcesses.size === 0) {
          return { content: [{ type: "text", text: "No background processes running." }], details: { hash: "0" } };
        }
        const lines: string[] = [];
        let fullState = "";

        for (const p of bgProcesses.values()) {
          const icon = statusIcon(p.finished, p.exitCode, p.isStalled);
          const status = p.finished
            ? `done (${p.exitCode ?? "?"})`
            : (isAlive(p.pid) ? (p.isStalled ? "STALLED" : "running") : "stopped");
          const elapsed = formatDuration(Date.now() - p.startedAt);
          const lastOutput = formatDuration(Date.now() - p.lastOutputAt);
          const outputSize = p.lastOutputSize > 0 ? ` | ${formatBytes(p.lastOutputSize)}` : "";
          const stallInfo = p.isStalled ? " [PROMPT DETECTED]" : "";
          lines.push(`${icon} PID ${p.pid} | ${status}${stallInfo} | ${elapsed}${outputSize} | last output ${lastOutput} ago\n  Log: ${p.logFile}\n  Cmd: ${p.command.slice(0, 60)}`);
          fullState += `${p.pid}:${status}:${p.lastOutputSize}:`;
        }

        // Limit output to avoid context window blowup
        const maxLines = 10;
        const truncated = lines.length > maxLines;
        const displayLines = truncated ? lines.slice(0, maxLines) : lines;
        const suffix = truncated ? `\n... and ${lines.length - maxLines} more (use win_bg_status log <pid> for details)` : "";
        const hash = hashString(fullState);
        return { content: [{ type: "text", text: displayLines.join("\n\n") + suffix }], details: { hash, count: bgProcesses.size } };
      }

      // DELTA: Only changed processes (efficient polling)
      if (action === "delta") {
        if (bgProcesses.size === 0) {
          return { content: [{ type: "text", text: "No background processes running." }], details: { hash: "0", changed: [] } };
        }

        let fullState = "";
        const changed: BgProcess[] = [];

        for (const p of bgProcesses.values()) {
          const status = p.finished
            ? `finished (exit ${p.exitCode ?? "?"})`
            : (isAlive(p.pid) ? (p.isStalled ? "STALLED" : "running") : "stopped");
          fullState += `${p.pid}:${status}:${p.lastOutputSize}:`;

          // Check if changed from previous hash
          const procHash = hashString(`${p.pid}:${status}:${p.lastOutputSize}`);
          if (procHash !== p.previousOutputHash) {
            changed.push(p);
            p.previousOutputHash = procHash;
          }
        }

        const currentHash = hashString(fullState);

        if (changed.length === 0 && lastKnownHash === currentHash) {
          return { content: [{ type: "text", text: "No changes since last check." }], details: { hash: currentHash, changed: [] } };
        }

        const lines = changed.map(p => {
          const icon = statusIcon(p.finished, p.exitCode, p.isStalled);
          const status = p.finished
            ? `done (${p.exitCode ?? "?"})`
            : (isAlive(p.pid) ? (p.isStalled ? "STALLED" : "running") : "stopped");
          const elapsed = formatDuration(Date.now() - p.startedAt);
          const stallInfo = p.isStalled ? " [PROMPT DETECTED]" : "";
          return `${icon} PID ${p.pid} | ${status}${stallInfo} | ${elapsed} | Cmd: ${p.command.slice(0, 60)}`;
        });

        return { content: [{ type: "text", text: lines.join("\n") || "No changes." }], details: { hash: currentHash, changed: changed.map(p => p.pid) } };
      }

      // PROGRESS: Check if process is making progress
      if (action === "progress") {
        if (!pid) {
          return { content: [{ type: "text", text: "Error: `pid` is required for progress action." }], details: {}, isError: true };
        }

        const proc = bgProcesses.get(pid);
        if (!proc) {
          return { content: [{ type: "text", text: `No process found with PID ${pid}.` }], details: {} };
        }

        const isRunning = isAlive(pid) && !proc.finished;
        const timeSinceOutput = Date.now() - proc.lastOutputAt;
        const isStalled = timeSinceOutput > STALL_THRESHOLD_MS;
        const icon = statusIcon(proc.finished, proc.exitCode, isStalled || proc.isStalled);
        const elapsed = formatDuration(Date.now() - proc.startedAt);
        const outputSize = proc.lastOutputSize > 0 ? ` | ${formatBytes(proc.lastOutputSize)}` : "";

        const status = proc.finished
          ? `done (${proc.exitCode ?? "?"}) in ${elapsed}`
          : (isRunning ? (isStalled ? "STALLED" : `running ${elapsed}${outputSize}`) : "stopped");

        const stallInfo = isStalled ? `\n⚠ No output for ${formatDuration(timeSinceOutput)}. Process may be waiting for input.` : "";
        const promptHint = proc.isStalled ? `\nInteractive prompt detected in output. Use win_bg_status log ${pid} to check.` : "";

        return {
          content: [{ type: "text", text: `${icon} PID ${pid}: ${status}${stallInfo}${promptHint}` }],
          details: {
            pid,
            status,
            isRunning,
            isStalled: isStalled || proc.isStalled,
            timeSinceOutput,
            exitCode: proc.exitCode,
          }
        };
      }

      if (!pid) {
        return { content: [{ type: "text", text: "Error: `pid` is required for log/stop actions." }], details: {}, isError: true };
      }

      const proc = bgProcesses.get(pid);

      if (action === "log") {
        if (!proc) {
          return { content: [{ type: "text", text: `No process found with PID ${pid}.` }], details: {} };
        }
        const content = getLogContent(proc.logFile, 15000);
        const statusLine = proc.finished
          ? `Status: finished (exit ${proc.exitCode ?? "?"})\n`
          : (isAlive(pid) ? (proc.isStalled ? "Status: STALLED (may need input)\n" : "Status: running\n") : "Status: stopped\n");
        return { content: [{ type: "text", text: statusLine + content }], details: {} };
      }

      if (action === "stop") {
        if (!proc) {
          return { content: [{ type: "text", text: `No process found with PID ${pid}.` }], details: {} };
        }
        // Clean up resources before killing
        proc._cleanup?.();
        proc._cleanup = null;
        proc._notified = true; // prevent double notification from close handler
        proc.finished = true; updateFooterBadge();
        killTree(pid);
        bgProcesses.delete(pid); updateFooterBadge();
        return { content: [{ type: "text", text: `Process tree ${pid} terminated.` }], details: {} };
      }

      return { content: [{ type: "text", text: `Unknown action: ${action}` }], details: {}, isError: true };
    },
  });

  // ==========================================================================
  // win_path TOOL — normalize Windows paths across formats
  // ==========================================================================

  pi.registerTool({
    name: "win_path",
    label: "Windows Path",
    description: "Convert a Windows path into Git Bash, Win32, and file:// URL formats all at once. Use this to avoid path conversion round-trips.",
    parameters: Type.Object({
      path: Type.String({ description: "The path to convert (any format: C:\\Users\\name, /c/Users/name, file:///C:/Users/name, or relative)" }),
    }),
    async execute(_toolCallId, params) {
      const { path: inputPath } = params;
      const converted = convertPath(inputPath);
      return {
        content: [{
          type: "text",
          text: `Git Bash:  ${converted.gitBash}\nWin32:     ${converted.win32}\nfile://:   ${converted.fileUrl}`,
        }],
        details: converted,
      };
    },
  });

  // ==========================================================================
  // /win_tasks COMMAND — interactive TUI for task management
  // ==========================================================================

  pi.registerCommand("win_tasks", {
    description: "Interactive background task manager. Usage: /win_tasks or /win_tasks <pid>",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("This command requires a TUI.", "error");
        return;
      }
      const pidArg = (args || "").trim();

      // If PID provided, show that task's details
      if (pidArg && /^\d+$/.test(pidArg)) {
        const pid = parseInt(pidArg, 10);
        const proc = bgProcesses.get(pid);
        if (!proc) {
          ctx.ui.notify(`PID ${pid} not found`, "error");
          return;
        }

        await openLogViewer(proc, pid, ctx);
        return;
      }

      // No PID - show task list selector
      if (bgProcesses.size === 0) {
        ctx.ui.notify("No background tasks running.", "info");
        return;
      }

      const items = [...bgProcesses.values()].map(p => {
        const icon = statusIcon(p.finished, p.exitCode, p.isStalled);
        const elapsed = formatDuration(Date.now() - p.startedAt);
        const outputSize = p.lastOutputSize > 0 ? ` ${formatBytes(p.lastOutputSize)}` : "";
        return {
          label: `${icon} PID ${p.pid} | ${elapsed}${outputSize} | ${p.command.substring(0, 40)}`,
          value: p.pid,
        };
      });

      const selected = await ctx.ui.select(
        "Background Tasks — Enter to view, k to kill",
        items.map(i => i.label),
        { outline: true }
      );

      if (!selected) return;

      const selectedPid = items.find(i => i.label === selected)?.value;
      if (!selectedPid) return;

      const proc = bgProcesses.get(selectedPid);
      if (!proc) return;

      await openLogViewer(proc, selectedPid, ctx);
    },
  });

  /** Shared log viewer with auto-refresh for running processes */
  async function openLogViewer(proc: BgProcess, pid: number, ctx: any) {
    const content = getLogContentFull(proc.logFile);
    const elapsed = formatDuration(Date.now() - proc.startedAt);
    const icon = statusIcon(proc.finished, proc.exitCode, proc.isStalled);
    const status = proc.finished
      ? `Finished (${proc.exitCode ?? "?"}) in ${elapsed}`
      : (isAlive(pid) ? (proc.isStalled ? "STALLED — may need input" : `Running ${elapsed}`) : "Stopped");

    const logLines = content.split("\n");
    const title = `${icon} PID ${pid} | ${status}`;

    await ctx.ui.custom((tui: pi.TUI, theme: Theme, _kb: any, done: (result: undefined) => void) => {
      const scrollable = new ScrollableContainer(logLines, title, Math.min(30, tui.terminal.rows - 6), theme, tui);
      scrollable.onDone = done;
      scrollable.onKill = () => {
        proc._cleanup?.();
        proc._cleanup = null;
        proc._notified = true;
        proc.finished = true; updateFooterBadge();
        killTree(pid);
        bgProcesses.delete(pid); updateFooterBadge();
        done(undefined);
        ctx.ui.notify(`Process ${pid} killed`, "info");
      };

      // Live tail for running processes
      if (!proc.finished && isAlive(pid)) {
        scrollable.logFile = proc.logFile;
        scrollable.watchPid = pid;
        scrollable.startLiveRefresh();
      }

      return scrollable;
    }, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "80%" } as any });
  }

  // ==========================================================================
  // Cleanup on shutdown
  // ==========================================================================

  pi.events.on("session_shutdown", async () => {
    shuttingDown = true;
    for (const [pid, proc] of bgProcesses) {
      if (!proc.finished && isAlive(pid)) {
        proc._cleanup?.();
        proc._cleanup = null;
        proc._notified = true;
        proc.finished = true; updateFooterBadge();
        killTree(pid);
      }
    }
    bgProcesses.clear();
  });
}

// ============================================================================
// EXECUTION WITH TIMEOUT + STALL WATCHDOG + PROGRESS STREAMING
// ============================================================================

async function executeWithTimeout(
  command: string,
  cwd: string,
  timeoutMs: number,
  pi: ExtensionAPI,
  signal?: AbortSignal | undefined,
  sync?: boolean,
  toolCallId?: string,
): Promise<ExecResult> {
  const shell = resolveShell();
  const effectiveSync = sync ?? true;

  return new Promise((resolve) => {
    const spawnTime = Date.now();
    let settled = false;
    let backgrounded = false;
    let memOutput = "";
    let logStream: ReturnType<typeof createWriteStream> | null = null;
    let logFile = "";
    let lastOutputAt = Date.now();
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;

    const abortController = new AbortController();

    const child = spawn(shell, ["-l", "-c", command], {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        CI: "1",
        PAGER: "cat",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        EDITOR: "true",
        VISUAL: "true",
        npm_config_yes: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (child.pid === undefined) {
      resolve({
        content: [{ type: "text", text: `Error: Failed to spawn process (shell: ${shell})` }],
        details: {},
        isError: true,
      });
      return;
    }
    const pid = child.pid;

    // Track as active foreground process (for Ctrl+B)
    const foregroundInfo: ActiveForegroundProcess = {
      pid,
      command,
      cwd,
      child,
      abortController,
      onManualBackground: () => {
        // Ctrl+B pressed - trigger backgrounding
        if (!settled && !backgrounded) {
          doBackgrounding(true);
        }
      }
    };
    activeForegrounds.set(pid, foregroundInfo);

    // Emit event for cross-extension analytics
    try {
      pi.events.emit("bg:process_started", { pid, command, cwd, timestamp: Date.now() });
    } catch { /* ignore */ }

    // AbortSignal handler
    let onAbort: (() => void) | null = null;
    if (signal) {
      onAbort = () => {
        if (settled) return;
        settled = true;
        activeForegrounds.delete(pid);
        clearTimeout(timer);
        if (progressTimer) clearTimeout(progressTimer);
        if (stallTimer) clearTimeout(stallTimer);
        killTree(pid);
        if (logStream) {
          logStream.destroy();
          logStream = null;
        }
        resolve({
          content: [{ type: "text", text: "Command cancelled." }],
          details: {},
          isError: true,
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const removeAbortListener = () => {
      if (onAbort && signal) {
        signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }
    };

    // Progress emission (debounced) - via EventBus only
    // Note: Extensions should NOT synthesize PI's internal ToolExecutionUpdateEvent.
    // Use pi.events.emit() for cross-extension communication.
    const emitProgress = () => {
      if (settled || !backgrounded) return;

      const proc = bgProcesses.get(pid);
      if (proc && !proc.finished && isAlive(pid)) {
        // Emit via EventBus for extensions/analytics
        pi.events.emit("bg:progress", {
          pid,
          elapsed: Date.now() - proc.startedAt,
          outputSize: proc.lastOutputSize,
        });

        // Schedule next progress update
        progressTimer = setTimeout(emitProgress, PROGRESS_DEBOUNCE_MS);
      }
    };

    // Stall detection
    const checkStall = () => {
      if (settled || !backgrounded) return;

      const proc = bgProcesses.get(pid);
      if (!proc || proc.finished) return;

      const timeSinceOutput = Date.now() - proc.lastOutputAt;

      // Check for stall condition
      if (timeSinceOutput > STALL_THRESHOLD_MS) {
        // Check output for interactive prompt
        const recentOutput = getLogContent(proc.logFile, 2000);
        if (detectStall(recentOutput)) {
          proc.isStalled = true;
          if (!proc.stallWarningSent) {
            proc.stallWarningSent = true;
            // Alert agent about stall
            try {
              pi.sendMessage(
                {
                  customType: "bgStallWarning",
                  content: `⚠️ Background process PID ${pid} appears STALLED. Interactive prompt detected in output.\nCommand: ${command.slice(0, 100)}\n\nThe process may be waiting for user input (y/n, password, etc.). Use win_bg_status with action "progress" or "log" to check.`,
                  display: true,
                },
                {
                  triggerTurn: true,
                  deliverAs: "steer", // Interrupt current generation
                }
              );
            } catch { /* ignore */ }
          }
        } else {
          // No output but no prompt detected - might be slow build
          proc.isStalled = true;
        }
      }

      // Continue checking
      stallTimer = setTimeout(checkStall, 10_000);
    };

    // Data handler with stall tracking
    const onData = (d: Buffer, source: "stdout" | "stderr") => {
      const chunk = d.toString();
      lastOutputAt = Date.now();

      if (!backgrounded) {
        memOutput += chunk;
        if (memOutput.length > MAX_BUFFER) {
          memOutput = memOutput.slice(-MAX_BUFFER);
        }
      } else {
        if (logStream) {
          logStream.write(chunk);
        }
        // Update last output tracking
        const proc = bgProcesses.get(pid);
        if (proc) {
          proc.lastOutputAt = Date.now();
          proc.lastOutputSize += chunk.length;
          // Clear stall flag on new output
          if (proc.isStalled) {
            proc.isStalled = false;
          }
        }
      }
    };

    child.stdout?.on("data", (d: Buffer) => onData(d, "stdout"));
    child.stderr?.on("data", (d: Buffer) => onData(d, "stderr"));

    // Backgrounding function
    let timer: ReturnType<typeof setTimeout>;

    const doBackgrounding = (isExplicit: boolean) => {
      if (settled) return;
      settled = true;
      activeForegrounds.delete(pid);
      clearTimeout(timer);

      // Detach so Node doesn't wait for it
      child.unref();

      // Create log file
      logFile = path.join(BG_TEMP_DIR, `bg-${spawnTime}-${pid}.log`);
      try {
        logStream = createWriteStream(logFile, { flags: "w" });
      } catch (err: any) {
        resolve({
          content: [{ type: "text", text: `Error: Cannot create log file at ${logFile}: ${err.message}` }],
          details: {},
          isError: true,
        });
        removeAbortListener();
        return;
      }

      const preview = memOutput.slice(0, 500);
      logStream.write(memOutput);
      memOutput = "";
      backgrounded = true;

      const proc: BgProcess = {
        pid,
        command,
        logFile,
        startedAt: spawnTime,
        finished: false,
        exitCode: null,
        cwd,
        lastOutputAt: Date.now(),
        lastOutputSize: 0,
        isStalled: false,
        stallWarningSent: false,
      };

      // Store cleanup so stop action can release resources
      proc._cleanup = () => {
        if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        if (logStream) { logStream.destroy(); logStream = null; }
        removeAbortListener();
      };

      bgProcesses.set(pid, proc); updateFooterBadge();
      trimBgProcesses();

      // Persist to session so it survives reloads
      try {
        persistBgState(pi);
      } catch { /* ignore */ }

      // Start progress tracking
      progressTimer = setTimeout(emitProgress, PROGRESS_DEBOUNCE_MS);

      // Start stall detection
      stallTimer = setTimeout(checkStall, STALL_THRESHOLD_MS);

      // Listen for completion
      child.on("close", (code) => {
        // Always clean up resources (timers, streams, listeners)
        proc._cleanup?.();
        proc._cleanup = null;

        // If already handled (stop action or prior close), skip notification
        if (proc._notified) return;
        proc._notified = true;
        proc.finished = true; updateFooterBadge();
        proc.exitCode = code;

        scheduleCleanup(pid);

        // Remove from persisted state
        try {
          persistBgState(pi);
        } catch { /* ignore */ }

        // Emit completion event
        try {
          pi.events.emit("bg:process_done", { pid, exitCode: code, command, timestamp: Date.now() });
        } catch { /* ignore */ }

        if (shuttingDown) return;

        // Cap BG_DONE output — model can read the log file for full output
        const output = getLogContent(logFile, 4_000);
        const elapsed = Math.round((Date.now() - spawnTime) / 1000);

        // Notify agent
        try {
          pi.sendMessage(
            {
              customType: "bgProcessDone",
              content: `[BG_DONE] PID ${pid} finished (exit ${code ?? "?"}) in ${elapsed}s\nCommand: ${command.slice(0, 200)}\nLog: ${logFile}\n\n${output}`,
              display: true,
            },
            {
              triggerTurn: true,
              deliverAs: "nextTurn", // Queue for next turn
            }
          );
        } catch { /* session may have shut down */ }
      });

      // Return backgrounding info as the tool result — no separate follow-up message
      const text = isExplicit
        ? `Command running in background (PID: ${pid}). You are unblocked — continue with other work. Output will arrive automatically when done. You can read the output anytime with: read ${logFile.replace(/\\/g, "/")}`
        : `Command still running after ${timeoutMs / 1000}s, moved to background (PID: ${pid}) to keep you unblocked. Continue with other work. Output will arrive automatically when done. You can read the output anytime with: read ${logFile.replace(/\\/g, "/")}`;

      resolve({
        content: [{ type: "text", text }],
        details: { pid, logFile, backgrounded: true },
      });
      removeAbortListener();
    };

    // sync: false — immediate backgrounding
    if (!effectiveSync) {
      doBackgrounding(true);
      return;
    }

    // sync: true — block up to timeout, then auto-background
    timer = setTimeout(() => doBackgrounding(false), timeoutMs);

    // Normal completion (before timeout)
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      activeForegrounds.delete(pid);
      clearTimeout(timer);
      removeAbortListener();

      const output = memOutput.trim();
      const exitInfo = code !== 0 ? `\n[Exit code: ${code}]` : "";

      resolve({
        content: [{ type: "text", text: output + exitInfo }],
        details: { exitCode: code },
        isError: code !== 0,
      });
    });

    // Spawn error
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      activeForegrounds.delete(pid);
      clearTimeout(timer);
      removeAbortListener();

      resolve({
        content: [{ type: "text", text: `Error: ${err.message}` }],
        details: {},
        isError: true,
      });
    });
  });
}

// ============================================================================
// PERSIST STATE TO SESSION
// ============================================================================

// Persist active background process metadata to the session file.
// This is for intra-session recovery (e.g., after extension reload), NOT cross-session —
// all backgrounded processes are killed on session_shutdown.
function persistBgState(pi: ExtensionAPI) {
  const activeProcs = [...bgProcesses.values()]
    .filter(p => !p.finished)
    .map(p => ({
      pid: p.pid,
      command: p.command,
      logFile: p.logFile,
      startedAt: p.startedAt,
      cwd: p.cwd,
    }));

  pi.appendEntry<PersistedBgState>("bgProcessPersisted", {
    customType: "bgProcessPersisted",
    processes: activeProcs,
  });
}
