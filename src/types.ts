import { spawn } from "node:child_process";

export interface BgProcess {
  pid: number;
  command: string;
  logFile: string;
  startedAt: number;
  finished: boolean;
  exitCode: number | null;
  cwd: string;
  lastOutputAt: number;
  lastOutputSize: number;
  isStalled: boolean;
  stallWarningSent: boolean;
  /** Rolling buffer of recent output lines (for peek action) */
  outputBuffer: string[];
  /** Whether this process was spawned with PTY (node-pty) */
  isPty: boolean;
  /** For delta tracking */
  previousOutputHash?: string;
  /** Internal: cleanup timers + streams + listeners */
  _cleanup?: () => void;
  /** Internal: whether completion notification was already sent */
  _notified?: boolean;
  /** Internal: PTY process handle (only set in PTY mode) */
  _ptyProcess?: any;
}

export interface PersistedBgState {
  customType: "bgProcessPersisted";
  processes: Array<{
    pid: number;
    command: string;
    logFile: string;
    startedAt: number;
    cwd: string;
  }>;
}

export interface ExecResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

export interface ActiveForegroundProcess {
  pid: number;
  command: string;
  cwd: string;
  child: ReturnType<typeof spawn>;
  onManualBackground: () => void;
  abortController: AbortController;
}
