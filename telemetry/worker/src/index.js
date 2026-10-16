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

const json = (obj) => new Response(JSON.stringify(obj), {
  status: 200,
  headers: {
    "content-type": "application/json",
    // Aggregates change once a day at most; an hour of edge cache is plenty.
    "cache-control": "public, max-age=3600",
  },
});

/**
 * Fold D1 rows into the only shape the public dashboard may see: sums
 * grouped by day and version, plus host totals. Per-install rows never
 * leave the database -- this function is the privacy boundary, so it takes
 * rows and returns aggregates, and the handler serialises nothing else.
 *
 * Each row is one install's one day: `hosts` is the stored JSON map from
 * the daily table, or an already-parsed object in tests.
 */
export function aggregate(rows) {
  const byDay = new Map();
  const byVersion = new Map();
  const hosts = {};
  const totals = { installs: 0, days: 0, ...Object.fromEntries(COUNTS.map((k) => [k, 0])) };

  for (const r of rows) {
    if (!r || typeof r.day !== "string") continue;
    let day = byDay.get(r.day);
    if (!day) {
      day = { day: r.day, installs: 0, ...Object.fromEntries(COUNTS.map((k) => [k, 0])) };
      byDay.set(r.day, day);
    }
    day.installs += 1;
    totals.installs += 1;
    for (const k of COUNTS) {
      const n = Number(r[k]) || 0;
      day[k] += n;
      totals[k] += n;
    }
    let v = byVersion.get(r.v);
    if (!v) {
      v = { v: r.v, installs: 0, sessions: 0, recalls: 0, notes: 0, compactions: 0, claims_kept: 0 };
      byVersion.set(r.v, v);
    }
    v.installs += 1;
    v.sessions += Number(r.sessions) || 0;
    v.recalls += Number(r.recalls) || 0;
    v.notes += Number(r.notes) || 0;
    v.compactions += Number(r.compactions) || 0;
    v.claims_kept += Number(r.claims_kept) || 0;
    let h = r.hosts;
    if (typeof h === "string") {
      try { h = JSON.parse(h); } catch { h = null; }
    }
    if (h && typeof h === "object") {
      for (const [name, n] of Object.entries(h)) {
        if (!HOSTS.includes(name)) continue;
        hosts[name] = (hosts[name] ?? 0) + (Number(n) || 0);
      }
    }
  }

  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  totals.days = days.length;
  return {
    updated: dayOf(Date.now()),
    days,
    totals,
    by_version: [...byVersion.values()].sort((a, b) => b.sessions - a.sessions),
    hosts,
    // Graded here, on the server, so the page renders pills without running
    // any logic of its own: embedding health.toString() in the page broke,
    // because wrangler's bundler rewrites the function (keepNames wraps every
    // declaration in a __name helper that does not exist in the page).
    health: health(totals),
  };
}

/**
 * At-a-glance health from aggregate totals, so the dashboard reads as
 * good-or-bad without interpreting numbers. Thresholds are judgement calls,
 * not derived: adoption and recalling measure whether the memory is used at
 * all, the empty-recall rate whether it answers, and the distiller pair
 * whether consolidation works. States are ok, warn, bad, idle (no data yet).
 * Runs server-side inside aggregate(), so /v1/stats carries graded pills and
 * the page only renders them.
 */
export function health(t) {
  const pills = [];
  const n = (v) => Number(v) || 0;
  const pct = (r) => Math.round(r * 100) + "%";
  const pill = (label, state, detail) => pills.push({ label, state, detail });

  const sessions = n(t.sessions), using = n(t.sessions_using), recalling = n(t.sessions_recalling);
  if (sessions === 0) pill("adoption", "idle", "no sessions yet");
  else {
    const a = using / sessions;
    pill("adoption", a >= 0.4 ? "ok" : a >= 0.2 ? "warn" : "bad", pct(a) + " of sessions use memory");
  }
  if (using === 0) pill("recalling", "idle", "nothing using memory yet");
  else {
    const r = recalling / using;
    pill("recalling", r >= 0.5 ? "ok" : r >= 0.25 ? "warn" : "bad", pct(r) + " of using sessions recall");
  }
  const recalls = n(t.recalls) + n(t.recalls_hook);
  if (recalls === 0) pill("answers", "idle", "no recalls yet");
  else {
    const e = n(t.recalls_empty) / recalls;
    pill("answers", e < 0.1 ? "ok" : e < 0.25 ? "warn" : "bad", pct(e) + " of recalls came back empty");
  }
  const compactions = n(t.compactions), failures = n(t.distiller_failures);
  if (failures > 0 && compactions === 0) pill("distiller", "bad", failures + " failures, no compaction succeeded");
  else if (failures > 0) pill("distiller", "warn", failures + " failures alongside " + compactions + " compactions");
  else if (compactions > 0) pill("distiller", "ok", compactions + " compactions, no failures");
  else pill("distiller", "idle", "no compactions yet");
  const kept = n(t.claims_kept), rejected = n(t.claims_rejected);
  if (kept + rejected === 0) pill("yield", "idle", "nothing distilled yet");
  else {
    const y = kept / (kept + rejected);
    pill("yield", y >= 0.5 ? "ok" : "warn", pct(y) + " of distilled claims kept");
  }
  return pills;
}

