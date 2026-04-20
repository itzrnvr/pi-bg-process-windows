/**
 * pi-bg-process-windows — Extension entry point
 *
 * Registers tools (bash, win_bg_status, win_path), commands (/win_tasks),
 * shortcuts (Ctrl+Shift+B), and event handlers (session_start, session_shutdown).
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import * as pi from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { SYNC_TIMEOUT_MS } from "./config";
import type { BgProcess } from "./types";
import { ptyAvailable } from "./pty";
import {
  formatDuration, formatBytes, statusIcon, convertPath,
  killTree, isAlive, getLogContent, getLogContentFull, hashString,
  scheduleCleanup, trimBgProcesses,
} from "./helpers";
import { bgProcesses, activeForegrounds, shuttingDown, setShuttingDown, executeWithTimeout } from "./execute";
import { ScrollableContainer } from "./scrollable-container";

export default function (pi: ExtensionAPI) {

  // ==========================================================================
  // FOOTER INDICATOR
  // ==========================================================================
  let requestRender: (() => void) | null = null;

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setFooter((tui: pi.TUI, theme: any, _footerData: any) => {
      const localRequestRender = () => tui.requestRender();
      requestRender = localRequestRender;

      return {
        dispose() { if (requestRender === localRequestRender) requestRender = null; },
        invalidate() {},
        render(_width: number): string[] {
          const running = [...bgProcesses.values()].filter(p => !p.finished && isAlive(p.pid)).length;
          const finished = [...bgProcesses.values()].filter(p => p.finished).length;
          if (running === 0 && finished === 0) return [];
          const ptyTag = ptyAvailable ? theme.fg("dim", " PTY") : "";
          const runningBadge = running > 0 ? theme.fg("accent", `⏳ ${running} bg${running > 1 ? "s" : ""}`) : theme.fg("dim", "✓ 0 bg");
          const doneBadge = finished > 0 ? theme.fg("dim", ` ${finished} done`) : "";
          return [`${runningBadge}${doneBadge}${ptyTag}  ${theme.fg("dim", "/win_tasks")}`];
        },
      };
    });
  });

  // ==========================================================================
  // CTRL+B SHORTCUT
  // ==========================================================================
  pi.registerShortcut("ctrl+shift+b", {
    description: "Background all running foreground processes",
    handler: async (ctx) => {
      if (activeForegrounds.size === 0) {
        ctx.ui.notify("No active foreground processes to background", "warning");
        return;
      }
      const entries = [...activeForegrounds.values()];
      for (const fg of entries) fg.onManualBackground();
      ctx.ui.notify(`Backgrounded PID(s): ${entries.map(e => e.pid).join(", ")}`, "info");
    },
  });

  // ==========================================================================
  // BASH TOOL
  // ==========================================================================
  pi.registerTool({
    name: "bash",
    label: "Bash",
    description: [
      `Execute a shell command via Git Bash on Windows. Auto-backgrounds long-running commands so you stay unblocked.`,
      ``,
      `sync: true (default) — Fast spawn. Blocks up to ${SYNC_TIMEOUT_MS / 1000}s waiting for output. If the command finishes in time, you get the result directly. If it takes longer, it's moved to the background — you can read its log but CANNOT send input to it.`,
      `sync: false — PTY spawn (slightly slower initial start). Runs in the background immediately inside a real terminal. You CAN peek at its output and send input to it via win_bg_status. Use this for commands that might need interaction (sudo, docker login, git push with credentials, install prompts, etc.) or when you explicitly want to run something in the background.`,
      ``,
      `When a backgrounded command finishes, you will be auto-notified with [BG_DONE].`,
      `If a backgrounded process has no output for 30s, you get a [BG_SILENT] message showing recent output so you can decide if it's stalled.`,
      ``,
      `Examples:`,
      `  Quick command:     bash command="echo hello"                              → sync:true, finishes instantly`,
      `  Build:            bash command="npm run build"                           → sync:true, auto-backgrounds if slow`,
      `  May need input:   bash command="sudo apt update" sync=false             → sync:false, PTY mode, can send input`,
      `  Long task:        bash command="docker build -t app ." sync=false        → sync:false, run in background from start`,
    ].join("\n"),
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
      sync: Type.Optional(Type.Boolean({ description: "true = fast spawn, blocks up to 60s then auto-backgrounds (no input capability after backgrounding). false = PTY spawn, runs in background immediately, can peek and send input via win_bg_status. Default: true." })),
    }),
    async execute(toolCallId, params, signal, _onUpdate) {
      const { command } = params;
      const cwd = params.cwd || process.cwd();
      const sync = params.sync ?? true;
      return executeWithTimeout(command, cwd, SYNC_TIMEOUT_MS, pi, signal, sync, toolCallId);
    },
  });

  // ==========================================================================
  // win_bg_status TOOL — with peek/input for PTY mode
  // ==========================================================================
  pi.registerTool({
    name: "win_bg_status",
    label: "Background Status",
    description: [
      `Manage backgrounded processes. Actions:`,
      ``,
      `list — Show all background processes with status, PID, elapsed time, and output size.`,
      `delta — Only show processes that changed since last check (efficient polling). Provide lastKnownHash from previous response.`,
      `log <pid> — Read the full output log (up to 15K chars). Works for all processes.`,
      `peek <pid> — Show the last N lines from a rolling buffer (default 30, max 200). Scroll back with 'offset' parameter. Works for all processes, but most useful for PTY (sync:false) commands where you can see what's on the terminal.`,
      `input <pid> — Send text to the process stdin. PTY (sync:false) processes only. Use \\n for Enter key. This is how you respond to interactive prompts like y/n confirmations, passwords, or selections.`,
      `progress <pid> — Check if a process is running, stalled, or done. Shows time since last output.`,
      `stop <pid> — Kill the process tree (parent + children). Reports if already finished vs actually killed.`,
      ``,
      `When a backgrounded process has no output for 30s, you receive a [BG_SILENT] message with recent output. Use peek to see more, or input to respond if it's a prompt.`,
      ``,
      `Examples:`,
      `  win_bg_status action=list                                    → see all running background tasks`,
      `  win_bg_status action=peek pid=1234                           → see last 30 lines of output`,
      `  win_bg_status action=peek pid=1234 lines=50 offset=30        → scroll back 30 lines, show 50`,
      `  win_bg_status action=input pid=1234 inputText="y\\n"         → send 'y' + Enter to confirm a prompt`,
      `  win_bg_status action=input pid=1234 inputText="my-password\\n" → send password + Enter`,
      `  win_bg_status action=stop pid=1234                           → kill the process`,
    ].join("\n"),
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("delta"),
        Type.Literal("log"),
        Type.Literal("stop"),
        Type.Literal("progress"),
        Type.Literal("peek"),
        Type.Literal("input"),
      ], { description: "list=all, delta=changed only, log=view output, stop=kill, progress=check status, peek=recent terminal output, input=send text to stdin (PTY only)" }),
      pid: Type.Optional(Type.Number({ description: "PID of the process (required for log/stop/progress/peek/input)" })),
      lastKnownHash: Type.Optional(Type.String({ description: "For delta action: hash from previous list response" })),
      inputText: Type.Optional(Type.String({ description: "Text to send to process stdin (for input action). Use \\n for Enter." })),
      lines: Type.Optional(Type.Number({ description: "For peek: how many lines to show (default 30, max 200)" })),
      offset: Type.Optional(Type.Number({ description: "For peek: line offset from the END of the buffer. 0 = most recent (default), 30 = start 30 lines before the end, etc." })),
    }),
    async execute(_toolCallId, params) {
      const { action, pid, lastKnownHash, inputText } = params;

      // PEEK — show recent terminal output (works in both PTY and spawn modes)
      if (action === "peek") {
        if (!pid) return { content: [{ type: "text", text: "Error: `pid` is required for peek action." }], details: {}, isError: true };
        const proc = bgProcesses.get(pid);
        if (!proc) return { content: [{ type: "text", text: `No process found with PID ${pid}.` }], details: {} };

        const lineCount = Math.min(params.lines ?? 30, 200);
        const offsetFromEnd = params.offset ?? 0;
        const buf = proc.outputBuffer;
        // offsetFromEnd=0, lines=30 → show last 30 lines
        // offsetFromEnd=30, lines=30 → show lines 30-60 from end (scroll back)
        const endIdx = Math.max(0, buf.length - offsetFromEnd);
        const startIdx = Math.max(0, endIdx - lineCount);
        const lines = buf.slice(startIdx, endIdx);

        const totalBuffered = buf.length;
        const linesAbove = startIdx;
        const linesBelow = buf.length - endIdx;
        const scrollInfo = linesAbove > 0 ? `↑ ${linesAbove} line${linesAbove > 1 ? 's' : ''} above` : '';
        const belowInfo = linesBelow > 0 ? `↓ ${linesBelow} line${linesBelow > 1 ? 's' : ''} below` : '';
        const scrollHint = [scrollInfo, belowInfo].filter(Boolean).join(' | ') || 'all output shown';

        const elapsed = formatDuration(Date.now() - proc.startedAt);
        const status = proc.finished
          ? `Finished (exit ${proc.exitCode ?? "?"}) in ${elapsed}`
          : (isAlive(pid) ? (proc.isStalled ? `SILENT for ${formatDuration(Date.now() - proc.lastOutputAt)}` : `Running ${elapsed}`) : "Stopped");

        const ptyNote = proc.isPty ? "\nPTY — use win_bg_status input to send text." : "\nSpawn — input not available, use win_bg_status log for full output.";
        const moreNote = linesAbove > 0 ? `\n${linesAbove} more line${linesAbove > 1 ? 's' : ''} above — use peek with offset=${offsetFromEnd + lineCount} to scroll back.` : '';

        const emptyMsg = buf.length === 0
          ? "(no output buffered yet)"
          : "(offset beyond buffer end — reduce offset to see output)";

        return {
          content: [{ type: "text", text: `PID ${pid} | ${status} | ${scrollHint}\n\n${lines.join("\n") || emptyMsg}${ptyNote}${moreNote}` }],
          details: { pid, isPty: proc.isPty, isStalled: proc.isStalled, totalBuffered, linesShown: lines.length, linesAbove, linesBelow },
        };
      }

      // INPUT — send text to PTY process stdin
      if (action === "input") {
        if (!pid) return { content: [{ type: "text", text: "Error: `pid` is required for input action." }], details: {}, isError: true };
        const proc = bgProcesses.get(pid);
        if (!proc) return { content: [{ type: "text", text: `No process found with PID ${pid}.` }], details: {} };
        if (!proc.isPty) return { content: [{ type: "text", text: `PID ${pid} is not in PTY mode — input is only available for PTY processes. Use win_bg_status log ${pid} instead.` }], details: {}, isError: true };
        if (proc.finished) return { content: [{ type: "text", text: `PID ${pid} has already finished.` }], details: {}, isError: true };
        if (inputText === undefined || inputText === null) return { content: [{ type: "text", text: "Error: `inputText` is required for input action." }], details: {}, isError: true };

        const ptyProc = proc._ptyProcess;
        if (!ptyProc) return { content: [{ type: "text", text: `PTY handle not available for PID ${pid}.` }], details: {}, isError: true };

        // Send the text — replace \n literal with actual newline
        const text = inputText.replace(/\\n/g, "\n");
        try {
          ptyProc.write(text);
          // Clear stall flag since we just interacted
          proc.isStalled = false;
          proc.stallWarningSent = false;
          return { content: [{ type: "text", text: `Sent to PID ${pid}: ${inputText.slice(0, 100)}` }], details: {} };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error writing to PID ${pid}: ${err.message}` }], details: {}, isError: true };
        }
      }

      // LIST
      if (action === "list") {
        if (bgProcesses.size === 0) return { content: [{ type: "text", text: "No background processes running." }], details: { hash: "0" } };
        const lines: string[] = [];
        let fullState = "";

        for (const p of bgProcesses.values()) {
          const icon = statusIcon(p.finished, p.exitCode, p.isStalled);
          const status = p.finished
            ? `done (${p.exitCode ?? "?"})`
            : (isAlive(p.pid) ? (p.isStalled ? "SILENT" : "running") : "stopped");
          const elapsed = formatDuration(Date.now() - p.startedAt);
          const lastOutput = formatDuration(Date.now() - p.lastOutputAt);
          const outputSize = p.lastOutputSize > 0 ? ` | ${formatBytes(p.lastOutputSize)}` : "";
          const ptyTag = p.isPty ? " [PTY]" : "";
          lines.push(`${icon} PID ${p.pid} | ${status}${ptyTag} | ${elapsed}${outputSize} | last output ${lastOutput} ago\n  Log: ${p.logFile}\n  Cmd: ${p.command.slice(0, 60)}`);
          fullState += `${p.pid}:${status}:${p.lastOutputSize}:`;
        }

        const maxLines = 10;
        const truncated = lines.length > maxLines;
        const displayLines = truncated ? lines.slice(0, maxLines) : lines;
        const suffix = truncated ? `\n... and ${lines.length - maxLines} more` : "";
        return { content: [{ type: "text", text: displayLines.join("\n\n") + suffix }], details: { hash: hashString(fullState), count: bgProcesses.size } };
      }

      // DELTA
      if (action === "delta") {
        if (bgProcesses.size === 0) return { content: [{ type: "text", text: "No background processes running." }], details: { hash: "0", changed: [] } };
        let fullState = "";
        const changed: BgProcess[] = [];

        for (const p of bgProcesses.values()) {
          const status = p.finished ? `finished (exit ${p.exitCode ?? "?"})` : (isAlive(p.pid) ? (p.isStalled ? "SILENT" : "running") : "stopped");
          fullState += `${p.pid}:${status}:${p.lastOutputSize}:`;
          const procHash = hashString(`${p.pid}:${status}:${p.lastOutputSize}`);
          if (procHash !== p.previousOutputHash) { changed.push(p); p.previousOutputHash = procHash; }
        }

        const currentHash = hashString(fullState);
        if (changed.length === 0 && lastKnownHash === currentHash) return { content: [{ type: "text", text: "No changes since last check." }], details: { hash: currentHash, changed: [] } };

        const lines = changed.map(p => {
          const icon = statusIcon(p.finished, p.exitCode, p.isStalled);
          const status = p.finished ? `done (${p.exitCode ?? "?"})` : (isAlive(p.pid) ? (p.isStalled ? "SILENT" : "running") : "stopped");
          return `${icon} PID ${p.pid} | ${status} | ${formatDuration(Date.now() - p.startedAt)} | Cmd: ${p.command.slice(0, 60)}`;
        });
        return { content: [{ type: "text", text: lines.join("\n") || "No changes." }], details: { hash: currentHash, changed: changed.map(p => p.pid) } };
      }

      // PROGRESS
      if (action === "progress") {
        if (!pid) return { content: [{ type: "text", text: "Error: `pid` is required for progress action." }], details: {}, isError: true };
        const proc = bgProcesses.get(pid);
        if (!proc) return { content: [{ type: "text", text: `No process found with PID ${pid}.` }], details: {} };

        const isRunning = isAlive(pid) && !proc.finished;
        const timeSinceOutput = Date.now() - proc.lastOutputAt;
        const isStalled = timeSinceOutput > SYNC_TIMEOUT_MS / 2;
        const icon = statusIcon(proc.finished, proc.exitCode, isStalled || proc.isStalled);
        const elapsed = formatDuration(Date.now() - proc.startedAt);
        const outputSize = proc.lastOutputSize > 0 ? ` | ${formatBytes(proc.lastOutputSize)}` : "";
        const status = proc.finished ? `done (${proc.exitCode ?? "?"}) in ${elapsed}` : (isRunning ? (isStalled ? `SILENT ${elapsed}${outputSize}` : `running ${elapsed}${outputSize}`) : "stopped");
        const stallInfo = isStalled ? `\nNo output for ${formatDuration(timeSinceOutput)}. ${proc.isPty ? `Use win_bg_status peek ${pid} to inspect, or win_bg_status input ${pid} to send input.` : `Use win_bg_status log ${pid} to check output.`}` : "";

        return { content: [{ type: "text", text: `${icon} PID ${pid}: ${status}${stallInfo}` }], details: { pid, status, isRunning, isStalled: isStalled || proc.isStalled, timeSinceOutput, exitCode: proc.exitCode } };
      }

      if (!pid) return { content: [{ type: "text", text: "Error: `pid` is required for log/stop actions." }], details: {}, isError: true };
      const proc = bgProcesses.get(pid);

      // LOG
      if (action === "log") {
        if (!proc) return { content: [{ type: "text", text: `No process found with PID ${pid}.` }], details: {} };
        const content = getLogContent(proc.logFile, 15000);
        const statusLine = proc.finished ? `Status: finished (exit ${proc.exitCode ?? "?"})\n` : (isAlive(pid) ? (proc.isStalled ? "Status: SILENT (may need input)\n" : "Status: running\n") : "Status: stopped\n");
        return { content: [{ type: "text", text: statusLine + content }], details: {} };
      }

      // STOP
      if (action === "stop") {
        if (!proc) return { content: [{ type: "text", text: `No process found with PID ${pid}.` }], details: {} };
        const alreadyFinished = proc.finished;
        proc._cleanup?.();
        proc._cleanup = null;
        proc._notified = true;
        proc.finished = true;
        killTree(pid);
        bgProcesses.delete(pid);
        const msg = alreadyFinished
          ? `PID ${pid} had already finished (exit ${proc.exitCode ?? "?"}). Cleaned up from tracking.`
          : `Process tree ${pid} terminated.`;
        return { content: [{ type: "text", text: msg }], details: {} };
      }

      return { content: [{ type: "text", text: `Unknown action: ${action}` }], details: {}, isError: true };
    },
  });

  // ==========================================================================
  // win_path TOOL
  // ==========================================================================
  pi.registerTool({
    name: "win_path",
    label: "Windows Path",
    description: "Convert a Windows path into Git Bash, Win32, and file:// URL formats all at once.",
    parameters: Type.Object({
      path: Type.String({ description: "The path to convert (any format)" }),
    }),
    async execute(_toolCallId, params) {
      const converted = convertPath(params.path);
      return { content: [{ type: "text", text: `Git Bash:  ${converted.gitBash}\nWin32:     ${converted.win32}\nfile://:   ${converted.fileUrl}` }], details: converted };
    },
  });

  // ==========================================================================
  // /win_tasks COMMAND
  // ==========================================================================
  pi.registerCommand("win_tasks", {
    description: "Interactive background task manager. Usage: /win_tasks or /win_tasks <pid>",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("This command requires a TUI.", "error"); return; }
      const pidArg = (args || "").trim();

      if (pidArg && /^\d+$/.test(pidArg)) {
        const pid = parseInt(pidArg, 10);
        const proc = bgProcesses.get(pid);
        if (!proc) { ctx.ui.notify(`PID ${pid} not found`, "error"); return; }
        await openLogViewer(proc, pid, ctx);
        return;
      }

      if (bgProcesses.size === 0) { ctx.ui.notify("No background tasks running.", "info"); return; }

      const items = [...bgProcesses.values()].map(p => {
        const icon = statusIcon(p.finished, p.exitCode, p.isStalled);
        const elapsed = formatDuration(Date.now() - p.startedAt);
        const outputSize = p.lastOutputSize > 0 ? ` ${formatBytes(p.lastOutputSize)}` : "";
        const ptyTag = p.isPty ? " PTY" : "";
        return { label: `${icon} PID ${p.pid} | ${elapsed}${outputSize}${ptyTag} | ${p.command.substring(0, 40)}`, value: p.pid };
      });

      const selected = await ctx.ui.select("Background Tasks — Enter to view, k to kill", items.map(i => i.label), { outline: true });
      if (!selected) return;
      const selectedPid = items.find(i => i.label === selected)?.value;
      if (!selectedPid) return;
      const proc = bgProcesses.get(selectedPid);
      if (!proc) return;
      await openLogViewer(proc, selectedPid, ctx);
    },
  });

  async function openLogViewer(proc: BgProcess, pid: number, ctx: any) {
    const content = getLogContentFull(proc.logFile);
    const elapsed = formatDuration(Date.now() - proc.startedAt);
    const icon = statusIcon(proc.finished, proc.exitCode, proc.isStalled);
    const ptyTag = proc.isPty ? " [PTY]" : "";
    const status = proc.finished
      ? `Finished (${proc.exitCode ?? "?"}) in ${elapsed}`
      : (isAlive(pid) ? (proc.isStalled ? `SILENT ${ptyTag}` : `Running ${elapsed}${ptyTag}`) : "Stopped");

    const logLines = content.split("\n");
    const title = `${icon} PID ${pid} | ${status}`;

    await ctx.ui.custom((tui: pi.TUI, theme: Theme, _kb: any, done: (result: undefined) => void) => {
      const scrollable = new ScrollableContainer(logLines, title, Math.min(30, tui.terminal.rows - 6), theme, tui);
      scrollable.onDone = done;
      scrollable.onKill = () => {
        proc._cleanup?.();
        proc._cleanup = null;
        proc._notified = true;
        proc.finished = true;
        killTree(pid);
        bgProcesses.delete(pid);
        done(undefined);
        ctx.ui.notify(`Process ${pid} killed`, "info");
      };

      if (!proc.finished && isAlive(pid)) {
        scrollable.logFile = proc.logFile;
        scrollable.watchPid = pid;
        scrollable.startLiveRefresh();
      }

      return scrollable;
    }, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "80%" } as any });
  }

  // ==========================================================================
  // SHUTDOWN CLEANUP
  // ==========================================================================
  pi.events.on("session_shutdown", async () => {
    setShuttingDown(true);
    for (const [pid, proc] of bgProcesses) {
      if (!proc.finished && isAlive(pid)) {
        proc._cleanup?.();
        proc._cleanup = null;
        proc._notified = true;
        proc.finished = true;
        killTree(pid);
      }
    }
    bgProcesses.clear();
  });
}
