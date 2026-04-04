# Project Learnings: pi-background-bash

**Created:** 2026-04-03  
**Last Updated:** 2026-04-03  
**Purpose:** Document mistakes, insights, and technical gotchas for future agents

---

## 🔴 Critical Mistakes Made (Don't Repeat These!)

### Mistake 1: Assuming PI API Matches Documentation

**What Happened:**
I implemented `pi.registerHook()` based on my understanding of extension APIs, but it doesn't exist in PI. This caused the extension to fail loading with:
```
Failed to load extension: pi.registerHook is not a function
```

**Root Cause:**
PI's extension API is different from typical hook-based systems. It uses:
- `pi.on(event, handler)` for event subscriptions
- `pi.registerTool()` for tools
- `pi.registerCommand()` for slash commands

**The Fix:**
```typescript
// ❌ WRONG - Doesn't exist in PI
pi.registerHook("on_shutdown", { name, handler });

// ✅ CORRECT - Use pi.on() with event names
pi.on("session_shutdown", async () => {
  // cleanup code
});
```

**Lesson:**
Always verify PI's actual API by looking at working extensions (like codemode) rather than assuming standard patterns.

---

### Mistake 2: Invalid package.json Declarations

**What Happened:**
Added these to `package.json` which PI doesn't support:
```json
{
  "piPackage": {
    "keybindings": [...],  // ❌ Not supported
    "hooks": [...]         // ❌ Not supported
  }
}
```

**What PI Actually Supports:**
```json
{
  "piPackage": {
    "type": "extension",
    "tools": ["toolName"],
    "commands": ["commandName"]
  }
}
```

**Lesson:**
PI's manifest is minimal. Don't add speculative features - only use what verified extensions use.

---

### Mistake 3: Multiple PI Config Locations

**What Happened:**
Initially tried to disable codemode by modifying `settings.json` but PI was loading it from multiple sources:
1. `~/.pi/agent/settings.json` - packages array
2. `~/.pi/agent/extensions/` - auto-discovery
3. `~/Documents/code/pi-codemode-fork/` - direct path reference

**The Confusion:**
```bash
# I thought removing from settings.json would disable it
# But PI still found it at:
~/Documents/code/pi-codemode-fork/src/index.ts
```

**The Reality:**
PI has multiple extension discovery mechanisms:
1. **Explicit packages** in `settings.json`
2. **Auto-discovery** from conventional paths
3. **Git/npm packages** installed globally

**How to Properly Disable:**
Either:
- Rename the folder (e.g., `pi-codemode-fork.disabled`)
- Remove from ALL locations
- Or modify the extension's internal default state

**Lesson:**
PI extensions can be loaded from multiple sources. Always check the startup output to see where extensions are actually loading from.

---

### Mistake 4: Confusion About .omp vs .pi Directories

**What Happened:**
The system has TWO separate PI installations/configurations:
- `~/.omp/agent/` - One PI setup
- `~/.pi/agent/` - Another PI setup

I was installing extensions to `.omp` but PI was loading from `.pi`!

**Evidence:**
```bash
# I installed to:
~/.omp/agent/extensions/pi-background-bash

# But PI loaded from:
~/.pi/agent/extensions/pi-background-bash
```

**Lesson:**
Always verify which PI instance is actually running. Check `where pi` and the startup banner to know which config directory is active.

---

## 💡 Technical Insights

### Insight 1: PI's Event System

PI uses Node.js-style event emitters:

```typescript
// Subscribe to events
pi.on("session_start", async (event, ctx) => {
  // Runs when session starts
});

pi.on("session_shutdown", async () => {
  // Cleanup when session ends
});

pi.on("before_agent_start", async (event) => {
  // Modify system prompt before agent starts
  return { systemPrompt: event.systemPrompt + "\n\nAdditional context" };
});
```

**Key Events:**
- `session_start` - Session initialization
- `session_shutdown` - Cleanup time
- `before_agent_start` - Modify system prompt
- `message` - Incoming messages (maybe?)

---

### Insight 2: TUI Components Are the ONLY Way to Capture Keyboard

