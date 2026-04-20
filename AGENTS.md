# Agent Instructions: pi-bg-process-windows

**Updated:** 2026-04-20 (v4.0 — Modular + PTY)

---

## Architecture (v4.0)

Modular extension with PTY support via node-pty (ConPTY on Windows):

1. `src/config.ts` — Constants (timeouts, buffer sizes, PTY dimensions)
2. `src/types.ts` — Interfaces (BgProcess, ExecResult, ActiveForegroundProcess)
3. `src/pty.ts` — Dynamic node-pty loader with graceful fallback, stripAnsi
4. `src/helpers.ts` — Shell resolution, path conversion, process management, formatting
5. `src/execute.ts` — Core execution: `executeWithPty` + `executeWithSpawn`
6. `src/scrollable-container.ts` — TUI log viewer with live refresh
7. `src/index.ts` — Extension entry point: tools, commands, shortcuts, events

Execution dispatch:
- `sync: true` (default) → `executeWithSpawn` (piped stdio, fast, no input after backgrounding)
- `sync: false` → `executeWithPty` (real terminal, can peek/input anytime)

Notification: `deliverAs: "followUp"` with `triggerTurn: true` — ensures `[BG_DONE]` arrives automatically without waiting for user prompt.

## Critical Rules

1. **Use Git Bash, NOT PowerShell** — `resolveShell()` finds bash.exe
2. **Kill with SIGKILL, NOT taskkill** — `taskkill` hangs from Node/Bun
3. **deliverAs: "followUp" for notifications** — "nextTurn" waits for next user prompt, "followUp" triggers automatically
4. **Guard sendMessage with shuttingDown** — prevents crashes during teardown
5. **60s sync timeout** — matches `SYNC_TIMEOUT_MS` in config.ts
6. **PTY only for sync: false** — PTY overhead (ConPTY setup, OpenConsole.exe) causes false backgrounding on quick commands if used for sync: true
7. **stripAnsi for PTY output** — terminal output contains CSI/OSC sequences; must strip before sending to agent
8. **native/ directory ships node-pty** — must be copied alongside dist/index.js at install time

## Context & Documentation Maintenance (MANDATORY)

Agents are required to maintain the following documentation files. Update them as you work to ensure a zero-knowledge loss handoff.

### 1. `.project-context.md` (The "Live" State)
**Purpose:** Maps the current progress and tells the next agent exactly where you left off.
- **Status:** current phase (e.g., "Testing", "Bug Fixing").
- **Current State:** A 2-3 paragraph summary of the latest architectural state.
- **Task List:** Checkboxes for Completed, In-Progress, and Planned tasks.
- **Handoff:** Explicit instructions for the next agent on the very next step.

### 2. `LEARNINGS.md` (The "Mistake Prevention" Log)
**Purpose:** Stores technical hurdles and obscure fixes to prevent regression.
- **Critical Discoveries:** Document things that caused hangs, crashes, or weird behavior.
- **API Notes:** Quirks of the PI Extension API or Windows-specific Node.js behavior.
- **Format:** Always include "Symptom", "Cause", and "Solution".

### 3. `PROJECT.md` (The Technical Blueprint)
**Purpose:** High-level overview of how the extension is built.
- **Architecture:** Keep diagrams updated.
- **Design Decisions:** Document *why* we chose certain logic.
- **File Structure:** Update if you add new files to `src/`.

### 4. `AGENTS.md` (This File)
**Purpose:** The "SOP" (Standard Operating Procedure) for agents.
- **Critical Rules:** Update if you find a pattern that MUST be followed to avoid failure.
- **Debugging Table:** Add symptoms and fixes as you encounter them.

---

## Key Functions

```
resolveShell()          → finds Git Bash (cached after first call)
killTree(pid)           → process.kill(pid, "SIGKILL") + PowerShell orphan cleanup
executeWithTimeout()    → dispatches to executeWithPty or executeWithSpawn
  Parameters: command, cwd, timeoutMs, pi, signal?, sync?, toolCallId?
  - sync=true: spawn with piped stdio, 60s budget then auto-background
  - sync=false: PTY spawn, immediate background, can peek/input
loadPty()               → dynamic require of native/node-pty, sets NODE_PATH
stripAnsi(str)          → removes CSI, OSC, charset, control chars from PTY output
```

## pi API Usage

```typescript
// ✅ CORRECT — Auto-background with 60s budget
pi.registerTool({
  name: "bash",
  parameters: Type.Object({
    command: Type.String(),
    cwd: Type.Optional(Type.String()),
    sync: Type.Optional(Type.Boolean()),  // true=spawn, false=PTY
  }),
  async execute(toolCallId, params, signal) {
    const { command, cwd, sync } = params;
    return executeWithTimeout(command, cwd, SYNC_TIMEOUT_MS, pi, signal, sync, toolCallId);
  }
});

// ✅ CORRECT — sendMessage with followUp (auto-notifies agent)
pi.sendMessage(
  { customType: "bgProcessDone", content: "...", display: true },
  { triggerTurn: true, deliverAs: "followUp" }
);

// ❌ WRONG — deliverAs: "nextTurn" waits for next user prompt
// { triggerTurn: true, deliverAs: "nextTurn" }  ← BUG: notification never arrives until user types

// ❌ WRONG — taskkill hangs from Node
// execSync("taskkill /T /F /PID " + pid)
```

## Testing

```bash
bun build ./src/index.ts --outdir ./dist --target node   # build
cp dist/index.js ~/.pi/agent/extensions/pi-bg-process-windows/index.js  # install
# Restart pi, then test interactively
```

## Debugging

| Symptom | Cause | Fix |
|---------|-------|-----|
| Extension won't load | Syntax error or missing import | Check `dist/index.js` exists, read startup log |
| [BG_DONE] never arrives | deliverAs: "nextTurn" | Change to deliverAs: "followUp" |
| Process survives after kill | taskkill doesn't work from Node | Use `process.kill(pid, "SIGKILL")` |
| PTY path mangled | Backslash escaping | Both `C:\...\bash.exe` and `C:/.../bash.exe` work — tested |
| PTY not loading | native/ directory missing | Copy native/ alongside dist/index.js |
| Quick commands falsely backgrounded | PTY used for sync: true | Only use PTY for sync: false |
| Stall false positives | Heuristic detection | Replaced with "show output" approach + 30s [BG_SILENT] |
