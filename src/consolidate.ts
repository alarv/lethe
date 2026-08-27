/**
 * Turning episodes into claims, with the model deciding what belongs together.
 *
 * The previous design grouped episodes by Jaccard word overlap and distilled
 * each group. That cannot work, and the reason is measurable rather than
 * theoretical: on a single-project store every note shares vocabulary, so
 * "about the same project" and "about the same problem" score alike. Measured on
 * 13 hand-labelled pairs, the best achievable accuracy was 77% for Jaccard and
 * 85% for TF-IDF cosine -- and the unrelated pairs scored HIGHER than most
 * genuinely related ones, so no threshold separates them. It fused five
 * unrelated notes into one claim about FTS5 and would have dropped four.
 *
 * The distinction is semantic, so it belongs to the model. It reads every
 * unconsolidated episode at once and returns however many claims it finds,
 * citing which episodes each came from. That deletes the similarity metric, the
 * threshold and the cluster cap, and costs one model call per compaction rather
 * than one per cluster.
 *
 * What does NOT move to the model: whether a claim kept its evidence. That is
 * checked mechanically afterwards, because it is the defect the eval actually
 * found and a nondeterministic gate on a destructive operation is how
 * consolidation starts failing silently.
 */

import type { Memory } from "./store.js";
import type { Distiller } from "./compact.js";
import { droppedFrom, unrepresentedSources } from "./evidence.js";
import { log } from "./log.js";

/**
 * Episodes sent for replay in one pass.
 *
 * Bounded because a store that went months without a distiller could hold
 * hundreds, and a megabyte of prompt is neither affordable nor well-attended.
 * Chosen by salience, which is what selective replay means (docs/brain.md 4):
 * "Events tagged as significant are replayed preferentially. Most of the day is
 * never replayed and is simply lost."
 */
export const MAX_REPLAY = 24;

export interface DraftClaim {
  /** 1-based indices into the episodes given to the model. */
  sources: number[];
  title: string;
  body: string;
}

const PROMPT = `You are consolidating an AI coding agent's memory of one codebase.

Below are numbered episodes recorded during work. Decide which of them are about
the SAME underlying thing, and write one claim per group -- the durable lesson
that will still be true next month, stated so a future agent can act on it.

Judgement you are being asked for: episodes from one project share vocabulary
without being about the same problem. A note about npm packaging and a note about
query syntax are both "about this repo" and are NOT one lesson. Group by problem,
not by topic area.

Rules:
- Emit one block per claim, in the format shown. Nothing outside the blocks.
- An episode that belongs with nothing else is still worth a claim of its own if
  it carries a durable lesson. Say so by citing it alone.
- An episode that carries no durable lesson: leave it out entirely.
- Never put unrelated episodes in one group to reduce the number of claims.
- Lead with the rule, not the story. "Tests need docker compose up first", not
  "we spent time debugging tests".
- Reproduce commands, paths, environment variables and error strings EXACTLY as
  written in the sources. A lesson whose command has been paraphrased cannot be
  found again, and the claim will be rejected if any are missing.
- No preamble, no commentary, no tool use. Do not explain what you are doing.

Format, repeated per claim:

CLAIM
sources: 1, 4
title: one line, the rule itself
body: one to three lines, keeping every command and path verbatim
END

Episodes:
`;

