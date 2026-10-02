/**
 * Collector for lethe's opt-in daily usage counts.
 *
 * The endpoint is public, so it trusts nothing it is sent. A body is accepted
 * only if it is exactly the summary lethe builds (src/telemetry.ts): the known
 * keys and no others, small non-negative integers, a version string, a recent
 * day, and host kinds from a fixed list. Anything else is refused whole --
 * a field that is merely ignored is a field someone can later be talked into
 * storing.
 *
 * Nothing about the sender is kept: not the address Cloudflare sees, not the
 * country it infers, not the time of day. See wrangler.toml for request logs.
 */

export const COUNTS = [
  "sessions", "sessions_using", "sessions_recalling", "recalls", "recalls_hook", "recalls_empty",
  "notes", "confirms", "corrections", "forgets", "learns", "briefed", "compactions",
  "claims_kept", "claims_rejected", "distiller_failures",
];

export const HOSTS = ["claude-code", "claude-desktop", "opencode", "cursor", "codex", "windsurf", "zed", "vscode", "other"];

const KEYS = new Set(["schema", "v", "day", "hosts", ...COUNTS]);
const MAX_BODY = 4096;
/** A day of one person's use; anything above it is not a real install. */
const MAX_COUNT = 100_000;
const MAX_AGE_DAYS = 30;

const isCount = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_COUNT;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** @returns {string | null} why the summary is refused, or null if it is acceptable */
export function invalid(s, now = Date.now()) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "not an object";
  for (const k of Object.keys(s)) if (!KEYS.has(k)) return `unknown field ${k}`;
  for (const k of KEYS) if (!(k in s)) return `missing field ${k}`;
  if (s.schema !== 1) return "unsupported schema";
  if (typeof s.v !== "string" || s.v.length > 32 || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(s.v)) {
    return "bad version";
  }
  if (typeof s.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.day) || dayOf(Date.parse(s.day)) !== s.day) {
    return "bad day";
  }
  // Completed days only, give or take a timezone, and not older than lethe keeps them.
  if (s.day > dayOf(now + 86400_000) || s.day < dayOf(now - MAX_AGE_DAYS * 86400_000)) return "day out of range";
  for (const k of COUNTS) if (!isCount(s[k])) return `bad count ${k}`;
  if (s.sessions_using > s.sessions || s.sessions_recalling > s.sessions_using) return "inconsistent sessions";
  if (!s.hosts || typeof s.hosts !== "object" || Array.isArray(s.hosts)) return "bad hosts";
  for (const [h, n] of Object.entries(s.hosts)) {
    if (!HOSTS.includes(h)) return `unknown host ${h}`;
    if (!isCount(n)) return "bad host count";
  }
  return null;
}

// A 204 may not carry a body at all, not even an empty one.
const reply = (status, text) => new Response(status === 204 ? null : (text ?? ""), {
  status, headers: { "content-type": "text/plain" },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/daily") return reply(404, "lethe telemetry collector: POST /v1/daily\n");
    if (request.method !== "POST") return reply(405);

    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY) return reply(413);
    const text = await request.text();
    if (text.length > MAX_BODY) return reply(413);

    let s;
    try {
      s = JSON.parse(text);
    } catch {
      return reply(400, "not json\n");
    }
    const why = invalid(s);
    if (why) return reply(400, `${why}\n`);

    await env.DB.prepare(
      `INSERT INTO daily (received, day, v, hosts, ${COUNTS.join(", ")})
       VALUES (?, ?, ?, ?, ${COUNTS.map(() => "?").join(", ")})`,
    ).bind(dayOf(Date.now()), s.day, s.v, JSON.stringify(s.hosts), ...COUNTS.map((k) => s[k])).run();

    return reply(204);
  },
};
