# Project Documentation: pi-background-bash

## Project Overview

**Name:** pi-background-bash  
**Type:** PI Coding Agent Extension  
**Purpose:** Bring Claude Code-style Ctrl+B background execution to PI Coding Agent on Windows  
**Location:** `C:\Users\babys\Documents\code\pi-extensions-dev\pi-background-bash`

### What This Extension Does

This extension transforms PI's default blocking bash behavior into Claude Code's background-friendly model:

- **Default:** Commands run synchronously (blocking) - same as normal bash
- **Ctrl+B:** Press Ctrl+B during any long-running command to send it to background
- **Auto-background:** Commands automatically background after 5 minutes (300 seconds)
- **Job tracking:** Use `/tasks` to monitor, view output, or kill background jobs

### Why This Project Exists

**Problem:**
- PI's default bash tool blocks the terminal and agent
- Long commands (npm install, builds, dev servers) freeze the UI
- No way to continue working while commands run
- Windows has the worst experience (no tmux, poor PTY support)

**Existing Solutions:**
- Claude Code has Ctrl+B feature - but it's closed source
- PI philosophy: "Use tmux" - not practical for most Windows users
- No existing PI extension provides this functionality

**Solution:**
- Create an extension that replaces the bash tool
- Add Ctrl+B detection during execution
- Spawn PowerShell jobs for Windows background execution
- Provide job management interface

## Architecture

### High-Level Flow

```
User: Run npm install
    ↓
[Extension intercepts bash tool call]
    ↓
Start synchronous execution with monitoring
    ↓
Show TUI execution monitor
├─ Display elapsed time
├─ Listen for Ctrl+B
├─ Show auto-background countdown
└─ Stream output
    ↓
[User presses Ctrl+B OR 5min timeout]
    ↓
Kill foreground process
    ↓
Spawn PowerShell job with same command
    ↓
Return immediately with job ID
    ↓
User continues working
    ↓
Can check /tasks anytime
```

### Components

#### 1. Bash Tool Override (`executeBashWithCtrlB`)
**File:** `src/index.ts` (lines 195-350)

**Purpose:** Replaces PI's default bash tool execution

**Key Features:**
- Starts command synchronously with output redirection
- Creates TUI monitor component if UI available
- Captures all output to temp file
- Handles Ctrl+B detection
- Manages timeout and auto-background

**Critical Code Pattern:**
```typescript
// Show TUI monitor during execution
if (ctx.ui?.custom) {
  ctx.ui.custom((tui, theme, keybindings, done) => {
    return {
      handleInput(data: string): void {
        if (data === '\x02' || data === 'ctrl+b') {
          // BACKGROUND THE EXECUTION
        }
      }
    };
  });
}
```

**Why This Approach:**
- PI's tool execution is blocking by design
- TUI component is the ONLY way to receive keyboard input during execution
- `ctx.ui.custom()` creates a focused component that intercepts keys
- Ctrl+B is detected via `handleInput()` callback

#### 2. Windows Job Manager (`WindowsJobManager`)
**File:** `src/index.ts` (lines 60-165)

**Purpose:** Handle PowerShell job spawning and management

**Key Methods:**
- `spawnBackgroundJob()` - Creates PowerShell job from running command
- `isJobRunning()` - Polls job status via Get-Job
- `getOutput()` - Reads job output from temp files
- `killJob()` - Stops job via Stop-Job

**Implementation Details:**
- Uses `Start-Job` PowerShell cmdlet
- Generates PowerShell script files in temp directory
- Redirects all output to temp files
- Polls job state every 2 seconds

**PowerShell Script Template:**
```powershell
$env:VAR = "value"
Set-Location "cwd"
try {
    $output = & command 2>&1
    $output | Out-File -FilePath "output.txt" -Encoding UTF8
    $LASTEXITCODE | Out-File -FilePath "exitcode.txt" -Encoding UTF8
} catch {
    $_ | Out-File -FilePath "error.txt" -Encoding UTF8
    "1" | Out-File -FilePath "exitcode.txt" -Encoding UTF8
}
```

**Why PowerShell Jobs:**
- True background execution (not just async)
- Invisible (no console window)
- Native Windows integration
- Can survive PI restart
- Full lifecycle management (Start/Stop/Get/Remove)

#### 3. Job Registry (`completedJobs`)
**File:** `src/index.ts` (line 53)

**Purpose:** Track all background jobs

**Type:** `Map<string, BackgroundJob>`

**Storage:** In-memory with temp file backup

**Why In-Memory:**
- Fast lookups for /tasks command
- Jobs survive PI restart via temp files
- Reconstructed on extension load

#### 4. Task Management Commands
**File:** `src/index.ts` (lines 352-420)

