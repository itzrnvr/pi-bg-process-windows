# pi-bg-process-windows

Auto-backgrounding for PI Coding Agent on Windows. Commands that exceed a timeout are automatically detached and continue running in the background, with completion auto-notified to the LLM.

**Version 2.0** — rewritten to use bash (not PowerShell), with proper process tree killing, bounded memory, and AbortSignal support.

## How It Works

```
LLM calls bash tool → "run cmake --build"
       │
       ├── Finishes within 15s → Returns output normally
       │
       └── Still running after 15s → AUTO-BACKGROUND (always)
                  │
                  ├── child.unref() — process keeps running
                  ├── Streams to log file (memory stays bounded)
                  ├── Returns immediately: PID + log path + output so far
                  │
                  └── On completion → pi.sendMessage() auto-notifies LLM
```

## Features

- **Shadows built-in bash** — registers tool named `"bash"`, replaces built-in transparently
- **Claude Code-style auto-backgrounding** — commands exceeding 15s auto-background (assistant-mode blocking budget)
- **Explicit backgrounding** — set `run_in_background: true` to immediately background without waiting
- **Opt-out of auto-backgrounding** — set `no_background: true` to wait for completion synchronously
- **Auto-notification** — `pi.sendMessage()` fires when background process completes
- **Process tree kill** — SIGKILL + PowerShell orphan cleanup (cmake, cl.exe, etc.)
- **Memory-bounded** — after backgrounding, streams to log file only (no RAM growth)
- **AbortSignal** — respects cancellation from pi's tool execution
- **Shutdown-safe** — guards against late `sendMessage()` during teardown
- **`win_bg_status` tool** — agent-facing: `list`, `delta`, `log`, `stop`, `progress`
- **`win_path` tool** — convert paths to Git Bash / Win32 / file:// formats in one shot
- **`/win_tasks` command** — user-facing: list, view output, kill

## Installation

Referenced in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    { "source": "C:\\Users\\babys\\Documents\\code\\pi-extensions-dev\\pi-bg-process-windows" }
  ]
}
```

## Build & Test

```bash
cd C:\Users\babys\Documents\code\pi-extensions-dev\pi-bg-process-windows

# Build
bun run build

# Run tests (no pi restart needed)
bun run test

# Watch mode — reruns tests on file changes
bun run dev
```

See [TESTING-2026-04-11.md](TESTING-2026-04-11.md) for full testing documentation.

## Tools Registered

| Tool | Purpose |
|------|---------|
| `bash` | Shadows built-in — auto-backgrounds on timeout |
| `win_bg_status` | List/view/stop background processes |
| `win_path` | Path normalization (Git Bash, Win32, file://) |

## Commands Registered

| Command | Purpose |
|---------|---------|
| `/win_tasks` | User-facing background task manager |

## Architecture

```
resolveShell()     → finds Git Bash (C:\Program Files\Git\bin\bash.exe)
killTree(pid)      → SIGKILL parent + PowerShell orphan cleanup
executeWithTimeout → spawns bash, 15s timeout, auto-backgrounds
```

Entry points:
- `pi.registerTool({ name: "bash" })` — shadows built-in (LLM calls)
- `pi.events.on("user_bash")` — intercepts `!` prefix commands
- `pi.registerTool({ name: "win_bg_status" })` — process management
- `pi.registerTool({ name: "win_path" })` — path conversion
- `pi.registerCommand("win_tasks")` — user-facing
- `pi.events.on("session_shutdown")` — cleanup

## License

MIT
