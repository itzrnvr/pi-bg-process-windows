/**
 * executeWithTimeout — core execution with auto-backgrounding, PTY support,
 * and stall detection replaced by "show the agent what's happening" approach.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import * as path from "node:path";
import { SYNC_TIMEOUT_MS, MAX_BUFFER, STALL_THRESHOLD_MS, PROGRESS_DEBOUNCE_MS, PTY_COLS, PTY_ROWS, BG_TEMP_DIR } from "./config";
import type { BgProcess, ExecResult, ActiveForegroundProcess } from "./types";
import { ptyAvailable, ptySpawn, stripAnsi } from "./pty";
import { resolveShell, killTree, ensureBgTempDir, pushToBuffer } from "./helpers";

export const bgProcesses = new Map<number, BgProcess>();
export let activeForegrounds = new Map<number, ActiveForegroundProcess>();
export let shuttingDown = false;

export function setShuttingDown(val: boolean) { shuttingDown = val; }

export async function executeWithTimeout(
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

  // PTY only for sync:false (explicitly backgrounded from start).
  // Regular spawn for foreground — PTY overhead (ConPTY setup, OpenConsole.exe)
  // slows even simple commands, causing false backgrounding.
  const usePty = ptyAvailable && ptySpawn && !effectiveSync;

  if (usePty) {
    return executeWithPty(command, cwd, timeoutMs, pi, shell, signal, effectiveSync, toolCallId);
  }

  // Regular spawn with piped stdio (fast, no overhead)
  return executeWithSpawn(command, cwd, timeoutMs, pi, shell, signal, effectiveSync, toolCallId);
}

// ============================================================================
// PTY EXECUTION — node-pty with ConPTY on Windows
// ============================================================================

async function executeWithPty(
  command: string,
  cwd: string,
  timeoutMs: number,
  pi: ExtensionAPI,
  shell: string,
  signal?: AbortSignal,
  sync?: boolean,
  toolCallId?: string,
): Promise<ExecResult> {
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

    // Spawn via PTY — real terminal, process can receive input
    const ptyProcess = ptySpawn!(shell, ["-l", "-c", command], {
      cwd,
      cols: PTY_COLS,
      rows: PTY_ROWS,
      env: {
        ...process.env,
        CI: "1",
        PAGER: "cat",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        EDITOR: "true",
        VISUAL: "true",
        npm_config_yes: "true",
        TERM: "xterm-256color",
      },
    });

    const pid = ptyProcess.pid as number;

    // Track as active foreground process (for Ctrl+B)
    const foregroundInfo: ActiveForegroundProcess = {
      pid,
      command,
      cwd,
      child: null as any, // PTY doesn't use child_process
      abortController,
      onManualBackground: () => {
        if (!settled && !backgrounded) doBackgrounding(true);
      },
    };
    activeForegrounds.set(pid, foregroundInfo);

    // Emit event for cross-extension analytics
    try { pi.events.emit("bg:process_started", { pid, command, cwd, timestamp: Date.now() }); } catch { /* ignore */ }

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
        try { ptyProcess.kill(); } catch { /* ignore */ }
        if (logStream) { logStream.destroy(); logStream = null; }
        resolve({ content: [{ type: "text", text: "Command cancelled." }], details: {}, isError: true });
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const removeAbortListener = () => {
      if (onAbort && signal) { signal.removeEventListener("abort", onAbort); onAbort = null; }
    };

    // Data handler — PTY gives a single merged stream (no separate stdout/stderr)
    ptyProcess.onData((data: string) => {
      lastOutputAt = Date.now();
      const clean = stripAnsi(data);

      if (!backgrounded) {
        memOutput += clean;
        if (memOutput.length > MAX_BUFFER) memOutput = memOutput.slice(-MAX_BUFFER);
      } else {
        if (logStream) logStream.write(clean);
        const proc = bgProcesses.get(pid);
        if (proc) {
          proc.lastOutputAt = Date.now();
          proc.lastOutputSize += clean.length;
          if (proc.isStalled) proc.isStalled = false;
          // Push lines to rolling buffer
          for (const line of clean.split("\n")) {
            proc.outputBuffer = pushToBuffer(proc.outputBuffer, line);
          }
        }
      }
    });

    // Progress emission (debounced)
    const emitProgress = () => {
      if (settled || !backgrounded) return;
      const proc = bgProcesses.get(pid);
      if (proc && !proc.finished && isAlive(pid)) {
        pi.events.emit("bg:progress", { pid, elapsed: Date.now() - proc.startedAt, outputSize: proc.lastOutputSize });
        progressTimer = setTimeout(emitProgress, PROGRESS_DEBOUNCE_MS);
      }
    };

    // Stall detection — "show, don't tell": surface recent output and let the agent decide
    const checkStall = () => {
      if (settled || !backgrounded) return;
      const proc = bgProcesses.get(pid);
      if (!proc || proc.finished) return;

      const timeSinceOutput = Date.now() - proc.lastOutputAt;
      if (timeSinceOutput > STALL_THRESHOLD_MS && !proc.stallWarningSent) {
        proc.isStalled = true;
        proc.stallWarningSent = true;

        // Show the agent what's on screen — no heuristic guessing
        const recentOutput = proc.outputBuffer.slice(-20).join("\n");
        try {
          pi.sendMessage(
            {
              customType: "bgSilentProcess",
              content: `[BG_SILENT] PID ${pid} — no output for ${Math.round(timeSinceOutput / 1000)}s.\nLast output:\n${recentOutput || "(none)"}\n\nUse win_bg_status peek ${pid} to inspect, or win_bg_status input ${pid} "text" to send input.`,
              display: true,
            },
            { triggerTurn: true, deliverAs: "followUp" }, // Don't interrupt — just queue
          );
        } catch { /* ignore */ }
      }

      stallTimer = setTimeout(checkStall, 10_000);
    };

    function isAlive(pid: number): boolean {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }

    // Backgrounding function
    let timer: ReturnType<typeof setTimeout>;

    const doBackgrounding = (isExplicit: boolean) => {
      if (settled) return;
      settled = true;
      activeForegrounds.delete(pid);
      clearTimeout(timer);

      const tempDir = ensureBgTempDir();
      if (!tempDir) {
        resolve({ content: [{ type: "text", text: `Error: Cannot create background log directory at ${BG_TEMP_DIR}.` }], details: {}, isError: true });
        removeAbortListener();
        return;
      }

      logFile = path.join(tempDir, `bg-${spawnTime}-${pid}.log`);
      try {
        logStream = createWriteStream(logFile, { flags: "w" });
      } catch (err: any) {
        resolve({ content: [{ type: "text", text: `Error: Cannot create log file at ${logFile}: ${err.message}` }], details: {}, isError: true });
        removeAbortListener();
        return;
      }

      logStream.write(memOutput);
      memOutput = "";
      backgrounded = true;

      const proc: BgProcess = {
        pid, command, logFile, startedAt: spawnTime,
        finished: false, exitCode: null, cwd,
        lastOutputAt: Date.now(), lastOutputSize: 0,
        isStalled: false, stallWarningSent: false,
        outputBuffer: [], isPty: true,
        _ptyProcess: ptyProcess,
      };

      proc._cleanup = () => {
        if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        if (logStream) { logStream.destroy(); logStream = null; }
        removeAbortListener();
      };

      bgProcesses.set(pid, proc);

      progressTimer = setTimeout(emitProgress, PROGRESS_DEBOUNCE_MS);
      stallTimer = setTimeout(checkStall, STALL_THRESHOLD_MS);

      // Listen for PTY exit
      ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
        proc._cleanup?.();
        proc._cleanup = null;
        if (proc._notified) return;
        proc._notified = true;
        proc.finished = true;
        proc.exitCode = exitCode;

        const { scheduleCleanup, trimBgProcesses: trim } = require("./helpers");
        scheduleCleanup(bgProcesses, pid);
        trim(bgProcesses);

        try { persistBgState(pi); } catch { /* ignore */ }
        try { pi.events.emit("bg:process_done", { pid, exitCode, command, timestamp: Date.now() }); } catch { /* ignore */ }

        if (shuttingDown) return;

        const { getLogContent } = require("./helpers");
        const output = getLogContent(logFile, 4_000);
        const elapsed = Math.round((Date.now() - spawnTime) / 1000);

        try {
          pi.sendMessage(
            {
              customType: "bgProcessDone",
              content: `[BG_DONE] PID ${pid} finished (exit ${exitCode ?? "?"}) in ${elapsed}s\nCommand: ${command.slice(0, 200)}\nLog: ${logFile}\n\n${output}`,
              display: true,
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        } catch { /* session may have shut down */ }
      });

      const text = isExplicit
        ? `Command running in background (PID: ${pid}, PTY mode). You can peek at output with: win_bg_status peek ${pid}. Send input with: win_bg_status input ${pid} "text". Full log: read ${logFile.replace(/\\/g, "/")}`
        : `Command still running after ${timeoutMs / 1000}s, moved to background (PID: ${pid}, PTY mode). Peek: win_bg_status peek ${pid}. Input: win_bg_status input ${pid} "text". Log: read ${logFile.replace(/\\/g, "/")}`;

      resolve({ content: [{ type: "text", text }], details: { pid, logFile, backgrounded: true, isPty: true } });
      removeAbortListener();
    };

    if (!effectiveSync) { doBackgrounding(true); return; }
    timer = setTimeout(() => doBackgrounding(false), timeoutMs);
  });
}

