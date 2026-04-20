/** Sync-mode timeout - auto-background after this (milliseconds) */
export const SYNC_TIMEOUT_MS = 60_000;

/** Max in-memory buffer before backgrounding (bytes) */
export const MAX_BUFFER = 512 * 1024;

/** Temp directory for background process logs */
export const BG_TEMP_DIR = (() => {
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  return join(tmpdir(), "pi-bg");
})();

/** Time without output before flagging as slow/stalled (milliseconds) */
export const STALL_THRESHOLD_MS = 30_000;

/** Debounce for progress updates (ms) */
export const PROGRESS_DEBOUNCE_MS = 2_000;

/** Max background process entries in memory */
export const MAX_BG_PROCESSES = 50;

/** Max lines kept in the rolling output buffer per process */
export const OUTPUT_BUFFER_MAX_LINES = 500;

/** PTY terminal dimensions for spawned processes */
export const PTY_COLS = 120;
export const PTY_ROWS = 40;
