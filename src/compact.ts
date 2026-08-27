/**
 * Compaction: consolidate, promote, decay.
 *
 * docs/compact.md. Three passes, in order, all off the user's latency path.
 *
 * The model is optional. With one, clusters of episodes are rewritten into a
 * single claim. Without one, consolidation does not run at all: episodes wait
 * for a session that can distil them. Decay still runs either way.
 */

import type { Memory, Scope, Store } from "./store.js";
import { log } from "./log.js";
import { STOP, stem } from "./query.js";

/** Asks a model for a completion. Supplied by the MCP host via sampling. */
export type Distiller = (prompt: string) => Promise<string>;

export interface CompactOptions {
  /**
   * Where consolidated claims are written. Cannot be inferred from the source
   * episodes -- those are always stored locally, so they would always say
   * "local" and a claim could never reach the team.
   */
  claimScope?: Scope;
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
/** Distinct confirmers that make a claim team knowledge rather than one view. */
const PROMOTE_MIN_CONFIRMERS = 2;
const SIMILARITY = 0.12;
/**
 * A consolidated claim has to still be about one thing. Beyond a handful of
 * episodes the distilled result generalises into a platitude -- observed on real
 * data, where eight episodes became "guard shared instance state in async",
 * discarding the specific commands and traps that made each one worth keeping.
 */
const MAX_CLUSTER = 5;

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