**Commands:**
- `/tasks` - List jobs with status emoji (🟡🟢🔴)
- `/tasks output <id>` - View last N lines of output
- `/tasks kill <id>` - Stop running job

**Implementation:**
```typescript
pi.registerCommand("tasks", {
  handler: async (args, ctx) => {
    // Parse subcommand
    // Call jobManager methods
    // Display with UI notifications
  }
});
```

## Key Decisions

### Decision 1: Extension vs Core Modification
**Choice:** Build as extension, not modify PI core

**Rationale:**
- PI philosophy: minimal core, extensible
- Extensions can override default tools
- Can be shared/installed by others
- No fork maintenance burden

**Implementation:**
- Used `pi.registerTool({ name: "bash", ... })` to override
- PI tool registry allows replacement by name
- Hook system for intercepting calls

### Decision 2: Blocking by Default
**Choice:** Commands run synchronously unless Ctrl+B pressed

**Rationale:**
- Matches Claude Code behavior exactly
- No surprise behavior change
- User is always in control
- Aligns with PI's minimal philosophy

**Trade-offs:**
- ✅ Predictable behavior
- ✅ No breaking changes
- ✅ User opts-in to backgrounding
- ❌ Requires TUI for Ctrl+B detection
- ❌ Headless mode loses Ctrl+B feature

### Decision 3: PowerShell Jobs (Windows-First)
**Choice:** Use PowerShell Start-Job, not generic Node.js spawn

**Rationale:**
- True background process isolation
- Windows-native solution
- Handles Windows quirks (paths, permissions)
- No console window popups

**Alternative Considered:** Node.js detached processes
```typescript
// Rejected approach:
spawn('cmd', ['/c', command], { detached: true })
```
**Why Rejected:**
- cmd windows pop up and steal focus
- No clean lifecycle management
- Harder to track and kill
- Output capture is messy

### Decision 4: TUI Monitor Component
**Choice:** Show execution status with `ctx.ui.custom()`

**Rationale:**
- Only way to capture keyboard during execution
- Provides visual feedback to user
- Can show elapsed time and countdown
- Stream output in real-time

**Implementation Details:**
```typescript
// Execution monitor component
{
  render(width): string[] {
    return [
      `⚡ Running: ${command}`,
      `⏱  Elapsed: ${elapsed}`,
      `Press Ctrl+B to send to background`,
      `(Auto-background in ${countdown}s)`
    ];
  },
  handleInput(data) {
    if (data === '\x02') { /* Ctrl+B */ }
  }
}
```

**Trade-offs:**
- ✅ User sees what's happening
- ✅ Can press Ctrl+B anytime
- ✅ Shows auto-background countdown
- ❌ Requires interactive mode
- ❌ Adds visual overhead

### Decision 5: 5-Minute Auto-Background
**Choice:** Automatically background commands after 5 minutes

**Rationale:**
- Matches Claude Code behavior
- Prevents forgotten commands from blocking forever
- Safety net for long operations

**Implementation:**
```typescript
const autoBackgroundTimeout = setTimeout(() => {
  if (status === 'running') {
    monitorResolve('background');
  }
}, 300000); // 5 minutes
```

**Trade-offs:**
- ✅ Prevents indefinite blocking
- ✅ Matches user expectations (Claude Code)
- ❌ Might interrupt intentional long waits
- ❌ Not configurable (yet)

