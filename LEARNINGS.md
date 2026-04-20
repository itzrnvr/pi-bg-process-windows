# Project Learnings: pi-bg-process-windows

**Created:** 2026-04-03
**Last Updated:** 2026-04-20 (v4.0 — Modular + PTY)

---

## Critical Discoveries

### 1. taskkill /T /F hangs from Node/Bun

`taskkill /T /F /PID` is the documented way to kill process trees on Windows. It **hangs** (ETIMEDOUT) when called via `execSync`, `execFileSync`, or `exec` from Node.js or Bun, targeting a process that is a child of the current process.

**Solution:** SIGKILL the parent, then spawn a detached PowerShell process to find and kill orphans via `Get-CimInstance Win32_Process`.

```typescript
process.kill(pid, "SIGKILL");
spawn("powershell.exe", [
  "-NoProfile", "-Command",
  `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
], { windowsHide: true, stdio: "ignore", detached: true }).unref();
```

### 2. deliverAs: "nextTurn" vs "followUp"

**Symptom:** `[BG_DONE]` notifications never arrived until the user sent their next prompt.

**Cause:** `deliverAs: "nextTurn"` pushes to `_pendingNextTurnMessages`, which only get injected when `prompt()` is called (i.e., when user types something). The notification sits in a queue forever.

**Solution:** Use `deliverAs: "followUp"`. When the agent is streaming, this calls `this.agent.followUp(appMessage)` which queues the message for delivery after the current turn. When the agent is idle with `triggerTurn: true`, it calls `await this.agent.prompt(appMessage)` which starts a new turn immediately.

```typescript
// ✅ CORRECT — auto-notifies agent
pi.sendMessage(
  { customType: "bgProcessDone", content: "...", display: true },
  { triggerTurn: true, deliverAs: "followUp" }
);

// ❌ WRONG — waits for next user prompt
pi.sendMessage(
  { customType: "bgProcessDone", content: "...", display: true },
  { triggerTurn: true, deliverAs: "nextTurn" }
);
```

### 3. node-pty npm install hangs in monorepos

**Symptom:** `npm install node-pty` hangs forever at `node-gyp rebuild` in monorepo directories with lockfiles.

**Cause:** Native addon compilation via node-gyp can stall when package managers hold locks. Node 24 (ABI v137) has no prebuilt binaries, forcing compilation.

**Solution:** Install node-pty in a clean directory outside the monorepo (installs in 3 seconds with prebuilts), then copy the entire `node_modules/node-pty` to the extension's `native/` directory. At runtime, `pty.ts` sets `NODE_PATH` to include `native/prebuilds/win32-x64` and requires the JS wrapper.

### 4. PTY overhead causes false backgrounding for sync: true

**Symptom:** Quick commands like `echo hello` were getting auto-backgrounded when spawned via PTY.

**Cause:** ConPTY setup adds ~2-5s overhead (spawning OpenConsole.exe, terminal initialization). This caused the 60s sync timeout to be reached for commands that should complete instantly.

**Solution:** Only use PTY for `sync: false` commands. Use regular `spawn` with piped stdio for `sync: true`.

### 5. Heuristic stall detection produces false positives

**Symptom:** Docker builds (trailing `:`), cargo builds (silent compilation), and git clone (pack phase) were falsely flagged as stalled.

**Cause:** Pattern-based heuristics can't distinguish "waiting for input" from "legitimately producing no output." 

**Solution:** Replace heuristics with "show the agent what's happening." After 30s with no output, send `[BG_SILENT]` with the last 20 lines of output and let the agent decide.

### 6. node-pty ConPTY path handling works correctly

**Symptom:** Concern that `C:\Program Files\Git\bin\bash.exe` with backslashes might get mangled.

**Testing:** Both `C:\Program Files\Git\bin\bash.exe` (backslashes) and `C:/Program Files/Git/bin/bash.exe` (forward slashes) spawn correctly via node-pty. The `argsToCommandLine` function in node-pty's `windowsPtyAgent.js` properly handles MSDN escaping conventions. `CreateProcessW` receives the command line correctly.

### 7. pi.sendMessage signature

```typescript
// ✅ CORRECT — 2 parameter form
pi.sendMessage(
  { customType: "...", content: "...", display: true },
  { triggerTurn: true, deliverAs: "followUp" }
);

// ❌ WRONG — causes [undefined] in UI
pi.sendMessage({
  content: "...",
  display: true,
  triggerTurn: true,    // belongs in 2nd param
});
```

### 8. itmux/Cygwin paths don't work for Windows PTY

**Symptom:** itmux (Windows tmux bundler) produces path resolution errors and environment mismatches.

**Cause:** itmux bundles a Cygwin-based tmux. Cygwin paths (`/cygdrive/c/...`) and environment differ from the Windows host. Commands run inside itmux can't find tools at their expected Windows paths.

**Solution:** Use node-pty instead — it uses Windows native ConPTY API (same as VS Code terminal), preserving the same paths, environment, and output.

---

## Technical Insights

### ConPTY Two-Phase Spawn

node-pty's ConPTY implementation works in two phases:
1. `PtyStartProcess` — creates pseudoconsole (named pipes for input/output), returns pipe names
2. `PtyConnect` — connects to pipes, calls `CreateProcessW` with the command line

The `argsToCommandLine` function in `windowsPtyAgent.js` handles MSDN command-line escaping (backslashes before `"` get doubled, spaces trigger quoting).

### PTY Output Processing

PTY output contains terminal control sequences that must be stripped before sending to the LLM:
- CSI sequences: `\x1b[...letter` (colors, cursor movement)
- DEC private modes: `\x1b[?25h` (cursor show), `\x1b[?1004h` (focus reporting)
- OSC sequences: `\x1b]0;title\x07` (window title)
- Charset designations: `\x1b(B`
- Line endings: `\r\n` → `\n`, standalone `\r` removed

### Memory Management After Backgrounding

Before timeout: accumulate output in memory (needed for normal return).
After timeout: stream to log file only via `createWriteStream`. Stop appending to memory strings.
On completion: read log file for notification content (bounded to last N chars).

### PID Reuse Protection

After a process finishes and the LLM is notified, schedule the entry for removal from `bgProcesses` map after 60s. This prevents stale entries from being confused with new processes that reuse the same PID.

---

## Version History

| Version | Date | Key Changes |
|---------|------|-------------|
| v1.0 | 2026-04-03 | Initial release with PowerShell backgrounding |
| v2.0 | 2026-04-11 | Rewritten for Git Bash, forced 10s backgrounding |
| v3.0 | 2026-04-13 | Claude Code style: 15s budget + `run_in_background` parameter |
| v4.0 | 2026-04-20 | Modular architecture, PTY via node-pty, sync param, peek/input, deliverAs followUp fix |
