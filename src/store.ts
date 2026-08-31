/**
 * Memory store.
 *
 * Markdown files are the source of truth (docs/architecture.md § Storage).
 * There is deliberately no database yet: capture has to work before retrieval
 * quality is worth optimising, and the markdown is what a future index would be
 * built from anyway.
 *
 * Retrieval here is naive keyword scoring. That is a known-weak placeholder,
 * not the design -- see docs/architecture.md § Embeddings.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MemoryIndex, type IndexFile } from "./index-db.js";
import { rank } from "./rank.js";
import { log } from "./log.js";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

/**
 * Where a memory lives, which is derived rather than chosen.
 *
 *   claims, patterns  <repo>/.lethe/memory/     — beside the code they describe
 *   episodes          ~/.lethe/projects/<key>/  — your scratchpad, never in a repo
 *
 * There is no scope to pass and nothing to configure: what a memory *is* decides
 * where it goes. Whether anyone else can read the claims is a separate question,
 * answered by `.lethe/.gitignore` -- see config.ts § ignoreInGit.
 *
 * One word used to answer both questions at once, and could not. `local` and
 * `personal` differed only in reach, which neither word said; `team` claimed
 * sharing that a .gitignore line could silently revoke. Deriving the path
 * deleted the question instead of renaming it.
 */

/** Episodic = what happened. Semantic = what is true. Procedural = how we do things. */
export type Kind = "episode" | "claim" | "pattern";

export interface Memory {
  id: string;
  kind: Kind;
  title: string;
  body: string;
  tags: string[];
  files: string[];
  /** How much this deserves to survive. docs/architecture.md § Salience. */
  salience: number;
  /** Erodes on decay, reinforced on access. */
  strength: number;
  /** When decay was last applied. Decay measures elapsed time since this, not
   *  since `updated`, so running compaction twice does not decay twice. */
  decayedAt: string;
  accessCount: number;
  created: string;
  updated: string;
  lastAccessed: string | null;
  /** Episode ids this claim was distilled from. */
  provenance: string[];
  /** Set when a memory is corrected rather than deleted. */
  supersededBy: string | null;
  /** Who recorded it. Shared memory needs attribution to be reviewable. */
  author: string;
  /** Set only on results borrowed from another project. */
  fromProject?: string;
  /** Distinct people who found it accurate. Corroboration, not a hit count. */
  confirmedBy: string[];
}

// ---------------------------------------------------------------- locations

/** Walk up to the nearest .git, so memory attaches to the repo, not the cwd. */
/**
 * Who is recording this.
 *
 * git config first, since shared memory shows up in review and should match the
 * commit history. Resolved once: shelling out on every write would be silly.
 */