During tool execution, the ONLY way to capture keyboard input (like Ctrl+B) is through the TUI component system:

```typescript
ctx.ui.custom((tui, theme, keybindings, done) => {
  return {
    handleInput(data: string): void {
      // Ctrl+B detection
      if (data === '\x02') {  // ASCII for Ctrl+B
        done('background');
      }
    },
    render(width: number): string[] {
      return ["UI lines here"];
    }
  };
});
```

**Critical Understanding:**
- Tool execution blocks the main thread
- No global keybinding system exists
- TUI component has focus and receives keys via `handleInput()`
- `\x02` is the ASCII control character for Ctrl+B

---

### Insight 3: Process Migration Strategy

Windows doesn't support true process migration (like Unix `nohup`). The only reliable pattern is:

```
1. Kill foreground process
2. Collect captured output
3. Spawn new PowerShell job with same command
4. Transfer output to job
5. Return job ID
```

**Trade-offs:**
- ✅ 100% reliable
- ✅ Works with any command
- ❌ Loses 1-2 seconds during transition
- ❌ Command restarts from beginning

**Alternative Considered:**
Using Node.js `child_process.spawn({ detached: true })` - but this creates visible console windows and poor lifecycle management.

**Why PowerShell Jobs:**
- True background execution
- No visible window
- Full lifecycle control (Start/Stop/Get/Remove)
- Survives parent process exit

---

### Insight 4: Extension Loading Order Matters

Extensions are loaded in the order they appear in `settings.json`. This matters for:

1. **Tool overrides** - Last extension wins
2. **Command registration** - First to register gets the name
3. **Event handlers** - Earlier handlers can modify later ones

**Our Situation:**
```json
"packages": [
  "C:\\...\\pi-codemode-fork",      // Loads first
  "C:\\...\\pi-background-bash"    // Loads second, can override bash
]
```

Both register a `bash` tool - the last one loaded wins (ours).

---

## 🎯 PI-Specific Gotchas

### Gotcha 1: Extension Discovery

PI discovers extensions from:
1. `settings.json` `packages` array (explicit)
2. `~/.pi/agent/extensions/` (auto-discovery)
3. Global npm packages with `piPackage` keyword
4. Git repos cloned to specific directories

**Manifest Format:**
```json
{
  "name": "my-extension",
  "piPackage": {
    "type": "extension",
    "tools": ["toolName"],
    "commands": ["commandName"]
  },
  "main": "dist/index.js"
}
```

### Gotcha 2: Tool Override Semantics

Registering a tool with the same name as a default tool REPLACES it:

```typescript
// This REPLACES the default bash tool
pi.registerTool({
  name: "bash",
  // ... our implementation
});
```

**Implication:**
All bash calls now go through our code. We must maintain full compatibility or things break.

### Gotcha 3: Async Tool Execution

Tool `execute()` functions can be async but must handle:
- `signal` (AbortSignal) for cancellation
- `onUpdate()` for streaming output
- Timeout via the `timeout` parameter

```typescript
async execute(toolCallId, params, onUpdate, ctx, signal) {
  // Check for abort
  signal.addEventListener('abort', () => {
    cleanup();
  });
  
  // Stream output
  onUpdate({
    content: [{ type: "text", text: "partial output" }],
    details: { partial: true }
  });
}
```

### Gotcha 4: TUI vs Headless Mode

Extensions must handle both modes:
- **TUI mode:** `ctx.ui` exists, can show components
- **Headless mode:** `ctx.ui` is undefined, use console/logs

```typescript
if (ctx.ui?.custom) {
  // Show TUI component
} else {
  // Headless fallback
}
```

---

## 📚 Reference: Working Extension Pattern

Based on codemode (which works), here's the proven pattern:

### File Structure
```
extension/
├── package.json          # piPackage manifest
├── src/
│   └── index.ts         # Main entry point
├── dist/                # Compiled output
└── README.md            # Documentation
```

### package.json Template
```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "description": "What it does",
  "piPackage": {
    "type": "extension",
    "tools": ["myTool"],
    "commands": ["myCommand"]
  },
  "main": "dist/index.js",
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*"
  }
}
```

