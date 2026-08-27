/**
 * The ranker.
 *
 * The index says how well text matched. This says which of those matches
 * deserve to surface, which is a different question and the one lethe has an
 * opinion about: a distilled claim beats a raw episode, a memory about the file
 * in front of you beats one about elsewhere, and a memory you have leaned on
 * repeatedly beats one that has been decaying untouched.
 *
 * It is also where pattern completion happens. Consolidation leaves the
 * episodic trace on disk rather than deleting it (docs/brain.md 7), so a query
 * phrased the way the original episode was phrased can reach the claim that
 * replaced it. The trace is a route, never a result -- what comes back is the
 * claim.
 */

import type { Memory } from "./store.js";
import type { Hit } from "./index-db.js";

/**
 * Everything about the score that is not about text.
 *
 * Kept identical to what the naive scorer applied, so that replacing the
 * lexical term changes one variable at a time. An eval cannot attribute an
 * improvement otherwise.
 */
export function dynamicsMultiplier(m: Memory, paths: string[]): number {
  let mult = 1;
  if (m.kind === "claim") mult *= 1.5;
  if (m.kind === "pattern") mult *= 1.5;
  if (paths.length && m.files.length) {
    const overlap = m.files.some((f) => paths.some((p) => f.includes(p) || p.includes(f)));
    if (overlap) mult *= 2;
  }
  // A memory borrowed from another repository is a fallback, not an answer.
  if (m.fromProject) mult *= 0.5;
  return mult * m.strength;
}

export function rank(
  hits: Hit[],
  byId: Map<string, Memory>,
  paths: string[],
  limit: number,
): Memory[] {
  // A claim can be reached directly and through several of its traces. Keep the
  // best score per destination rather than emitting it once per route.
  const best = new Map<string, { m: Memory; score: number }>();

  for (const hit of hits) {
    const matched = byId.get(hit.id);
    if (!matched) continue;

    // Resolve forward. An episode whose claim has been evicted is dropped:
    // it was kept as a route to something, and returning the raw trace instead
    // would undo the consolidation the user already paid for.
    const target = hit.supersededBy ? byId.get(hit.supersededBy) : matched;
    if (!target || target.supersededBy) continue;

    const score = hit.relevance * dynamicsMultiplier(target, paths);
    const existing = best.get(target.id);
    if (!existing || score > existing.score) best.set(target.id, { m: target, score });
  }

  return [...best.values()]
    // Ties break on title, not on id and not on filesystem order. Ids are
    // random, so an id tiebreak is stable only within a single run, and an eval
    // that ranks differently on another machine cannot be reproduced.
    .sort((a, b) => b.score - a.score || a.m.title.localeCompare(b.m.title))
    .slice(0, limit)
    .map((r) => r.m);
}
