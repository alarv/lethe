/**
 * Is anyone actually using this?
 *
 * log.ts was written on the observation that "a memory harness that is silent is
 * indistinguishable from one that is never called". That turned out to be the
 * real failure: measured across 79 sessions, 76% never touched lethe at all and
 * only 10% called recall. Better retrieval is worth very little at that rate, so
 * adoption needs to be a number somebody watches rather than an impression.
 *
 * Everything here is derived from the log. No new bookkeeping, no state to keep
 * in sync, and it works retroactively on history already recorded.
 */

import { existsSync, readFileSync } from "node:fs";
import { LOG_PATH } from "./log.js";

export interface Metrics {
  since: string | null;
  /**
   * Timestamp of the last line in the log, i.e. where the window actually ends.
   *
   * Reported because `since` alone reads as "up to now", and a log that stopped
   * being written does not look any different from a quiet one. Logging is off by
   * default and a config change does not reach an already-running server, so the
   * realistic failure is a frozen window presented as current: this happened for
   * 15 days and the adoption rows below were read as today's numbers.
   */
  until: string | null;
  sessions: number;
  sessionsUsing: number;
  sessionsRecalling: number;
  recalls: number;
  /** Recalls the UserPromptSubmit hook performed, needing no model cooperation. */
  recallsViaHook: number;
  notes: number;
  confirms: number;
  corrections: number;
  /** Recalls that returned nothing: retrieval failing, or an empty store. */
  emptyRecalls: number;
  /** Mean hits across recalls that returned at least one, excluding empties. */
  meanHits: number;
  /**
   * Recalls whose results were later confirmed in the same session.
   *
   * The closest thing to "memory helped" that the log can support, and it
   * undercounts badly: confirm has to be called by the model, which is the same
   * cooperation problem that produced the 10% adoption rate. Read it as a floor,
   * never as a rate.
   */
  confirmedAfterRecall: number;
  /** Compaction runs that produced at least one claim. */
  compactions: number;
  /** Distiller calls that yielded nothing usable: an error, no reply, an unparseable one. */
  compactionsFailed: number;
  /** Claims written by compaction. */
  claimsKept: number;
  /**
   * Claims the evidence gate threw away.
   *
   * Counted apart from compactionsFailed: one run can keep two claims and reject
   * five, and lumping per-claim rejections in with per-run successes printed
   * "the distiller fails more than it succeeds" over a log where it had not.
   */
  claimsRejected: number;
  /** Builds seen running. More than one means stale servers are still serving. */
  builds: string[];
}

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

/**
 * The whole log, oldest first, across a rotation.
 *
 * The rotated half has to be included or metrics silently restart from zero
 * every time the log fills -- which would make adoption look like it collapsed
 * on a day when nothing happened but a rename.
 */
export function readLog(path = LOG_PATH): string[] {
  const read = (p: string): string[] => {
    try {
      return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
    } catch {
      return [];
    }
  };
  return [...read(`${path}.1`), ...read(path)];
}

/**
 * Only the lines from a date onward.
 *
 * Exists because history can be untrustworthy in ways deleting it would not fix.
 * The test suite once logged to the real store, so the counts before that was
 * caught measure fixtures rather than use; excluding a period is honest, editing
 * the log would not be. Timestamps are ISO 8601, so a prefix compare is a date
 * compare.
 */
export function since(lines: string[], date: string): string[] {
  return lines.filter((l) => l.slice(0, date.length) >= date);
}

/** Events written only when a tool is called, by the model or the prompt hook. */
const TOOL_CALLS = new Set(["recall", "note", "confirm", "correct", "forget", "learn"]);

/** server.ts logs this when a distiller subprocess tries to start a server. */
const DISTILLER_CHILD = /refusing to start inside a distiller subprocess/;

