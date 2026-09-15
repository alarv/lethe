/**
 * Harvesting real eval tasks from dogfooding.
 *
 * evals/tasks.jsonl is synthetic, which docs/evals.md names as the largest
 * caveat on the eval. The log already contains what a real task needs: a
 * recall's query, paired with a memory that recall surfaced and the session
 * then acted on, is exactly a (probe, seed) pair -- discovered instead of
 * invented.
 *
 * TWO SIGNALS, because the obvious one does not occur. `confirm` is the ideal
 * evidence and produced nothing: measured across 111 sessions it has been
 * called zero times, twice in a row, so a harvester that waits for it is
 * waiting for model cooperation that has already failed. `correct` does happen
 * -- 14 times in the same window -- and is nearly as good a pair for *this*
 * purpose: correcting a memory proves recall surfaced the one the session was
 * looking for. It says the content was wrong, not that retrieval was, and
 * retrieval is what the eval measures.
 *
 * So a candidate records which signal produced it. Weigh them differently when
 * reviewing: a confirm says "right answer", a correct says "right memory".
 * Still a trickle to review by hand, not a pipeline that feeds the eval
 * unsupervised.
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
  /**
   * Which signal produced the pair.
   *
   * `confirm` means the memory answered the query. `correct` means it was the
   * memory the session wanted but its content was wrong -- good evidence of
   * retrieval, weaker evidence of the seed text, so review it before promoting.
   */
  via: "confirm" | "correct";
}

/**
 * Every confirm or correct matched back to the most recent recall, in the same
 * session, whose results included that memory's id.
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

    if (e.event === "confirm" || e.event === "correct") {
      const via = e.event;
      // confirm logs the memory as `id=`; correct logs the superseded one as
      // `old=`, which is the id recall actually returned.
      const id = via === "confirm"
        ? /\bid=(\w+)/.exec(e.rest)?.[1]
        : /\bold=(\w+)/.exec(e.rest)?.[1];
      if (!id) continue;
      // correct logs "<old title> -> <new title>"; the seed is the old one.
      const logged = e.rest.split(/ {2}/)[0] ?? "";
      const title = via === "correct" ? (logged.split(" -> ")[0] ?? logged) : logged;
      for (let i = recalls.length - 1; i >= 0; i--) {
        if (recalls[i]?.ids.includes(id)) {
          out.push({ ts: e.ts, query: recalls[i]!.query, id, title, via });
          break;
        }
      }
    }
  }

  return out;
}
