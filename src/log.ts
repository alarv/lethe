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
 *
 * It is off by default. Appending forever to a file in someone's home directory
 * is not a diagnostic, it is a leak -- nothing rotated it, nothing capped it,
 * and nobody asked for it. `lethe init --debug` turns it on for this machine and
 * `LETHE_DEBUG=1` for a single run. Everything derived from the log --
 * `lethe metrics`, and the adoption rows in `status` and `doctor` -- then says
 * that logging is off rather than reporting zero activity, because "nothing was
 * recorded" and "nothing was written down" are different answers and only one of
 * them is a problem.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build stamp of the running code.
 *
 * MCP servers are long-lived child processes: a rebuild does not reach one that
 * is already running, so a harness can keep serving code from hours earlier with
 * no outward sign. Logging this at startup lets `lethe status` say so.
 */
export function buildStamp(): string {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtime.toISOString();
  } catch {
    return "unknown";
  }
}

/** Mirrors store.letheHome(); kept here to avoid a cycle. */
function home(): string {
  return process.env.LETHE_HOME || join(homedir(), ".lethe");
}

export const LOG_PATH = join(home(), "lethe.log");

/** One rotation, so the worst case is two files rather than unbounded growth. */
const MAX_BYTES = 512 * 1024;

/**
 * Whether the log file is written at all.
 *
 * Read straight out of config.json rather than through config.ts, which imports
 * store.ts and would close an import cycle. Cached against the home path it was
 * read from, so tests that repoint LETHE_HOME are not answered from a stale
 * decision.
 */
let cached: { home: string; on: boolean } | undefined;

export function logging(): boolean {
  if (process.env.LETHE_DEBUG === "1") return true;
  const h = home();
  if (cached?.home !== h) {
    let on = false;
    try {
      const raw = JSON.parse(readFileSync(join(h, "config.json"), "utf8")) as { log?: unknown };
      on = raw?.log === true;
    } catch {
      on = false; // no config, or an unreadable one, means off
    }
    cached = { home: h, on };
  }
  return cached.on;
}

/**
 * Bytes in the current file, tracked in this process.
 *
 * Sized once from disk and then counted in memory, so an active server does not
 * stat the log on every line. Per-session MCP servers each keep their own count
 * and so may rotate at slightly different moments; for a debug log that is
 * cheaper than the coordination it would take to avoid.
 */
let written: number | undefined;
/** Which file `written` counts, so repointing LETHE_HOME re-sizes rather than
 *  carrying a total from a file in a different directory. */
let counting: string | undefined;

function rotate(path: string, add: number): void {
  if (written === undefined || counting !== path) {
    try {
      written = existsSync(path) ? statSync(path).size : 0;
    } catch {
      written = 0;
    }
    counting = path;
  }
  written += add;
  if (written <= MAX_BYTES) return;
  try {
    renameSync(path, `${path}.1`);
  } catch {
    /* another process may have just rotated it; either way the next write is fine */
  }
  written = 0;
}

export type Event =
  | "start"
  | "recall"
  | "note"
  | "confirm"
  | "correct"
  | "forget"
  | "compact"
  | "learn"
  | "index"
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

  if (logging()) {
    try {
      const p = logPath();
      mkdirSync(dirname(p), { recursive: true });
      rotate(p, Buffer.byteLength(line));
      appendFileSync(p, line, "utf8");
    } catch {
      // Logging must never break the caller.
    }
  }
  if (process.env.LETHE_DEBUG === "1") process.stderr.write(line);
}

export function tail(n = 40): string[] {
  const p = logPath();
  const read = (path: string): string[] => {
    try {
      return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
    } catch {
      return [];
    }
  };
  const current = read(p);
  // Reach into the rotated file only when the current one cannot answer, so a
  // rotation does not make `lethe log` and `lethe metrics` look like a reset.
  if (current.length >= n) return current.slice(-n);
  return [...read(`${p}.1`), ...current].slice(-n);
}
