import { test } from "node:test";
import assert from "node:assert/strict";
import { metrics, formatMetrics } from "./metrics.js";

const line = (ts: string, event: string, rest: string) => `${ts}  ${event.padEnd(8)}  ${rest}`;

test("counts sessions that never touched lethe", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "mcp server connected  build=b1"),
    line("2026-01-01T01:00:00Z", "start", "mcp server connected  build=b1"),
    line("2026-01-01T02:00:00Z", "start", "mcp server connected  build=b1"),
    line("2026-01-01T02:01:00Z", "recall", "something  hits=3"),
  ]);
  assert.equal(m.sessions, 3);
  assert.equal(m.sessionsUsing, 1);
  assert.equal(m.sessionsRecalling, 1);
});

test("reports the recall-to-note balance", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "note", "a  id=1"),
    line("2026-01-01T00:02:00Z", "note", "b  id=2"),
    line("2026-01-01T00:03:00Z", "recall", "q  hits=2"),
  ]);
  assert.equal(m.notes, 2);
  assert.equal(m.recalls, 1);
  assert.match(formatMetrics(m), /backwards/,
    "a ratio below 1 must be called out, not just printed");
});

test("separates empty recalls from productive ones", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", "q1  hits=0"),
    line("2026-01-01T00:02:00Z", "recall", "q2  hits=4"),
    line("2026-01-01T00:03:00Z", "recall", "q3  hits=6"),
  ]);
  assert.equal(m.recalls, 3);
  assert.equal(m.emptyRecalls, 1);
  assert.equal(m.meanHits, 5, "averaged over non-empty recalls only");
});

test("credits a confirm only when a recall in that session returned something", () => {
  const withHit = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", "q  hits=2"),
    line("2026-01-01T00:02:00Z", "confirm", "x  id=1"),
  ]);
  assert.equal(withHit.confirmedAfterRecall, 1);

  const withoutHit = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", "q  hits=0"),
    line("2026-01-01T00:02:00Z", "confirm", "x  id=1"),
  ]);
  assert.equal(withoutHit.confirmedAfterRecall, 0,
    "a confirm after an empty recall is not evidence recall helped");
});

test("flags stale servers when several builds are seen", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=2026-01-01T00:00:00Z"),
    line("2026-01-02T00:00:00Z", "start", "connected  build=2026-01-02T00:00:00Z"),
  ]);
  assert.equal(m.builds.length, 2);
  assert.match(formatMetrics(m), /lethe restart/);
});

test("an empty log says so rather than printing zeroes", () => {
  assert.match(formatMetrics(metrics([])), /No activity recorded/);
});

test("ignores malformed lines instead of throwing", () => {
  assert.doesNotThrow(() => metrics(["", "garbage", "also garbage no timestamp"]));
});

test("meanHits excludes empty recalls, matching its label", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", "q1  hits=0"),
    line("2026-01-01T00:02:00Z", "recall", "q2  hits=4"),
    line("2026-01-01T00:03:00Z", "recall", "q3  hits=6"),
  ]);
  assert.equal(m.meanHits, 5, "must average 4 and 6, not 0, 4 and 6");
  assert.equal(m.emptyRecalls, 1, "the empty one is reported separately");
});

test("separates hook-driven recalls from model-driven ones", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", "q1  hits=2 via=hook"),
    line("2026-01-01T00:02:00Z", "recall", "q2  hits=3"),
  ]);
  assert.equal(m.recalls, 2);
  assert.equal(m.recallsViaHook, 1);
  assert.match(formatMetrics(m), /1 via hook, 1 by the model/);
});

test("says so when nothing is driving recall but the model", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", "q  hits=2"),
  ]);
  assert.equal(m.recallsViaHook, 0);
  assert.match(formatMetrics(m), /lethe hook show/);
});

import { composition, formatComposition, since } from "./metrics.js";

const m2 = (kind: string, supersededBy: string | null = null, salience = 0.5) =>
  ({ kind, supersededBy, salience });

test("composition separates live from cold and counts pressure", () => {
  const c = composition([
    m2("claim"), m2("pattern"),
    m2("episode"), m2("episode"),
    m2("episode", "claim-1"),
  ]);
  assert.equal(c.claims, 1);
  assert.equal(c.patterns, 1);
  assert.equal(c.episodes, 3, "cold episodes are still episodes");
  assert.equal(c.cold, 1);
  assert.equal(c.waiting, 2, "pressure counts only unconsolidated episodes");
  assert.equal(c.pressure, 1.0, "pressure sums salience, not headcount");
});