### Decision 6: Temp File Output Storage
**Choice:** Save job output to `%TEMP%\pi-background-bash\`

**Rationale:**
- Survives PI restart
- Can be read on-demand
- No memory pressure for large output
- Simple file operations

**Structure:**
```
%TEMP%\pi-background-bash\/
├── job-{timestamp}-{counter}-output.txt
├── job-{timestamp}-{counter}-error.txt
├── job-{timestamp}-{counter}-script.ps1
└── jobs-state.json (optional persistence)
```

**Trade-offs:**
- ✅ Persistent across sessions
- ✅ No memory limits
- ✅ Can use standard tools to view
- ❌ Needs cleanup (auto-delete after 24h?)
- ❌ File I/O overhead

### Decision 7: Override vs Intercept
**Choice:** Override the `bash` tool completely, not just intercept

**Rationale:**
- Seamless experience
- No need for agents to learn new tool
- Works with existing prompts/workflows

**Implementation:**
```typescript
pi.registerTool({
  name: "bash",  // Same name as default
  // ... overrides default
});
```

**Alternative Considered:** Hook interception
```typescript
// Rejected:
pi.registerHook("on_tool_call", {
  handler: (event) => {
    if (event.tool === 'bash') {
      event.redirectTo = 'background_bash';
    }
  }
});
```
**Why Rejected:** More complex, requires two tools, no benefit

## Implementation Challenges & Solutions

### Challenge 1: Capturing Ctrl+B During Execution
**Problem:** PI tool execution blocks - how to detect keypress?

**Solution:** Use TUI `custom()` component
- Creates focused overlay during execution
- `handleInput()` receives all keyboard input
- Can detect any key combination
- Must return control to PI when done

**Code:**
```typescript
ctx.ui.custom((tui, theme, keybindings, done) => {
  return {
    handleInput(data: string): void {
      if (data === '\x02') { // Ctrl+B
        done('background'); // Signal completion
      }
    }
  };
});
```

### Challenge 2: Migrating Running Process
**Problem:** How to move a running process to background?

**Solution:** Kill and respawn
1. Kill the foreground process
2. Collect output captured so far
3. Spawn new PowerShell job with same command
4. Transfer captured output to job

**Code:**
```typescript
// In handleInput when Ctrl+B pressed:
child.kill('SIGTERM');
const job = await jobManager.spawnBackgroundJob(
  params.command,
  cwd,
  env,
  capturedOutput  // Transfer what we have so far
);
```

**Trade-off:** Loses a bit of time (seconds) between kill and respawn
**Mitigation:** Acceptable - command restarts immediately

### Challenge 3: PowerShell Execution Policy
**Problem:** Windows blocks PowerShell scripts by default

**Solution:** Use `-ExecutionPolicy Bypass` flag
```typescript
spawn('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-Command', psCommand
]);
```

### Challenge 4: Output Streaming
**Problem:** Need to see output in real-time AND capture to file

**Solution:** PowerShell `Tee-Object`
```powershell
command 2>&1 | Tee-Object -FilePath "output.txt"
```
- Streams to console (captured by Node.js)
- Also writes to file
- Can read file anytime for full history

### Challenge 5: Job Status Monitoring
**Problem:** How to know when background job finishes?

**Solution:** Polling with `Get-Job`
```typescript
const checkInterval = setInterval(async () => {
  const isRunning = await this.isJobRunning(psJobId);
  if (!isRunning) {
    job.status = 'completed';
    clearInterval(checkInterval);
  }
}, 2000); // Check every 2 seconds
```

**Trade-off:** Not instant notification (2s latency max)
**Acceptance:** Good enough for user experience

## File Structure

```
pi-background-bash/
├── package.json          # Extension manifest & dependencies
├── src/
│   └── index.ts         # Main extension code (~500 lines)
├── README.md            # User-facing documentation
├── SKILL.md             # AI assistant instructions
└── PROJECT.md           # This file (technical deep dive)
```

### Key Files Explained

**`package.json`**
- Declares extension type for PI
- Registers tools, commands, hooks
- Defines Ctrl+B keybinding
- Peer dependency on `@oh-my-pi/pi-coding-agent`

**`src/index.ts`**
- Single file architecture (simple)
- Global state for active executions
- WindowsJobManager class
- Bash tool override
- Task management commands
- Cleanup hooks

**`README.md`**
- User installation instructions
- Usage examples
- Troubleshooting
- Comparison with Claude Code

**`SKILL.md`**
- When to use Ctrl+B
- Conversation patterns
- Commands reference
- Best practices for AI assistants

## Development Guide

### Setup
```bash
cd C:\Users\babys\Documents\code\pi-extensions-dev\pi-background-bash
bun install
```

### Build
```bash
bun run build
# Creates dist/index.js
```

### Development Mode
```bash
bun run watch
# Rebuilds on file changes
```

### Install to PI
```bash
# Option 1: Symlink (recommended for development)
mklink /D "%USERPROFILE%\.omp\agent\extensions\pi-background-bash" "C:\Users\babys\Documents\code\pi-extensions-dev\pi-background-bash"

# Option 2: Copy
xcopy /E /I "C:\Users\babys\Documents\code\pi-extensions-dev\pi-background-bash" "%USERPROFILE%\.omp\agent\extensions\pi-background-bash"

# Enable
omp /plugin enable pi-background-bash
```

### Testing
```bash
# Quick command (should complete normally)
Run ls -la

# Medium command, Ctrl+B after 30s
Run npm install
[Press Ctrl+B]

# Long command, wait for auto-background
Run npm run build
[Wait 5 minutes]

# Check task management
/tasks
/tasks output <job-id>
/tasks kill <job-id>
```

### Debugging
```bash
# Check if extension loaded
omp /plugins list

# Look for errors
# PI logs to ~/.omp/agent/logs/

