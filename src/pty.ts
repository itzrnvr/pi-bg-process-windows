/**
 * PTY support — dynamic load of node-pty with graceful fallback.
 *
 * Shipping strategy: node-pty's entire module is copied to native/ directory
 * alongside the bundled dist/index.js. At runtime, we set NODE_PATH to point
 * to the prebuilds directory so the native .node binaries are found, then
 * require the JS wrapper.
 *
 * When node-pty is available, processes get a real PTY (ConPTY on Windows).
 * The agent can "peek" at terminal output and "input" text to stdin.
 * When not available, falls back to regular spawn with piped stdio.
 */

import * as path from "node:path";

/** Resolve the native directory relative to this file's location at runtime */
function findNativeDir(): string | null {
  // __dirname in the bundled file points to where dist/index.js lives
  const candidates = [
    path.join(__dirname, "native"),
    path.join(__dirname, "..", "native"),
  ];

  for (const dir of candidates) {
    try {
      const { existsSync } = require("node:fs") as typeof import("node:fs");
      if (existsSync(path.join(dir, "package.json"))) return dir;
    } catch { /* ignore */ }
  }
  return null;
}

/** Load node-pty — try shipped native/ first, then node_modules fallback */
function loadPty(): { spawn: (file: string, args: string | string[], options: any) => any } | null {
  // 1. Try shipped native/ directory
  const nativeDir = findNativeDir();
  if (nativeDir) {
    try {
      // Set NODE_PATH so prebuild-install finds the .node binaries
      const prebuildDir = path.join(nativeDir, "prebuilds", "win32-x64");
      const { existsSync } = require("node:fs") as typeof import("node:fs");
      if (existsSync(prebuildDir)) {
        process.env.NODE_PATH = [prebuildDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
        // Force Module._initPaths to re-resolve with new NODE_PATH
        (require("node:module") as any)._initPaths();
      }
      const pty = require(path.join(nativeDir, "lib", "index.js"));
      if (typeof pty.spawn === "function") return pty;
    } catch { /* corrupted install, try fallback */ }
  }

  // 2. Try node_modules (user installed globally)
  try {
    const pty = require("node-pty");
    if (typeof pty.spawn === "function") return pty;
  } catch { /* not installed */ }

  return null;
}

const ptyModule = loadPty();

/** Whether node-pty loaded successfully */
export const ptyAvailable: boolean = ptyModule !== null;

/** Typed PTY spawn function — null if PTY unavailable */
export const ptySpawn: ((file: string, args: string | string[], options: any) => any) | null =
  ptyModule ? ptyModule.spawn : null;

/** Strip ANSI escape sequences from terminal output */
export function stripAnsi(str: string): string {
  return str
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[\?[0-9]+[hl]/g, "")   // DEC private modes: ?25h, ?1004h
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")  // CSI sequences: colors, cursor
    .replace(/\x1b\][^\x07\x1b]*[\x07\x1b]/g, "") // OSC sequences
    .replace(/\x1b\(B/g, "")                 // Charset designations
    .replace(/\x1b\][^\x07\x1b]*[\x07\x1b]/g, "") // OSC sequences (title)
    .replace(/\r\n/g, "\n")                  // Normalize line endings
    .replace(/\r/g, "")                      // Carriage returns
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""); // Control characters
}
