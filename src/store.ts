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

import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
  accessCount: number;
  created: string;
  updated: string;
  lastAccessed: string | null;
  /** Episode ids this claim was distilled from. */
  provenance: string[];
  /** Set when a memory is corrected rather than deleted. */
  supersededBy: string | null;
}

// ---------------------------------------------------------------- locations

/** Walk up to the nearest .git, so memory attaches to the repo, not the cwd. */
export function findProjectRoot(start = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Stable per-repo directory name: readable, with a hash to avoid collisions. */
function projectKey(root: string): string {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  const name = root.split("/").filter(Boolean).pop() ?? "project";
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${hash}`;
}

export function memoryDir(scope: Scope, cwd = process.cwd()): string {
  const home = join(homedir(), ".lethe");
  if (scope === "personal") return join(home, "memory");

  const root = findProjectRoot(cwd);
  if (!root) throw new Error("not inside a git repository");
  if (scope === "team") return join(root, ".lethe", "memory");
  return join(home, "projects", projectKey(root), "memory");
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

export function serialize(m: Memory): string {
  const fm = [
    `id: ${m.id}`,
    `kind: ${m.kind}`,
    `title: ${esc(m.title)}`,
    `tags: ${m.tags.join(", ")}`,
    `files: ${m.files.join(", ")}`,
    `salience: ${m.salience}`,
    `strength: ${m.strength}`,
    `accessCount: ${m.accessCount}`,
    `created: ${m.created}`,
    `updated: ${m.updated}`,
    `lastAccessed: ${m.lastAccessed ?? ""}`,
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
    accessCount: Number(f.accessCount ?? 0),
    created: f.created ?? new Date().toISOString(),
    updated: f.updated ?? new Date().toISOString(),
    lastAccessed: f.lastAccessed ? f.lastAccessed : null,
    provenance: list(f.provenance),
    supersededBy: f.supersededBy ? f.supersededBy : null,
  };
}

// ----------------------------------------------------------------- storage

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) ||
    "memory";
}

export class Store {
  constructor(private readonly cwd = process.cwd()) {}

  private dir(scope: Scope): string {
    const d = memoryDir(scope, this.cwd);
    mkdirSync(d, { recursive: true });
    return d;
  }

  private pathFor(m: Memory): string {
    return join(this.dir(m.scope), `${m.id.slice(0, 8)}-${slug(m.title)}.md`);
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
      if (m) out.push(m);
    }
    return out;
  }

  all(): Memory[] {
    return [...this.list("local"), ...this.list("team"), ...this.list("personal")];
  }

  get(id: string): Memory | null {
    return this.all().find((m) => m.id === id || m.id.startsWith(id)) ?? null;
  }

  write(m: Memory): Memory {
    writeFileSync(this.pathFor(m), serialize(m), "utf8");
    return m;
  }

  remove(id: string): boolean {
    const m = this.get(id);
    if (!m) return false;
    rmSync(this.pathFor(m), { force: true });
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
      accessCount: 0,
      created: now,
      updated: now,
      lastAccessed: null,
      provenance: input.provenance ?? [],
      supersededBy: null,
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
    return this.write(m);
  }

  /**
   * Placeholder retrieval: token overlap, weighted by field. Good enough to
   * start capturing real sessions; replaced by embeddings once there is data
   * to evaluate against.
   */
  search(query: string, limit = 8): Memory[] {
    const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    const scored = this.all()
      .filter((m) => !m.supersededBy)
      .map((m) => {
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
        return { m, score: score * m.strength };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map((r) => r.m);
  }
}
