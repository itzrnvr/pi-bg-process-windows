# SKILL: Background Process Management (Windows)

## What This Extension Does

Automatically backgrounds long-running bash commands on Windows, with optional PTY support for interactive processes.

- **sync: true** (default): Fast spawn. Commands finishing within 60s return normally. Longer commands auto-background.
- **sync: false**: PTY spawn. Runs in a real terminal immediately. Agent can peek at output and send input.
- `[BG_DONE]` notifications arrive automatically when processes complete — no user prompt needed.

## When to Use Each Mode

```
Command needs to run?
    ↓
Will it need interaction (prompts, passwords, confirmations)?
    ├─ YES → Use sync: false (PTY mode)
    │        Agent can send input via win_bg_status input
    │
    ├─ Just a long build/install you want in background?
    │   → Use sync: false (starts in background immediately)
    │
    └─ Normal quick command or you need the result this turn?
        → Use sync: true (default) or just call bash normally
```

## Tools Available

### `bash` (shadows built-in)

```json
// Normal usage — auto-backgrounds after 60s if still running
{ "command": "cmake --build build" }

// PTY mode — for interactive or explicitly background tasks
{ "command": "docker build -t app .", "sync": false }

// PTY mode — for commands needing input
{ "command": "sudo apt update", "sync": false }
```

### `win_bg_status` (for LLM)

```
win_bg_status({ action: "list" })                                    → show all backgrounded processes
win_bg_status({ action: "delta", lastKnownHash: "abc" })            → only changed since last check
win_bg_status({ action: "peek", pid: 123 })                          → last 30 lines of output
win_bg_status({ action: "peek", pid: 123, lines: 50, offset: 30 })  → scroll back 30 lines, show 50
win_bg_status({ action: "input", pid: 123, inputText: "y\n" })      → send 'y' + Enter to PTY process
win_bg_status({ action: "log", pid: 123 })                           → view full output log (15K chars)
win_bg_status({ action: "stop", pid: 123 })                          → kill process tree
win_bg_status({ action: "progress", pid: 123 })                      → check if running/stalled/done
```

### `win_path` (for LLM)

Converts any Windows path into all three common formats at once.

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
/win_tasks 123           → view output for PID 123 (scrollable TUI)
```

## After Backgrounding

When a command gets auto-backgrounded (sync: true, exceeded 60s):

```
Command still running after 60s, moved to background (PID: 49281, PTY mode).
Peek: win_bg_status peek 49281. Input: win_bg_status input 49281 "text".
```

When started with sync: false:

```
Command running in background (PID: 49281, PTY mode). You can peek at output with: win_bg_status peek 49281.
```

When it completes, you'll automatically receive:

```
[BG_DONE] PID 49281 finished (exit 0) in 47s
Command: cmake --build build
...output...
```

## Common Patterns

### Pattern 1: Long build or install
```json
{ "command": "docker build -t app .", "sync": false }
```

### Pattern 2: Interactive command needing input
```json
{ "command": "ssh-keygen -t ed25519", "sync": false }
```
Then: `win_bg_status input 1234 "\n"` to send Enter for default path.

### Pattern 3: Quick command you need now
```json
{ "command": "find . -name '*.test.ts'" }
```
Uses default sync: true, returns output directly.

### Pattern 4: Path conversion
```json
{ "path": "C:\\Users\\name\\Documents\\project\\file.txt" }
```
Use the `file://` output for Node `new URL()` or browser preload URLs.

## Edge Cases

- **Interactive commands with sync: true** (default) will hang and get backgrounded, then cannot receive input — use `sync: false` for interactive commands
- **Very short commands** (<60s) are never affected when sync: true
- **Process tree killing** uses SIGKILL + PowerShell orphan cleanup for cmake/cl.exe trees
- **[BG_SILENT]** notification after 30s with no output — agent can peek to decide if stalled
- **PTY unavailable** — falls back to regular spawn (no input capability, but still auto-backgrounds)