// ============================================================================
// SPAWN EXECUTION — fallback when PTY unavailable
// ============================================================================

async function executeWithSpawn(
  command: string,
  cwd: string,
  timeoutMs: number,
  pi: ExtensionAPI,
  shell: string,
  signal?: AbortSignal,
  sync?: boolean,
  toolCallId?: string,
): Promise<ExecResult> {
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

    const child = spawn(shell, ["-l", "-c", command], {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        CI: "1", PAGER: "cat", GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0", EDITOR: "true", VISUAL: "true", npm_config_yes: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (child.pid === undefined) {
      resolve({ content: [{ type: "text", text: `Error: Failed to spawn process (shell: ${shell})` }], details: {}, isError: true });
      return;
    }

    const pid = child.pid;

    const foregroundInfo: ActiveForegroundProcess = {
      pid, command, cwd, child,
      abortController: new AbortController(),
      onManualBackground: () => { if (!settled && !backgrounded) doBackgrounding(true); },
    };
    activeForegrounds.set(pid, foregroundInfo);

    try { pi.events.emit("bg:process_started", { pid, command, cwd, timestamp: Date.now() }); } catch { /* ignore */ }

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
        if (logStream) { logStream.destroy(); logStream = null; }
        resolve({ content: [{ type: "text", text: "Command cancelled." }], details: {}, isError: true });
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const removeAbortListener = () => {
      if (onAbort && signal) { signal.removeEventListener("abort", onAbort); onAbort = null; }
    };

    const emitProgress = () => {
      if (settled || !backgrounded) return;
      const proc = bgProcesses.get(pid);
      if (proc && !proc.finished) {
        pi.events.emit("bg:progress", { pid, elapsed: Date.now() - proc.startedAt, outputSize: proc.lastOutputSize });
        progressTimer = setTimeout(emitProgress, PROGRESS_DEBOUNCE_MS);
      }
    };

    // Stall detection — show agent the output, no heuristic guessing
    const checkStall = () => {
      if (settled || !backgrounded) return;
      const proc = bgProcesses.get(pid);
      if (!proc || proc.finished) return;

      const timeSinceOutput = Date.now() - proc.lastOutputAt;
      if (timeSinceOutput > STALL_THRESHOLD_MS && !proc.stallWarningSent) {
        proc.isStalled = true;
        proc.stallWarningSent = true;

        const recentOutput = proc.outputBuffer.slice(-20).join("\n");
        try {
          pi.sendMessage(
            {
              customType: "bgSilentProcess",
              content: `[BG_SILENT] PID ${pid} — no output for ${Math.round(timeSinceOutput / 1000)}s.\nLast output:\n${recentOutput || "(none)"}\n\nUse win_bg_status log ${pid} to check full output.`,
              display: true,
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        } catch { /* ignore */ }
      }
      stallTimer = setTimeout(checkStall, 10_000);
    };

    const onData = (d: Buffer) => {
      const chunk = d.toString();
      lastOutputAt = Date.now();

      if (!backgrounded) {
        memOutput += chunk;
        if (memOutput.length > MAX_BUFFER) memOutput = memOutput.slice(-MAX_BUFFER);
      } else {
        if (logStream) logStream.write(chunk);
        const proc = bgProcesses.get(pid);
        if (proc) {
          proc.lastOutputAt = Date.now();
          proc.lastOutputSize += chunk.length;
          if (proc.isStalled) proc.isStalled = false;
          for (const line of chunk.split("\n")) {
            proc.outputBuffer = pushToBuffer(proc.outputBuffer, line);
          }
        }
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let timer: ReturnType<typeof setTimeout>;

    const doBackgrounding = (isExplicit: boolean) => {
      if (settled) return;
      settled = true;
      activeForegrounds.delete(pid);
      clearTimeout(timer);
      child.unref();

      const tempDir = ensureBgTempDir();
      if (!tempDir) {
        resolve({ content: [{ type: "text", text: `Error: Cannot create background log directory at ${BG_TEMP_DIR}.` }], details: {}, isError: true });
        removeAbortListener();
        return;
      }

      logFile = path.join(tempDir, `bg-${spawnTime}-${pid}.log`);
      try { logStream = createWriteStream(logFile, { flags: "w" }); } catch (err: any) {
        resolve({ content: [{ type: "text", text: `Error: Cannot create log file at ${logFile}: ${err.message}` }], details: {}, isError: true });
        removeAbortListener();
        return;
      }

      logStream.write(memOutput);
      memOutput = "";
      backgrounded = true;

      const proc: BgProcess = {
        pid, command, logFile, startedAt: spawnTime,
        finished: false, exitCode: null, cwd,
        lastOutputAt: Date.now(), lastOutputSize: 0,
        isStalled: false, stallWarningSent: false,
        outputBuffer: [], isPty: false,
      };

      proc._cleanup = () => {
        if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        if (logStream) { logStream.destroy(); logStream = null; }
        removeAbortListener();
      };

      bgProcesses.set(pid, proc);
      const { trimBgProcesses } = require("./helpers");
      trimBgProcesses(bgProcesses);

      progressTimer = setTimeout(emitProgress, PROGRESS_DEBOUNCE_MS);
      stallTimer = setTimeout(checkStall, STALL_THRESHOLD_MS);

      child.on("close", (code) => {
        proc._cleanup?.();
        proc._cleanup = null;
        if (proc._notified) return;
        proc._notified = true;
        proc.finished = true;
        proc.exitCode = code;

        const { scheduleCleanup, trimBgProcesses: trim } = require("./helpers");
        scheduleCleanup(bgProcesses, pid);
        trim(bgProcesses);
        try { persistBgState(pi); } catch { /* ignore */ }
        try { pi.events.emit("bg:process_done", { pid, exitCode: code, command, timestamp: Date.now() }); } catch { /* ignore */ }
        if (shuttingDown) return;

        const { getLogContent } = require("./helpers");
        const output = getLogContent(logFile, 4_000);
        const elapsed = Math.round((Date.now() - spawnTime) / 1000);

        try {
          pi.sendMessage(
            {
              customType: "bgProcessDone",
              content: `[BG_DONE] PID ${pid} finished (exit ${code ?? "?"}) in ${elapsed}s\nCommand: ${command.slice(0, 200)}\nLog: ${logFile}\n\n${output}`,
              display: true,
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        } catch { /* session may have shut down */ }
      });

      const text = isExplicit
        ? `Command running in background (PID: ${pid}). Continue with other work. Log: read ${logFile.replace(/\\/g, "/")}`
        : `Command still running after ${timeoutMs / 1000}s, moved to background (PID: ${pid}). Log: read ${logFile.replace(/\\/g, "/")}`;

      resolve({ content: [{ type: "text", text }], details: { pid, logFile, backgrounded: true, isPty: false } });
      removeAbortListener();
    };

    if (!effectiveSync) { doBackgrounding(true); return; }
    timer = setTimeout(() => doBackgrounding(false), timeoutMs);

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      activeForegrounds.delete(pid);
      clearTimeout(timer);
      removeAbortListener();
      const output = memOutput.trim();
      const exitInfo = code !== 0 ? `\n[Exit code: ${code}]` : "";
      resolve({ content: [{ type: "text", text: output + exitInfo }], details: { exitCode: code }, isError: code !== 0 });
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      activeForegrounds.delete(pid);
      clearTimeout(timer);
      removeAbortListener();
      resolve({ content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true });
    });
  });
}

// ============================================================================
// PERSIST STATE
// ============================================================================

import type { PersistedBgState } from "./types";

function persistBgState(pi: ExtensionAPI) {
  const activeProcs = [...bgProcesses.values()]
    .filter(p => !p.finished)
    .map(p => ({ pid: p.pid, command: p.command, logFile: p.logFile, startedAt: p.startedAt, cwd: p.cwd }));

  pi.appendEntry<PersistedBgState>("bgProcessPersisted", {
    customType: "bgProcessPersisted",
    processes: activeProcs,
  });
}
