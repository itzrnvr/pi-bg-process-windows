# Project Documentation: pi-bg-process-windows

**Version:** 4.0 (Modular + PTY)
**Updated:** 2026-04-20
**Type:** PI Coding Agent Extension

---

## What It Does

Shadows the built-in bash tool with auto-backgrounding on Windows. Two execution modes:

- **sync: true** (default): Fast spawn with piped stdio. Commands exceeding 60s auto-background. No input capability after backgrounding.
- **sync: false**: PTY spawn via node-pty (ConPTY). Runs in a real terminal immediately. Agent can peek at output and send input to interactive processes.

Completion notifications (`[BG_DONE]`) arrive automatically via `deliverAs: "followUp"` — no user prompt needed.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Extension Entry (index.ts)                 │
│  export default function(pi: ExtensionAPI)                    │
│                                                               │
│  ├── pi.registerTool({ name: "bash" })         ← shadows     │
│  ├── pi.registerTool({ name: "win_bg_status" }) ← manage     │
│  ├── pi.registerTool({ name: "win_path" })      ← convert    │
│  ├── pi.registerCommand("win_tasks")            ← user UI    │
│  ├── pi.registerShortcut("ctrl+shift+b")        ← manual BG  │
│  ├── pi.on("session_start")                     ← footer     │
│  └── pi.events.on("session_shutdown")           ← cleanup    │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    execute.ts — Core Execution                │
│                                                               │
│  executeWithTimeout(command, cwd, timeout, pi, signal, sync) │
│    ├── sync=false → executeWithPty                            │
│    │     ├── ptySpawn(shell, args, { cwd, cols, rows, env }) │
│    │     ├── onData → stripAnsi → pushToBuffer + log         │
│    │     ├── onExit → [BG_DONE] via sendMessage              │
│    │     └── immediate background, peek/input available      │
│    │                                                          │
│    └── sync=true → executeWithSpawn                           │
│          ├── spawn(bash, ["-l", "-c", command])               │
│          ├── <60s → return output normally                    │
│          └── >60s → auto-background, stream to log file       │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Supporting Modules                          │
│                                                               │
│  pty.ts        → loadPty(), stripAnsi()                      │
│  helpers.ts    → resolveShell(), killTree(), path conversion  │
│  config.ts     → SYNC_TIMEOUT_MS=60000, PTY_COLS=120, etc.  │
│  types.ts      → BgProcess, ExecResult, ActiveForeground     │
│  scrollable-container.ts → TUI log viewer                    │
└─────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### Why two execution modes (sync vs PTY)?

PTY has overhead — ConPTY setup, OpenConsole.exe process, terminal initialization. Using it for quick commands causes false auto-backgrounding. Spawn with piped stdio is fast for normal commands. PTY is only needed for interactive processes.

### Why deliverAs: "followUp" instead of "nextTurn"?

`deliverAs: "nextTurn"` pushes to `_pendingNextTurnMessages`, which only get injected when the user sends their next prompt. `deliverAs: "followUp"` calls `this.agent.followUp()` when streaming or `this.agent.prompt()` when idle — both trigger the agent automatically. This is critical for `[BG_DONE]` notifications.

### Why node-pty instead of itmux/tmux?

itmux bundles a Cygwin-based tmux. On Windows, Cygwin paths and environment differ from the host, causing path resolution issues. node-pty uses Windows native ConPTY API (same as VS Code terminal), preserving the same paths, environment, and output.

### Why ship native/ instead of npm install?

node-pty requires native addon compilation (node-gyp). In monorepos with lockfiles, `npm install node-pty` frequently hangs during `node-gyp rebuild`. Shipping the prebuilt binaries in `native/` alongside the extension avoids this entirely.

### Why "show output" instead of heuristic stall detection?

Heuristics produced false positives: docker build `:` line endings, cargo build silent periods, git clone pack phase. Instead, after 30s with no output, the agent receives `[BG_SILENT]` with the recent output shown, and can decide for itself whether the process is stalled.

### Why stream to log file after backgrounding?

After backgrounding, stdout/stderr go to a `createWriteStream` instead of memory strings. This prevents unbounded memory growth for processes producing megabytes of output.

### Why SIGKILL instead of taskkill?

`taskkill /T /F /PID` hangs when called from Node/Bun targeting child processes. `process.kill(pid, "SIGKILL")` calls `TerminateProcess` and works instantly. Orphan cleanup runs asynchronously via PowerShell.

## File Structure

```
pi-bg-process-windows/
├── src/
│   ├── index.ts               ← Extension entry point (~600 lines)
│   ├── execute.ts             ← Core execution logic (~550 lines)
│   ├── pty.ts                 ← PTY loader + stripAnsi (~100 lines)
│   ├── helpers.ts             ← Utilities (~200 lines)
│   ├── config.ts              ← Constants (~30 lines)
│   ├── types.ts               ← Interfaces (~50 lines)
│   └── scrollable-container.ts ← TUI log viewer (~130 lines)
├── dist/
│   └── index.js               ← Built output (bundled)
├── native/                    ← node-pty with prebuilt binaries (not in git)
├── package.json
├── .gitignore
├── README.md
├── AGENTS.md
├── SKILL.md
├── LEARNINGS.md
├── TESTING-2026-04-11.md
├── PROJECT.md                 ← This file
└── .project-context.md
```

## Configuration

| Constant | Default | Description |
|----------|---------|-------------|
| `SYNC_TIMEOUT_MS` | 60,000 | ms before auto-backgrounding for sync: true |
| `MAX_BUFFER` | 512KB | max in-memory output before background |
| `BG_TEMP_DIR` | `%TEMP%\pi-bg` | log file directory |
| `STALL_THRESHOLD_MS` | 30,000 | ms before [BG_SILENT] notification |
| `PROGRESS_DEBOUNCE_MS` | 2,000 | ms between progress emissions |
| `MAX_BG_PROCESSES` | 50 | max entries in bgProcesses map |
| `OUTPUT_BUFFER_MAX_LINES` | 500 | rolling buffer size for peek |
| `PTY_COLS` | 120 | PTY terminal columns |
| `PTY_ROWS` | 40 | PTY terminal rows |

## Tool Parameters

### bash

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |
| `cwd` | string | No | Working directory (default: current) |
| `sync` | boolean | No | true=spawn (default), false=PTY |

### win_bg_status

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | list, delta, log, stop, progress, peek, input |
| `pid` | number | Conditional | Required for log/stop/progress/peek/input |
| `lastKnownHash` | string | No | For delta action |
| `inputText` | string | Conditional | Required for input action |
| `lines` | number | No | For peek: lines to show (default 30, max 200) |
| `offset` | number | No | For peek: offset from end (0=most recent) |
