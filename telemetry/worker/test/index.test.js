import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { COUNTS, aggregate, health, invalid } from "../src/index.js";
import { summarise } from "../../../dist/telemetry.js";

const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

function summary(over = {}) {
  return {
    schema: 1, v: "0.1.4", day: yesterday, hosts: { "claude-code": 2 },
    ...Object.fromEntries(COUNTS.map((k) => [k, 0])), sessions: 2, sessions_using: 1, ...over,
  };
}

/** A stand-in for D1 that records what would have been inserted. */
function fakeDB() {
  const rows = [];
  return {
    rows,
    prepare: (sql) => ({ bind: (...args) => ({ run: async () => { rows.push({ sql, args }); } }) }),
  };
}

const post = (body, env) => worker.fetch(new Request("https://c.test/v1/daily", {
  method: "POST", headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
}), env);

// The contract: whatever the client builds, the collector accepts.
test("accepts exactly what the lethe client sends", () => {
  const [s] = summarise([`${yesterday} 1 session`, `${yesterday} 1 host opencode`, `${yesterday} 1 recall`], "0.1.4");
  assert.equal(invalid(s), null);
});

test("stores a valid summary and nothing about the sender", async () => {
  const env = { DB: fakeDB() };
  const res = await post(summary(), env);
  assert.equal(res.status, 204);
  assert.equal(env.DB.rows.length, 1);
  const args = env.DB.rows[0].args;
  assert.match(args[0], /^\d{4}-\d{2}-\d{2}$/, "received is a day, not a time");
  assert.equal(args.length, 4 + COUNTS.length);
});

test("refuses unknown fields rather than ignoring them", () => {
  assert.match(invalid(summary({ repo: "acme/secret" })), /unknown field repo/);
  assert.match(invalid(summary({ hosts: { "acme-internal": 1 } })), /unknown host/);
});

test("refuses missing fields, bad numbers and impossible ratios", () => {
  const s = summary();
  delete s.notes;
  assert.match(invalid(s), /missing field notes/);
  assert.match(invalid(summary({ recalls: -1 })), /bad count/);
  assert.match(invalid(summary({ recalls: 1.5 })), /bad count/);
  assert.match(invalid(summary({ recalls: "3" })), /bad count/);
  assert.match(invalid(summary({ recalls: 1e9 })), /bad count/);
  assert.match(invalid(summary({ sessions: 1, sessions_using: 2 })), /inconsistent/);
});

test("refuses free text where a version or a day belongs", () => {
  assert.match(invalid(summary({ v: "0.1.4 from alice@laptop" })), /bad version/);
  assert.match(invalid(summary({ day: "2026-02-30" })), /bad day/);
  assert.match(invalid(summary({ day: "2020-01-01" })), /out of range/);
});

test("aggregate folds rows to sums and never echoes a row", () => {
  const row = (day, over = {}) => ({
    day, v: "0.2.2", hosts: JSON.stringify({ opencode: 1 }),
    ...Object.fromEntries(COUNTS.map((k) => [k, 0])),
    sessions: 2, sessions_using: 1, recalls: 3, notes: 1, ...over,
  });
  const s = aggregate([row("2026-10-14"), row("2026-10-14", { sessions: 4 }), row("2026-10-15")]);
  assert.equal(s.totals.installs, 3);
  assert.equal(s.totals.sessions, 8);
  assert.equal(s.days.length, 2);
  assert.equal(s.days[0].installs, 2);
  assert.deepEqual(s.hosts, { opencode: 3 });
  assert.equal(JSON.stringify(s).includes("2026-10-14 1 session"), false);
});

