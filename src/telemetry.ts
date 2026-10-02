/**
 * Anonymous usage counts, opt-in.
 *
 * `lethe metrics` answers "is it being used?" for one machine. Whether lethe
 * works for anyone else -- whether sessions recall, whether consolidation keeps
 * claims -- is unknowable without counts from machines that are not the
 * author's. So, like an IDE's usage statistics: asked once, off unless you say
 * yes, and only ever counts.
 *
 * What leaves the machine is one summary per completed day: numbers, the lethe
 * version, and which kind of host connected (from a fixed list). Never a query,
 * title, body, path, repository, user, host name or timestamp finer than the
 * day, and no id that outlives a single server process -- the pids used to tell
 * sessions apart stay in the local file and are not sent. `lethe telemetry show`
 * prints the exact payloads before anything is sent.
 *
 * Counts are taken where log() is called, so telemetry and the activity log
 * cannot disagree about what happened -- but they are recorded whether or not
 * the log is on, because the log is a debugging aid that is off by default.
 *
 * Read straight out of config.json for the same reason log.ts does: config.ts
 * imports store.ts, and log.ts imports this module.
 */

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where summaries go unless LETHE_TELEMETRY_URL says otherwise: the collector
 * in telemetry/worker. Set LETHE_TELEMETRY_URL="" for a build that has nowhere
 * to send to; `lethe telemetry` then says so and nobody is asked.
 */
export const DEFAULT_ENDPOINT = "https://lethe-telemetry.alarvfm.workers.dev/v1/daily";

/** Days a summary waits for a collector before it is dropped. The collector refuses older ones. */
const MAX_AGE_DAYS = 14;

function home(): string {
  return process.env.LETHE_HOME || join(homedir(), ".lethe");
}

function dir(): string {
  return join(home(), "telemetry");
}

function pendingPath(): string {
  return join(dir(), "pending.log");
}

export function endpoint(): string {
  return process.env.LETHE_TELEMETRY_URL ?? DEFAULT_ENDPOINT;
}

export type Consent = "on" | "off" | "unasked";

/**
 * Whether counts are recorded, and why.
 *
 * DO_NOT_TRACK is the cross-tool convention and beats everything, including a
 * yes given earlier: someone who exports it in their shell profile means it.
 */
export function consent(): { state: Consent; why: string } {
  const dnt = process.env.DO_NOT_TRACK;
  if (dnt && dnt !== "0" && dnt.toLowerCase() !== "false") return { state: "off", why: "DO_NOT_TRACK is set" };
  if (process.env.LETHE_TELEMETRY === "0") return { state: "off", why: "LETHE_TELEMETRY=0" };
  if (process.env.LETHE_TELEMETRY === "1") return { state: "on", why: "LETHE_TELEMETRY=1" };
  try {
    const raw = JSON.parse(readFileSync(join(home(), "config.json"), "utf8")) as { telemetry?: unknown };
    if (raw?.telemetry === true) return { state: "on", why: "you opted in" };
    if (raw?.telemetry === false) return { state: "off", why: "you opted out" };
  } catch {
    // no config: nobody has been asked
  }
  return { state: "unasked", why: "never asked; off until you answer" };
}

/** The version of the running package, read once from its package.json. */
let cachedVersion: string | undefined;
export function version(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    cachedVersion = String((JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown }).version ?? "unknown");
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

/**
 * Which kind of host, from a fixed list.
 *
 * clientInfo.name is free text a host chooses; passing it through would let an
 * internal fork's name, or anything else, leave the machine. Anything not on
 * the list is "other".
 */
export function hostKind(name: string | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (n.includes("claude-code") || n === "claude code") return "claude-code";
  if (n.includes("claude")) return "claude-desktop";
  if (n.includes("opencode")) return "opencode";
  if (n.includes("cursor")) return "cursor";
  if (n.includes("codex")) return "codex";
  if (n.includes("windsurf")) return "windsurf";
  if (n.includes("zed")) return "zed";
  if (n.includes("visual studio code") || n.includes("vscode")) return "vscode";
  return "other";
}

