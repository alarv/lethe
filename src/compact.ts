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

/** Asks a model for a completion. Supplied by the MCP host via sampling. */
export type Distiller = (prompt: string) => Promise<string>;

export interface CompactOptions {
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
const SIMILARITY = 0.12;

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "was", "were", "not", "but", "you",
  "from", "have", "has", "had", "are", "its", "it's", "then", "than", "when",
]);

/** Crude suffix stripping so "test" and "tests" collide. Not a real stemmer. */
function stem(t: string): string {
  for (const suf of ["ing", "ed", "es", "s"]) {
    if (t.length > suf.length + 2 && t.endsWith(suf)) return t.slice(0, -suf.length);
  }
  return t;
}

function tokens(m: Memory): Set<string> {
  const text = `${m.title} ${m.body}`.toLowerCase();
  return new Set(
    text.split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOP.has(t))
      .map(stem),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Pattern separation at write time is the DG's job (docs/brain.md §3); this is
 * the read-side equivalent -- group episodes that are about the same thing.
 *
 * Overlap of shared files or tags counts for more than prose similarity: two
 * sessions touching the same file are usually related even when described in
 * completely different words.
 */
export function cluster(episodes: Memory[]): Memory[][] {
  const toks = new Map(episodes.map((m) => [m.id, tokens(m)] as const));
  const seen = new Set<string>();
  const out: Memory[][] = [];

  for (const seed of episodes) {
    if (seen.has(seed.id)) continue;
    const group = [seed];
    seen.add(seed.id);

    // Grow transitively: A relates to B and B to C should pull C in, even when
    // A and C share little wording. Sessions drift in vocabulary as they go.
    for (let grew = true; grew; ) {
      grew = false;
      for (const other of episodes) {
        if (seen.has(other.id)) continue;
        const related = group.some((g) => {
          if (other.files.some((f) => g.files.includes(f))) return true;
          if (other.tags.some((t) => g.tags.includes(t))) return true;
          return jaccard(toks.get(g.id)!, toks.get(other.id)!) >= SIMILARITY;
        });
        if (related) {
          group.push(other);
          seen.add(other.id);
          grew = true;
        }
      }
    }
    out.push(group);
  }
  return out;
}

const PROMPT = `You are consolidating an AI coding agent's memory of one codebase.

Below are several episodes recorded during work. Find what is INVARIANT across
them -- the durable lesson that will still be true next month -- and state it as
one claim a future agent can act on.

Rules:
- One claim. If the episodes are genuinely unrelated, say exactly: SKIP
- Lead with the rule, not the story. "Tests need docker compose up first", not
  "we spent time debugging tests".
- Keep what makes it actionable: commands, paths, error strings.
- Drop what was incidental: timings, dead ends that led nowhere, narration.
- No preamble. Reply with a title line, then a blank line, then 1-3 lines of body.

Episodes:
`;

async function distilGroup(
  group: Memory[],
  distil: Distiller,
): Promise<{ title: string; body: string } | null> {
  const episodes = group
    .map((m) => `- ${m.title}${m.body ? `\n  ${m.body.replace(/\n/g, "\n  ")}` : ""}`)
    .join("\n");

  let reply: string;
  try {
    reply = (await distil(PROMPT + episodes)).trim();
  } catch {
    return null; // the model failed; leave the episodes alone
  }

  if (!reply || reply.toUpperCase().startsWith("SKIP")) return null;

  const [title, ...body] = reply.split("\n");
  const claim = {
    title: (title ?? "").replace(/^#+\s*/, "").trim(),
    body: body.join("\n").trim(),
  };
  // Reject nonconforming output rather than writing it. A claim that is empty or
  // absurdly long is a sign the model ignored the contract, and consuming the
  // source episodes on the strength of it would destroy them for nothing.
  if (!claim.title || claim.title.length > 200) return null;
  return claim;
}

/**
 * Global downscaling. docs/brain.md §5 -- signal improves because the total is cut.
 *
 * Elapsed time is measured from the last decay, not from `updated`. Measuring
 * from `updated` compounds: two compaction runs a minute apart would each apply
 * a week's worth of decay.
 */
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
  for (const group of distil ? cluster(episodes) : []) {
    if (group.length < 2) continue; // one episode is not yet a lesson
    report.clustered += 1;

    const claim = await distilGroup(group, distil!);
    if (!claim) continue;

    report.changes.push(
      `${group.length} episodes -> "${claim.title}"\n` +
        group.map((m) => `    - ${m.title}`).join("\n"),
    );
    report.episodesConsumed += group.length;
    report.claimsWritten += 1;
    if (dryRun) continue;

    store.create({
      kind: "claim",
      scope: group[0]!.scope,
      title: claim.title,
      body: claim.body,
      tags: [...new Set(group.flatMap((m) => m.tags))],
      files: [...new Set(group.flatMap((m) => m.files))],
      salience: Math.max(...group.map((m) => m.salience)),
      provenance: group.map((m) => m.id),
    });
    for (const m of group) store.remove(m.id);
  }

  // 2. Promote ---------------------------------------------------------------
  // A claim repeatedly corroborated stops being a fact and becomes how we do
  // things here. Recurrence is required: you cannot learn a habit from one telling.
  for (const m of store.all()) {
    if (m.kind !== "claim" || m.supersededBy) continue;
    if (m.provenance.length < PROMOTE_MIN_EVIDENCE) continue;
    if (m.accessCount < PROMOTE_MIN_ACCESS) continue;
    report.promoted += 1;
    report.changes.push(`promote -> pattern: "${m.title}"`);
    if (dryRun) continue;
    m.kind = "pattern";
    m.strength = Math.min(2, m.strength + 0.3);
    store.write(m);
  }

  // 3. Decay -----------------------------------------------------------------
  for (const m of store.all()) {
    if (m.kind === "episode") continue; // episodes are consumed, not decayed
    const next = decayOne(m, now);
    if (next < COLD && deep) {
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
    store.write(m);
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
      `${r.promoted} promoted, ${r.decayed} decayed, ${r.purged} purged`,
  ];
  return lines.join("\n");
}
