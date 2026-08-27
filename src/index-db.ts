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

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { Memory } from "./store.js";
import { matchExpression, terms } from "./query.js";
import { log } from "./log.js";

const SCHEMA_VERSION = 2;

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
      db.exec("DROP TABLE IF EXISTS meta");
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
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    return db;
  }

  /**
   * A fingerprint of the corpus, so an unchanged store costs no writes.
   *
   * Hashes the indexed content, not ids and timestamps. Store.write does not
   * bump `updated`, so a caller that edits a body and writes it back leaves
   * every timestamp identical -- and a timestamp fingerprint would then skip the
   * rebuild and leave the old terms searchable forever. A silently stale index
   * is the worst outcome available here, so correctness wins over cheapness.
   *
   * The cost is CPU only: these bodies were already read off disk to build the
   * array being passed in.
   */
  private static fingerprint(memories: Memory[]): string {
    const h = createHash("sha1");
    for (const line of memories
      .map((m) => `${m.id}\u0000${m.title}\u0000${m.body}\u0000${m.tags.join(",")}` +
        `\u0000${m.files.join(",")}\u0000${m.supersededBy ?? ""}`)
      .sort()) {
      h.update(line);
    }
    return h.digest("hex");
  }

  /**
   * Bring the index in line with the markdown.
   *
   * Returns early when nothing has changed. That matters more than it looks:
   * search calls this on every query, and rebuilding each time left over half
   * the file as free pages -- 26 of 49 on the real store, which is how a 138KB
   * corpus produced a 200KB index.
   *
   * When a rebuild is needed it deletes and reinserts inside one transaction.
   * Rebuild-by-rename is not an option: MCP servers are per-session, so another
   * process may hold this file open. A crash mid-transaction rolls back rather
   * than leaving a half-built index that would silently return partial results.
   */
  sync(memories: Memory[]): void {
    const fingerprint = MemoryIndex.fingerprint(memories);
    const stored = this.db.prepare("SELECT value FROM meta WHERE key = 'fingerprint'").get();
    if (stored && String(stored.value) === fingerprint) return;

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
      this.db
        .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('fingerprint', ?)")
        .run(fingerprint);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.reclaim();
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