### Extension Entry Point Template
```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // Register tools
  pi.registerTool({
    name: "myTool",
    label: "My Tool",
    description: "What it does",
    parameters: Type.Object({...}),
    execute: async (toolCallId, params, onUpdate, ctx, signal) => {
      // Implementation
    }
  });
  
  // Register commands
  pi.registerCommand("mycommand", {
    description: "What it does",
    handler: async (args, ctx) => {
      // Implementation
    }
  });
  
  // Subscribe to events
  pi.on("session_start", async (event, ctx) => {
    // Initialization
  });
  
  pi.on("session_shutdown", async () => {
    // Cleanup
  });
}
```

---

## ⚠️ Common Errors and Solutions

### Error: "Failed to load extension: X is not a function"

**Cause:** Using non-existent API methods  
**Solution:** Check working extensions (codemode, etc.) for valid APIs

### Error: Extension loads but doesn't work

**Cause:** Tool/command name collision or loading order  
**Solution:** Check PI startup output for extension list, verify names are unique

### Error: Commands not appearing

**Cause:** Package.json `commands` array doesn't match registered command names  
**Solution:** Ensure `piPackage.commands` includes all registered command names

### Error: Tools not overriding defaults

**Cause:** Extension loaded before default tools, or wrong name  
**Solution:** Use exact same name as default tool (e.g., "bash"), load later in settings.json

---

## 🧪 Testing Strategy

### Manual Testing Checklist

1. **Startup Test**
   - [ ] PI loads without extension errors
   - [ ] Extension appears in `[Extensions]` list

2. **Tool Override Test**
   - [ ] Run a command, verify custom behavior
   - [ ] Check TUI appears (if applicable)

3. **Command Test**
   - [ ] Run `/yourcommand`
   - [ ] Verify it responds correctly

4. **Edge Cases**
   - [ ] Cancel running command (Ctrl+C)
   - [ ] Timeout behavior
   - [ ] Error handling

### Debug Techniques

```typescript
// Add logging to trace issues
console.log("Extension loaded");
console.log("Active tools:", pi.getActiveTools());
console.log("Event triggered:", event.type);
```

---

## 🔮 Future Considerations

### Cross-Platform Support

Current implementation is Windows-only (PowerShell). For Linux/Mac:

```typescript
// Platform detection
const platform = process.platform;

if (platform === 'win32') {
  // Use PowerShell jobs
} else {
  // Use nohup or disown
}
```

### Real-Time Output Streaming

Current implementation polls every 2 seconds. Better approach:
- Use WebSocket or EventSource
- Push notifications on job completion
- Watch file for changes (fs.watch)

### Configuration System

PI extensions should support user configuration:

```typescript
// Read from PI settings
const settings = pi.getSettings();
const timeout = settings["pi-background-bash"]?.timeout || 300;
```

---

## 📖 Resources for Future Agents

### Essential References

1. **Working Examples:**
   - `~/Documents/code/pi-codemode-fork/src/index.ts`
   - `~/.pi/agent/extensions/` (all installed extensions)

2. **PI Documentation:**
   - https://pi.dev/docs/extensions (if available)
   - Ask PI: "How do I create an extension?"

3. **Community Extensions:**
   - npm packages with `pi-package` keyword
   - GitHub repos tagged with `pi-extension`

### When Stuck

1. Look at codemode - it's complex but works
2. Check PI's startup output for extension loading messages
3. Verify API calls against working extensions
4. Use `console.log()` liberally for debugging
5. Remember: PI's API is minimal and specific

---

## 📝 Changelog of Learnings

### 2026-04-03 - Initial Documentation
- Documented mistakes with registerHook
- Documented package.json limitations
- Documented multiple config locations (.omp vs .pi)
- Documented TUI keyboard capture
- Documented process migration strategy

---

**For Future Agents:**

When working on this project:
1. Read this file FIRST
2. Check the actual PI API in codemode or other working extensions
3. Don't assume standard extension patterns
4. Test incrementally - verify each piece works
5. Update this file with new learnings

**Remember:** PI is minimal and opinionated. Less is more. Don't over-engineer.
