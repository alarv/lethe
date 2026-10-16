/**
 * Compaction: consolidate, promote, decay.
 *
 * docs/compact.md. Three passes, in order, all off the user's latency path.
 *
 * The model is optional. With one, clusters of episodes are rewritten into a
 * single claim. Without one, consolidation does not run at all: episodes wait
 * for a session that can distil them. Decay still runs either way.
 */

import type { Memory, Store } from "./store.js";
import { log } from "./log.js";
import { selectForEviction } from "./evict.js";
import { prune, survey } from "./maintain.js";
import { consolidate } from "./consolidate.js";
import { letheHome } from "./store.js";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Asks a model for a completion. Supplied by the MCP host via sampling. */
export type Distiller = (prompt: string) => Promise<string>;

export interface CompactOptions {
  /** Memories to keep per project before eviction starts. */
  budget?: number;
  distil?: Distiller | undefined;
  dryRun?: boolean;
  /** Also purge memories that have decayed below the cold threshold. */
  deep?: boolean;
}

function episodesWaiting(store: Store): number {
  return store.all().filter((m) => m.kind === "episode" && !m.supersededBy).length;
}

function lockPath(): string {
  return join(letheHome(), "compact.lock");
}

function journalPath(): string {
  return join(letheHome(), "compact.journal.json");
}