/** Tolerant parser: CLI models drift on whitespace, case and stray prose. */
export function parseClaims(reply: string): DraftClaim[] {
  const out: DraftClaim[] = [];
  // Split on a CLAIM line rather than requiring the reply to start with one, so
  // a model that prefixes an apology still parses.
  for (const chunk of reply.split(/^\s*CLAIM\s*$/im).slice(1)) {
    const block = chunk.split(/^\s*END\s*$/im)[0] ?? chunk;
    const sourcesLine = /^\s*sources?\s*:\s*(.+)$/im.exec(block);
    const titleLine = /^\s*title\s*:\s*(.+)$/im.exec(block);
    if (!sourcesLine?.[1] || !titleLine?.[1]) continue;

    const sources = [...sourcesLine[1].matchAll(/\d+/g)]
      .map((m) => Number(m[0]))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!sources.length) continue;

    // Body runs from the body: label to the end of the block, so it may span
    // lines. A missing body is not fatal -- the title alone is a usable claim.
    const bodyStart = /^\s*body\s*:\s*/im.exec(block);
    const body = bodyStart
      ? block.slice(bodyStart.index + bodyStart[0].length).trim()
      : "";

    out.push({
      sources: [...new Set(sources)],
      title: titleLine[1].replace(/^#+\s*/, "").trim(),
      body,
    });
  }
  return out;
}

export interface Consolidation {
  claim: DraftClaim;
  sources: Memory[];
}

export interface ConsolidateResult {
  accepted: Consolidation[];
  /** Claims discarded for consuming a source while keeping nothing from it. */
  rejected: { claim: DraftClaim; missing: string[] }[];
  /** Episodes the model chose to leave unconsolidated. */
  untouched: Memory[];
}

export async function consolidate(
  episodes: Memory[],
  distil: Distiller,
): Promise<ConsolidateResult> {
  const empty: ConsolidateResult = { accepted: [], rejected: [], untouched: episodes };
  if (!episodes.length) return empty;

  const replay = [...episodes]
    .sort((a, b) => b.salience - a.salience || a.created.localeCompare(b.created))
    .slice(0, MAX_REPLAY);
  if (replay.length < episodes.length) {
    log("compact", `replaying ${replay.length} of ${episodes.length} episodes, most salient first`);
  }

  const numbered = replay
    .map((m, i) => `${i + 1}. ${m.title}${m.body ? `\n   ${m.body.replace(/\n/g, "\n   ")}` : ""}`)
    .join("\n\n");

  let reply: string;
  try {
    reply = (await distil(PROMPT + numbered)).trim();
  } catch (err) {
    log("error", `distil failed: ${err instanceof Error ? err.message : String(err)}`);
    return empty; // the model failed; leave every episode alone
  }
  if (!reply) {
    log("compact", "rejected: model returned nothing");
    return empty;
  }

  const drafts = parseClaims(reply);
  if (!drafts.length) {
    log("compact", `rejected unparseable reply: ${JSON.stringify(reply.slice(0, 160))}`);
    return empty;
  }

  const accepted: Consolidation[] = [];
  const rejected: ConsolidateResult["rejected"] = [];
  const consumed = new Set<string>();

  for (const claim of drafts) {
    const sources = claim.sources
      .map((n) => replay[n - 1])
      .filter((m): m is Memory => Boolean(m))
      // A model citing the same episode in two claims would consume it twice
      // and leave the second claim's provenance pointing at a cold trace.
      .filter((m) => !consumed.has(m.id));
    if (!sources.length) continue;
    if (!claim.title) continue;

    const text = `${claim.title}\n${claim.body}`;
    const orphaned = unrepresentedSources(sources.map((m) => m.body), text);
    if (orphaned.length) {
      // Name what each orphaned source lost, so a rejection is diagnosable
      // rather than just a count. A silent rejection is indistinguishable from
      // compaction being broken.
      const missing = orphaned.flatMap((i) =>
        droppedFrom(sources[i]!.body, text).slice(0, 2).map((e) => `${sources[i]!.title}: ${e}`),
      );
      rejected.push({ claim, missing });
      log("compact",
        `rejected "${claim.title}": consumed ${orphaned.length} source(s) keeping nothing from them`);
      continue;
    }

    for (const m of sources) consumed.add(m.id);
    accepted.push({ claim, sources });
  }

  return {
    accepted,
    rejected,
    untouched: episodes.filter((m) => !consumed.has(m.id)),
  };
}
