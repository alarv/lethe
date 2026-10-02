import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { COUNTS, invalid } from "../src/index.js";
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

test("rejects other paths, methods, oversized and malformed bodies", async () => {
  const env = { DB: fakeDB() };
  assert.equal((await worker.fetch(new Request("https://c.test/"), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://c.test/v1/daily"), env)).status, 405);
  assert.equal((await post("x".repeat(5000), env)).status, 413);
  assert.equal((await post("{not json", env)).status, 400);
  assert.equal(env.DB.rows.length, 0);
});
