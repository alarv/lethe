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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

/**
 * Where a memory lives.
 *
 *   local     ~/.lethe/projects/<repo>/  — this repo, private to you. The default.
 *   team      <repo>/.lethe/memory/      — committed, shared, reviewed in PRs.
 *   personal  ~/.lethe/memory/           — you, across every repo.
 *
 * `local` is the default because writing into someone's repo is a decision they
 * should opt into, not discover in `git status`.
 */
export type Scope = "local" | "team" | "personal";

/** Episodic = what happened. Semantic = what is true. Procedural = how we do things. */
export type Kind = "episode" | "claim" | "pattern";

export interface Memory {
  id: string;
  kind: Kind;
  scope: Scope;
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
    writeFileSync(f, root + "\n", "utf8");
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

export function memoryDir(scope: Scope, cwd = process.cwd()): string {
  const home = letheHome();
  if (scope === "personal") return join(home, "memory");

  const root = findProjectRoot(cwd);
  if (scope === "team") {
    if (!root) throw new Error("team scope needs a git repository");
    return join(root, ".lethe", "memory");
  }
  // Local scope falls back to the working directory when there is no repo.
  // Throwing here made list() return empty and recall silently answer nothing --
  // the agent asked four times, got zero hits, and had no way to see why.
  const base = root ?? cwd;
  migrate(home, base);
  const dir = join(home, "projects", projectKey(base));
  recordSource(dir, base);
  return join(dir, "memory");
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
    `confirmedBy: ${m.confirmedBy.join(", ")}`,
    `provenance: ${m.provenance.join(", ")}`,
    `supersededBy: ${m.supersededBy ?? ""}`,
  ].join("\n");
  return `---\n${fm}\n---\n\n${m.body}\n`;
}

export function parse(text: string, scope: Scope): Memory | null {
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
    scope,
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
    confirmedBy: list(f.confirmedBy),
  };
}

// ----------------------------------------------------------------- storage

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
    };
  }

  set(id: string, d: Dyn): void {
    this.load();
    this.data[id] = d;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 0), "utf8");
    } catch {
      // Losing reinforcement is survivable; failing a recall is not.
    }
  }

  drop(id: string): void {
    this.load();
    delete this.data[id];
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 0), "utf8");
    } catch {
      /* ignore */
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
   * Earlier versions let any memory be written to team scope, so repositories
   * picked up private scratchpad entries that would otherwise reach a commit.
   * Runs once per store: cheap when there is nothing to move.
   */
  private relocateEpisodes(): void {
    let from: string;
    try {
      from = memoryDir("team", this.cwd);
    } catch {
      return; // not in a repository; nothing to relocate
    }
    if (!existsSync(from)) return;
    let moved = 0;
    try {
      for (const name of readdirSync(from)) {
        if (!name.endsWith(".md")) continue;
        const path = join(from, name);
        const m = parse(readFileSync(path, "utf8"), "team");
        if (!m || m.kind !== "episode") continue;
        const to = join(memoryDir("local", this.cwd), name);
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

  private dir(scope: Scope): string {
    const d = memoryDir(scope, this.cwd);
    mkdirSync(d, { recursive: true });
    return d;
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
  private scopeFor(m: Memory): Scope {
    return m.kind === "episode" ? "local" : m.scope;
  }

  private pathFor(m: Memory): string {
    return join(this.dir(this.scopeFor(m)), `${m.id.slice(0, 8)}-${slug(m.title)}.md`);
  }

  list(scope: Scope): Memory[] {
    let dir: string;
    try {
      dir = this.dir(scope);
    } catch {
      return []; // outside a repo: not an error, just empty
    }
    const out: Memory[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const m = parse(readFileSync(join(dir, name), "utf8"), scope);
      if (!m) continue;
      Object.assign(m, this.dyn.get(m.id, m.created));
      out.push(m);
    }
    return out;
  }

  all(): Memory[] {
    return [...this.list("local"), ...this.list("team"), ...this.list("personal")];
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
    const direct = all.find((m) => m.id === id || m.id.startsWith(id));
    if (direct) return direct;
    return all.find((m) => m.provenance.some((p) => p === id || p.startsWith(id))) ?? null;
  }

  write(m: Memory): Memory {
    writeFileSync(this.pathFor(m), serialize(m), "utf8");
    this.saveDynamics(m);
    return m;
  }

  remove(id: string): boolean {
    const m = this.get(id);
    if (!m) return false;
    rmSync(this.pathFor(m), { force: true });
    this.dyn.drop(m.id);
    return true;
  }

  create(input: {
    title: string;
    body: string;
    kind?: Kind;
    scope?: Scope;
    tags?: string[];
    files?: string[];
    salience?: number;
    provenance?: string[];
  }): Memory {
    const now = new Date().toISOString();
    return this.write({
      id: randomUUID(),
      kind: input.kind ?? "episode",
      scope: input.scope ?? "local",
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
    // Reinforcement is local, so this must not rewrite the shared file.
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
    });
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
          const m = parse(readFileSync(join(mem, name), "utf8"), "local");
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
   * Placeholder retrieval: token overlap, weighted by field. Good enough to
   * start capturing real sessions; replaced by embeddings once there is data
   * to evaluate against.
   */
  search(query: string, limit = 8, paths: string[] = []): Memory[] {
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

    // Top up from neighbouring projects, discounted so anything local wins.
    const elsewhere = rank(this.otherProjects())
      .map((r) => ({ ...r, score: r.score * 0.5 }))
      .slice(0, limit - here.length);
    return [...here, ...elsewhere].map((r) => r.m);
  }
}
