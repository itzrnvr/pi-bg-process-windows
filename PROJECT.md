# Project Documentation: pi-bg-process-windows

**Version:** 3.0 (Claude Code Style)
**Updated:** 2026-04-13
**Type:** PI Coding Agent Extension

---

## What It Does

Shadows the built-in bash tool with **Claude Code-style** auto-backgrounding on Windows. Commands exceeding the 15s assistant-mode blocking budget are detached (not killed), continue running in the background, and the LLM is auto-notified when they complete.

The model can also explicitly background immediately with `run_in_background: true`, matching Claude Code's behavior.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Extension Entry                        │
│  export default function(pi: ExtensionAPI)                │
│                                                          │
│  ├── pi.registerTool({ name: "bash" })     ← shadows    │
│  ├── pi.events.on("user_bash")             ← ! commands │
│  ├── pi.registerTool({ name: "win_bg_status" })          │
│  ├── pi.registerCommand("win_tasks")                     │
│  └── pi.events.on("session_shutdown")      ← cleanup    │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────┐
│                Core Functions                             │
│                                                          │
│  resolveShell()                                          │
│    └── Git Bash: C:\Program Files\Git\bin\bash.exe       │
│                                                          │
│  killTree(pid)                                           │
│    ├── process.kill(pid, "SIGKILL")  ← instant          │
│    └── PowerShell orphan cleanup      ← async           │
│                                                          │
│  executeWithTimeout(cmd, cwd, budget, pi, signal?, bg?)  │
│    ├── spawn(bash, ["-l", "-c", command])                │
│    ├── run_in_background=true → immediate background    │
│    ├── <15s → return output normally                     │
│    └── >15s → child.unref(), stream to log, auto-notify  │
└──────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### Why Claude Code style (15s + run_in_background)?

Claude Code uses a **15s assistant-mode blocking budget** and an explicit `run_in_background` parameter. This gives the model:
1. A longer grace period (15s vs 10s) for quick commands
2. An explicit escape hatch (`run_in_background: true`) for long-running work
3. Clearer messaging distinguishing auto vs explicit backgrounding

### Why shadow bash instead of a separate tool?

`pi.registerTool({ name: "bash" })` replaces the built-in bash tool. The LLM calls bash normally and any command exceeding the 15s budget gets auto-backgrounded.

### Why SIGKILL instead of taskkill?

`taskkill /T /F /PID` hangs when called from Node/Bun targeting child processes. `process.kill(pid, "SIGKILL")` calls `TerminateProcess` and works instantly. Orphan cleanup runs asynchronously via PowerShell.

### Why stream to log file after backgrounding?

After backgrounding, stdout/stderr go to a `createWriteStream` instead of memory strings. This prevents unbounded memory growth for processes producing megabytes of output.

### Why capture preview BEFORE clearing memOutput?

The preview (first 500 chars of output) must be captured before `memOutput` is cleared and written to the log file. Otherwise the model always sees "(waiting for output...)" even when useful output was produced.

### Why BashResult for user_bash?

The `user_bash` event's `recordBashResult()` expects `{ output, exitCode, ... }`, not `{ content: [...] }`. Returning the wrong shape causes `textContent.unshift is not a function`.

## File Structure

```
pi-bg-process-windows/
├── src/
│   ├── index.ts               ← Extension code (~310 lines)
│   └── test.ts                ← Standalone test harness (8 tests)
├── dist/
│   └── index.js               ← Built output
├── package.json
├── README.md                  ← User-facing overview
├── AGENTS.md                  ← Agent instructions
├── SKILL.md                   ← Usage guide
├── LEARNINGS.md               ← Technical discoveries
├── TESTING-2026-04-11.md      ← Testing documentation
└── PROJECT.md                 ← This file
```

## Configuration

| Constant | Default | Description |
|----------|---------|-------------|
| `ASSISTANT_BLOCKING_BUDGET_MS` | 15,000 | ms before auto-backgrounding (Claude Code style) |
| `MAX_BUFFER` | 512KB | max in-memory output before background |
| `BG_TEMP_DIR` | `%TEMP%\pi-bg` | log file directory |

## Tool Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |
| `cwd` | string | No | Working directory (default: current) |
| `run_in_background` | boolean | No | If true, immediately background without 15s wait |

## Integration Test

After standalone tests pass:

```bash
bun run build
cp dist/index.js ~/.pi/agent/extensions/pi-bg-process-windows/index.js
cp src/index.ts ~/.pi/agent/extensions/pi-bg-process-windows/index.ts
# Restart pi, then:
#   echo hello                    → returns immediately
#   sleep 20                      → backgrounds after 15s, auto-notifies
#   bash with run_in_background   → immediate background
#   /win_tasks                    → shows running process
```
