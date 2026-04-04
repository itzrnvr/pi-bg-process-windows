# pi-bg-process-windows

Windows-first auto-backgrounding for PI Coding Agent. Commands that exceed a timeout threshold are automatically detached and continue running in the background, with completion auto-notified to the LLM.

## How It Works

```
Agent calls bash → "run npm install"
       │
       ├── Finishes within 10s ──→ Returns output normally
       │
       └── Still running after 10s ──→ AUTO-BACKGROUND
                  │
                  ├─ child.unref() → Node stops waiting, process keeps running
                  ├─ Log written to %TEMP%\pi-bg\bg-<timestamp>-<pid>.log
                  ├─ Returns immediately: PID + log path
                  │
                  └─ When done → pi.sendMessage() auto-notifies LLM
```

## Features

- **Auto-backgrounding** — Commands exceeding 10s timeout are detached, not killed
- **Auto-notification** — `pi.sendMessage()` fires when background process completes
- **`win_bg_status` tool** — Agent-facing: `list`, `log`, `stop` by PID
- **`/win_tasks` command** — User-facing: `/win_tasks list`, `/win_tasks output <pid>`, `/win_tasks kill <pid>`
- **Windows-native** — Uses `powershell.exe`, proper temp paths, `windowsHide: true`
- **Shutdown cleanup** — Kills all running background processes on session exit

## Installation

This extension is referenced directly in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "C:\\Users\\babys\\Documents\\code\\pi-extensions-dev\\pi-bg-process-windows"
  ]
}
```

## Build

```bash
cd C:\Users\babys\Documents\code\pi-extensions-dev\pi-bg-process-windows
bun build ./src/index.ts --outdir ./dist --target node
```

## Tools Registered

| Tool            | Purpose                                    |
| --------------- | ------------------------------------------ |
| `win_bash`      | Windows PowerShell — auto-backgrounds on timeout |
| `win_bg_status` | List/view/stop background processes        |

## Commands Registered

| Command      | Purpose                           |
| ------------ | --------------------------------- |
| `/win_tasks` | User-facing background task manager |

## Configuration

| Constant        | Default     | Description                          |
| --------------- | ----------- | ------------------------------------ |
| `BG_TIMEOUT_MS` | `10_000`    | Milliseconds before auto-backgrounding |

## Differences from oh-pi's bg-process

| Feature              | oh-pi bg-process          | pi-bg-process-windows        |
| -------------------- | ------------------------- | ---------------------------- |
| Shell                | `bash` (broken on Windows) | `powershell.exe` (Windows-native) |
| Temp paths           | `/tmp/oh-pi-bg-*.log`     | `%TEMP%\pi-bg\bg-*.log`      |
| Timeout              | 10s                       | 10s (configurable)           |
| Notification         | `pi.sendMessage()` (wrong signature) | `pi.sendMessage()` (correct 2-param form) |
| User command         | None                      | `/win_tasks`                 |
| Tool names           | `bash`, `bg_status`       | `win_bash`, `win_bg_status` (no conflicts) |

## License

MIT
