# SKILL: Background Process Management

## What This Extension Does

Automatically backgrounds long-running bash commands on Windows:

- Commands that finish in <15s return normally (no change in behavior)
- Commands still running after 15s are auto-detached and continue running
- LLM gets auto-notified when the background process completes
- User can check/manage via `/win_tasks`

## When Backgrounding Happens

Any bash command that exceeds 15 seconds is automatically backgrounded. This includes:
- cmake builds
- npm install on large projects
- Long-running test suites
- Any command the LLM runs via the bash tool

## Decision Flow

```
Command needs to run?
    ↓
Will it take > 15 seconds AND you don't need the result immediately?
    ├─ YES → Use run_in_background: true (background immediately)
    │
    ├─ MAYBE, but you need it to finish this turn → Use no_background: true
    │        (waits for completion; disables auto-backgrounding)
    │
    └─ NO → Just call bash normally
```

## Tools Available

### `bash` (shadows built-in)

```json
// Normal usage — auto-backgrounds after 15s if still running
{ "command": "cmake --build build" }

// Background immediately (for builds, installs, dev servers)
{ "command": "npm install", "run_in_background": true }

// Wait for completion — disable auto-backgrounding
{ "command": "find . -name '*.ts'", "no_background": true }
```

### `win_bg_status` (for LLM)

```
win_bg_status({ action: "list" })           → show all backgrounded processes
win_bg_status({ action: "delta" })          → only changed since last check
win_bg_status({ action: "log", pid: 123 })  → view process output
win_bg_status({ action: "stop", pid: 123 }) → kill process tree
win_bg_status({ action: "progress", pid: 123 }) → check if running/stalled
```

### `win_path` (for LLM)

Converts any Windows path into all three common formats at once. Use this instead of guessing `cygpath` round-trips.

```json
{ "path": "C:\\Users\\name\\Documents" }
```

Returns:
```
Git Bash:  /c/Users/name/Documents
Win32:     C:\Users\name\Documents
file://:   file:///C:/Users/name/Documents
```

### `/win_tasks` (for user)

```
/win_tasks               → list all background tasks
/win_tasks output 123    → view output for PID 123
/win_tasks kill 123      → kill process tree for PID 123
```

## After Backgrounding

When a command gets backgrounded, you'll see:

```
Command exceeded the assistant-mode blocking budget (15s) and was moved to the background with PID: 49281.
```

When it completes, you'll automatically receive:

```
[BG_DONE] PID 49281 finished (exit 0) in 47s
Command: cmake --build build
...output...
```

## What You Can Do While Waiting

While a background process runs, you can:
- Ask the LLM to do other work (read files, search code, etc.)
- Check progress: `win_bg_status({ action: "log", pid: 49281 })`
- Stop it: `win_bg_status({ action: "stop", pid: 49281 })`
- Or user: `/win_tasks output 49281`

## Common Patterns

### Pattern 1: Long build or install
```json
{ "command": "npm install", "run_in_background": true }
```

### Pattern 2: Search you need synchronously
```json
{ "command": "find . -name '*.test.ts'", "no_background": true }
```

### Pattern 3: Write + lint + test a script in one call
Instead of three separate bash calls, write the file first, then run validation in a single compound command:

```json
{
  "command": "cat > test-script.js << 'EOF'\nconst add = (a, b) => a + b;\nconsole.log(add(2, 3));\nEOF && node -c test-script.js && node test-script.js",
  "no_background": true
}
```

Or for PowerShell-friendly one-liners:
```json
{
  "command": "echo 'console.log(1+1)' > test.js && node -c test.js && node test.js",
  "no_background": true
}
```

### Pattern 4: Path conversion before using a file:// URL
```json
{ "path": "C:\\Users\\name\\Documents\\project\\file.txt" }
```
Use the `file://` output for Node `new URL()` or browser preload URLs.

## Edge Cases

- **Interactive commands** (needing stdin) will hang and get backgrounded, then never finish
- **Very short commands** (<15s) are never affected
- **Process tree killing** uses SIGKILL + PowerShell orphan cleanup for cmake/cl.exe trees
- **Using `no_background: true`** on very long commands (>2–3 minutes) will block the agent — only use it when you genuinely need the result before continuing