    // Average linkage: a candidate must resemble the group as a whole, not just
    // one member of it. Single-link growth chains -- A relates to B, B to C, and
    // a run of weak pairwise links fuses unrelated topics into one cluster. On
    // real data that turned eight distinct lessons, about pytest, linting,
    // MLflow packaging and concurrency, into a single meaningless claim.
    for (let grew = true; grew && group.length < MAX_CLUSTER; ) {
      grew = false;
      let best: { m: Memory; score: number } | null = null;

      for (const other of episodes) {
        if (seen.has(other.id)) continue;
        // Shared files or tags are concrete evidence of relatedness and still
        // count on their own; prose similarity has to hold against the average.
        const concrete = group.some((g) =>
          other.files.some((f) => g.files.includes(f)) ||
          other.tags.some((t) => g.tags.includes(t)));
        const mean =
          group.reduce((sum, g) => sum + jaccard(toks.get(g.id)!, toks.get(other.id)!), 0) /
          group.length;
        if (!concrete && mean < SIMILARITY) continue;
        const score = concrete ? Math.max(mean, SIMILARITY) : mean;
        if (!best || score > best.score) best = { m: other, score };
      }

      if (best) {
        group.push(best.m);
        seen.add(best.m.id);
        grew = true;
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
- No preamble, no commentary, no tool use. Do not explain what you are doing.
- Your entire reply is the memory itself: a title line, a blank line, then 1-3
  lines of body. Nothing before the title.

Episodes:
`;

/**
 * Distilling one episode is a different job from distilling several.
 *
 * With several, the work is generalisation -- find what is invariant and discard
 * what belonged to any one of them. With one there is nothing to generalise
 * across, so the work is compression: keep the lesson, drop the narration. The
 * multi-episode prompt asks for what is "INVARIANT across them", which is
 * incoherent for a single source and produced SKIP when tried.
 */
const PROMPT_SINGLE = `You are consolidating an AI coding agent's memory of one codebase.

Below is one episode recorded during work. Compress it into the durable lesson it
contains -- what will still be true next month -- and state it as one claim a
future agent can act on.

Rules:
- One claim. If the episode contains no durable lesson, say exactly: SKIP
- Lead with the rule, not the story. "Tests need docker compose up first", not
  "we spent time debugging tests".
- Reproduce commands, paths, environment variables and error strings EXACTLY as
  written. A lesson whose command has been paraphrased cannot be found again.
- Drop what was incidental: timings, dead ends that led nowhere, narration.
- No preamble, no commentary, no tool use. Do not explain what you are doing.
- Your entire reply is the memory itself: a title line, a blank line, then 1-3
  lines of body. Nothing before the title.

Episode:
`;

/**
 * An episode significant enough to distil with no similar sibling.
 *
 * Clustering alone cannot consolidate a store like this one. It requires two
 * topically similar episodes, and a productive session produces notes on
 * unrelated things -- an npm packaging trap, a rejected design, a measurement.
 * Five useful memories with no overlap never cluster, so they stay raw forever
 * however high the pressure threshold climbs. Measured: 32 episodes, 3 claims.
 *
 * docs/brain.md 4 says replay is selective, and selects on significance rather
 * than on repetition: "Events tagged as significant -- reward, surprise,
 * emotional salience -- are replayed preferentially." A single significant
 * event does consolidate in biology. Requiring a topical twin was the less
 * faithful reading.
 *
 * Two routes in, matching the two signals available: it has been retrieved
 * repeatedly, or it was recorded as significant in the first place.
 */
const SOLO_MIN_ACCESS = 2;
const SOLO_MIN_SALIENCE = 0.8;

function worthDistillingAlone(m: Memory): boolean {
  return m.accessCount >= SOLO_MIN_ACCESS || m.salience >= SOLO_MIN_SALIENCE;
}

/**
 * Agent CLIs are the fallback distiller, and an agent narrates: it announces
 * which tool it intends to use, or prefaces the answer with "Let me...". That
 * text is not a memory, and storing it as one is worse than storing nothing.
 */
/** Values that appear in more than one source, else those of the best source. */
function shared(lists: string[][], group: Memory[]): string[] {
  const count = new Map<string, number>();
  for (const list of lists) {
    for (const v of new Set(list)) count.set(v, (count.get(v) ?? 0) + 1);
  }
  const agreed = [...count].filter(([, n]) => n > 1).map(([v]) => v);
  if (agreed.length) return agreed.slice(0, 8);
  const best = [...group].sort((a, b) => b.salience - a.salience)[0];
  return (lists[group.indexOf(best!)] ?? []).slice(0, 8);
}

const PREAMBLE = /^(let me\b|i'?ll\b|i will\b|here'?s\b|sure[,!.]|okay[,!.]|based on\b|looking at\b|this (is|looks)\b|lethe_|the \w+ tool\b)/i;

async function distilGroup(
  group: Memory[],
  distil: Distiller,
): Promise<{ title: string; body: string } | null> {
  const episodes = group
    .map((m) => `- ${m.title}${m.body ? `\n  ${m.body.replace(/\n/g, "\n  ")}` : ""}`)
    .join("\n");

  let reply: string;
  try {
    const prompt = group.length === 1 ? PROMPT_SINGLE : PROMPT;
    reply = (await distil(prompt + episodes)).trim();
  } catch (err) {
    log("error", `distil failed: ${err instanceof Error ? err.message : String(err)}`);
    return null; // the model failed; leave the episodes alone
  }

  if (!reply) {
    log("compact", "rejected: model returned nothing");
    return null;
  }
  if (reply.toUpperCase().startsWith("SKIP")) {
    log("compact", "model judged the group unrelated; left intact");
    return null;
  }

  let [title, ...body] = reply.split("\n");
  title = (title ?? "").replace(/^#+\s*/, "").trim();

  // Models sometimes answer in prose rather than title-then-body. Rather than
  // discard a sound consolidation over formatting, take the first sentence as
  // the title and keep the rest as body.
  if (title.length > 120) {
    // A sentence end, not an abbreviation. Splitting naively produced the title
    // "...always specify the path, e.g" with the rest orphaned into the body.
    const cut = /^(.{20,160}?(?<!\b(?:e\.g|i\.e|etc|vs|cf|approx|no)\b)[.;])\s+(?=[A-Z`"'(])/
      .exec(title);
    if (cut?.[1]) {
      body = [title.slice(cut[0].length), ...body];
      title = cut[1].replace(/[.;]$/, "");
    } else {
      // No clean break: keep the whole reply as the body rather than cutting a
      // sentence in half, and title it from the leading clause.
      const clause = /^(.{20,150}?)(?:[,;:]|\s+--\s+|\s+—\s+)/.exec(title);
      if (clause?.[1]) {
        body = [title, ...body];
        title = clause[1].trim();
      } else {
        // Still nothing to cut on. Trim at a word boundary rather than lose the
        // claim: a long title is untidy, discarding a sound consolidation is not.
        body = [title, ...body];
        title = title.slice(0, 110).replace(/\s+\S*$/, "");
      }
    }
  }
  const claim = { title, body: body.join("\n").trim() };
  // Reject nonconforming output rather than writing it. A claim that is empty or
  // absurdly long is a sign the model ignored the contract, and consuming the
  // source episodes on the strength of it would destroy them for nothing.
  // Length is no longer grounds for rejection -- it is fixed above. What is left
  // is content that should never have been stored: nothing, or agent chatter.
  if (!claim.title || PREAMBLE.test(claim.title)) {
    log("compact", `rejected nonconforming reply: ${JSON.stringify(reply.slice(0, 160))}`);
    return null;
  }
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
  const { distil, dryRun = false, deep = false, claimScope = "local" } = opts;
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
    // One episode is not yet a lesson -- unless it has proven to be one, by
    // being retrieved repeatedly or by having been recorded as significant.
    if (group.length < 2 && !worthDistillingAlone(group[0]!)) continue;
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

    const written = store.create({
      kind: "claim",
      scope: claimScope,
      title: claim.title,
      body: claim.body,
      // Union across sources produced thirty tags and a dozen files on one
      // claim, which is noise: it makes tag matching meaningless and lets path
      // scoping match half the repository. Keep what more than one episode
      // agreed on, falling back to the most salient episode's own.
      tags: shared(group.map((m) => m.tags), group),
      files: shared(group.map((m) => m.files), group),
      salience: Math.max(...group.map((m) => m.salience)),
      provenance: group.map((m) => m.id),
    });

    // Consumed episodes go cold rather than being deleted (docs/brain.md §7).
    // A claim is a lossy summary: it keeps the lesson and drops the exact
    // command, path or error string that often made the episode worth having.
    // Superseded memories stop surfacing in recall but remain on disk and
    // resolvable by id, so a claim that turns out to be too vague is recoverable
    // -- and a mistaken consolidation is no longer destructive.
    for (const m of group) {
      m.supersededBy = written.id;
      store.write(m);
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
    // Decay is per-machine; writing the memory would dirty a shared file.
    store.saveDynamics(m);
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