/** One self-contained page: no CDN, no build step, fetches ./v1/stats. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lethe telemetry</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231a7f37'/%3E%3Ctext x='32' y='44' font-family='system-ui,sans-serif' font-size='36' fill='white' text-anchor='middle'%3EL%3C/text%3E%3C/svg%3E">
<style>
body{font-family:system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#222}
h1{font-size:1.4rem}p.sub{color:#666}.cards{display:flex;gap:1rem;flex-wrap:wrap}
.card{border:1px solid #ddd;border-radius:8px;padding:.6rem 1rem;min-width:120px}
.card b{font-size:1.3rem;display:block}.pills{display:flex;gap:.5rem;flex-wrap:wrap;margin:1rem 0 1.5rem}
.pill{border-radius:999px;padding:.25rem .8rem;font-size:.85rem;border:1px solid transparent}
.pill.ok{background:#dafbe1;border-color:#1a7f37;color:#1a7f37}
.pill.warn{background:#fff8c5;border-color:#9a6700;color:#9a6700}
.pill.bad{background:#ffebe9;border-color:#d1242f;color:#d1242f}
.pill.idle{background:#f0f0f0;border-color:#999;color:#666}
table{border-collapse:collapse;width:100%;margin-top:1rem}
td,th{border-bottom:1px solid #eee;text-align:right;padding:.25rem .5rem;font-variant-numeric:tabular-nums}
td:first-child,th:first-child{text-align:left}.bar{background:#4a7;height:8px;border-radius:2px;min-width:2px}
</style></head><body>
<h1>lethe telemetry</h1>
<p class="sub">Opt-in daily counts only: sessions, recalls, notes, compactions. No queries, paths, or ids ever leave a machine. <a href="https://github.com/alarv/lethe/tree/main/telemetry">collector source</a>.</p>
<div class="pills" id="pills"></div>
<div class="cards" id="cards"></div>
<h2>by day</h2><table id="days"><tr><th>day</th><th>installs</th><th>sessions</th><th>recalls</th><th>notes</th><th>kept</th></tr></table>
<h2>hosts</h2><table id="hosts"><tr><th>host</th><th>sessions</th></tr></table>
<h2>versions</h2><table id="vers"><tr><th>v</th><th>installs</th><th>sessions</th><th>recalls</th><th>notes</th></tr></table>
<script>
fetch("./v1/stats").then(r=>r.json()).then(s=>{
const t=s.totals;
document.getElementById("pills").innerHTML=(s.health||[]).map(p=>"<span class='pill "+p.state+"' title='"+p.detail+"'>"+p.label+": "+p.state+"</span>").join("");
const adopt=t.sessions?Math.round(100*t.sessions_using/t.sessions):0;
const recal=t.sessions_using?Math.round(100*t.sessions_recalling/t.sessions_using):0;
document.getElementById("cards").innerHTML=
card(t.installs,"install-days")+card(t.sessions,"sessions")+card(adopt+"%","sessions using")+card(recal+"%","of those recalling")+card(t.claims_kept,"claims kept");
const max=Math.max(1,...s.days.map(d=>d.sessions));
document.getElementById("days").innerHTML="<tr><th>day</th><th></th><th>installs</th><th>sessions</th><th>recalls</th><th>notes</th><th>kept</th></tr>"+s.days.map(d=>"<tr><td>"+d.day+"</td><td><div class=bar style=width:"+Math.round(120*d.sessions/max)+"px></div></td><td>"+d.installs+"</td><td>"+d.sessions+"</td><td>"+d.recalls+"</td><td>"+d.notes+"</td><td>"+d.claims_kept+"</td></tr>").join("");
document.getElementById("hosts").innerHTML="<tr><th>host</th><th>sessions</th></tr>"+Object.entries(s.hosts).sort((a,b)=>b[1]-a[1]).map(([h,n])=>"<tr><td>"+h+"</td><td>"+n+"</td></tr>").join("");
document.getElementById("vers").innerHTML="<tr><th>v</th><th>installs</th><th>sessions</th><th>recalls</th><th>notes</th></tr>"+s.by_version.map(v=>"<tr><td>"+v.v+"</td><td>"+v.installs+"</td><td>"+v.sessions+"</td><td>"+v.recalls+"</td><td>"+v.notes+"</td></tr>").join("");
function card(n,l){return "<div class=card><b>"+n+"</b>"+l+"</div>"}
}).catch(()=>{document.body.insertAdjacentHTML("beforeend","<p>no data yet.</p>")});
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(DASHBOARD_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" },
      });
    }
    if (url.pathname === "/v1/stats" && request.method === "GET") {
      const want = Number(url.searchParams.get("days") ?? 90);
      const days = Number.isFinite(want) ? Math.min(365, Math.max(7, Math.floor(want))) : 90;
      const res = await env.DB.prepare(
        `SELECT day, v, hosts, ${COUNTS.join(", ")} FROM daily
         WHERE day >= date('now', ?) ORDER BY day`,
      ).bind(`-${days} days`).all();
      // wrangler's .all() returns { results }; tolerate either shape.
      const rows = res.results ?? res;
      const body = aggregate(Array.isArray(rows) ? rows : []);
      // Slice server-side too: the query window is by receive date, the
      // aggregation below is by event day, so cap the tail for ?days=7.
      body.days = body.days.slice(-days);
      return json(body);
    }
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