/** Exclusive lock via atomic mkdir. Returns release fn, or null if held. */
function acquireLock(): (() => void) | null {
  const dir = lockPath();
  try {
    mkdirSync(dir);
  } catch {
    return null;
  }
  try {
    writeFileSync(join(dir, "pid"), String(process.pid), "utf8");
  } catch {
    /* pid file cosmetic */
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
}

interface Journal {
  /** Claim ids written but whose sources may not yet be marked cold. */
  pending: { claimId: string; sources: string[] }[];
}

function readJournal(): Journal {
  try {
    return JSON.parse(readFileSync(journalPath(), "utf8")) as Journal;
  } catch {
    return { pending: [] };
  }
}

function writeJournal(j: Journal): void {
  try {
    mkdirSync(dirname(journalPath()), { recursive: true });
    const tmp = `${journalPath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(j), "utf8");
    renameSync(tmp, journalPath());
  } catch {
    /* journal best-effort; consolidation remains retryable */
  }
}

export interface CompactReport {
  /** Consolidation was skipped because no model was available to distil. */
  skippedNoModel: boolean;
  /** Consolidation was skipped because another compaction holds the lock. */
  skippedLocked?: boolean;
  clustered: number;
  episodesConsumed: number;
  claimsWritten: number;
  promoted: number;
  decayed: number;
  purged: number;
  /** Claims discarded for dropping evidence their sources carried. */
  rejectedNoEvidence: number;
  /** Existing claims replaced by a revision rather than duplicated beside it. */
  claimsRevised: number;
  /** Dead project directories collected from ~/.lethe on the way past. */
  sweptProjects: number;
  changes: string[];
}

const COLD = 0.2;
/**
 * Time constant for decay, in days. A memory left unused falls below the cold
 * threshold in roughly three months. This is a guess, and one of the numbers
 * docs/evals.md exists to tune: too fast loses real knowledge, too slow and
 * this is just another store that grows forever.
 */
const TAU_DAYS = 56;
const PROMOTE_MIN_EVIDENCE = 2;
/**
 * Promotion needs repeated *use*, not a big cluster. A claim distilled from
 * many episodes in one session is still one lesson; it becomes procedural only
 * once it has proven useful across separate sessions (docs/brain.md §1 --
 * you cannot learn a habit from one telling).
 */
const PROMOTE_MIN_ACCESS = 3;
/** Distinct confirmers that make a claim team knowledge rather than one view. */
const PROMOTE_MIN_CONFIRMERS = 2;
/**
 * Agent CLIs are the fallback distiller, and an agent narrates: it announces
 * which tool it intends to use, or prefaces the answer with "Let me...". That
 * text is not a memory, and storing it as one is worse than storing nothing.
 */
/**
 * Global downscaling. docs/brain.md §5 -- signal improves because the total is cut.
 *
 * Elapsed time is measured from the last decay, not from `updated`. Measuring
 * from `updated` compounds: two compaction runs a minute apart would each apply
 * a week's worth of decay.
 */
/** Values that appear in more than one source, else those of the best source. */
function shared(lists: string[][], group: Memory[]): string[] {
  const counts = new Map<string, number>();
  for (const list of lists) for (const v of new Set(list)) counts.set(v, (counts.get(v) ?? 0) + 1);
  const agreed = [...counts.entries()].filter(([, n]) => n > 1).map(([v]) => v);
  if (agreed.length) return agreed;
  const best = group.reduce((a, b) => (b.salience > a.salience ? b : a), group[0]!);
  return [...new Set(lists[group.indexOf(best)] ?? [])];
}

function decayOne(m: Memory, now: number): number {
  const elapsedDays = (now - Date.parse(m.decayedAt)) / 86_400_000;
  if (elapsedDays <= 0) return m.strength;
  const resistance = 1 + Math.log(1 + m.accessCount);
  return m.strength * Math.exp(-elapsedDays / (TAU_DAYS * resistance));
}

export async function compact(
  store: Store,
  opts: CompactOptions = {},
): Promise<CompactReport> {
  const { distil, dryRun = false, deep = false } = opts;
  const report: CompactReport = {
    skippedNoModel: !distil && episodesWaiting(store) > 0,
    clustered: 0,
    episodesConsumed: 0,
    claimsWritten: 0,
    promoted: 0,
    decayed: 0,
    purged: 0,
    rejectedNoEvidence: 0,
    claimsRevised: 0,
    sweptProjects: 0,
    changes: [],
  };
  const now = Date.now();

  // Exclusive lock: two MCP servers + CLI must not double-consolidate,
  // double-promote, or double-decay. A stale lock from a crash is cleared by
  // age (10 min) rather than held forever.
  if (!dryRun) {
    const release = acquireLock();
    if (!release) {
      report.skippedLocked = true;
      report.changes.push("compaction already running -- skipped");
      log("compact", "skipped: lock held");
      return report;
    }
    try {
      return await compactInner(store, opts, report, now);
    } finally {
      release();
    }
  }
  return compactInner(store, opts, report, now);
}

async function compactInner(
  store: Store,
  opts: CompactOptions,
  report: CompactReport,
  now: number,
): Promise<CompactReport> {
  const { distil, dryRun = false, deep = false } = opts;

  // Journal recovery: a crash between `create` and marking sources cold left
  // a claim whose sources still look unconsumed. Finish that work instead of
  // distilling a duplicate claim next run.
  if (!dryRun) {
    const journal = readJournal();
    if (journal.pending.length) {
      const byId = new Map(store.all().map((m) => [m.id, m]));
      const remaining: Journal["pending"] = [];
      for (const p of journal.pending) {
        const claim = byId.get(p.claimId);
        if (!claim) continue; // claim gone; nothing to finish
        let done = true;
        for (const sid of p.sources) {
          const s = byId.get(sid);
          if (s && !s.supersededBy) {
            s.supersededBy = p.claimId;
            try {
              store.write(s);
            } catch {
              done = false;
            }
          }
        }
        if (!done) remaining.push(p);
        else report.changes.push(`journal: finished cold-marking for "${claim.title}"`);
      }
      writeJournal({ pending: remaining });
      if (remaining.length === 0) {
        try {
          rmSync(journalPath(), { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  // 1. Consolidate -----------------------------------------------------------
  //
  // Only ever destructive when a model actually rewrote the episodes into a
  // claim. Without one there is nothing to consolidate *into*: keeping the most
  // salient episode and deleting its siblings is not compression, it is losing
  // eleven memories to keep one. Episodes simply wait for a session that can
  // distil them.
  const episodes = store.all().filter((m) => m.kind === "episode" && !m.supersededBy);
  // Live claims go in as well, so a lesson already recorded can be revised
  // instead of written twice. Patterns are left out deliberately: they are the
  // promoted survivors, and letting an automatic pass demote one is a bigger
  // decision than this is. `correct` still reaches them.
  const live = store.all().filter((m) => m.kind === "claim" && !m.supersededBy);
  if (distil && episodes.length) {
    const result = await consolidate(episodes, distil, live);
    report.clustered = result.accepted.length + result.rejected.length;
    report.rejectedNoEvidence = result.rejected.length;

    for (const { claim, missing } of result.rejected) {
      report.changes.push(
        `rejected "${claim.title}" -- dropped evidence: ${missing.slice(0, 3).join(", ")}`,
      );
    }

    for (const { claim, sources, revises } of result.accepted) {
      report.changes.push(
        `${sources.length} episode(s)` +
          (revises.length ? ` + ${revises.length} existing claim(s)` : "") +
          ` -> "${claim.title}"\n` +
          [...sources, ...revises].map((m) => `    - ${m.title}`).join("\n"),
      );
      report.episodesConsumed += sources.length;
      report.claimsRevised += revises.length;
      report.claimsWritten += 1;
      if (dryRun) continue;

      const written = store.create({
        kind: "claim",
        title: claim.title,
        body: claim.body,
        // Union across sources produced thirty tags and a dozen files on one
        // claim, which is noise: it makes tag matching meaningless and lets path
        // scoping match half the repository. Keep what more than one source
        // agreed on, falling back to the most salient source's own.
        tags: shared(sources.map((m) => m.tags), sources),
        files: shared(sources.map((m) => m.files), sources),
        // A revision inherits the salience AND strength it earned; replacing a
        // claim must not quietly demote what it knew or reset earned use.
        salience: Math.max(...[...sources, ...revises].map((m) => m.salience)),
        strength: Math.max(...[...sources, ...revises].map((m) => m.strength)),
        provenance: [...sources, ...revises].map((m) => m.id),
      });

      // Journal before marking sources: a crash here must resume, not duplicate.
      const journal = readJournal();
      journal.pending.push({ claimId: written.id, sources: [...sources, ...revises].map((m) => m.id) });
      writeJournal(journal);

      // Consumed episodes go cold rather than being deleted (docs/brain.md §7).
      // A claim is a lossy summary, so the trace stays on disk as a second route
      // to it -- which is what makes a mistaken consolidation recoverable rather
      // than destructive, and what pattern completion retrieves through.
      // A replaced claim goes cold on exactly the same terms as an episode: the
      // file stays, so a mistaken revision is recoverable and the old wording
      // remains a route to the new claim through pattern completion.
      for (const m of [...sources, ...revises]) {
        m.supersededBy = written.id;
        store.write(m);
      }
      // Sources marked: journal entry fulfilled.
      writeJournal({ pending: readJournal().pending.filter((p) => p.claimId !== written.id) });
      if (!readJournal().pending.length) {
        try {
          rmSync(journalPath(), { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  // 2. Promote ---------------------------------------------------------------
  // A claim becomes procedural -- how we do things here -- once it has earned
  // trust, by one of two routes: sustained personal use (recalled repeatedly),
  // or corroboration by several different people. The second matters more for a
  // team: a claim three colleagues independently confirmed is settled in a way
  // that one person leaning on it is not.
  for (const m of store.all()) {
    if (m.kind !== "claim" || m.supersededBy) continue;
    if (m.provenance.length < PROMOTE_MIN_EVIDENCE) continue;
    const corroborated = m.confirmedBy.length >= PROMOTE_MIN_CONFIRMERS;
    const relied = m.accessCount >= PROMOTE_MIN_ACCESS;
    if (!corroborated && !relied) continue;
    report.promoted += 1;
    report.changes.push(`promote -> pattern: "${m.title}"`);
    if (dryRun) continue;
    m.kind = "pattern";           // durable: belongs in the shared file
    m.strength = Math.min(2, m.strength + 0.3);
    store.write(m);
  }

  // 3. Decay -----------------------------------------------------------------
  {
    const snapshot = store.all();
    const dependedOn = new Set<string>();
    for (const m of snapshot) {
      for (const p of m.provenance) dependedOn.add(p);
      if (m.supersededBy) dependedOn.add(m.supersededBy);
    }
    // Reverse index: which ids point at m (traces citing it as provenance).
    const citedBy = new Map<string, number>();
    for (const m of snapshot) {
      for (const p of m.provenance) citedBy.set(p, (citedBy.get(p) ?? 0) + 1);
    }
    for (const m of snapshot) {
      const next = decayOne(m, now);
      if (next < COLD && deep && m.kind !== "episode") {
        // Never purge a claim other memories still cite: that orphans traces
        // evict.ts then pins as never-evictable.
        if ((citedBy.get(m.id) ?? 0) > 0 || dependedOn.has(m.id) && m.kind === "claim") {
          // Fall through to decay rather than purge when still referenced,
          // unless nothing references it.
          if ((citedBy.get(m.id) ?? 0) > 0) {
            report.changes.push(`kept (cited): "${m.title}"`);
            continue;
          }
        }
        report.purged += 1;
        report.changes.push(`purge (cold): "${m.title}"`);
        if (!dryRun) store.remove(m.id);
        continue;
      }
      if (Math.abs(next - m.strength) < 0.001) continue;
      report.decayed += 1;
      if (dryRun) continue;
      m.strength = next;
      m.decayedAt = new Date(now).toISOString();
      // Decay is per-machine; writing the memory would dirty a shared file.
      store.saveDynamics(m);
    }
  }

  // 4. Evict -----------------------------------------------------------------
  //
  // Decay lowers strength; this is what acts on it. It runs on the automatic
  // path rather than only under --deep, because a threshold nobody reaches is
  // not a policy. Ordered by tier so the cheapest losses go first: a superseded
  // episode costs a retrieval route while its claim keeps the lesson.
  for (const { memory, tier: t } of selectForEviction(store.all(), opts.budget)) {
    report.purged += 1;
    report.changes.push(`evict (tier ${t}, over budget): "${memory.title}"`);
    log("compact", `evicting "${memory.title}"`, {
      kind: memory.kind,
      tier: t,
      strength: memory.strength.toFixed(2),
    });
    if (!dryRun) store.remove(memory.id);
  }

  // 5. Sweep the home directory ---------------------------------------------
  //
  // Compaction is already the pass that decides what does not deserve to
  // survive, already triggered by use, and already off the latency path, so
  // scaffolding left by projects that no longer exist is collected here rather
  // than on a timer nobody set. Only directories holding no memories at all --
  // see maintain.ts for why that line is drawn there and not further.
  if (!dryRun) {
    const swept = prune(survey());
    report.sweptProjects = swept.length;
    for (const dir of swept) report.changes.push(`swept empty project dir: ${dir}`);
  }

  return report;
}

export function formatReport(r: CompactReport): string {
  const lines = [
    r.skippedNoModel
      ? "no model available -- consolidation skipped, episodes kept intact"
      : "consolidated",
    "",
    ...r.changes.map((c) => `  ${c}`),
    "",
    `  ${r.claimsWritten} claim(s) from ${r.episodesConsumed} episode(s), ` +
      `${r.promoted} promoted, ${r.decayed} decayed, ${r.purged} purged` +
      (r.claimsRevised ? `, ${r.claimsRevised} claim(s) revised rather than duplicated` : "") +
      (r.rejectedNoEvidence ? `, ${r.rejectedNoEvidence} rejected for dropped evidence` : "") +
      (r.sweptProjects ? `, ${r.sweptProjects} empty project dir(s) swept` : ""),
  ];
  return lines.join("\n");
}
