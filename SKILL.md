# SKILL: Background Bash Tool Usage

## Core Concept

This extension makes PI work like **Claude Code**:
- Commands run **blocking by default** (normal behavior)
- Press **Ctrl+B** during execution to **send to background**
- Use `/tasks` to manage background jobs

## When to Use Ctrl+B

### ALWAYS press Ctrl+B if:

1. **Command is taking too long**
   - npm install is still running after 2 minutes
   - Build process is ongoing
   - Tests are running

2. **You want to do something else while waiting**
   - "While that runs, can you check..."
   - "Let me look at the code while this builds"

3. **Auto-background kicks in** (after 5 minutes)
   - Extension automatically sends long commands to background
   - You'll see: "Auto-backgrounding..."

### Keep it BLOCKING if:

1. **Quick commands** (< 30 seconds)
   - `ls`, `git status`, `cat file.txt`
   - No need to background, just wait

2. **You need the result immediately for next step**
   - Getting a value to use in next command
   - Sequential dependent operations

3. **User explicitly says "wait for it"**
   - "Run npm test and wait for results"

## Workflow Examples

### Example 1: Background npm install

```
You: Run npm install
Agent: ⚡ Running: npm install
       ⏱  Elapsed: 1m 15s
       
       [You: Press Ctrl+B]
       
       🔄 Sent to background (Ctrl+B)
       Job ID: job-1743691234567-abc123xyz

You: While that runs, what files are in src/
Agent: <lists files while npm install runs>

You: Check if npm install finished
Agent: <runs /tasks>
       🟢 job-1743691234567-abc123xyz | completed | 3m 12s | npm install
       
       npm install completed successfully! 847 packages installed.
```

### Example 2: Auto-background after 5 minutes

```
You: Run npm run build
Agent: ⚡ Running: npm run build
       ⏱  Elapsed: 5m 0s
       
       Auto-backgrounding...
       
       🔄 Sent to background (timeout)
       Job ID: job-1743691234567-abc123xyz

You: What's taking so long?
Agent: <checks /tasks output job-1743691234567-abc123xyz>
       Build is still running, compiling TypeScript...
```

### Example 3: Dev server (must background)

```
You: Start the dev server
Agent: ⚡ Running: npm run dev
       ⏱  Elapsed: 0m 5s
       
       [You: Press Ctrl+B immediately]
       
       🔄 Sent to background (Ctrl+B)
       Job ID: job-1743691234567-abc123xyz
       
       Server running at http://localhost:3000

You: Open the main page in browser
Agent: <helps while server runs in background>
```

## User Prompts That Mean "Use Ctrl+B"

When user says these, **suggest Ctrl+B**:

- "This is taking too long"
- "Can we do something else while this runs?"
- "Let me check something while that runs"
- "Is there a way to run this in background?"
- "This is freezing the terminal"

## Managing Background Tasks

### After backgrounding a command, you should:

1. **Tell user the job ID**
2. **Suggest /tasks command**
3. **Offer to check status periodically**

Example response:

```
You: <npm install is taking a while>

Agent: 🔄 Sent to background (Ctrl+B)
       
       Job ID: job-1743691234567-abc123xyz
       Command: npm install
       Status: running in background
       
       You can:
       - Check all tasks with /tasks
       - View output with /tasks output job-1743691234567-abc123xyz
       - Kill it with /tasks kill job-1743691234567-abc123xyz
       
       What would you like to work on while that runs?
```

### Checking on tasks:

```
You: Is npm install done yet?

Agent: <runs /tasks>
       🟢 job-1743691234567-abc123xyz | completed | 5m 43s | npm install
       
       npm install completed successfully!
       Added 847 packages in 5m 43s
```

## Common Patterns

### Pattern 1: Install deps, then explore

```
You: Run npm install
Agent: ⚡ Running: npm install...
       [Ctrl+B after 30s]
       🔄 Sent to background

User: What files are in the project?

Agent: <lists files while npm install runs>
      
You: Check if npm install finished
Agent: 🟢 Completed! 847 packages installed.
```

### Pattern 2: Build and review code

```
You: Run npm run build
Agent: ⚡ Running: npm run build
       [Auto-backgrounds after 5min]
       🔄 Sent to background (timeout)

User: While that builds, can you review src/utils/helpers.ts?

Agent: <reviews code while build runs>

You: Is the build done?
Agent: 🟢 Completed! Build took 7m 12s, 0 errors.
```

### Pattern 3: Long-running tests

```
You: Run the full test suite
Agent: ⚡ Running: npm test
       ⏱  Elapsed: 2m 30s (running 847 tests)

User: This is taking a while, I'll check email

Agent: Want me to send this to background so you can keep working?
       Press Ctrl+B or I can background it for you.

[User presses Ctrl+B]

Agent: 🔄 Sent to background!
       Job ID: job-1743691234567-abc123xyz
       
       I'll check on the tests. What else can I help with?
```

## Important Notes

### Windows-Specific

- Background jobs run as **PowerShell jobs**
- Output saved to `%TEMP%\pi-background-bash\`
- No console windows pop up
- Works with Windows Terminal, cmd, PowerShell

### What Can't Be Backgrounded Well

1. **Interactive commands**
   - `git commit` (opens editor)
   - `npm init` (prompts for input)
   - Commands with `read` or prompts

2. **Commands depending on your shell environment**
   - Aliases won't work
   - Custom functions not available
   - Profile not loaded

3. **Very short commands**
   - `ls`, `pwd`, `echo` - no point in backgrounding

### Best Practices

1. **Don't preemptively background** - Wait to see if it's slow
2. **Suggest Ctrl+B when commands take > 1 minute**
3. **Offer to check status periodically**
4. **Always tell user the job ID when backgrounding**

## Commands Reference

```bash
# During command execution:
Ctrl+B          # Send to background
Ctrl+C          # Cancel/kill

# After backgrounding:
/tasks                      # List all tasks
/tasks output <id>          # View task output
/tasks kill <id>            # Stop a task
```

## Remember

> **Ctrl+B is your escape hatch.** When a command is taking too long and blocking work, press Ctrl+B to free up the terminal while keeping the command running.

Default behavior is blocking (like normal bash). Only background when:
- Command is slow (> 1-2 minutes)
- User wants to do something else
- Auto-background kicks in (5 minutes)

The user is always in control - they can press Ctrl+B anytime, or you can suggest it when appropriate.