export const HOSTS = ["claude-code", "claude-desktop", "opencode", "cursor", "codex", "windsurf", "zed", "vscode", "other"];

const TOOLS = new Set(["recall", "note", "confirm", "correct", "forget", "learn"]);

/**
 * Turn one log call into counter lines, or none.
 *
 * Mirrors metrics.ts, which reads the same events back out of the log file.
 */
export function counters(event: string, detail: string, extra: Record<string, unknown> = {}): string[] {
  switch (event) {
    case "start":
      if (/^mcp server connected/.test(detail)) return ["session"];
      if (detail === "briefed") return ["briefed"];
      if (detail === "client" && typeof extra.host === "string") return [`host ${hostKind(extra.host)}`];
      return [];
    case "recall": {
      const out = [extra.via === "hook" ? "recall_hook" : "recall"];
      if (Number(extra.hits) === 0) out.push("recall_empty");
      return out;
    }
    case "compact": {
      if (detail === "done") {
        const kept = Number(extra.claims ?? 0);
        return kept > 0 ? ["compaction", `claims_kept ${kept}`] : [];
      }
      if (detail.startsWith('rejected "')) return ["claims_rejected"];
      if (detail.startsWith("rejected")) return ["distiller_failure"];
      return [];
    }
    case "error":
      return detail.startsWith("distil failed") ? ["distiller_failure"] : [];
    default:
      return TOOLS.has(event) ? [event] : [];
  }
}

const today = () => new Date().toISOString().slice(0, 10);

/** Called by log() for every event. Must never throw and never block for long. */
export function record(event: string, detail: string, extra?: Record<string, unknown>): void {
  if (consent().state !== "on") return;
  const lines = counters(event, detail, extra);
  if (!lines.length) return;
  try {
    mkdirSync(dir(), { recursive: true });
    const prefix = `${today()} ${process.pid} `;
    appendFileSync(pendingPath(), lines.map((l) => prefix + l + "\n").join(""), "utf8");
  } catch {
    // Telemetry must never break the caller.
  }
}

export interface Summary {
  schema: 1;
  v: string;
  day: string;
  hosts: Record<string, number>;
  sessions: number;
  sessions_using: number;
  sessions_recalling: number;
  recalls: number;
  recalls_hook: number;
  recalls_empty: number;
  notes: number;
  confirms: number;
  corrections: number;
  forgets: number;
  learns: number;
  briefed: number;
  compactions: number;
  claims_kept: number;
  claims_rejected: number;
  distiller_failures: number;
}