# Test PowerShell directly
powershell -Command "Get-Job"
```

## Future Improvements

### Short-term
1. **Configuration options**
   - Auto-background timeout (currently hardcoded 5min)
   - Default output line count
   - Cleanup interval

2. **Better error handling**
   - Handle PowerShell not found
   - Handle execution policy blocks
   - Better error messages

3. **Cross-platform support**
   - Linux: use `nohup` or `disown`
   - macOS: same as Linux
   - Conditional compilation based on `process.platform`

### Medium-term
1. **Real-time output streaming**
   - WebSocket or EventSource
   - Push notifications on job completion
   - Live tail -f style viewing

2. **Job dependencies**
   - "Wait for job X before starting Y"
   - Chain jobs together
   - Parallel job execution

3. **Better TUI**
   - Show live output in TUI widget
   - Progress bars for known commands
   - Better visual design

### Long-term
1. **Session persistence**
   - SQLite database for jobs
   - Full job history
   - Resume jobs across PI restarts

2. **Advanced features**
   - Job scheduling (cron-like)
   - Job templates
   - Resource limits (CPU, memory)

## Known Issues & Limitations

### Current Limitations

1. **Windows only**
   - Uses PowerShell jobs
   - Would need different implementation for Linux/Mac

2. **TUI required**
   - Ctrl+B detection needs interactive mode
   - Headless/print mode won't work

3. **Not all commands background well**
   - Interactive prompts (read, vim, etc.) won't work
   - Commands needing PTY fail
   - Shell aliases not available

4. **Output gaps**
   - Brief gap between kill and respawn
   - Might miss a few lines of output
   - Generally acceptable

5. **No stdin input**
   - Background jobs can't receive input
   - Commands with prompts will hang

### Technical Debt

1. **Polling for job status**
   - Every 2 seconds is wasteful
   - Should use events/notifications

2. **Temp file cleanup**
   - Files accumulate over time
   - No automatic cleanup yet

3. **Global state**
   - Uses module-level Maps
   - Could be cleaner with proper state management

## API Reference

### Extension API

```typescript
interface ExtensionAPI {
  registerTool(tool: ToolDefinition): void;
  registerCommand(name: string, command: CommandDefinition): void;
  registerHook(event: string, hook: HookDefinition): void;
  notify(message: string, type: string): void;
  cwd: string;
}
```

### Tool Context

```typescript
interface ToolContext {
  ui?: {
    custom<T>(factory: ComponentFactory): Promise<T>;
    notify(message: string, type: string, options?: object): void;
  };
  hasUI: boolean;
}
```

### BackgroundJob Interface

```typescript
interface BackgroundJob {
  id: string;
  command: string;
  psJobId?: number;
  pid?: number;
  status: 'running' | 'completed' | 'failed' | 'killed' | 'backgrounded';
  startTime: Date;
  endTime?: Date;
  outputFile: string;
  errorFile: string;
  exitCode?: number;
  cwd: string;
  env: Record<string, string>;
  wasBackgrounded?: boolean;
  backgroundedAt?: Date;
  originalOutput?: string;
}
```

## Contributing

If you're another AI agent working on this project:

1. **Read this document first** - It explains the why and how
2. **Check the code comments** - Detailed inline documentation
3. **Test on Windows** - This is Windows-first extension
4. **Preserve the behavior** - Blocking by default, Ctrl+B to escape
5. **Follow the patterns** - PowerShell jobs, temp files, TUI components

### Common Tasks

**Adding a new command:**
```typescript
pi.registerCommand("new-command", {
  description: "What it does",
  handler: async (args, ctx) => {
    // Implementation
  }
});
```

**Modifying job behavior:**
- Look at `WindowsJobManager` class
- Key methods: `spawnBackgroundJob`, `isJobRunning`, `killJob`

**Changing TUI appearance:**
- Find `ctx.ui.custom()` call in `executeBashWithCtrlB`
- Modify `render()` method
- Update `handleInput()` for new keybindings

**Adding configuration:**
- Use environment variables (PI convention)
- Check at top of `executeBashWithCtrlB`
- Document in README.md

## Resources

- **PI Extension Docs:** https://pi.dev/docs/extensions
- **PI Coding Agent API:** https://pi.dev/docs/api
- **Claude Code Changelog:** See `.claude/cache/changelog.md` for Ctrl+B evolution
- **PowerShell Jobs:** https://docs.microsoft.com/powershell/module/microsoft.powershell.core/start-job

## Questions?

If you're an agent working on this and have questions:

1. Check inline code comments - they're extensive
2. Look at the Claude Code behavior for reference
3. Test on actual Windows system
4. Remember: Windows-first, blocking by default, Ctrl+B to escape

---

**Last Updated:** 2026-04-03  
**Created By:** Veronica 2.0  
**For:** PI Coding Agent Extension Development
