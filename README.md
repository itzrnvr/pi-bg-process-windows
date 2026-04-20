# pi-bg-process-windows

Auto-backgrounding for PI Coding Agent on Windows. Commands that exceed a timeout are automatically detached and continue running in the background, with completion auto-notified to the LLM.

**Version 4.0** — modular architecture with PTY support via node-pty (ConPTY on Windows).

## How It Works

```
LLM calls bash tool → "run cmake --build"
       │
       ├── sync: true (default)
       │     ├── Finishes within 60s → Returns output normally
       │     └── Still running after 60s → AUTO-BACKGROUND
       │              ├── Streams to log file (memory stays bounded)
       │              ├── Returns immediately: PID + log path + output so far
       │              └── On completion → [BG_DONE] auto-notifies LLM
       │
       └── sync: false (PTY mode)
              ├── Spawns in real terminal (ConPTY)
              ├── Runs in background immediately
              ├── Agent can peek at output and send input
              └── On completion → [BG_DONE] auto-notifies LLM
```

## Features

- **Shadows built-in bash** — registers tool named `"bash"`, replaces built-in transparently
- **Two execution modes** — `sync: true` (spawn, fast) and `sync: false` (PTY, interactive)
- **PTY support** — real terminal via node-pty (ConPTY), agent can send keystrokes to interactive prompts
- **Auto-notification** — `[BG_DONE]` fires automatically when background process completes (no user prompt needed)
- **Peek with scrolling** — `win_bg_status peek` shows terminal output with lines/offset params
- **Input to PTY** — `win_bg_status input` sends text to interactive processes (y/n, passwords, selections)
- **Stall detection** — `[BG_SILENT]` after 30s with no output, shows recent output so agent can decide
- **Process tree kill** — SIGKILL + PowerShell orphan cleanup (cmake, cl.exe, etc.)
- **Memory-bounded** — after backgrounding, streams to log file only (no RAM growth)
- **AbortSignal** — respects cancellation from pi's tool execution
- **Shutdown-safe** — guards against late `sendMessage()` during teardown
- **`win_bg_status` tool** — agent-facing: `list`, `delta`, `log`, `stop`, `progress`, `peek`, `input`
- **`win_path` tool** — convert paths to Git Bash / Win32 / file:// formats in one shot
- **`/win_tasks` command** — user-facing: list, view output, kill
- **Footer indicator** — shows running/finished background process counts
- **Ctrl+Shift+B** — manually background all active foreground processes

## Installation

Install the extension and its native PTY binaries:

```bash
cd pi-bg-process-windows
pnpm build
cp dist/index.js ~/.pi/agent/extensions/pi-bg-process-windows/index.js
cp -r native/ ~/.pi/agent/extensions/pi-bg-process-windows/native/
```

Or reference in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    { "source": "C:\\Users\\you\\path\\to\\pi-bg-process-windows" }
  ]
}
```

## Build

```bash
bun build ./src/index.ts --outdir ./dist --target node
```

## Tools Registered

| Tool | Purpose |
|------|---------|
| `bash` | Shadows built-in — auto-backgrounds on timeout; `sync: false` for PTY mode |
| `win_bg_status` | List/view/stop/peek/input background processes |
| `win_path` | Path normalization (Git Bash, Win32, file://) |

## Commands Registered

| Command | Purpose |
|---------|---------|
| `/win_tasks` | User-facing background task manager |

## Architecture

```
src/
  config.ts              — Constants (timeouts, buffer sizes, PTY dimensions)
  types.ts               — BgProcess, PersistedBgState, ExecResult, ActiveForegroundProcess
  pty.ts                 — Dynamic node-pty loader, stripAnsi utility
  helpers.ts             — Shell resolution, path conversion, process management, formatting
  execute.ts             — Core execution: executeWithPty + executeWithSpawn
  scrollable-container.ts — TUI log viewer with live refresh
  index.ts               — Extension entry point: tools, commands, shortcuts, events

resolveShell()       → finds Git Bash (C:\Program Files\Git\bin\bash.exe)
killTree(pid)        → SIGKILL parent + PowerShell orphan cleanup
executeWithTimeout() → dispatches to PTY or spawn based on sync param
```

## PTY (node-pty) Shipping

The `native/` directory contains the full node-pty module with prebuilt binaries for Windows x64. At runtime, `pty.ts` sets `NODE_PATH` to include the prebuilds directory and requires the JS wrapper. If node-pty is unavailable, the extension falls back to regular spawn with piped stdio (no input capability).

## License

MIT
