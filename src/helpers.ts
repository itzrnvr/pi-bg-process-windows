/**
 * Helpers — shell resolution, path conversion, process management,
 * format utilities, temp directory management.
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { BG_TEMP_DIR, MAX_BG_PROCESSES, OUTPUT_BUFFER_MAX_LINES } from "./config";
import type { BgProcess } from "./types";

// ============================================================================
// FORMAT HELPERS
// ============================================================================

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function statusIcon(finished: boolean, exitCode: number | null, stalled: boolean): string {
  if (finished) return exitCode === 0 ? "✓" : "✗";
  if (stalled) return "⚠";
  return "●";
}

// ============================================================================
// TEMP DIRECTORY
// ============================================================================

/** Lazily ensure temp directory exists. Returns dir path on success, null on failure. */
export function ensureBgTempDir(): string | null {
  if (!existsSync(BG_TEMP_DIR)) {
    try {
      mkdirSync(BG_TEMP_DIR, { recursive: true });
    } catch (err: any) {
      console.error(`[pi-bg] Failed to create temp dir ${BG_TEMP_DIR}: ${err.message}`);
      return null;
    }
  }
  return BG_TEMP_DIR;
}

// ============================================================================
// SHELL RESOLUTION
// ============================================================================

let _cachedShell: string | null = null;

export function resolveShell(): string {
  if (_cachedShell) return _cachedShell;

  const gitBash = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
  if (existsSync(gitBash)) { _cachedShell = gitBash; return gitBash; }

  const gitBash86 = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe");
  if (existsSync(gitBash86)) { _cachedShell = gitBash86; return gitBash86; }

  try {
    const which = execSync("where bash.exe", { windowsHide: true, encoding: "utf-8", timeout: 3000 }).trim();
    const first = which.split("\n")[0].trim();
    if (first) { _cachedShell = first; return first; }
  } catch {}

  _cachedShell = "bash";
  return "bash";
}

// ============================================================================
// PATH CONVERSION
// ============================================================================

export function toGitBashPath(input: string): string {
  const fileUrlMatch = /^file:\/\/\/([a-zA-Z]):\/(.*)$/.exec(input.replace(/\\/g, "/"));
  if (fileUrlMatch) return `/${fileUrlMatch[1].toLowerCase()}/${fileUrlMatch[2]}`;

  const winMatch = /^([a-zA-Z]):[\\\/](.*)$/.exec(input);
  if (winMatch) return `/${winMatch[1].toLowerCase()}/${winMatch[2].replace(/\\/g, "/")}`;

  return input.replace(/\\/g, "/");
}

export function toWin32Path(input: string): string {
  const fileUrlMatch = /^file:\/\/\/([a-zA-Z]):\/(.*)$/.exec(input.replace(/\\/g, "/"));
  if (fileUrlMatch) return `${fileUrlMatch[1].toUpperCase()}:\\${fileUrlMatch[2].replace(/\//g, "\\")}`;

  const bashMatch = /^\/([a-zA-Z])\/(.*)$/.exec(input.replace(/\\/g, "/"));
  if (bashMatch) return `${bashMatch[1].toUpperCase()}:\\${bashMatch[2].replace(/\//g, "\\")}`;

  return input.replace(/\//g, "\\");
}

export function toFileUrl(input: string): string {
  const win = toWin32Path(input);
  const withSlashes = win.replace(/\\/g, "/");
  const match = /^([a-zA-Z]):\/(.*)$/.exec(withSlashes);
  if (match) return `file:///${match[1].toUpperCase()}:/${match[2]}`;
  return `file:///${withSlashes.replace(/^\//, "")}`;
}

export function convertPath(input: string): { gitBash: string; win32: string; fileUrl: string } {
  return { gitBash: toGitBashPath(input), win32: toWin32Path(input), fileUrl: toFileUrl(input) };
}

// ============================================================================
// PROCESS MANAGEMENT
// ============================================================================

export function killTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;

  try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }

  try {
    spawn("powershell.exe", [
      "-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { windowsHide: true, stdio: "ignore", detached: true }).unref();
  } catch { /* best effort */ }
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function getLogContent(logFile: string, maxChars: number = 5000): string {
  if (!existsSync(logFile)) return "(no log file)";
  try {
    const content = readFileSync(logFile, "utf-8");
    if (content.length <= maxChars) return content || "(empty)";
    return `[...truncated, showing last ${maxChars} chars]\n${content.slice(-maxChars)}`;
  } catch (e: any) {
    return `Error reading log: ${e.message}`;
  }
}

export function getLogContentFull(logFile: string): string {
  if (!existsSync(logFile)) return "(no log file)";
  try {
    return readFileSync(logFile, "utf-8") || "(empty)";
  } catch (e: any) {
    return `Error reading log: ${e.message}`;
  }
}

export function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/** Remove finished entries from the map after a delay. Also deletes log file. */
export function scheduleCleanup(bgProcesses: Map<number, BgProcess>, pid: number, delayMs: number = 60_000) {
  setTimeout(() => {
    const proc = bgProcesses.get(pid);
    if (proc) {
      try { if (existsSync(proc.logFile)) unlinkSync(proc.logFile); } catch { /* ignore */ }
      bgProcesses.delete(pid);
    }
  }, delayMs);
}

/** Guard against unbounded Map growth */
export function trimBgProcesses(bgProcesses: Map<number, BgProcess>) {
  if (bgProcesses.size > MAX_BG_PROCESSES) {
    const finished = [...bgProcesses.entries()]
      .filter(([, p]) => p.finished)
      .sort((a, b) => a[1].startedAt - b[1].startedAt);
    for (const [pid] of finished.slice(0, bgProcesses.size - MAX_BG_PROCESSES)) {
      bgProcesses.delete(pid);
    }
  }
}

/** Push a line into a rolling output buffer, capped at OUTPUT_BUFFER_MAX_LINES */
export function pushToBuffer(buffer: string[], line: string): string[] {
  buffer.push(line);
  if (buffer.length > OUTPUT_BUFFER_MAX_LINES) {
    return buffer.slice(buffer.length - OUTPUT_BUFFER_MAX_LINES);
  }
  return buffer;
}
