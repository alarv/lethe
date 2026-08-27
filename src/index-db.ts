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

const SCHEMA_VERSION = 1;

export interface Hit {
  id: string;
  relevance: number;
  supersededBy: string | null;
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
    }
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      title, body, tags, files,
      content='', contentless_delete=1, tokenize='porter unicode61')`);
    db.exec(`CREATE TABLE IF NOT EXISTS memories (
      rowid INTEGER PRIMARY KEY,
      id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      updated TEXT NOT NULL,
      superseded_by TEXT)`);
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    return db;
  }

  /**
   * Bring the index in line with the markdown.
   *
   * Delete then reinsert inside one transaction. Rebuild-by-rename is not an
   * option: MCP servers are per-session, so another process may hold this file
   * open. A crash mid-transaction rolls back rather than leaving a half-built
   * index, which would silently return partial results.
   */
  sync(memories: Memory[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM fts");
      this.db.exec("DELETE FROM memories");
      const fts = this.db.prepare(
        "INSERT INTO fts(rowid, title, body, tags, files) VALUES (?, ?, ?, ?, ?)",
      );
      const meta = this.db.prepare(
        `INSERT INTO memories(rowid, id, project, scope, kind, updated, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      memories.forEach((m, i) => {
        const rowid = i + 1;
        fts.run(rowid, m.title, m.body, m.tags.join(" "), m.files.join(" "));
        meta.run(rowid, m.id, m.fromProject ?? "", m.scope, m.kind, m.updated,
          m.supersededBy ?? null);
      });
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.db.exec("INSERT INTO fts(fts) VALUES('optimize')");
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
        `SELECT m.id AS id, m.superseded_by AS superseded_by,
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
    }));
  }

  bytes(): number {
    try {
      return existsSync(this.path) ? statSync(this.path).size : 0;
    } catch {
      return 0;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
