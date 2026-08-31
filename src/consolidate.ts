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
 *
 * Existing claims are shown too, and may be revised. Without that this ran
 * blind: it saw only new episodes, so the same lesson learned in two sessions
 * was stored twice and nothing could ever notice. Measured in lethe's own store
 * -- "Compaction silently fails when the distiller is unavailable" and "All
 * lethe.log errors are distil failed: no model" are one lesson, written 28 hours
 * apart from different episodes, both live. Detecting that lexically is not an
 * option: the header above is the record of that approach already failing.
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

/**
 * Existing claims offered for revision in one pass.
 *
 * Bounded for the same reason as MAX_REPLAY: a prompt nobody attends to is worse
 * than a short one. Chosen by salience, so a duplicate outside the window waits
 * for a run where it matters more -- which is a slower merge, not a lost one.
 */
export const MAX_REVISABLE = 12;

export interface DraftClaim {
  /** 1-based indices into the episodes given to the model. */
  sources: number[];
  /** 1-based indices into the existing claims offered for revision. */
  supersedes: number[];
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
`;

/**
 * Appended only when there are claims to offer, so a model with nothing to
 * revise is never shown a field it cannot use.
 */
const REVISION = `
Lessons already recorded are listed below as C1, C2 and so on. You are seeing
them because this used to run blind -- it saw only new episodes, so the same
lesson learned twice was stored twice, and nothing could notice.

If an episode is about the same underlying thing as one of those claims, do not
write a second claim beside it. Write the claim you would have written anyway and
name what it replaces:

CLAIM
supersedes: C1
sources: 3
title: one line, the rule itself
body: one to three lines
END

Rules for revising:
- A revision REPLACES the claim it supersedes. Keep everything in it that is
  still true and add what the episodes taught; anything you leave out is lost.
- Reproduce the old claim's commands, paths and error strings exactly as well.
  The revision is rejected for dropping them, exactly as it is for episodes.
- Supersede more than one claim only when they are the same lesson stated twice.
  That case is worth catching: it is how duplicates get collapsed.
- Never supersede a claim for being on a related topic. In doubt, leave it and
  write a separate claim.
- Every claim still needs at least one episode in sources. Do not rewrite a
  claim you have nothing new to add to.

Existing claims:
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

    // `supersedes: C1, C2`. Optional, and so is the C -- models drop it about as
    // often as they keep it.
    const supersedesLine = /^\s*supersedes\s*:\s*(.+)$/im.exec(block);
    const supersedes = [...new Set(
      [...(supersedesLine?.[1] ?? "").matchAll(/\d+/g)]
        .map((m) => Number(m[0]))
        .filter((n) => Number.isFinite(n) && n > 0),
    )];

    // Body runs from the body: label to the end of the block, so it may span
    // lines. A missing body is not fatal -- the title alone is a usable claim.
    const bodyStart = /^\s*body\s*:\s*/im.exec(block);
    const body = bodyStart
      ? block.slice(bodyStart.index + bodyStart[0].length).trim()
      : "";

    out.push({
      sources: [...new Set(sources)],
      supersedes,
      title: titleLine[1].replace(/^#+\s*/, "").trim(),
      body,
    });
  }
  return out;
}

export interface Consolidation {
  claim: DraftClaim;
  sources: Memory[];
  /** Existing claims this one replaces. They go cold, exactly as episodes do. */
  revises: Memory[];
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
  claims: Memory[] = [],
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

  // Most salient first, then most recently touched, mirroring replay. A claim
  // outside the window is not offered this run and keeps its duplicate for now.
  const revisable = [...claims]
    .sort((a, b) => b.salience - a.salience || b.updated.localeCompare(a.updated))
    .slice(0, MAX_REVISABLE);
  const numberedClaims = revisable
    .map((m, i) => `C${i + 1}. ${m.title}${m.body ? `\n    ${m.body.replace(/\n/g, "\n    ")}` : ""}`)
    .join("\n\n");

  const prompt = revisable.length
    ? `${PROMPT}${REVISION}\n${numberedClaims}\n\nEpisodes:\n\n${numbered}`
    : `${PROMPT}\nEpisodes:\n\n${numbered}`;

  let reply: string;
  try {
    reply = (await distil(prompt)).trim();
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
  const revised = new Set<string>();

  for (const claim of drafts) {
    const sources = claim.sources
      .map((n) => replay[n - 1])
      .filter((m): m is Memory => Boolean(m))
      // A model citing the same episode in two claims would consume it twice
      // and leave the second claim's provenance pointing at a cold trace.
      .filter((m) => !consumed.has(m.id));
    // Still requires new evidence: a claim with no episode behind it is a
    // rewrite for its own sake, and the evidence gate would have nothing to
    // check it against.
    if (!sources.length) continue;
    if (!claim.title) continue;

    const revises = claim.supersedes
      .map((n) => revisable[n - 1])
      .filter((m): m is Memory => Boolean(m))
      // Two revisions of one claim would leave the loser's successor pointing at
      // a memory that is already cold.
      .filter((m) => !revised.has(m.id));

    // A superseded claim is consumed exactly as an episode is, so it goes
    // through the same gate: replace a claim and you must keep at least one of
    // its retrievable strings. Otherwise "revising" is how a claim's commands
    // quietly disappear -- the failure the gate was built for, one level up.
    const eaten = [...sources, ...revises];
    const text = `${claim.title}\n${claim.body}`;
    const orphaned = unrepresentedSources(eaten.map((m) => m.body), text);
    if (orphaned.length) {
      // Name what each orphaned source lost, so a rejection is diagnosable
      // rather than just a count. A silent rejection is indistinguishable from
      // compaction being broken.
      const missing = orphaned.flatMap((i) =>
        droppedFrom(eaten[i]!.body, text).slice(0, 2).map((e) => `${eaten[i]!.title}: ${e}`),
      );
      rejected.push({ claim, missing });
      log("compact",
        `rejected "${claim.title}": consumed ${orphaned.length} source(s) keeping nothing from them`);
      continue;
    }

    for (const m of sources) consumed.add(m.id);
    for (const m of revises) revised.add(m.id);
    if (revises.length) {
      log("compact", `"${claim.title}" revises ${revises.length} existing claim(s)`);
    }
    accepted.push({ claim, sources, revises });
  }

  return {
    accepted,
    rejected,
    untouched: episodes.filter((m) => !consumed.has(m.id)),
  };
}
