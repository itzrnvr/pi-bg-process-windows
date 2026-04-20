# Agent Instructions: pi-bg-process-windows

**Updated:** 2026-04-13 (v3.0 — Claude Code Style)

---

## Architecture (v3.0)

This extension shadows the built-in bash tool with **Claude Code-style** auto-backgrounding:

1. `pi.registerTool({ name: "bash" })` — replaces built-in bash transparently
2. Spawns commands via Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. **15s assistant-mode blocking budget** — if still running, `child.unref()` detaches it
4. **Explicit backgrounding** — model can set `run_in_background: true` to skip the 15s wait
5. After backgrounding: streams to log file only (memory bounded)
6. On completion: `pi.sendMessage()` auto-notifies the LLM
7. `user_bash` event — intercepts `!` prefix commands, returns `BashResult` shape

## Critical Rules

1. **Use Git Bash, NOT PowerShell** — `resolveShell()` finds bash.exe
2. **Kill with SIGKILL, NOT taskkill** — `taskkill` hangs from Node/Bun
3. **Return BashResult from user_bash** — NOT AgentToolResult (causes `textContent.unshift` crash)
4. **pi.sendMessage() uses 2 params** — message + options, not merged
5. **Guard sendMessage with shuttingDown** — prevents crashes during teardown
6. **15s assistant-mode blocking budget** — matches Claude Code behavior (was 10s)
7. **run_in_background parameter** — model can explicitly background immediately
8. **Capture preview BEFORE clearing memOutput** — model sees actual pre-timeout output

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
- **Critical Discoveries:** Document things that caused hangs, crashes, or weird behavior (e.g., `taskkill` hangs).
- **API Notes:** Quirks of the PI Extension API or Windows-specific Node.js behavior.
- **Format:** Always include "Symptom", "Cause", and "Solution".

### 3. `PROJECT.md` (The Technical Blueprint)
**Purpose:** High-level overview of how the extension is built.
- **Architecture:** Keep Mermaid diagrams updated.
- **Design Decisions:** Document *why* we chose certain logic (e.g., Why 10s timeout?).
- **File Structure:** Update if you add new files to `src/`.

### 4. `AGENTS.md` (This File)
**Purpose:** The "SOP" (Standard Operating Procedure) for agents.
- **Critical Rules:** Update if you find a pattern that MUST be followed to avoid failure.
- **Debugging Table:** Add symptoms and fixes as you encounter them.

---

## Key Functions

```
resolveShell()       → finds Git Bash (cached after first call)
killTree(pid)        → process.kill(pid, "SIGKILL") + PowerShell orphan cleanup
executeWithTimeout() → core execution with 15s budget + backgrounding logic
  Parameters: command, cwd, timeoutMs, pi, signal?, runInBackground?
  - runInBackground=true: immediate background, no 15s wait
  - runInBackground=false/undefined: 15s budget then auto-background
```

## pi API Usage

```typescript
// ✅ CORRECT — Auto-background with 15s budget (Claude Code style)
pi.registerTool({
  name: "bash",
  parameters: Type.Object({
    command: Type.String(),
    cwd: Type.Optional(Type.String()),
    run_in_background: Type.Optional(Type.Boolean()), // Explicit immediate background
  }),
  async execute(_id, params, signal) {
    const { command, cwd, run_in_background } = params;
    return executeWithTimeout(command, cwd, ASSISTANT_BLOCKING_BUDGET_MS, pi, signal, run_in_background);
  }
});

// ✅ CORRECT — Explicit immediate background
// Model sets: run_in_background: true
// Result: "Command running in background with PID: X..."

// ✅ CORRECT — Auto-background after 15s budget exceeded
// Model does NOT set run_in_background
// Result: "Command exceeded the assistant-mode blocking budget (15s)..."

pi.registerTool({ name: "win_bg_status", ... });
pi.registerCommand("win_tasks", { ... });
pi.events.on("session_shutdown", async () => { ... });
pi.events.on("user_bash", async (event) => { return { result: bashResult }; });

// ✅ CORRECT sendMessage
pi.sendMessage(
  { customType: "bgProcessDone", content: "...", display: true },
  { triggerTurn: true, deliverAs: "followUp" }
);

// ❌ WRONG — causes textContent.unshift crash
// Returning { content: [{ type: "text", text }], details: {} } from user_bash

// ❌ WRONG — taskkill hangs from Node
// execSync("taskkill /T /F /PID " + pid)
```

## Testing

```bash
bun run test    # standalone tests (no pi needed)
bun run dev     # watch mode
bun run build   # build dist/index.js
```

## Debugging

| Symptom | Cause | Fix |
|---------|-------|-----|
| Extension won't load | Syntax error or missing import | Check `dist/index.js` exists, read startup log |
| `textContent.unshift` crash | user_bash returns wrong shape | Return `BashResult { output, exitCode, ... }` |
| `[undefined]` in UI | sendMessage wrong params | Use 2-parameter form |
| Background process not notifying | shuttingDown guard too early | Check guard is only set in session_shutdown |
| Process survives after kill | taskkill doesn't work from Node | Use `process.kill(pid, "SIGKILL")` |
