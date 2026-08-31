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

export interface CompactReport {
  /** Consolidation was skipped because no model was available to distil. */
  skippedNoModel: boolean;
  clustered: number;
  episodesConsumed: number;
  claimsWritten: number;
  promoted: number;
  decayed: number;
  purged: number;
  /** Claims discarded for dropping evidence their sources carried. */
  rejectedNoEvidence: number;
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
    sweptProjects: 0,
    changes: [],
  };
  const now = Date.now();

  // 1. Consolidate -----------------------------------------------------------
  //
  // Only ever destructive when a model actually rewrote the episodes into a
  // claim. Without one there is nothing to consolidate *into*: keeping the most
  // salient episode and deleting its siblings is not compression, it is losing
  // eleven memories to keep one. Episodes simply wait for a session that can
  // distil them.
  const episodes = store.all().filter((m) => m.kind === "episode" && !m.supersededBy);
  if (distil && episodes.length) {
    const result = await consolidate(episodes, distil);
    report.clustered = result.accepted.length + result.rejected.length;
    report.rejectedNoEvidence = result.rejected.length;

    for (const { claim, missing } of result.rejected) {
      report.changes.push(
        `rejected "${claim.title}" -- dropped evidence: ${missing.slice(0, 3).join(", ")}`,
      );
    }

    for (const { claim, sources } of result.accepted) {
      report.changes.push(
        `${sources.length} episode(s) -> "${claim.title}"\n` +
          sources.map((m) => `    - ${m.title}`).join("\n"),
      );
      report.episodesConsumed += sources.length;
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
        salience: Math.max(...sources.map((m) => m.salience)),
        provenance: sources.map((m) => m.id),
      });

      // Consumed episodes go cold rather than being deleted (docs/brain.md §7).
      // A claim is a lossy summary, so the trace stays on disk as a second route
      // to it -- which is what makes a mistaken consolidation recoverable rather
      // than destructive, and what pattern completion retrieves through.
      for (const m of sources) {
        m.supersededBy = written.id;
        store.write(m);
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
  for (const m of store.all()) {
    // Episodes used to be exempt, on the theory that consolidation would consume
    // them. It does not delete them -- it marks them cold -- and it needs a
    // distiller that is often absent, so they accumulated forever. That is how a
    // project named for forgetting came to never forget.
    const next = decayOne(m, now);
    if (next < COLD && deep && m.kind !== "episode") {
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
      : "consolidated with the host's model",
    "",
    ...r.changes.map((c) => `  ${c}`),
    "",
    `  ${r.claimsWritten} claim(s) from ${r.episodesConsumed} episode(s), ` +
      `${r.promoted} promoted, ${r.decayed} decayed, ${r.purged} purged` +
      (r.rejectedNoEvidence ? `, ${r.rejectedNoEvidence} rejected for dropped evidence` : "") +
      (r.sweptProjects ? `, ${r.sweptProjects} empty project dir(s) swept` : ""),
  ];
  return lines.join("\n");
}
