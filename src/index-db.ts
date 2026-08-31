/**
 * The index layer.
 *
 * Answers one question: which memory ids match this query, and how well. It
 * holds an inverted index and nothing else -- the FTS5 tables are content='',
 * so no memory text is duplicated here. That is the decision that keeps the
 * file small (measured: 4.1MB per 10,000 memories, against 23.7MB if the bodies
 * were stored) and that makes deleting it always safe, since it holds no
 * information that is not in the markdown.
 *
 * node:sqlite is loaded through a feature check rather than a static import. It
 * is flagged experimental and early 22.x needed --experimental-sqlite, so a
 * failure has to degrade to the in-memory scorer instead of breaking recall.
 * The index is an optimisation, not a requirement.
 *
 * The check uses createRequire rather than a dynamic import so that loading
 * stays synchronous. A top-level await here would sit inside an import cycle
 * with store.ts and risk deadlocking module evaluation.
 */

import { createRequire } from "node:module";
import { existsSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { Memory } from "./store.js";
import { matchExpression, terms } from "./query.js";
import { log } from "./log.js";

const SCHEMA_VERSION = 4;

export interface Hit {
  id: string;
  relevance: number;
  supersededBy: string | null;
  /** Where the markdown is, so the caller can load this one and no others. */
  path: string;
  /** Source path of the project it came from, or "" for the current one. */
  project: string;
}

/**
 * A candidate file, described without being read.
 *
 * `mtimeMs` and `size` are the change signal, and the whole point: deciding
 * what to index used to require reading and parsing every memory in every
 * project on every query. Measured on a 36,000-memory store, that was 4.4
 * seconds per recall; stat-ing the same files costs 120ms and reading only the
 * hits costs about one.
 */
export interface IndexFile {
  path: string;
  mtimeMs: number;
  size: number;
  project: string;
}

/** What a row already in the index says about the file behind it. */
interface Known {
  rowid: number;
  mtime: number;
  size: number;
}

/** Only what we use, so the experimental surface we depend on stays visible. */
interface Db {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
  close(): void;
}

type Sqlite = { DatabaseSync: new (path: string) => Db };

const req = createRequire(import.meta.url);
let sqlite: Sqlite | null | undefined;

function loadSqlite(): Sqlite | null {
  if (sqlite !== undefined) return sqlite;
  try {
    sqlite = req("node:sqlite") as Sqlite;
  } catch {
    sqlite = null;
    log("index", "node:sqlite unavailable; retrieval falls back to the in-memory scorer");
  }
  return sqlite;
}

export class MemoryIndex {
  private constructor(private readonly db: Db, private readonly path: string) {}

  /**
   * @param path where the index lives. Passed in rather than derived, so this
   *   module needs no knowledge of lethe's directory layout and no runtime
   *   import from store.ts.
   */
  static open(path: string): MemoryIndex | null {
    const mod = loadSqlite();
    if (!mod) return null;
    try {
      return new MemoryIndex(MemoryIndex.connect(mod, path), path);
    } catch (e) {
      // A corrupt or truncated index must never stop recall. Delete and retry
      // once; the markdown is the source of truth, so nothing is lost.
      log("index", `rebuilding after open failed: ${(e as Error).message}`);
      try {
        rmSync(path, { force: true });
        return new MemoryIndex(MemoryIndex.connect(mod, path), path);
      } catch (again) {
        log("index", `index unusable, falling back: ${(again as Error).message}`);
        return null;
      }
    }
  }

  private static connect(mod: Sqlite, path: string): Db {
    mkdirSync(dirname(path), { recursive: true });
    const db = new mod.DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");

    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    if (Number(row?.user_version ?? 0) !== SCHEMA_VERSION) {
      // No migration path, deliberately: the markdown is the source of truth
      // and rebuilding is cheap, so a schema change costs a rebuild rather than
      // migration code that has to stay correct forever.
      db.exec("DROP TABLE IF EXISTS fts");
      db.exec("DROP TABLE IF EXISTS memories");
      db.exec("DROP TABLE IF EXISTS meta");
    }
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      title, body, tags, files,
      content='', contentless_delete=1, tokenize='porter unicode61')`);
    db.exec(`CREATE TABLE IF NOT EXISTS memories (
      rowid INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      path TEXT UNIQUE NOT NULL,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      updated TEXT NOT NULL,
      superseded_by TEXT)`);
    // Lookups by id resolve a hit's successor, which is the one thing the
    // ranker needs that the hit itself does not carry.
    db.exec("CREATE INDEX IF NOT EXISTS memories_id ON memories(id)");
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    return db;
  }

  /**
   * Bring the index in line with the markdown, touching only what moved.
   *
   * The old version hashed the content of every memory in every project and, on
   * any mismatch, deleted and rebuilt the whole table. That made the cost of
   * writing one note proportional to the size of the entire cross-project
   * store: a note in project A invalidated the index for a recall in project B.
   *
   * Now the unit is a file. Anything whose path, mtime and size are unchanged is
   * left alone; anything new or modified is read and reindexed; anything the
   * caller no longer lists is deleted. That last clause is also how the index
   * garbage-collects itself -- delete a memory, or a whole project directory,
   * and its rows go on the next sync with nothing to schedule.
   *
   * mtime is trusted because every write goes through a temp file and rename
   * (store.ts § atomicWrite), and rename always moves the mtime forward. Size is
   * carried too so that an edit landing inside the same millisecond is still
   * seen. A per-directory mtime gate would cut the stat count from thousands to
   * dozens, and is deliberately not done: it would miss a file an editor
   * rewrote in place, and a silently stale index is the worst outcome available
   * here.
   *
   * One transaction, because a crash mid-sync must leave the previous index
   * intact rather than a half-built one that returns partial results. Rebuild by
   * rename is not an option: MCP servers are per-session, so another process may
   * hold this file open.
   */
  sync(files: IndexFile[], load: (file: IndexFile) => Memory | null): void {
    const known = new Map<string, Known>();
    for (const r of this.db.prepare("SELECT rowid, path, mtime, size FROM memories").all()) {
      known.set(String(r.path), {
        rowid: Number(r.rowid),
        mtime: Number(r.mtime),
        size: Number(r.size),
      });
    }

    const stale: IndexFile[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      // Two directories can resolve to the same file -- outside a repository
      // claims and episodes share one -- so the same path may arrive twice.
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      const k = known.get(f.path);
      if (!k || k.mtime !== f.mtimeMs || k.size !== f.size) stale.push(f);
    }
    const gone = [...known.entries()].filter(([path]) => !seen.has(path));

    if (!stale.length && !gone.length) return;

    let nextRowid = Number(
      Object.values(this.db.prepare("SELECT MAX(rowid) AS max FROM memories").get() ?? {})[0] ?? 0,
    ) + 1;

    this.db.exec("BEGIN");
    try {
      const dropFts = this.db.prepare("DELETE FROM fts WHERE rowid = ?");
      const dropMeta = this.db.prepare("DELETE FROM memories WHERE rowid = ?");
      const addFts = this.db.prepare(
        "INSERT INTO fts(rowid, title, body, tags, files) VALUES (?, ?, ?, ?, ?)",
      );
      const addMeta = this.db.prepare(
        `INSERT INTO memories(rowid, id, path, mtime, size, project, kind, updated, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const [, k] of gone) {
        dropFts.run(k.rowid);
        dropMeta.run(k.rowid);
      }

      for (const f of stale) {
        const existing = known.get(f.path);
        if (existing) {
          dropFts.run(existing.rowid);
          dropMeta.run(existing.rowid);
        }
        const m = load(f);
        if (!m) continue; // unreadable or not a memory; the row stays deleted
        // Reuse the rowid of the file being replaced. Growing it forever would
        // leave the fts b-tree sparse for no reason.
        const rowid = existing ? existing.rowid : nextRowid++;
        addFts.run(rowid, m.title, m.body, m.tags.join(" "), m.files.join(" "));
        addMeta.run(rowid, m.id, f.path, f.mtimeMs, f.size, f.project, m.kind, m.updated,
          m.supersededBy ?? null);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    // Only worth the pages when something was actually removed.
    if (gone.length) this.reclaim();
  }

  /**
   * Locate memories by id without searching for them.
   *
   * The ranker resolves a hit forward onto the claim that superseded it, and
   * that successor is usually not itself a hit -- so it has to be findable by
   * id alone, or consolidation's whole point is lost at retrieval time.
   */
  locate(ids: string[]): { id: string; path: string; project: string }[] {
    if (!ids.length) return [];
    const holes = ids.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT id, path, project FROM memories WHERE id IN (${holes})`)
      .all(...ids)
      .map((r) => ({ id: String(r.id), path: String(r.path), project: String(r.project) }));
  }

  /**
   * Give freed space back to the filesystem after a rebuild.
   *
   * Three steps, each needed for a different reason.
   *
   * `optimize` merges the FTS5 b-tree, which a rebuild leaves fragmented.
   *
   * The checkpoint is TRUNCATE rather than the default PASSIVE because a WAL
   * does not shrink on its own. Measured: deleting 280 of 300 memories grew the
   * total footprint from 210KB to 309KB, all of it accumulated sidecar. Since
   * the index is rebuilt whenever the corpus changes, a WAL that only grows is
   * unbounded growth by another route.
   *
   * VACUUM then returns pages the delete marked free. It cannot run inside a
   * transaction, hence its position after the commit, and it is gated on there
   * being enough slack to be worth the rewrite.
   */
  private reclaim(): void {
    try {
      this.db.exec("INSERT INTO fts(fts) VALUES('optimize')");
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const pages = Number(Object.values(this.db.prepare("PRAGMA page_count").get() ?? {})[0] ?? 0);
      const free = Number(Object.values(this.db.prepare("PRAGMA freelist_count").get() ?? {})[0] ?? 0);
      if (pages > 0 && free > pages / 4) {
        this.db.exec("VACUUM");
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }
    } catch (e) {
      // Housekeeping. Failing it must not fail the search that triggered it.
      log("index", `reclaim skipped: ${(e as Error).message}`);
    }
  }

  search(query: string, limit: number): Hit[] {
    const expr = matchExpression(query);
    if (expr === null) return [];
    return this.run(expr, limit);
  }

  /** An exact adjacent phrase. This is why the index uses detail='full'. */
  searchPhrase(phrase: string, limit: number): Hit[] {
    const words = terms(phrase);
    if (!words.length) return [];
    return this.run(`"${words.join(" ")}"`, limit);
  }

  private run(expr: string, limit: number): Hit[] {
    // bm25 returns negative values, more negative meaning a better match, so it
    // is negated into a positive relevance the ranker can multiply.
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, m.superseded_by AS superseded_by, m.path AS path,
                m.project AS project,
                -bm25(fts, 10.0, 1.0, 8.0, 4.0) AS relevance
           FROM fts JOIN memories m ON m.rowid = fts.rowid
          WHERE fts MATCH ?
          ORDER BY relevance DESC, m.id
          LIMIT ?`,
      )
      .all(expr, limit);
    return rows.map((r) => ({
      id: String(r.id),
      relevance: Number(r.relevance),
      supersededBy: r.superseded_by === null ? null : String(r.superseded_by),
      path: String(r.path),
      project: String(r.project),
    }));
  }

  /**
   * Size on disk, including the WAL sidecar.
   *
   * Under WAL a commit lands in index.db-wal and does not reach index.db until
   * a checkpoint, so measuring the main file alone reports a nearly empty index
   * for a freshly written one -- which would make `lethe status` reassuring and
   * wrong.
   */
  bytes(): number {
    let total = 0;
    for (const p of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try {
        if (existsSync(p)) total += statSync(p).size;
      } catch {
        /* a sidecar that vanished between the check and the stat is fine */
      }
    }
    return total;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
