# Agent Instructions: pi-bg-process-windows

**For:** AI Agents working on this project
**Purpose:** Actionable instructions to avoid mistakes and work effectively
**Created:** 2026-04-03
**Updated:** 2026-04-09 (renamed tools: win_bash, win_bg_status, win_tasks to avoid conflicts with oh-pi built-in)
**Applies To:** All agents editing, debugging, or extending this codebase

---

## 🚨 STOP - Read This First

**Before you do ANYTHING else:**

1. ✅ Read `LEARNINGS.md` (know what mistakes not to make)
2. ✅ Read this file (know what to do)
3. ✅ Check `src/index.ts` (understand the current implementation)
4. ✅ Verify PI location (`where pi` - know if it's using .pi or .omp)

---

## 🎯 Architecture

This extension uses a **simple timeout-based approach**:
1. Register `win_bash` tool with `spawn("powershell.exe", ...)`
2. Set a 10s timer — if still running, call `child.unref()` to detach
3. Register `win_bg_status` tool for agent-facing management
4. Register `/win_tasks` command for user-facing management
5. On process close after backgrounding, call `pi.sendMessage()` to notify LLM

**DO NOT** add TUI components, Ctrl+B detection, or PowerShell Job migration. The current approach is simpler and more reliable.

---

## 🔧 Technical Standards

### Code Style

```typescript
// Use explicit types - don't rely on inference for public APIs
const bgProcesses = new Map<number, BgProcess>();

// Handle errors explicitly
try { process.kill(pid, "SIGTERM"); } catch {}
```

### PI API Usage

```typescript
// ✅ CORRECT
pi.registerTool({ name: "win_bash", ... });
pi.registerTool({ name: "win_bg_status", ... });
pi.registerCommand("win_tasks", { ... });
pi.on("session_shutdown", async () => { ... });

// ✅ CORRECT sendMessage (2-parameter form)
pi.sendMessage(
  { customType: "bgProcessDone", content: "...", display: true },
  { triggerTurn: true, deliverAs: "followUp" }
);

// ❌ WRONG - these don't exist
pi.registerHook()  // DOES NOT EXIST
```

### ⚠️ CRITICAL: pi.sendMessage() signature

```typescript
// WRONG - causes [undefined] in UI
pi.sendMessage({
  content: "...",
  display: true,
  triggerTurn: true,    // ← belongs in 2nd param
  deliverAs: "followUp", // ← belongs in 2nd param
});

// CORRECT
pi.sendMessage(
  { customType: "bgProcessDone", content: "...", display: true },
  { triggerTurn: true, deliverAs: "followUp" }
);
```

### File Structure

```
pi-bg-process-windows/
├── src/index.ts              # Main code (~300 lines)
├── dist/index.js             # Compiled output
├── package.json              # Manifest
├── README.md                 # User docs
├── SKILL.md                  # AI training
├── .project-context.md       # Technical reference
└── LEARNINGS.md              # Mistakes & insights
```

---

## 🧪 Testing Protocol

### Test 1: Extension Loads

```bash
pi
# Check startup output for:
#   pi-bg-process-windows\dist\index.js  ✅
# Should NOT show:
#   Failed to load extension  ❌
```

### Test 2: Short Command (No Backgrounding)

```bash
# In PI: Run echo "hello"
# Expected: Returns "hello" immediately
```

### Test 3: Long Command (Auto-Background)

```bash
# In PI: Run powershell -Command "Start-Sleep -Seconds 15"
# Expected after 10s:
#   "Command still running after 10s, moved to background."
#   PID: XXXXX
#   Log: C:\Users\babys\AppData\Local\Temp\pi-bg\bg-XXX.log
# Expected after ~15s:
#   [BG_PROCESS_DONE] PID XXXXX finished (exit 0)
```

### Test 4: win_bg_status Tool

```bash
# win_bg_status({ action: "list" }) → shows all background processes
# win_bg_status({ action: "log", pid: XXXXX }) → shows output
# win_bg_status({ action: "stop", pid: XXXXX }) → kills process
```

### Test 5: /win_tasks Command

```bash
/win_tasks              → lists all jobs
/win_tasks output <pid> → shows output
/win_tasks kill <pid>   → kills process
```

---

## 🐛 Debugging Guidelines

### Extension Won't Load
1. Check PI startup output for error message
2. Verify `dist/index.js` exists and is recent
3. Check for syntax errors in `src/index.ts`

### [undefined] Appears in UI
- **Root cause:** `pi.sendMessage()` called with `triggerTurn`/`deliverAs` on message object
- **Fix:** Move them to the second `options` parameter

### Background Process Not Notifying
- Verify `child.on("close", ...)` handler is registered before `child.unref()`
- Check `pi.sendMessage()` uses correct 2-parameter form

---

## 🔄 Build & Deploy

```bash
cd C:\Users\babys\Documents\code\pi-extensions-dev\pi-bg-process-windows
bun build ./src/index.ts --outdir ./dist --target node
# No deploy needed — settings.json points directly to this path
```

---

## ⚠️ Critical Rules

1. **Use `powershell.exe`, NOT `bash`** — this is Windows-first
2. **Use `os.tmpdir()`, NOT `/tmp/`** — Windows temp paths
3. **`child.unref()` is critical** — without it, Node blocks waiting for process
4. **`pi.sendMessage()` uses 2 params** — message + options, not one merged object
5. **One change at a time** — build → test → verify → next change

---

## 🆘 Rollback

```bash
git checkout -- src/index.ts
bun build ./src/index.ts --outdir ./dist --target node
```

---

**Remember:** Every agent after you will read this file. Make their life easier.
