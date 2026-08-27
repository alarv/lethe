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
  sessions: number;
  sessionsUsing: number;
  sessionsRecalling: number;
  recalls: number;
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

export function readLog(path = LOG_PATH): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

export function metrics(lines: string[]): Metrics {
  const entries = parse(lines);

  // Events are attributed to the most recent preceding start. Sessions
  // interleave across projects, so this is approximate -- but the question it
  // answers, "did a session that had lethe available use it", does not need
  // perfect attribution to be worth knowing.
  const sessions: { used: boolean; recalled: boolean; recalledAny: boolean }[] = [];
  let recalls = 0, notes = 0, confirms = 0, corrections = 0, emptyRecalls = 0;
  let hitTotal = 0, hitCount = 0, confirmedAfterRecall = 0;
  const builds = new Set<string>();

  for (const e of entries) {
    if (e.event === "start") {
      sessions.push({ used: false, recalled: false, recalledAny: false });
      const build = /build=(\S+)/.exec(e.rest)?.[1];
      if (build) builds.add(build);
      continue;
    }
    const current = sessions[sessions.length - 1];
    if (current) current.used = true;

    switch (e.event) {
      case "recall": {
        recalls += 1;
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
    }
  }

  return {
    since: entries[0]?.ts ?? null,
    sessions: sessions.length,
    sessionsUsing: sessions.filter((s) => s.used).length,
    sessionsRecalling: sessions.filter((s) => s.recalled).length,
    recalls,
    notes,
    confirms,
    corrections,
    emptyRecalls,
    meanHits: hitCount ? hitTotal / hitCount : 0,
    confirmedAfterRecall,
    builds: [...builds].sort(),
  };
}

function pct(n: number, of: number): string {
  return of ? `${Math.round((n / of) * 100)}%` : "n/a";
}

export function formatMetrics(m: Metrics): string {
  if (!m.sessions && !m.recalls) {
    return "No activity recorded yet. Run `lethe doctor` if that is unexpected.";
  }
  const lines: string[] = [];
  const row = (label: string, value: string, note = "") =>
    lines.push(`  ${label.padEnd(26)} ${value.padStart(9)}   ${note}`);

  lines.push(`lethe metrics${m.since ? ` — since ${m.since.slice(0, 10)}` : ""}`);
  lines.push("");
  lines.push("adoption — the number that decides whether anything else matters");
  row("sessions connected", String(m.sessions));
  row("used lethe at all", `${m.sessionsUsing}`, pct(m.sessionsUsing, m.sessions));
  row("called recall", `${m.sessionsRecalling}`, pct(m.sessionsRecalling, m.sessions));
  row("never touched it", `${m.sessions - m.sessionsUsing}`,
    pct(m.sessions - m.sessionsUsing, m.sessions));

  lines.push("");
  lines.push("balance — memory should be read far more often than written");
  row("recalls", String(m.recalls));
  row("notes", String(m.notes));
  row("recalls per note", m.notes ? (m.recalls / m.notes).toFixed(2) : "n/a",
    m.notes && m.recalls / m.notes < 1 ? "<- backwards" : "");

  lines.push("");
  lines.push("retrieval");
  row("recalls returning nothing", String(m.emptyRecalls), pct(m.emptyRecalls, m.recalls));
  row("mean hits when non-empty", m.meanHits.toFixed(1));
  row("confirmed after a recall", String(m.confirmedAfterRecall),
    "floor only — confirm needs the model to call it");
  row("corrections", String(m.corrections));

  if (m.builds.length > 1) {
    lines.push("");
    lines.push(`  ${m.builds.length} builds seen running; the oldest is ${m.builds[0]}.`);
    lines.push("  A rebuild does not reach a running server. `lethe restart` clears stale ones.");
  }
  return lines.join("\n");
}
