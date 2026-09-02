/**
 * Harvesting real eval tasks from dogfooding.
 *
 * evals/tasks.jsonl is synthetic, which docs/evals.md names as the largest
 * caveat on the eval. The log already contains what a real task needs: a
 * recall's query, paired with a memory that was later confirmed useful, is
 * exactly a (probe, seed) pair -- discovered instead of invented.
 *
 * This undercounts the same way metrics.ts's confirmedAfterRecall does --
 * confirm has to be called by the model. Read it as a trickle to review by
 * hand, not a pipeline that feeds the eval unsupervised.
 */

interface Entry {
  ts: string;
  event: string;
  rest: string;
}

function parse(lines: string[]): Entry[] {
  const out: Entry[] = [];
  for (const line of lines) {
    const m = /^(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m?.[1] && m[2]) out.push({ ts: m[1], event: m[2], rest: m[3] ?? "" });
  }
  return out;
}

/** A recall logs its query as `JSON.stringify(query)`; pulls that back out,
 *  along with whatever extra fields (`ids=...`) follow it. */
function leadingJsonString(s: string): { value: string; rest: string } | null {
  if (!s.startsWith('"')) return null;
  let i = 1;
  while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
  try {
    return { value: JSON.parse(s.slice(0, i + 1)), rest: s.slice(i + 1) };
  } catch {
    return null;
  }
}

export interface Candidate {
  ts: string;
  query: string;
  id: string;
  title: string;
}

/**
 * Every confirm matched back to the most recent recall, in the same session,
 * whose results included the confirmed memory's id.
 *
 * Sessions reset on `start`, mirroring metrics.ts, so a recall from a
 * previous session is never credited for a confirm in this one.
 */
export function harvest(lines: string[]): Candidate[] {
  const entries = parse(lines);
  const out: Candidate[] = [];
  let recalls: { query: string; ids: string[] }[] = [];

  for (const e of entries) {
    if (e.event === "start") {
      recalls = [];
      continue;
    }

    if (e.event === "recall") {
      const parsed = leadingJsonString(e.rest);
      if (!parsed) continue;
      const ids = /\bids=([\w,]*)/.exec(parsed.rest)?.[1]?.split(",").filter(Boolean) ?? [];
      if (ids.length) recalls.push({ query: parsed.value, ids });
      continue;
    }

    if (e.event === "confirm") {
      const id = /\bid=(\w+)/.exec(e.rest)?.[1];
      if (!id) continue;
      const title = e.rest.split(/ {2}/)[0] ?? "";
      for (let i = recalls.length - 1; i >= 0; i--) {
        if (recalls[i]?.ids.includes(id)) {
          out.push({ ts: e.ts, query: recalls[i]!.query, id, title });
          break;
        }
      }
    }
  }

  return out;
}
