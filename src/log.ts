/**
 * Logging.
 *
 * stdout is the MCP transport -- anything written there corrupts the JSON-RPC
 * stream and the host drops the connection. So logs go to a file, and to stderr
 * only when explicitly enabled.
 *
 * This exists because a memory harness that is silent is indistinguishable from
 * one that is never called, which is the single most likely failure while
 * dogfooding: the tools are registered, the agent ignores them, and the store
 * stays empty with no indication why.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Mirrors store.letheHome(); kept here to avoid a cycle. */
function home(): string {
  return process.env.LETHE_HOME || join(homedir(), ".lethe");
}

export const LOG_PATH = join(home(), "lethe.log");

export type Event =
  | "start"
  | "recall"
  | "note"
  | "confirm"
  | "correct"
  | "forget"
  | "compact"
  | "sampling"
  | "error";

function logPath(): string {
  return join(home(), "lethe.log");
}

export function log(event: Event, detail: string, extra?: Record<string, unknown>): void {
  const parts = [new Date().toISOString(), event.padEnd(8), detail];
  if (extra && Object.keys(extra).length) {
    parts.push(Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" "));
  }
  const line = parts.join("  ") + "\n";

  try {
    const p = logPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, line, "utf8");
  } catch {
    // Logging must never break the caller.
  }
  if (process.env.LETHE_DEBUG === "1") process.stderr.write(line);
}

export function tail(n = 40): string[] {
  const p = logPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).slice(-n);
}
