import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consent, counters, due, flush, hostKind, record, summarise, version } from "./telemetry.js";
import { log } from "./log.js";

const saved = { ...process.env };
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lethe-telemetry-"));
  process.env.LETHE_HOME = home;
  delete process.env.DO_NOT_TRACK;
  delete process.env.LETHE_TELEMETRY;
  process.env.LETHE_TELEMETRY_URL = "http://collector.test/v1/daily";
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env = { ...saved };
});

const optIn = (on: boolean) => writeFileSync(join(home, "config.json"), JSON.stringify({ telemetry: on }));
const pending = () => {
  const p = join(home, "telemetry", "pending.log");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
};
const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);

test("off until asked, and nothing is recorded while off", () => {
  assert.equal(consent().state, "unasked");
  record("recall", '"q"', { hits: 3 });
  assert.deepEqual(pending(), []);
});

test("DO_NOT_TRACK beats an earlier yes", () => {
  optIn(true);
  process.env.DO_NOT_TRACK = "1";
  assert.equal(consent().state, "off");
  record("note", "t");
  assert.deepEqual(pending(), []);
});

test("LETHE_TELEMETRY=0 beats an earlier yes; =1 turns it on without config", () => {
  optIn(true);
  process.env.LETHE_TELEMETRY = "0";
  assert.equal(consent().state, "off");
  rmSync(join(home, "config.json"));
  process.env.LETHE_TELEMETRY = "1";
  assert.equal(consent().state, "on");
});

test("counted through log() even when the activity log is off", () => {
  optIn(true);
  log("recall", '"why does the build fail"', { hits: 0 });
  const lines = pending();
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => !l.includes("build fail")), "the query never reaches the counter file");
  assert.ok(!existsSync(join(home, "lethe.log")), "the log itself stayed off");
});

test("counters carry names and numbers only", () => {
  assert.deepEqual(counters("recall", '"secret query"', { hits: 0, ids: "abc" }), ["recall", "recall_empty"]);
  assert.deepEqual(counters("recall", '"q"', { hits: 2, via: "hook" }), ["recall_hook"]);
  assert.deepEqual(counters("note", "a title with a path src/x.ts", { id: "1" }), ["note"]);
  assert.deepEqual(counters("compact", "done", { claims: 2 }), ["compaction", "claims_kept 2"]);
  assert.deepEqual(counters("compact", "done", { claims: 0 }), []);
  assert.deepEqual(counters("compact", 'rejected "t": consumed 1 source(s)'), ["claims_rejected"]);
  assert.deepEqual(counters("compact", "rejected unparseable reply: x"), ["distiller_failure"]);
  assert.deepEqual(counters("error", "distil failed: opencode exited 1"), ["distiller_failure"]);
  assert.deepEqual(counters("start", "client", { host: "claude-code" }), ["host claude-code"]);
  assert.deepEqual(counters("index", "rebuilt"), []);
});

test("host names are mapped onto a fixed list", () => {
  assert.equal(hostKind("claude-code"), "claude-code");
  assert.equal(hostKind("opencode"), "opencode");
  assert.equal(hostKind("acme-internal-agent-v3"), "other");
  assert.equal(hostKind(undefined), "other");
});

test("summaries count sessions by pid and never contain one", () => {
  const [s] = summarise([
    `${yesterday} 100 session`, `${yesterday} 100 host claude-code`, `${yesterday} 100 recall`,
    `${yesterday} 200 session`, `${yesterday} 200 note`,
    `${yesterday} 300 session`,
    `${yesterday} 999 recall_hook`,
    `${yesterday} 400 recall`, // started the day before: not a session of this day
  ], "9.9.9");
  assert.ok(s);
  assert.equal(s.sessions, 3);
  assert.equal(s.sessions_using, 2);
  assert.equal(s.sessions_recalling, 1);
  assert.equal(s.recalls, 2);
  assert.equal(s.recalls_hook, 1);
  assert.deepEqual(s.hosts, { "claude-code": 1 });
  assert.equal(s.v, "9.9.9");
  const text = JSON.stringify(s);
  for (const pid of ["100", "200", "300", "400", "999"]) assert.ok(!text.includes(pid), `pid ${pid} leaked`);
});

test("only completed days are due", () => {
  assert.deepEqual(due([`${today} 1 session`]), []);
  assert.equal(due([`${yesterday} 1 session`]).length, 1);
});

test("flush sends completed days, keeps today, and keeps what the collector did not take", async () => {
  optIn(true);
  const dir = join(home, "telemetry");
  mkdirSync(dir, { recursive: true });
  const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
  writeFileSync(join(dir, "pending.log"),
    [`${twoDaysAgo} 1 session`, `${yesterday} 2 session`, `${today} 3 session`].join("\n") + "\n");

  const bodies: string[] = [];
  const r = await flush(async (_url, body) => {
    bodies.push(body);
    return !body.includes(yesterday); // the collector is down for one of them
  });
  assert.equal(r.sent, 1);
  assert.equal(bodies.length, 2);
  const left = pending();
  assert.ok(left.some((l) => l.startsWith(today)), "today stays until it is complete");
  assert.ok(left.some((l) => l.startsWith(yesterday)), "the refused day waits for the next flush");
  assert.ok(!left.some((l) => l.startsWith(twoDaysAgo)), "the sent day is gone");
});

test("flush sends nothing when off or when there is nowhere to send", async () => {
  const dir = join(home, "telemetry");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pending.log"), `${yesterday} 1 session\n`);
  let calls = 0;
  const send = async () => { calls += 1; return true; };
  await flush(send);
  optIn(true);
  process.env.LETHE_TELEMETRY_URL = "";
  await flush(send);
  assert.equal(calls, 0);
});

test("days older than the collector accepts are dropped, not resent forever", async () => {
  optIn(true);
  const dir = join(home, "telemetry");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pending.log"), `2020-01-01 1 session\n`);
  let calls = 0;
  await flush(async () => { calls += 1; return false; });
  assert.equal(calls, 0);
  assert.deepEqual(pending(), []);
});

test("the version is read from package.json", () => {
  assert.match(version(), /^\d+\.\d+\.\d+/);
});