let cachedAuthor: string | null = null;
export function author(cwd = process.cwd()): string {
  if (cachedAuthor !== null) return cachedAuthor;
  try {
    cachedAuthor = execFileSync("git", ["config", "user.email"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    cachedAuthor = "";
  }
  if (!cachedAuthor) cachedAuthor = `${process.env.USER ?? "unknown"}@${hostname()}`;
  return cachedAuthor;
}

export function findProjectRoot(start = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Directory name for a project's store.
 *
 * The full path, slugified. Using only the basename would collide -- everyone
 * has more than one repo called `api` -- and appending a hash to the basename
 * fixes that at the cost of being unreadable, which matters because you end up
 * looking at these directories when something goes wrong. Encoding the whole
 * path is unique by construction and stays legible. Same convention as
 * ~/.claude/projects.
 */
export function projectKey(root: string): string {
  return root.replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "").toLowerCase();
}

/** The pre-0.1 name: basename plus a hash of the path. */
function legacyProjectKey(root: string): string {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  const name = root.split("/").filter(Boolean).pop() ?? "project";
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${hash}`;
}

/**
 * Move a store from the old hashed name if it is still there. Renaming on read
 * keeps existing memories reachable without asking anyone to run a migration.
 */
function migrate(home: string, root: string): void {
  const from = join(home, "projects", legacyProjectKey(root));
  const to = join(home, "projects", projectKey(root));
  if (from === to || !existsSync(from)) return;
  try {
    if (!existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      return;
    }
    // Merge rather than skip. A server running older code can recreate the old
    // directory after the rename, and skipping would strand those memories
    // somewhere nothing looks again.
    const fromMem = join(from, "memory");
    const toMem = join(to, "memory");
    if (existsSync(fromMem)) {
      mkdirSync(toMem, { recursive: true });
      for (const f of readdirSync(fromMem)) {
        if (!existsSync(join(toMem, f))) renameSync(join(fromMem, f), join(toMem, f));
      }
      if (!readdirSync(fromMem).length) rmSync(from, { recursive: true, force: true });
    }
  } catch {
    // Leave the old directory alone if the move fails; nothing is lost.
  }
}

/**
 * Root for all stored memory.
 *
 * LETHE_HOME exists so tests never touch a real store. Without it, a test that
 * cleans up after itself deletes whatever the user was actually relying on --
 * which is not hypothetical: it happened twice during development.
 */
export function letheHome(): string {
  return process.env.LETHE_HOME || join(homedir(), ".lethe");
}

/**
 * Record which directory a store belongs to.
 *
 * The key is the path with separators flattened, which is readable but not
 * reversible -- "a.arvanitidis" and "a/arvanitidis" flatten identically. Writing
 * the original alongside means tooling can show the real path instead of
 * guessing at one.
 */
function recordSource(dir: string, root: string): void {
  try {
    const f = join(dir, "source");
    if (existsSync(f)) return;
    mkdirSync(dir, { recursive: true });
    atomicWrite(f, root + "\n");
  } catch {
    // Cosmetic; never block a write on it.
  }
}

export function readSource(dir: string): string | null {
  try {
    return readFileSync(join(dir, "source"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Your scratchpad, and the fallback for everything when there is no repository.
 *
 * Keyed to the project rather than pooled across all of them, because episodes
 * are numerous and specific to the code that produced them. Nothing is lost by
 * not having a cross-project store: `otherProjects()` already reaches next door
 * when this one has little to say.
 */
export function episodeDir(cwd = process.cwd()): string {
  const home = letheHome();
  // Falls back to the working directory when there is no repo. Throwing here
  // made list() return empty and recall silently answer nothing -- the agent
  // asked four times, got zero hits, and had no way to see why.
  const base = findProjectRoot(cwd) ?? cwd;
  migrate(home, base);
  const dir = join(home, "projects", projectKey(base));
  recordSource(dir, base);
  return join(dir, "memory");
}

/**
 * Where consolidated claims go: beside the code they describe.
 *
 * In the repository whenever there is one, committed or not. That is what makes
 * the sharing decision free to change -- flipping it is two characters in
 * `.lethe/.gitignore` and not one file moves. The previous design put private
 * claims in ~/.lethe instead, so changing your mind meant relocating every file
 * and hoping none was lost on the way.
 */
export function claimDir(cwd = process.cwd()): string {
  const root = findProjectRoot(cwd);
  return root ? join(root, ".lethe", "memory") : episodeDir(cwd);
}

/**
 * `~/.lethe/memory/`, which nothing writes to any more.
 *
 * Still read, so claims written under the old cross-project scope stay findable
 * rather than being silently orphaned. `lethe doctor` points at it when it has
 * anything in it.
 */
export function legacyClaimDir(): string {
  return join(letheHome(), "memory");
}

// ---------------------------------------------------------- serialisation
// Deliberately hand-rolled rather than pulling in a YAML dependency: we own
// both sides of this format and it is a fixed, flat set of scalars and lists.

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
function unesc(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}

/**
 * Only what is durable and worth sharing.
 *
 * strength, accessCount, lastAccessed and decayedAt describe *your* relationship
 * with a memory, not the memory, and they change on every recall. Keeping them
 * here meant a single lookup rewrote three lines of a committed file, so any two
 * people reading the same memory conflicted on the same lines every time. They
 * live in a per-machine sidecar instead -- see Dynamics.
 */
export function serialize(m: Memory): string {
  const fm = [
    `id: ${m.id}`,
    `kind: ${m.kind}`,
    `title: ${esc(m.title)}`,
    `tags: ${m.tags.join(", ")}`,
    `files: ${m.files.join(", ")}`,
    `salience: ${m.salience}`,
    `created: ${m.created}`,
    `updated: ${m.updated}`,
    `author: ${m.author}`,
    `provenance: ${m.provenance.join(", ")}`,
    `supersededBy: ${m.supersededBy ?? ""}`,
  ].join("\n");
  return `---\n${fm}\n---\n\n${m.body}\n`;
}

/**
 * Walk supersession to the memory an id now means.
 *
 * A successor that is missing -- evicted, or in a project we did not load --
 * ends the walk where it is: a cold memory is worse than its replacement but far
 * better than nothing. The seen set is for cycles, which the data should never
 * contain and which must not hang retrieval if it does.
 */
export function follow(from: Memory, byId: Map<string, Memory>): Memory {
  let at = from;
  const seen = new Set<string>([from.id]);
  while (at.supersededBy) {
    const next = byId.get(at.supersededBy);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    at = next;
  }
  return at;
}

export function parse(text: string): Memory | null {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const [, fmBlock, body] = match;
  const f: Record<string, string> = {};
  for (const line of (fmBlock ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    f[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const list = (v: string | undefined) =>
    (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  if (!f.id) return null;
  return {
    id: f.id,
    kind: (f.kind as Kind) ?? "episode",
    title: unesc(f.title ?? ""),
    body: (body ?? "").trim(),
    tags: list(f.tags),
    files: list(f.files),
    salience: Number(f.salience ?? 0.5),
    strength: Number(f.strength ?? 1),
    decayedAt: f.decayedAt || f.created || new Date().toISOString(),
    accessCount: Number(f.accessCount ?? 0),
    created: f.created ?? new Date().toISOString(),
    updated: f.updated ?? new Date().toISOString(),
    lastAccessed: f.lastAccessed ? f.lastAccessed : null,
    provenance: list(f.provenance),
    supersededBy: f.supersededBy ? f.supersededBy : null,
    author: f.author ?? "",
    confirmedBy: [], // merged in from the sidecar on read
  };
}

// ----------------------------------------------------------------- storage

/**
 * Write via a temp sibling and rename.
 *
 * rename(2) is atomic on the same filesystem, so a concurrent reader sees either
 * the old file or the new one, never a half-written one -- and two servers
 * racing on the same path cannot interleave. Different sessions spawn different
 * servers, so this is not hypothetical.
 */
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, file);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) ||
    "memory";
}

/** Per-memory state that belongs to this machine, not to the team. */
interface Dyn {
  strength: number;
  accessCount: number;
  lastAccessed: string | null;
  decayedAt: string;
  /** Distinct people who confirmed this on this machine. */
  confirmedBy?: string[];
}

/**
 * Sidecar for the mutable half of a memory.
 *
 * Always under $LETHE_HOME, never in the repository, so recall and decay never
 * touch a tracked file. Decay is also genuinely personal: a memory you rely on
 * daily should not be weakened because a colleague never opens it.
 */
class Dynamics {
  private data: Record<string, Dyn> = {};
  private loaded = false;

  constructor(private readonly file: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Dyn>;
    } catch {
      this.data = {};
    }
  }

  get(id: string, created: string): Dyn {
    this.load();
    return this.data[id] ?? {
      strength: 1,
      accessCount: 0,
      lastAccessed: null,
      decayedAt: created,
      confirmedBy: [],
    };
  }

  set(id: string, d: Dyn): void {
    this.load();
    this.data[id] = d;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // Re-read before writing: another server may have recorded a confirmation
      // since we loaded, and a blind overwrite would drop it. Merge confirmer
      // lists rather than clobbering.
      this.mergeExternal();
      atomicWrite(this.file, JSON.stringify(this.data, null, 0));
    } catch {
      // Losing reinforcement is survivable; failing a recall is not.
    }
  }

  drop(id: string): void {
    this.load();
    delete this.data[id];
    try {
      atomicWrite(this.file, JSON.stringify(this.data, null, 0));
    } catch {
      /* ignore */
    }
  }

  /** Fold in confirmations another process wrote since we loaded. */
  private mergeExternal(): void {
    let disk: Record<string, Dyn>;
    try {
      disk = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Dyn>;
    } catch {
      return;
    }
    for (const [id, d] of Object.entries(disk)) {
      const mine = this.data[id];
      if (!mine) {
        this.data[id] = d;
        continue;
      }
      const union = new Set([...(mine.confirmedBy ?? []), ...(d.confirmedBy ?? [])]);
      mine.confirmedBy = [...union];

      // These only ever increase, so max is the right merge.
      mine.accessCount = Math.max(mine.accessCount, d.accessCount);
      if ((d.lastAccessed ?? "") > (mine.lastAccessed ?? "")) {
        mine.lastAccessed = d.lastAccessed;
      }

      // Strength is NOT monotonic: reinforcement raises it and decay lowers it.
      // Max-merging it silently discarded every decay, which is why nothing ever
      // reached the cold threshold and why a project named for forgetting never
      // forgot. Decay was computed, reported as decayed, and thrown away here.
      //
      // decayedAt marks the epoch a strength belongs to, so the newer epoch wins
      // outright. Within one epoch both values are reinforcements, and max is
      // right again. A reinforcement racing a decay in a different epoch is lost,
      // which is acceptable: it is re-earned on the next access, whereas a lost
      // decay is permanent.
      const mineAt = Date.parse(mine.decayedAt);
      const theirsAt = Date.parse(d.decayedAt);
      if (theirsAt > mineAt) {
        mine.strength = d.strength;
        mine.decayedAt = d.decayedAt;
      } else if (theirsAt === mineAt) {
        mine.strength = Math.max(mine.strength, d.strength);
      }
    }
  }
}

export class Store {
  private readonly dyn: Dynamics;

  constructor(private readonly cwd = process.cwd()) {
    const root = findProjectRoot(cwd) ?? cwd;
    this.dyn = new Dynamics(
      join(letheHome(), "projects", projectKey(root), "dynamics.json"),
    );
    this.relocateEpisodes();
  }

  /**
   * Move episodes out of the repository.
   *
   * Earlier versions let any memory be written into the repository, so repos
   * picked up private scratchpad entries that would otherwise reach a commit.
   * Runs once per store: cheap when there is nothing to move.
   */
  private relocateEpisodes(): void {
    const root = findProjectRoot(this.cwd);
    if (!root) return; // no repository; nothing to relocate
    const from = join(root, ".lethe", "memory");
    if (!existsSync(from)) return;
    let moved = 0;
    try {
      for (const name of readdirSync(from)) {
        if (!name.endsWith(".md")) continue;
        const path = join(from, name);
        const m = parse(readFileSync(path, "utf8"));
        if (!m || m.kind !== "episode") continue;
        const to = join(episodeDir(this.cwd), name);
        mkdirSync(dirname(to), { recursive: true });
        if (!existsSync(to)) renameSync(path, to);
        else rmSync(path, { force: true });
        moved += 1;
      }
      if (moved && !readdirSync(from).length) rmSync(from, { recursive: true, force: true });
    } catch {
      // Best effort; leaving them in place is not harmful, only untidy.
    }
  }

  /**
   * Where a memory belongs, decided by what it is rather than by what a caller
   * asked for.
   *
   * Episodes are a private scratchpad -- verbose, numerous, and deleted by
   * compaction -- so sharing them is what makes shared memory unusable: three
   * hundred people's scratchpads is noise, not knowledge. Claims and patterns
   * are what survived, and are the only things worth anyone else reading.
   */
  private dirFor(m: Memory): string {
    return m.kind === "episode" ? episodeDir(this.cwd) : claimDir(this.cwd);
  }

  private pathFor(m: Memory): string {
    const dir = this.dirFor(m);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${m.id.slice(0, 8)}-${slug(m.title)}.md`);
  }

  private read(dir: string): Memory[] {
    const out: Memory[] = [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return out; // nothing has been written there; not an error
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const m = parse(readFileSync(join(dir, name), "utf8"));
      if (!m) continue;
      const d = this.dyn.get(m.id, m.created);
      Object.assign(m, d);
      m.confirmedBy = d.confirmedBy ?? [];
      out.push(m);
    }
    return out;
  }

  /**
   * Everything readable from here, uniqued by directory.
   *
   * Outside a repository claims and episodes share one directory, so the paths
   * have to be deduplicated or every memory comes back twice.
   */
  all(): Memory[] {
    return this.myDirs().flatMap((d) => this.read(d));
  }

  /**
   * Resolve an id, following it forward if the memory no longer exists.
   *
   * Two things legitimately move an id: compaction consumes episodes into a
   * claim, and `correct` supersedes a memory. In both cases the agent may still
   * be holding the old id, so fall back to whichever memory cites it in
   * `provenance` -- that is what provenance is for. Without this, acting on a
   * recalled memory fails for reasons the agent cannot see or fix.
   */
  get(id: string): Memory | null {
    const all = this.all();
    const found = all.find((m) => m.id === id || m.id.startsWith(id))
      ?? all.find((m) => m.provenance.some((p) => p === id || p.startsWith(id)));
    return found ? follow(found, new Map(all.map((m) => [m.id, m]))) : null;
  }

  write(m: Memory): Memory {
    atomicWrite(this.pathFor(m), serialize(m));
    this.saveDynamics(m);
    return m;
  }

  /**
   * Delete exactly what was named, without following supersession.
   *
   * `get` answers "what does this id mean now", which is what an agent holding
   * an id from an earlier recall needs. Forget is the one caller that must not
   * have that: asked to delete a memory, deleting its replacement instead would
   * be the worst possible reading of the request.
   */
  remove(id: string): boolean {
    const m = this.all().find((x) => x.id === id || x.id.startsWith(id));
    if (!m) return false;
    rmSync(this.pathFor(m), { force: true });
    this.dyn.drop(m.id);
    return true;
  }

  create(input: {
    title: string;
    body: string;
    kind?: Kind;
    tags?: string[];
    files?: string[];
    salience?: number;
    provenance?: string[];
  }): Memory {
    const now = new Date().toISOString();
    return this.write({
      id: randomUUID(),
      kind: input.kind ?? "episode",
      title: input.title,
      body: input.body,
      tags: input.tags ?? [],
      files: input.files ?? [],
      salience: input.salience ?? 0.5,
      strength: 1,
      decayedAt: now,
      accessCount: 0,
      created: now,
      updated: now,
      lastAccessed: null,
      provenance: input.provenance ?? [],
      supersededBy: null,
      author: author(this.cwd),
      confirmedBy: [],
    });
  }

  /**
   * Reinforcement on access -- potentiation, docs/brain.md §5. Retrieval is a
   * write, which is also what makes reconsolidation possible at all.
   */
  touch(m: Memory, amount = 0.1): Memory {
    m.accessCount += 1;
    m.strength = Math.min(2, m.strength + amount);
    m.lastAccessed = new Date().toISOString();
    // Reinforcement is per-machine, so this must not rewrite the shared file.
    this.saveDynamics(m);
    return m;
  }

  /** Persist only the per-machine half. */
  saveDynamics(m: Memory): void {
    this.dyn.set(m.id, {
      strength: m.strength,
      accessCount: m.accessCount,
      lastAccessed: m.lastAccessed,
      decayedAt: m.decayedAt,
      confirmedBy: m.confirmedBy,
    });
  }

  /**
   * Record that someone found a memory accurate. Corroboration, not a counter:
   * the same person confirming twice is one voice, three different people is
   * team knowledge (docs/architecture.md § Attribution). Returns the distinct
   * count so a caller can act on it.
   */
  confirm(m: Memory, who: string): number {
    const set = new Set(m.confirmedBy);
    set.add(who);
    m.confirmedBy = [...set];
    m.strength = Math.min(2, m.strength + 0.4);
    m.accessCount += 1;
    m.lastAccessed = new Date().toISOString();
    this.saveDynamics(m);
    return m.confirmedBy.length;
  }

  /**
   * Every other project's memories.
   *
   * Repositories are not the same thing as problems. A service, its infra repo
   * and its client are one system to the person working on them, and a lesson
   * learned in one is routinely needed in another -- so when the current project
   * has little to say, it is better to look next door than to answer nothing.
   * Results are marked so their origin is visible rather than implied.
   */
  private otherProjects(): Memory[] {
    const projects = join(letheHome(), "projects");
    const mine = findProjectRoot(this.cwd) ?? this.cwd;
    const out: Memory[] = [];
    let dirs: string[];
    try {
      dirs = readdirSync(projects);
    } catch {
      return out;
    }
    for (const key of dirs) {
      const source = readSource(join(projects, key));
      if (source === mine) continue;
      const mem = join(projects, key, "memory");
      if (!existsSync(mem)) continue;
      for (const name of readdirSync(mem)) {
        if (!name.endsWith(".md")) continue;
        try {
          const m = parse(readFileSync(join(mem, name), "utf8"));
          if (!m) continue;
          m.fromProject = source ?? key;
          out.push(m);
        } catch {
          /* skip unreadable */
        }
      }
    }
    return out;
  }

  /**
   * Every candidate file, described without being read.
   *
   * This is the enumeration the index diffs against. It stats rather than
   * parses, because the point is to discover what changed without paying for
   * what did not: reading the whole cross-project corpus was costing 4.4 seconds
   * per recall on a 36,000-memory store, and stat-ing it costs 120ms.
   */
  private indexFiles(): IndexFile[] {
    const out: IndexFile[] = [];
    const add = (dir: string, project: string) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        const path = join(dir, name);
        try {
          const st = statSync(path);
          out.push({ path, mtimeMs: st.mtimeMs, size: st.size, project });
        } catch {
          /* vanished between readdir and stat; it is simply not there */
        }
      }
    };

    // "" marks this project. Anything else is a borrowed memory, which the
    // ranker discounts -- so the distinction has to survive into the index.
    for (const dir of this.myDirs()) add(dir, "");
    const projects = join(letheHome(), "projects");
    const mine = findProjectRoot(this.cwd) ?? this.cwd;
    let keys: string[];
    try {
      keys = readdirSync(projects);
    } catch {
      return out;
    }
    for (const key of keys) {
      const source = readSource(join(projects, key));
      if (source === mine) continue;
      add(join(projects, key, "memory"), source ?? key);
    }
    return out;
  }

  /** The directories this project reads as its own. */
  private myDirs(): string[] {
    return [...new Set([episodeDir(this.cwd), claimDir(this.cwd), legacyClaimDir()])];
  }

  /**
   * Read one memory off disk, with the trimmings the caller's project needs.
   *
   * Dynamics are merged only for our own memories, because dynamics.json is
   * per-project: another project's strengths are not ours to apply, and reading
   * eighteen sidecars to rank eight results would give back the cost this whole
   * change removed.
   */
  private load(path: string, project: string): Memory | null {
    let m: Memory | null;
    try {
      m = parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
    if (!m) return null;
    if (project) {
      m.fromProject = project;
      return m;
    }
    const d = this.dyn.get(m.id, m.created);
    Object.assign(m, d);
    m.confirmedBy = d.confirmedBy ?? [];
    return m;
  }

  private score(m: Memory, tokens: string[], paths: string[]): number {
    const title = m.title.toLowerCase();
    const body = m.body.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (m.tags.some((tag) => tag.toLowerCase() === t)) score += 5;
      if (title.includes(t)) score += 3;
      if (m.files.some((f) => f.toLowerCase().includes(t))) score += 2;
      if (body.includes(t)) score += 1;
    }
    if (m.kind === "claim") score *= 1.5; // distilled beats raw
    if (m.kind === "pattern") score *= 1.5;
    // Memories about the code in front of you are likelier to be the ones
    // wanted. In a large repository this is the difference between every claim
    // and the handful that are relevant.
    if (paths.length && m.files.length) {
      const overlap = m.files.some((f) =>
        paths.some((p) => f.includes(p) || p.includes(f)));
      if (overlap) score *= 2;
    }
    return score * m.strength;
  }

  /**
   * Token-overlap retrieval, weighted by field.
   *
   * Retained rather than deleted: it is the fallback when node:sqlite is
   * unavailable or the index cannot be opened, and the eval needs both
   * mechanisms in order to attribute an improvement to BM25 rather than to the
   * other retrieval changes landing alongside it.
   */
  searchNaive(query: string, limit = 8, paths: string[] = []): Memory[] {
    const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    const rank = (pool: Memory[]) =>
      pool
        .filter((m) => !m.supersededBy)
        .map((m) => ({ m, score: this.score(m, tokens, paths) }))
        .filter((r) => r.score > 0)
        // Ties break on content, not on the order the filesystem returned files
        // in and not on id -- ids are random, so an id tiebreak is only stable
        // within a single run. Without this, the same query can rank differently
        // on another machine, and an eval cannot be reproduced.
        .sort((a, b) => b.score - a.score || a.m.title.localeCompare(b.m.title));

    const here = rank(this.all()).slice(0, limit);
    if (here.length >= limit) return here.map((r) => r.m);

    // Top up from neighbouring projects, discounted so anything here wins.
    const elsewhere = rank(this.otherProjects())
      .map((r) => ({ ...r, score: r.score * 0.5 }))
      .slice(0, limit - here.length);
    return [...here, ...elsewhere].map((r) => r.m);
  }

  /**
   * Retrieval.
   *
   * The index answers how well text matched; rank() decides what deserves to
   * surface. When the index is unavailable -- an older Node without
   * node:sqlite, or a file we could not repair -- this falls back to
   * searchNaive rather than failing. Recall degrading is acceptable; recall
   * throwing is not.
   *
   * Superseded memories are handed to the index rather than filtered out here,
   * because a cold episode is a route to the claim that replaced it. rank()
   * resolves them forward.
   */
  search(query: string, limit = 8, paths: string[] = []): Memory[] {
    const index = MemoryIndex.open(join(letheHome(), "index.db"));
    if (!index) return this.searchNaive(query, limit, paths);
    try {
      index.sync(this.indexFiles(), (f) => this.load(f.path, f.project));
      // Over-fetch: hits that resolve forward collapse onto shared claims, so
      // asking for exactly `limit` rows can yield fewer than `limit` results.
      const hits = index.search(query, limit * 4);
      if (!hits.length) return [];

      // Load the hits, and then the successors of any that were superseded --
      // a successor is rarely a hit itself, and dropping it would throw away
      // the consolidation the user already paid for. Both sets are bounded by
      // the number of hits, which is why recall no longer scales with the store.
      const byId = new Map<string, Memory>();
      for (const h of hits) {
        const m = this.load(h.path, h.project);
        if (m) byId.set(m.id, m);
      }
      // Chains, not single hops: an episode is superseded by a claim, and that
      // claim can later be superseded by a revision of it. Loading only the
      // immediate successor would leave the ranker looking at a cold claim and
      // dropping the episode's route to the live one. Bounded because a cycle in
      // the data must not become an infinite loop here.
      for (let hop = 0; hop < 8; hop++) {
        const wanted = [...new Set(
          [...hits.map((h) => h.supersededBy), ...[...byId.values()].map((m) => m.supersededBy)]
            .filter((id): id is string => !!id && !byId.has(id)),
        )];
        if (!wanted.length) break;
        for (const row of index.locate(wanted)) {
          const m = this.load(row.path, row.project);
          if (m) byId.set(m.id, m);
        }
      }
      return rank(hits, byId, paths, limit);
    } catch (e) {
      log("index", `search failed, falling back to the scorer: ${(e as Error).message}`);
      return this.searchNaive(query, limit, paths);
    } finally {
      index.close();
    }
  }
}