test("health grades each signal and idles without data", () => {
  const t = (over = {}) => ({
    sessions: 0, sessions_using: 0, sessions_recalling: 0, recalls: 0,
    recalls_hook: 0, recalls_empty: 0, compactions: 0, distiller_failures: 0,
    claims_kept: 0, claims_rejected: 0, ...over,
  });
  const state = (totals, label) => health(totals).find((p) => p.label === label).state;
  assert.deepEqual(health(t()).map((p) => p.state), ["idle", "idle", "idle", "idle", "idle"]);
  assert.equal(state(t({ sessions: 100, sessions_using: 50 }), "adoption"), "ok");
  assert.equal(state(t({ sessions: 100, sessions_using: 25 }), "adoption"), "warn");
  assert.equal(state(t({ sessions: 100, sessions_using: 5 }), "adoption"), "bad");
  assert.equal(state(t({ sessions_using: 10, sessions_recalling: 6 }), "recalling"), "ok");
  assert.equal(state(t({ sessions_using: 10, sessions_recalling: 1 }), "recalling"), "bad");
  assert.equal(state(t({ recalls: 100, recalls_empty: 5 }), "answers"), "ok");
  assert.equal(state(t({ recalls: 100, recalls_empty: 50 }), "answers"), "bad");
  assert.equal(state(t({ compactions: 0, distiller_failures: 3 }), "distiller"), "bad");
  assert.equal(state(t({ compactions: 2, distiller_failures: 1 }), "distiller"), "warn");
  assert.equal(state(t({ compactions: 2, distiller_failures: 0 }), "distiller"), "ok");
  assert.equal(state(t({ claims_kept: 3, claims_rejected: 1 }), "yield"), "ok");
  assert.equal(state(t({ claims_kept: 1, claims_rejected: 3 }), "yield"), "warn");
});

test("aggregate carries graded health pills for the page to render", () => {
  const row = {
    day: yesterday, v: "0.2.2", hosts: JSON.stringify({ opencode: 1 }),
    ...Object.fromEntries(COUNTS.map((k) => [k, 0])),
    sessions: 10, sessions_using: 5, sessions_recalling: 3,
    recalls: 4, recalls_empty: 0, compactions: 1, claims_kept: 2, claims_rejected: 1,
  };
  const s = aggregate([row]);
  assert.ok(Array.isArray(s.health) && s.health.length === 5);
  for (const p of s.health) assert.ok(["ok", "warn", "bad", "idle"].includes(p.state), p.label);
  assert.equal(s.health.find((p) => p.label === "adoption").state, "ok");
});

test("dashboard and stats are public GETs; POST /v1/daily still works", async () => {
  const rows = [{
    day: yesterday, v: "0.2.2", hosts: JSON.stringify({ opencode: 1 }),
    ...Object.fromEntries(COUNTS.map((k) => [k, 0])), sessions: 2,
  }];
  const env = {
    DB: {
      ...fakeDB(),
      prepare: (sql) => ({
        bind: (...args) => ({
          run: async () => { throw new Error("stats must read with .all(), not .run()"); },
          all: async () => ({ results: rows }),
        }),
      }),
    },
  };
  const dash = await worker.fetch(new Request("https://c.test/"), env);
  assert.equal(dash.status, 200);
  assert.match(dash.headers.get("content-type"), /text\/html/);
  const html = await dash.text();
  assert.match(html, /lethe telemetry/);
  // The page must run no logic of its own: pills arrive graded in the stats
  // payload. (Embedding health.toString() broke once, because wrangler's
  // bundler wraps functions in a __name helper missing from the page.)
  assert.ok(!html.includes("__name"), "dashboard carries no bundler helpers");
  assert.match(html, /id="pills"/);
  assert.match(html, /s\.health/);
  assert.match(html, /rel="icon"/);

  const stats = await worker.fetch(new Request("https://c.test/v1/stats"), env);
  assert.equal(stats.status, 200);
  const body = await stats.json();
  assert.equal(body.totals.sessions, 2);
  assert.equal(body.days.length, 1);
  assert.ok(Array.isArray(body.health) && body.health.length === 5);

  // The old contract is untouched: POST /v1/daily still stores.
  assert.equal((await post(summary(), { DB: fakeDB() })).status, 204);
});

test("rejects other paths, methods, oversized and malformed bodies", async () => {
  const env = { DB: fakeDB() };
  assert.equal((await worker.fetch(new Request("https://c.test/nope"), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://c.test/v1/daily"), env)).status, 405);
  assert.equal((await post("x".repeat(5000), env)).status, 413);
  assert.equal((await post("{not json", env)).status, 400);
  assert.equal(env.DB.rows.length, 0);
});
