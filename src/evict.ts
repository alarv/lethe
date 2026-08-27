/**
 * Forgetting, which the project is named for and did not do.
 *
 * Nothing was ever removed automatically. Episodes were exempt from decay
 * entirely, purging required a human typing `lethe compact --deep`, and
 * consolidation marks episodes cold rather than deleting them -- so the only
 * thing that ever removed a memory was a user calling forget. docs/brain.md 5
 * is blunt about what that makes it: "If memory only ever grows, it is a log
 * file, not a brain."
 *
 * The cost is not disk. The real store measured 130KB across 47 memories, about
 * 2MB a year. The costs are signal and resources: docs/evals.md names staleness
 * as a health metric because a store full of dead episodes retrieves worse
 * however good the ranking, and index build time and heap scale with the store
 * (144ms and 66MB at 2,800 memories, paid by a per-session server on first
 * recall).
 *
 * `strength` is already the right key. decayOne folds accessCount in as decay
 * resistance, so it blends recency and frequency -- the round-robin pressure
 * wanted, already computed, and already per-machine in dynamics.json, which is
 * where an eviction decision belongs.
 *
 * Not FIFO, deliberately. docs/brain.md 4: "replay is selective... Most of the
 * day is never replayed and is simply lost." Significance decides what survives,
 * not arrival order.
 */

import type { Memory } from "./store.js";

/**
 * Memories per project before eviction starts.
 *
 * From measurement rather than taste: the index costs 144ms to build and 66MB
 * of heap at 2,800 memories, and a per-session MCP server pays that on first
 * recall. 2,000 stays comfortably under it, and is about forty times the real
 * store today.
 */
export const DEFAULT_BUDGET = 2000;

/**
 * Cheapest loss first.
 *
 *   1  superseded episodes      the claim survives; a retrieval route is lost
 *   2  unconsolidated episodes  never distilled, never accessed
 *   3  claims                   real loss; only under genuine pressure
 *   4  patterns                 never, they are the promoted survivors
 */
export type Tier = 1 | 2 | 3;

export function tier(m: Memory, byId: Map<string, Memory>): Tier | null {
  if (m.kind === "pattern") return null;
  if (m.supersededBy) {
    // Never evict a trace whose claim has gone. That is the one case where the
    // knowledge exists nowhere else, so dropping it is data loss rather than
    // graceful degradation.
    return byId.has(m.supersededBy) ? 1 : null;
  }
  if (m.kind === "episode") return 2;
  return 3;
}

export interface Eviction {
  memory: Memory;
  tier: Tier;
}

/**
 * What to delete to get back under budget.
 *
 * Returns the reason alongside each choice, because silent deletion in a memory
 * tool is indistinguishable from a bug, and this project has already chased
 * three phantom data-loss reports.
 */
export function selectForEviction(memories: Memory[], budget = DEFAULT_BUDGET): Eviction[] {
  const over = memories.length - budget;
  if (over <= 0) return [];

  const byId = new Map(memories.map((m) => [m.id, m]));
  return memories
    .map((m) => ({ memory: m, tier: tier(m, byId) }))
    .filter((c): c is Eviction => c.tier !== null)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.memory.strength - b.memory.strength ||
        // Ids are random, so this only stabilises ordering within one run --
        // enough to make the choice reproducible for a given store snapshot.
        a.memory.id.localeCompare(b.memory.id),
    )
    .slice(0, over);
}