// The real store printed "episodes 25   31 of them cold": cold counted
// superseded claims too, so it could exceed the episode total.
test("cold counts only episodes; superseded claims are reported apart", () => {
  const c = composition([
    m2("claim"), m2("claim", "claim-2"), m2("pattern", "pattern-2"),
    m2("episode"), m2("episode", "claim-1"),
  ]);
  assert.equal(c.episodes, 2);
  assert.equal(c.cold, 1, "a revised claim is not a cold episode");
  assert.equal(c.superseded, 2);
  assert.ok(c.cold <= c.episodes);
  const out = formatComposition(c);
  assert.match(out, /episodes\s+2\s+1 raw, 1 cold/);
  assert.match(out, /claims \+ patterns\s+1\s+live; 2 more superseded/);
});

// The state that went unnoticed for weeks: recall serving raw session
// transcripts because consolidation had produced nothing.
test("says plainly when nothing has been distilled", () => {
  const out = formatComposition(composition([m2("episode"), m2("episode")]));
  assert.match(out, /nothing distilled/);
  assert.match(out, /raw sessions/);
});

test("flags a store that is mostly raw", () => {
  const memories = [m2("claim"), ...Array.from({ length: 20 }, () => m2("episode"))];
  assert.match(formatComposition(composition(memories)), /mostly raw/);
});

test("a healthy ratio is not flagged", () => {
  const memories = [m2("claim"), m2("claim"), m2("episode"), m2("episode")];
  const out = formatComposition(composition(memories));
  assert.doesNotMatch(out, /mostly raw|nothing distilled/);
});

test("compaction outcomes are counted from the log", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "compact", "pressure threshold reached  episodes=12"),
    line("2026-01-01T00:02:00Z", "compact", "done (extractive)  claims=1 consumed=12"),
    line("2026-01-01T00:03:00Z", "compact", "rejected nonconforming reply: blah"),
  ]);
  assert.equal(m.compactions, 1, "one run produced a claim");
  assert.equal(m.compactionsFailed, 1);
  assert.match(formatMetrics(m), /compaction runs/);
});

test("a run producing zero claims is not counted as a success", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:02:00Z", "compact", "done  claims=0 consumed=0"),
  ]);
  assert.equal(m.compactions, 0);
});

test("pressure is reported as salience against the real threshold", () => {
  const out = formatComposition(composition([m2("episode", null, 0.9), m2("episode", null, 0.9)]), 6);
  assert.match(out, /1\.8\/6/, "must show salience, not a count");
  assert.match(out, /2 raw/);
});

test("a high-salience store reaches the threshold with fewer episodes", () => {
  const few = composition(Array.from({ length: 4 }, () => m2("episode", null, 1.0)));
  const many = composition(Array.from({ length: 8 }, () => m2("episode", null, 0.2)));
  assert.ok(few.pressure > many.pressure,
    "4 important notes should outweigh 8 trivial ones");
});

test("since keeps only lines from a date onward", () => {
  const lines = [
    line("2026-08-25T10:00:00Z", "note", "old"),
    line("2026-08-27T10:00:00Z", "note", "mid"),
    line("2026-08-28T10:00:00Z", "note", "new"),
  ];
  assert.equal(since(lines, "2026-08-28").length, 1);
  assert.equal(since(lines, "2026-08-27").length, 2);
  assert.equal(since(lines, "2026-01-01").length, 3);
  assert.equal(since(lines, "2030-01-01").length, 0);
});

// The reason it exists: the test suite once logged to the real store, so counts
// before that was caught measure fixtures rather than use.
test("since can exclude a contaminated period from the metrics", () => {
  const lines = [
    line("2026-08-27T10:00:00Z", "compact", "rejected unparseable reply: fixture"),
    line("2026-08-27T10:01:00Z", "compact", "rejected unparseable reply: fixture"),
    line("2026-08-28T10:00:00Z", "start", "connected  build=b1"),
    line("2026-08-28T10:01:00Z", "recall", "real question  hits=3"),
  ];
  assert.equal(metrics(lines).compactionsFailed, 2, "unfiltered counts the fixtures");
  assert.equal(metrics(since(lines, "2026-08-28")).compactionsFailed, 0, "filtered does not");
  assert.equal(metrics(since(lines, "2026-08-28")).recalls, 1);
});

test("reports the window as a range, not an open-ended 'since'", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-08T00:00:00Z", "recall", "q  hits=3"),
  ]);
  assert.equal(m.since, "2026-01-01T00:00:00Z");
  assert.equal(m.until, "2026-01-08T00:00:00Z");
  assert.match(formatMetrics(m, new Date("2026-01-08T01:00:00Z")),
    /lethe metrics — 2026-01-01 to 2026-01-08/);
});

