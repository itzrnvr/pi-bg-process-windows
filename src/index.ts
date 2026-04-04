/*
 * PURPOSE: Windows-first background bash for PI Coding Agent
 *
 * Combines oh-pi's clean auto-backgrounding approach with Windows-native execution:
 * - Commands run synchronously with a configurable timeout
 * - After timeout, process is backgrounded (not killed) and continues running
 * - Completion auto-notified via pi.sendMessage()
 * - bg_status tool for managing background processes
 * - /tasks command for user-facing job management
 *
 * KEY DECISIONS:
 * - Uses PowerShell (not bash) for Windows-native execution
 * - Uses %TEMP%\pi-bg-<timestamp>.log for output (not /tmp/)
 * - 10s default timeout (like oh-pi) — fast enough to not trap the agent
 * - child.unref() keeps process alive after backgrounding
 * - pi.sendMessage() with triggerTurn notifies LLM when done
 *
 * DIFFERENCES FROM oh-pi bg-process:
 * - PowerShell instead of bash
 * - Windows temp paths instead of /tmp/
 * - Retains /tasks command from original implementation
 * - Retains Ctrl+B TUI support for manual backgrounding
 *
 * BUG FIXES:
 * - [2026-04-04] Rewrote from complex TUI Ctrl+B approach to oh-pi's simpler
 *   timeout-based auto-backgrounding. Root cause: TUI approach was incomplete
 *   and unreliable. New approach: set timeout, auto-background, notify on done.
 * - [2026-04-04] Fixed /tmp/ paths breaking on Windows — now uses os.tmpdir()
 *
 * GOTCHAS:
 * - Do NOT use spawn("bash") on Windows — use powershell.exe
 * - Do NOT use /tmp/ paths — use os.tmpdir()
 * - child.unref() is critical — without it, Node waits for process and blocks
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Default timeout before auto-backgrounding (milliseconds) */
const BG_TIMEOUT_MS = 10_000;

/** Temp directory for background process logs */
const BG_TEMP_DIR = path.join(os.tmpdir(), "pi-bg");

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
}

// ============================================================================
// GLOBAL STATE
// ============================================================================

const bgProcesses = new Map<number, BgProcess>();

// Ensure temp directory exists
try { mkdirSync(BG_TEMP_DIR, { recursive: true }); } catch {}

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

/**
 * Execute a command via PowerShell on Windows.
 * Returns stdout + stderr combined.
 */
function runPowerShell(command: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command", command
    ], {
      cwd,
      windowsHide: true,
      env: process.env,
    });

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      resolve({ stdout, stderr, code });
    });

    child.on("error", (err) => {
      resolve({ stdout, stderr: err.message, code: 1 });
    });
  });
}

// ============================================================================
// EXTENSION
// ============================================================================

