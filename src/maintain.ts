/**
 * Housekeeping for `~/.lethe`.
 *
 * The home directory is the one place lethe grows without anyone looking at it.
 * Nothing here was ever collected: dead project directories accumulated
 * forever, the log had no cap, and the index rebuilt rather than pruned. On the
 * author's machine that was eighteen project directories, ten of them
 * `/private/var/folders/.../tmp-xxxx` leftovers from test runs that will never
 * exist again.
 *
 * The rule that decides what may be removed automatically:
 *
 *   **Scaffolding is disposable. Markdown is not.**
 *
 * A directory holding no memories costs nothing to recreate, so it goes without
 * being mentioned. A directory holding memories is never touched automatically,
 * however dead its project looks -- a path that is missing today is just as
 * likely to be an unmounted volume, a moved checkout or a different machine as
 * it is to be a repository that was deleted. Losing memories to a filesystem
 * inference would be a far worse failure than keeping a stale directory, so
 * those are reported and wait for someone to say `lethe gc --dead`.
 *
 * Where it runs: from `compact()`, which the server already triggers on
 * pressure and which is already off the latency path. Cleanup therefore happens
 * as a side effect of use, in the same pass that decides what to forget --
 * which is the right place for it, since both are answering "what does not
 * deserve to survive".
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOG_PATH } from "./log.js";
import { letheHome, readSource } from "./store.js";

/** A project directory under `~/.lethe/projects/`. */
export interface ProjectDir {
  dir: string;
  /** The path it was keyed to, from its `source` file. */
  source: string | null;
  /** Memories in it. Zero is what makes a directory disposable. */
  files: number;
}

export interface Survey {
  /** No memories at all: safe to remove without asking. */
  empty: ProjectDir[];
  /** Has memories, but its project is no longer on disk. Reported only. */
  orphaned: ProjectDir[];
  /** Alive: its source path is still there. */
  live: ProjectDir[];
  logBytes: number;
  indexBytes: number;
  /** Everything under ~/.lethe. */
  totalBytes: number;
}

function bytes(path: string): number {
  let total = 0;
  let entries: string[];
  try {
    if (!statSync(path).isDirectory()) return statSync(path).size;
    entries = readdirSync(path);
  } catch {
    return 0;
  }
  for (const e of entries) total += bytes(join(path, e));
  return total;
}

function countMemories(dir: string): number {
  try {
    return readdirSync(join(dir, "memory")).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0; // no memory/ directory is the same answer as an empty one
  }
}

/**
 * What is in the home directory, and which of it is dead.
 *
 * Read-only and cheap: one readdir per project plus a stat walk for the sizes.
 * Nothing here decides anything -- `prune` does, and `lethe gc` and
 * `lethe doctor` both report from the same survey so they cannot disagree.
 */
export function survey(home = letheHome()): Survey {
  const root = join(home, "projects");
  const out: Survey = {
    empty: [], orphaned: [], live: [],
    logBytes: bytes(LOG_PATH) + bytes(`${LOG_PATH}.1`),
    indexBytes: ["index.db", "index.db-wal", "index.db-shm"]
      .reduce((n, f) => n + bytes(join(home, f)), 0),
    totalBytes: bytes(home),
  };

  let keys: string[];
  try {
    keys = readdirSync(root);
  } catch {
    return out;
  }

  for (const key of keys) {
    const dir = join(root, key);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const source = readSource(dir);
    const p: ProjectDir = { dir, source, files: countMemories(dir) };
    if (p.files === 0) out.empty.push(p);
    // No source file means an older layout wrote it and we cannot say whose it
    // is. Treated as live, because guessing wrong here costs memories.
    else if (source && !existsSync(source)) out.orphaned.push(p);
    else out.live.push(p);
  }
  return out;
}

/**
 * Remove what is safe to remove.
 *
 * `dead` opts into the directories whose projects are gone, which is never the
 * automatic behaviour -- see the note at the top of this file. Returns the
 * directories removed so a caller can report them; failures are ignored, since
 * a directory that could not be deleted is untidy rather than broken.
 */
export function prune(
  s: Survey,
  opts: { dead?: boolean; dryRun?: boolean } = {},
): string[] {
  const targets = [...s.empty, ...(opts.dead ? s.orphaned : [])];
  const removed: string[] = [];
  for (const p of targets) {
    if (!opts.dryRun) {
      try {
        rmSync(p.dir, { recursive: true, force: true });
      } catch {
        continue;
      }
    }
    removed.push(p.dir);
  }
  return removed;
}

export function human(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