test("says so when the log stopped being written, rather than passing it off as current", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", "q  hits=3"),
  ]);
  const out = formatMetrics(m, new Date("2026-01-16T00:00:00Z"));
  assert.match(out, /Nothing has been logged for 14 days/,
    "a frozen window is the failure this exists to catch");
  assert.match(out, /lethe init --debug/, "and it must say how to fix it");
  assert.match(out, /lethe restart/, "including that a running server keeps its config");
});

test("a fresh log carries no staleness warning", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", "q  hits=3"),
  ]);
  assert.doesNotMatch(formatMetrics(m, new Date("2026-01-01T06:00:00Z")),
    /Nothing has been logged/);
});

test("a distiller subprocess is not a session, and does not steal the parent's events", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "mcp server connected  build=b1"),
    line("2026-01-01T00:01:00Z", "note", "a  id=1"),
    line("2026-01-01T00:02:00Z", "start", "refusing to start inside a distiller subprocess"),
    line("2026-01-01T00:03:00Z", "recall", `"q"  hits=3`),
  ]);
  assert.equal(m.sessions, 1, "the refusal line must not add to the denominator");
  assert.equal(m.sessionsRecalling, 1, "the recall after it belongs to the real session");
});

test("housekeeping is not use: only tool calls mark a session as having used lethe", () => {
  const m = metrics([
    line("2026-01-01T00:00:00Z", "start", "mcp server connected  build=b1"),
    line("2026-01-01T00:01:00Z", "compact", "raw episodes went stale  episodes=6"),
    line("2026-01-01T00:02:00Z", "sampling", "distilling via opencode"),
    line("2026-01-01T01:00:00Z", "start", "mcp server connected  build=b1"),
    line("2026-01-01T01:01:00Z", "forget", "abc12345  id=abc12345"),
  ]);
  assert.equal(m.sessions, 2);
  assert.equal(m.sessionsUsing, 1, "compact and sampling are the server's doing, forget is a tool call");
});

test("events go to the session whose server logged them, not the last to start", () => {
  const m = metrics([
    line("2026-10-01T10:00:00Z", "start", "mcp server connected  pid=100"),
    line("2026-10-01T10:00:01Z", "start", "mcp server connected  pid=200"),
    line("2026-10-01T10:00:02Z", "start", "mcp server connected  pid=300"),
    line("2026-10-01T10:01:00Z", "recall", '"q"  hits=3 ids=a pid=100'),
    line("2026-10-01T10:02:00Z", "note", "t  id=b kind=episode pid=200"),
  ]);
  assert.equal(m.sessions, 3);
  assert.equal(m.sessionsUsing, 2, "pid 100 and 200 used it; the last start did not");
  assert.equal(m.sessionsRecalling, 1);
});

test("lines without a pid still fall back to the most recent start", () => {
  const m = metrics([
    line("2026-10-01T10:00:00Z", "start", "mcp server connected"),
    line("2026-10-01T10:01:00Z", "recall", '"q"  hits=3 ids=a'),
  ]);
  assert.equal(m.sessionsUsing, 1);
});

test("rejected claims are counted against kept claims, not against runs", () => {
  const m = metrics([
    line("2026-10-01T10:00:00Z", "compact", 'rejected "a": consumed 1 source(s) keeping nothing from them'),
    line("2026-10-01T10:00:00Z", "compact", 'rejected "b": consumed 1 source(s) keeping nothing from them'),
    line("2026-10-01T10:00:01Z", "compact", "done  via=x claims=3 consumed=3 promoted=0 decayed=1"),
    line("2026-10-01T11:00:00Z", "error", "distil failed: opencode exited 1 with no output"),
  ]);
  assert.equal(m.compactions, 1);
  assert.equal(m.claimsKept, 3);
  assert.equal(m.claimsRejected, 2);
  assert.equal(m.compactionsFailed, 1, "the crashed distiller, not the gate's rejections");
  const text = formatMetrics(m);
  assert.doesNotMatch(text, /rejects more than it keeps/);
});

test("only the connection opens a session; other start lines belong to it", () => {
  const m = metrics([
    line("2026-10-01T10:00:00Z", "start", "briefed  listed=5 omitted=0 pid=1"),
    line("2026-10-01T10:00:00Z", "start", "mcp server connected  pid=1"),
    line("2026-10-01T10:00:01Z", "start", "bound to workspace root  root=/x pid=1"),
  ]);
  assert.equal(m.sessions, 1);
});