/** Fold counter lines into one summary per day. pids are used here and dropped. */
export function summarise(lines: string[], v = version()): Summary[] {
  const days = new Map<string, { s: Summary; started: Set<string>; using: Set<string>; recalling: Set<string> }>();
  for (const line of lines) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d+) (\w+)(?: (\S+))?$/.exec(line.trim());
    if (!m) continue;
    const [, day, pid, name, arg] = m as unknown as [string, string, string, string, string | undefined];
    let d = days.get(day);
    if (!d) {
      d = {
        s: {
          schema: 1, v, day, hosts: {}, sessions: 0, sessions_using: 0, sessions_recalling: 0,
          recalls: 0, recalls_hook: 0, recalls_empty: 0, notes: 0, confirms: 0, corrections: 0,
          forgets: 0, learns: 0, briefed: 0, compactions: 0, claims_kept: 0, claims_rejected: 0,
          distiller_failures: 0,
        },
        started: new Set(), using: new Set(), recalling: new Set(),
      };
      days.set(day, d);
    }
    const s = d.s;
    switch (name) {
      case "session": s.sessions += 1; d.started.add(pid); break;
      case "host": if (arg && HOSTS.includes(arg)) s.hosts[arg] = (s.hosts[arg] ?? 0) + 1; break;
      case "briefed": s.briefed += 1; break;
      case "recall": s.recalls += 1; d.using.add(pid); d.recalling.add(pid); break;
      case "recall_hook": s.recalls_hook += 1; break;
      case "recall_empty": s.recalls_empty += 1; break;
      case "note": s.notes += 1; d.using.add(pid); break;
      case "confirm": s.confirms += 1; d.using.add(pid); break;
      case "correct": s.corrections += 1; d.using.add(pid); break;
      case "forget": s.forgets += 1; d.using.add(pid); break;
      case "learn": s.learns += 1; d.using.add(pid); break;
      case "compaction": s.compactions += 1; break;
      case "claims_kept": s.claims_kept += Number(arg ?? 0) || 0; break;
      case "claims_rejected": s.claims_rejected += 1; break;
      case "distiller_failure": s.distiller_failures += 1; break;
    }
  }
  return [...days.values()]
    .map(({ s, started, using, recalling }) => ({
      ...s,
      // Only sessions that started that day can count as using it, so the
      // ratio cannot exceed one when a session spans midnight.
      sessions_using: [...using].filter((p) => started.has(p)).length,
      sessions_recalling: [...recalling].filter((p) => started.has(p)).length,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Every counter line not yet sent, across the pending file and interrupted sends. */
export function pendingLines(): string[] {
  if (!existsSync(dir())) return [];
  return readdirSync(dir())
    .filter((f) => f === "pending.log" || f.startsWith("sending-"))
    .flatMap((f) => readLines(join(dir(), f)));
}

/** What would be sent now: completed days only, so each day is sent once, whole. */
export function due(lines = pendingLines()): Summary[] {
  const t = today();
  return summarise(lines).filter((s) => s.day < t);
}

type Post = (url: string, body: string) => Promise<boolean>;

const post: Post = async (url, body) => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    // 4xx means the collector will never take it; drop rather than resend forever.
    return res.ok || (res.status >= 400 && res.status < 500);
  } catch {
    return false;
  }
};

/**
 * Send completed days, keep the rest.
 *
 * The pending file is renamed before it is read, so servers appending to it
 * meanwhile start a fresh one and nothing is counted twice; a send interrupted
 * half-way leaves a sending-* file that the next flush picks up. Days the
 * collector did not accept go back to pending until they are too old to matter.
 */
export async function flush(send: Post = post): Promise<{ sent: number; kept: number }> {
  const url = endpoint();
  if (consent().state !== "on" || !url) return { sent: 0, kept: 0 };
  if (!due().length) return { sent: 0, kept: 0 };

  const mine = join(dir(), `sending-${process.pid}-${Date.now()}.log`);
  const claimed: string[] = [];
  for (const f of readdirSync(dir())) {
    const from = join(dir(), f);
    // Another process's in-flight send is left alone unless it is old enough
    // to have been abandoned.
    const stale = f.startsWith("sending-") && Date.now() - statSync(from).mtimeMs > 60 * 60 * 1000;
    if (f !== "pending.log" && !stale) continue;
    const to = `${mine}.${claimed.length}`;
    try {
      renameSync(from, to);
      claimed.push(to);
    } catch {
      // someone else claimed it first
    }
  }
  const lines = claimed.flatMap(readLines);
  const t = today();
  const oldest = new Date(Date.now() - MAX_AGE_DAYS * 86400_000).toISOString().slice(0, 10);

  let sent = 0;
  const keepDays = new Set<string>([t]);
  for (const s of summarise(lines)) {
    if (s.day >= t) continue;
    if (s.day < oldest) continue; // too old for the collector; drop it
    if (await send(url, JSON.stringify(s))) sent += 1;
    else keepDays.add(s.day);
  }
  const kept = lines.filter((l) => keepDays.has(l.slice(0, 10)));
  try {
    if (kept.length) appendFileSync(pendingPath(), kept.join("\n") + "\n", "utf8");
    for (const f of claimed) unlinkSync(f);
  } catch {
    // worst case a day is sent twice; the collector's rows are counts, not truth
  }
  return { sent, kept: kept.length };
}