export function metrics(lines: string[]): Metrics {
  const entries = parse(lines);

  // Events go to the session whose server logged them, by pid. Lines written
  // before pids were logged, and hook recalls (a separate process), fall back
  // to the most recent preceding start -- approximate, because sessions
  // interleave, which is exactly why the pid is there now.
  type Session = { used: boolean; recalled: boolean; recalledAny: boolean };
  const sessions: Session[] = [];
  const byPid = new Map<string, Session>();
  let recalls = 0, recallsViaHook = 0, notes = 0, confirms = 0, corrections = 0, emptyRecalls = 0;
  let hitTotal = 0, hitCount = 0, confirmedAfterRecall = 0;
  let compactions = 0, compactionsFailed = 0, claimsKept = 0, claimsRejected = 0;
  const builds = new Set<string>();

  for (const e of entries) {
    if (e.event === "start") {
      // A compaction's distiller subprocess inherits the MCP config, starts a
      // server, and logs a refusal. It is not a session: counting it put 25 of
      // 141 "sessions" in the denominator that no person ever opened, and began a
      // fresh session that swallowed the parent's following events.
      if (DISTILLER_CHILD.test(e.rest)) continue;
      // The server logs other start lines (briefed, bound to a workspace root)
      // within the same session; only the connection opens one.
      if (!/\bconnected\b/.test(e.rest)) continue;
      const session = { used: false, recalled: false, recalledAny: false };
      sessions.push(session);
      const pid = /\bpid=(\d+)/.exec(e.rest)?.[1];
      if (pid) byPid.set(pid, session);
      const build = /build=(\S+)/.exec(e.rest)?.[1];
      if (build) builds.add(build);
      continue;
    }
    const pid = /\bpid=(\d+)/.exec(e.rest)?.[1];
    const current = (pid && byPid.get(pid)) || sessions[sessions.length - 1];
    // Only a tool call counts as use. compact, sampling and index lines are the
    // server doing its own housekeeping, and counting them reported 63% of
    // sessions as using lethe when the model had called it in 40%.
    if (current && TOOL_CALLS.has(e.event)) current.used = true;

    switch (e.event) {
      case "recall": {
        recalls += 1;
        if (/\bvia=hook\b/.test(e.rest)) recallsViaHook += 1;
        if (current) current.recalled = true;
        const hits = Number(/hits=(\d+)/.exec(e.rest)?.[1] ?? NaN);
        if (Number.isFinite(hits)) {
          if (hits === 0) {
            emptyRecalls += 1;
          } else {
            // Averaged over non-empty recalls only. Including the empties would
            // fold the retrieval-failure rate into the depth measure and make
            // both harder to read.
            hitCount += 1;
            hitTotal += hits;
            if (current) current.recalledAny = true;
          }
        }
        break;
      }
      case "note":
        notes += 1;
        break;
      case "confirm":
        confirms += 1;
        if (current?.recalledAny) confirmedAfterRecall += 1;
        break;
      case "correct":
        corrections += 1;
        break;
      case "compact":
        // The log records several lines per run; count outcomes, not chatter.
        {
          const kept = Number(/\bclaims=(\d+)/.exec(e.rest)?.[1] ?? 0);
          claimsKept += kept;
          if (kept > 0) compactions += 1;
          else if (/^rejected "/.test(e.rest)) claimsRejected += 1;
          else if (/^rejected/.test(e.rest)) compactionsFailed += 1;
        }
        break;
      case "error":
        if (/^distil failed/.test(e.rest)) compactionsFailed += 1;
        break;
    }
  }

  return {
    since: entries[0]?.ts ?? null,
    until: entries[entries.length - 1]?.ts ?? null,
    sessions: sessions.length,
    sessionsUsing: sessions.filter((s) => s.used).length,
    sessionsRecalling: sessions.filter((s) => s.recalled).length,
    recalls,
    recallsViaHook,
    notes,
    confirms,
    corrections,
    emptyRecalls,
    meanHits: hitCount ? hitTotal / hitCount : 0,
    confirmedAfterRecall,
    compactions,
    compactionsFailed,
    claimsKept,
    claimsRejected,
    builds: [...builds].sort(),
  };
}

/**
 * What consolidation has actually produced.
 *
 * The ratio that matters, and the one nobody was looking at: the store was 32
 * episodes to 3 claims for weeks, which means recall was serving raw session
 * transcripts and the distilled memory the project exists to produce barely
 * existed. Derived from the store rather than the log, because the log records
 * that compaction ran, not what survived.
 */
export interface Composition {
  episodes: number;
  claims: number;
  patterns: number;
  /** Consolidated episodes: superseded by the claim they were distilled into. */
  cold: number;
  /** Claims and patterns replaced by a revision; not in `claims` or `patterns`. */
  superseded: number;
  /** Unconsolidated episodes. */
  waiting: number;
  /** Salience summed over unconsolidated episodes: what pressure actually is. */
  pressure: number;
}

export function composition(
  memories: { kind: string; supersededBy: string | null; salience?: number }[],
): Composition {
  const live = (kind: string) =>
    memories.filter((m) => m.kind === kind && !m.supersededBy).length;
  return {
    episodes: memories.filter((m) => m.kind === "episode").length,
    claims: live("claim"),
    patterns: live("pattern"),
    // Episodes only. Counting every superseded memory here put revised claims
    // into the episode row and printed "25 episodes, 31 of them cold".
    cold: memories.filter((m) => m.kind === "episode" && m.supersededBy).length,
    superseded: memories.filter((m) => m.kind !== "episode" && m.supersededBy).length,
    waiting: live("episode"),
    pressure: memories
      .filter((m) => m.kind === "episode" && !m.supersededBy)
      .reduce((sum, m) => sum + (m.salience ?? 0), 0),
  };
}

export function formatComposition(c: Composition, threshold = 6): string {
  const distilled = c.claims + c.patterns;
  const lines = ["", "consolidation — what the index actually has to serve"];
  const row = (label: string, value: string, note = "") =>
    lines.push(`  ${label.padEnd(26)} ${value.padStart(9)}   ${note}`);

  row("claims + patterns", String(distilled), c.superseded ? `live; ${c.superseded} more superseded` : "");
  row("episodes", String(c.episodes), `${c.waiting} raw, ${c.cold} cold`);
  row(
    "distilled per episode",
    c.episodes ? (distilled / c.episodes).toFixed(2) : "n/a",
    distilled === 0
      ? "<- nothing distilled; recall serves raw sessions"
      : distilled / c.episodes < 0.2
        ? "<- mostly raw"
        : "",
  );
  // Salience, not headcount -- the same number the server acts on. Reporting a
  // count here while the trigger used salience gave two answers for one thing.
  row(
    "pressure",
    `${c.pressure.toFixed(1)}/${threshold}`,
    `salience across ${c.waiting} raw` + (c.pressure >= threshold ? " — compaction due" : ""),
  );
  return lines.join("\n");
}

function pct(n: number, of: number): string {
  return of ? `${Math.round((n / of) * 100)}%` : "n/a";
}

/**
 * How long the log may go unwritten before the window is called stale.
 *
 * Two days, because a weekend of not coding is normal and a fortnight of
 * apparently-live numbers that stopped moving is not.
 */
const STALE_DAYS = 2;

export function formatMetrics(m: Metrics, now: Date = new Date()): string {
  if (!m.sessions && !m.recalls) {
    return "No activity recorded yet. Run `lethe doctor` if that is unexpected.";
  }
  const lines: string[] = [];
  const row = (label: string, value: string, note = "") =>
    lines.push(`  ${label.padEnd(26)} ${value.padStart(9)}   ${note}`);

  const day = (ts: string) => ts.slice(0, 10);
  // A range, not "since": the end of the window is the part that gets misread.
  const window = m.since && m.until
    ? ` — ${day(m.since)} to ${day(m.until)}`
    : m.since ? ` — since ${day(m.since)}` : "";
  lines.push(`lethe metrics${window}`);

  const staleFor = m.until
    ? Math.floor((now.getTime() - new Date(m.until).getTime()) / 86_400_000)
    : 0;
  if (staleFor >= STALE_DAYS) {
    lines.push("");
    lines.push(`  Nothing has been logged for ${staleFor} days. Every number below ends`);
    lines.push(`  ${day(m.until!)} — it is a snapshot of that window, not of today.`);
    lines.push("  Logging is off, or a server started before it was turned on:");
    lines.push("  `lethe init --debug` then `lethe restart`, since a running server");
    lines.push("  keeps the config it started with.");
  }
  lines.push("");
  lines.push("adoption — the number that decides whether anything else matters");
  row("sessions connected", String(m.sessions));
  row("called a lethe tool", `${m.sessionsUsing}`, pct(m.sessionsUsing, m.sessions));
  row("called recall", `${m.sessionsRecalling}`, pct(m.sessionsRecalling, m.sessions));
  row("never touched it", `${m.sessions - m.sessionsUsing}`,
    pct(m.sessions - m.sessionsUsing, m.sessions));

  lines.push("");
  lines.push("balance — memory should be read far more often than written");
  row("recalls", String(m.recalls),
    m.recallsViaHook ? `${m.recallsViaHook} via hook, ${m.recalls - m.recallsViaHook} by the model` : "all by the model");
  row("notes", String(m.notes));
  row("recalls per note", m.notes ? (m.recalls / m.notes).toFixed(2) : "n/a",
    m.notes && m.recalls / m.notes < 1 ? "<- backwards" : "");

  lines.push("");
  lines.push("consolidation");
  row("compaction runs", String(m.compactions),
    m.compactions === 0 ? "<- never produced a claim" : "");
  row("distiller failures", String(m.compactionsFailed),
    m.compactionsFailed > m.compactions ? "<- the distiller fails more than it succeeds" : "");
  row("claims kept", String(m.claimsKept));
  row("claims rejected", String(m.claimsRejected),
    m.claimsRejected > m.claimsKept ? "<- the evidence gate rejects more than it keeps" : "");

  lines.push("");
  lines.push("retrieval");
  row("recalls returning nothing", String(m.emptyRecalls), pct(m.emptyRecalls, m.recalls));
  row("mean hits when non-empty", m.meanHits.toFixed(1));
  row("confirmed after a recall", String(m.confirmedAfterRecall),
    "floor only — confirm needs the model to call it");
  row("corrections", String(m.corrections));

  if (!m.recallsViaHook) {
    lines.push("");
    lines.push("  No recalls came from a hook. Every one depended on the model choosing to");
    lines.push("  call it, which is why the adoption figure above looks as it does.");
    lines.push("  `lethe hook show` prints the config that removes that dependency.");
  }

  if (m.builds.length > 1) {
    lines.push("");
    lines.push(`  ${m.builds.length} builds seen running; the oldest is ${m.builds[0]}.`);
    lines.push("  A rebuild does not reach a running server. `lethe restart` clears stale ones.");
  }
  return lines.join("\n");
}
