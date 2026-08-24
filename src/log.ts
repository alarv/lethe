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

export const LOG_PATH = join(homedir(), ".lethe", "lethe.log");

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

export function log(event: Event, detail: string, extra?: Record<string, unknown>): void {
  const parts = [new Date().toISOString(), event.padEnd(8), detail];
  if (extra && Object.keys(extra).length) {
    parts.push(Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" "));
  }
  const line = parts.join("  ") + "\n";

  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, line, "utf8");
  } catch {
    // Logging must never break the caller.
  }
  if (process.env.LETHE_DEBUG === "1") process.stderr.write(line);
}

export function tail(n = 40): string[] {
  if (!existsSync(LOG_PATH)) return [];
  return readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean).slice(-n);
}
