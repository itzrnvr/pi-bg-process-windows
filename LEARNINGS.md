# Project Learnings: pi-bg-process-windows

**Created:** 2026-04-03
**Last Updated:** 2026-04-13 (v3.0 — Claude Code Style)

---

## Critical Discoveries

### 1. Platform-Specific Command Blindness (Windows/Node)

**Symptom:** Agent repeatedly tried `taskkill /F /IM` to reset environment. Terminal hung, orphans left behind, agent got "stuck" in non-responsive state.

**Cause:** Windows process management is fundamentally different from Unix:
- `taskkill /T /F /PID` **hangs** when called from Node/Bun targeting child processes (ETIMEDOUT)
- `taskkill /F /IM` (by image name) is blunt-force and unreliable for Node processes
- Orphan processes survive parent death on Windows (unlike Unix SIGTERM cascade)
- PowerShell `Stop-Process` has different behavior than `taskkill`

**Solution:** Implement surgical process management in extension code:
```typescript
// 1. SIGKILL the parent instantly (works from Node)
process.kill(pid, "SIGKILL");

// 2. Spawn detached PowerShell to clean up orphans
spawn("powershell.exe", [
  "-NoProfile", "-Command",
  `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
], { windowsHide: true, stdio: "ignore", detached: true }).unref();
```

**Lesson:** Never rely on CLI process management on Windows from Node. Use native `process.kill()` + async orphan cleanup.

### 2. Why Claude Code Style (15s + run_in_background)?

**Symptom:** Model was confused by forced 10s backgrounding. It would set `timeout` to wait longer, defeating the purpose.

**Cause:** No explicit escape hatch. The model couldn't express intent to background immediately.

**Solution:** Copy Claude Code exactly:
- 15s assistant-mode blocking budget (was 10s)
- `run_in_background: true` parameter for explicit immediate backgrounding
- Different messages for auto vs explicit backgrounding

**Result:** Model can now express intent: "I know this will take long, background it now" vs "This should be quick, let it run."

### 3. Preview Bug — Capture Before Clear

**Symptom:** Model always saw `(waiting for output...)` even when pre-timeout output existed.

**Cause:** Code cleared `memOutput` before reading the preview.

```typescript
// WRONG — preview is always empty
logStream.write(memOutput);
memOutput = "";  // cleared!
const preview = memOutput.slice(0, 500);  // always ""
```

**Solution:** Capture preview BEFORE clearing.

```typescript
// CORRECT — preview has actual content
const preview = memOutput.slice(0, 500);
logStream.write(memOutput);
memOutput = "";  // now safe to clear
```

### 4. taskkill /T /F hangs from Node/Bun

`taskkill /T /F /PID` is the documented way to kill process trees on Windows. It **hangs** (ETIMEDOUT) when called via `execSync`, `execFileSync`, or `exec` from Node.js or Bun, targeting a process that is a child of the current process.

Both `taskkill /F /PID` (without /T) and `taskkill /T /F /PID` hang. `process.kill(pid, "SIGKILL")` works instantly (calls `TerminateProcess`).

**Workaround:** SIGKILL the parent, then spawn a detached PowerShell process to find and kill orphans via `Get-CimInstance Win32_Process -Filter 'ParentProcessId=...'`.

### 5. BashResult vs AgentToolResult

The `user_bash` event handler must return `{ result: BashResult }` where:

```typescript
interface BashResult {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}
```

Returning `AgentToolResult` shape (`{ content: [{ type: "text", text }], details: {} }`) causes `textContent.unshift is not a function` crash in pi's `recordBashResult()`.

### 6. Built-in bash uses Git Bash, NOT PowerShell

The built-in bash tool resolves to Git Bash at `C:\Program Files\Git\bin\bash.exe`, uses persistent shell sessions via brush-core native bindings, has 300s default timeout, and sets non-interactive env vars (CI=1, PAGER=cat, etc.).

The extension must use the same shell for command compatibility.

### 7. Tool Shadowing via registerTool

`pi.registerTool({ name: "bash" })` shadows the built-in bash tool. The last extension to register a tool with a given name wins. This is how the extension intercepts all LLM bash calls without needing a separate tool.

### 8. user_bash intercepts `!` commands

The `user_bash` event fires when the user types `!` prefix commands. The handler can return `{ result: BashResult }` to fully replace execution. If it returns `undefined`, pi falls through to the built-in handler.

### 9. pi.sendMessage signature

```typescript
// CORRECT — 2 parameter form
pi.sendMessage(
  { customType: "...", content: "...", display: true },
  { triggerTurn: true, deliverAs: "followUp" }
);

// WRONG — causes [undefined] in UI
pi.sendMessage({
  content: "...",
  display: true,
  triggerTurn: true,    // belongs in 2nd param
});
```

---

## Technical Insights

### Process Lifecycle on Windows

```
spawn(bash, ["-l", "-c", "cmake --build"])
  └── cmake.exe
        ├── cl.exe (compiler)
        └── link.exe (linker)

process.kill(bash_pid, "SIGKILL")
  → bash dies instantly
  → cmake, cl.exe, link.exe become orphans
  → PowerShell Get-CimInstance finds them by parent PID
  → Stop-Process -Force kills them
```

### Memory Management After Backgrounding

Before timeout: accumulate output in memory (needed for normal return).
After timeout: stream to log file only via `createWriteStream`. Stop appending to memory strings.
On completion: read log file for notification content (bounded to last N chars).

This keeps memory O(1) after backgrounding regardless of output size.

### PID Reuse Protection

After a process finishes and the LLM is notified, schedule the entry for removal from `bgProcesses` map after 60s. This prevents stale entries from being confused with new processes that reuse the same PID.

---

## PI Extension API Notes

### Tool execute() signature

```typescript
execute(
  toolCallId: string,
  params: Static<TParams>,
  signal: AbortSignal | undefined,    // 3rd param
  onUpdate: AgentToolUpdateCallback | undefined,  // 4th param
  ctx: ExtensionContext,              // 5th param
): Promise<AgentToolResult>
```

### Event handler signatures

```typescript
pi.events.on("user_bash", async (event: UserBashEvent): Promise<UserBashEventResult | undefined> => { ... });
pi.events.on("session_shutdown", async () => { ... });
pi.events.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => { ... });  // can only block
pi.events.on("tool_result", async (event): Promise<ToolResultEventResult | undefined> => { ... });  // can modify results
```

---

## Testing

See [TESTING-2026-04-11.md](TESTING-2026-04-11.md) for the standalone test harness.

```bash
bun run test    # 8 tests, no pi needed
bun run dev     # watch mode
```

### Version History

| Version | Date | Key Changes |
|---------|------|-------------|
| v1.0 | 2026-04-03 | Initial release with PowerShell backgrounding |
| v2.0 | 2026-04-11 | Rewritten for Git Bash, forced 10s backgrounding |
| v3.0 | 2026-04-13 | Claude Code style: 15s budget + `run_in_background` parameter |