export default function (pi: ExtensionAPI) {

  // ==========================================================================
  // OVERRIDE: bash tool — auto-background on timeout
  // ==========================================================================

  pi.registerTool({
    name: "bash",
    label: "Bash",
    description: `Execute a shell command via PowerShell (Windows). If a command runs longer than ${BG_TIMEOUT_MS / 1000}s, it is automatically backgrounded and you get the PID + log file path. Use the bg_status tool to check on backgrounded processes.`,
    parameters: Type.Object({
      command: Type.String({ description: "PowerShell command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds before auto-backgrounding (default: 10)" })),
      cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
    }),
    async execute(_toolCallId, params, _signal) {
      const { command } = params;
      const cwd = params.cwd || process.cwd();
      const userTimeout = params.timeout ? params.timeout * 1000 : undefined;
      const effectiveTimeout = userTimeout ?? BG_TIMEOUT_MS;

      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let backgrounded = false;

        const child = spawn("powershell.exe", [
          "-NoProfile",
          "-ExecutionPolicy", "Bypass",
          "-Command", command
        ], {
          cwd,
          windowsHide: true,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        child.stdout?.on("data", (d: Buffer) => {
          const chunk = d.toString();
          stdout += chunk;
          // After backgrounding, append to log file
          if (backgrounded) {
            const proc = bgProcesses.get(child.pid!);
            if (proc) {
              try { appendFileSync(proc.logFile, chunk); } catch {}
            }
          }
        });

        child.stderr?.on("data", (d: Buffer) => {
          const chunk = d.toString();
          stderr += chunk;
          if (backgrounded) {
            const proc = bgProcesses.get(child.pid!);
            if (proc) {
              try { appendFileSync(proc.logFile, chunk); } catch {}
            }
          }
        });

        // Timeout → auto-background
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          backgrounded = true;

          // Detach so Node doesn't wait for it
          child.unref();

          const logFile = path.join(BG_TEMP_DIR, `bg-${Date.now()}-${child.pid}.log`);
          const pid = child.pid!;

          // Write existing output to log
          writeFileSync(logFile, stdout + stderr);

          const proc: BgProcess = {
            pid,
            command,
            logFile,
            startedAt: Date.now(),
            finished: false,
            exitCode: null,
            cwd,
          };
          bgProcesses.set(pid, proc);

          // Listen for completion → auto-notify LLM
          child.on("close", (code) => {
            proc.finished = true;
            proc.exitCode = code;
            const tail = (stdout + stderr).slice(-3000);
            const truncated = (stdout + stderr).length > 3000
              ? "[...truncated]\n" + tail
              : tail;

            // Final output to log
            try { writeFileSync(logFile, stdout + stderr); } catch {}

            // Notify the LLM automatically
            pi.sendMessage(
              {
                customType: "bgProcessDone",
                content: `[BG_PROCESS_DONE] PID ${pid} finished (exit ${code ?? "?"})\nCommand: ${command}\n\nOutput (last 3000 chars):\n${truncated}`,
                display: true,
              },
              {
                triggerTurn: true,
                deliverAs: "followUp",
              }
            );
          });

          const preview = (stdout + stderr).slice(0, 500);
          const text = `Command still running after ${effectiveTimeout / 1000}s, moved to background.\nPID: ${pid}\nLog: ${logFile}\nStop: kill -PID ${pid}\n\nOutput so far:\n${preview}\n\n⏳ You will be notified automatically when it finishes. No need to poll.`;

          resolve({
            content: [{ type: "text", text }],
            details: {},
          });
        }, effectiveTimeout);

        // Normal completion (before timeout)
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          const output = (stdout + stderr).trim();
          const exitInfo = code !== 0 ? `\n[Exit code: ${code}]` : "";

          resolve({
            content: [{ type: "text", text: output + exitInfo }],
            details: {},
          });
        });

        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          resolve({
            content: [{ type: "text", text: `Error: ${err.message}` }],
            details: {},
            isError: true,
          });
        });
      });
    },
  });

  // ==========================================================================
  // bg_status tool — list / view / stop background processes
  // ==========================================================================

  pi.registerTool({
    name: "bg_status",
    label: "Background Process Status",
    description: "Check status, view output, or stop background processes that were auto-backgrounded.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("log"),
        Type.Literal("stop"),
      ], { description: "list=show all, log=view output, stop=kill process" }),
      pid: Type.Optional(Type.Number({ description: "PID of the process (required for log/stop)" })),
    }),
    async execute(_toolCallId, params) {
      const { action, pid } = params;

      if (action === "list") {
        if (bgProcesses.size === 0) {
          return { content: [{ type: "text", text: "No background processes." }], details: {} };
        }
        const lines = [...bgProcesses.values()].map((p) => {
          const status = p.finished
            ? `⚪ stopped (exit ${p.exitCode ?? "?"})`
            : (isAlive(p.pid) ? "🟢 running" : "⚪ stopped");
          const elapsed = Math.round((Date.now() - p.startedAt) / 1000);
          return `PID: ${p.pid} | ${status} | ${elapsed}s | Log: ${p.logFile}\n  Cmd: ${p.command}`;
        });
        return { content: [{ type: "text", text: lines.join("\n\n") }], details: {} };
      }

      if (!pid) {
        return { content: [{ type: "text", text: "Error: pid is required for log/stop" }], details: {}, isError: true };
      }

      const proc = bgProcesses.get(pid);

      if (action === "log") {
        const logFile = proc?.logFile;
        if (logFile && existsSync(logFile)) {
          const content = getLogContent(logFile);
          return { content: [{ type: "text", text: content }], details: {} };
        }
        return { content: [{ type: "text", text: "No log available for this PID." }], details: {} };
      }

      if (action === "stop") {
        try {
          process.kill(pid, "SIGTERM");
          bgProcesses.delete(pid);
          return { content: [{ type: "text", text: `Process ${pid} terminated.` }], details: {} };
        } catch {
          bgProcesses.delete(pid);
          return { content: [{ type: "text", text: `Process ${pid} not found (already stopped?).` }], details: {} };
        }
      }

      return { content: [{ type: "text", text: `Unknown action: ${action}` }], details: {}, isError: true };
    },
  });

  // ==========================================================================
  // /tasks command — user-facing task management
  // ==========================================================================

  pi.registerCommand("tasks", {
    description: "View and manage background tasks. Usage: /tasks [list|output|kill] [pid]",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const subcommand = parts[0] || "list";
      const pidStr = parts[1];

      if (subcommand === "output" && pidStr) {
        const pid = parseInt(pidStr, 10);
        const proc = bgProcesses.get(pid);
        if (proc?.logFile) {
          const content = getLogContent(proc.logFile, 10000);
          ctx.ui?.notify(content.substring(0, 4000), "info", { timeout: 30000 });
        } else {
          ctx.ui?.notify(`No log found for PID ${pidStr}`, "error");
        }
        return;
      }

      if (subcommand === "kill" && pidStr) {
        const pid = parseInt(pidStr, 10);
        try {
          process.kill(pid, "SIGTERM");
          bgProcesses.delete(pid);
          ctx.ui?.notify(`Process ${pid} killed`, "success");
        } catch {
          ctx.ui?.notify(`Process ${pid} not found or already stopped`, "error");
        }
        return;
      }

      // List all jobs
      if (bgProcesses.size === 0) {
        ctx.ui?.notify("No background tasks.", "info");
        return;
      }

      const lines = [...bgProcesses.values()].map((p) => {
        const icon = p.finished ? "⚪" : (isAlive(p.pid) ? "🟢" : "⚪");
        const elapsed = Math.round((Date.now() - p.startedAt) / 1000);
        return `${icon} PID ${p.pid} | ${p.finished ? `exit ${p.exitCode ?? "?"}` : "running"} | ${elapsed}s | ${p.command.substring(0, 40)}`;
      });

      ctx.ui?.notify(
        `Background Tasks:\n${lines.join("\n")}\n\nUse /tasks output <pid> or /tasks kill <pid>`,
        "info",
        { timeout: 15000 }
      );
    },
  });

  // ==========================================================================
  // Cleanup on shutdown
  // ==========================================================================

  pi.on("session_shutdown", async () => {
    for (const [pid, proc] of bgProcesses) {
      if (!proc.finished && isAlive(pid)) {
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
    }
    bgProcesses.clear();
  });
}
