import { test } from "node:test";
import assert from "node:assert/strict";
import { harvest } from "./harvest.js";

const line = (ts: string, event: string, rest: string) => `${ts}  ${event.padEnd(8)}  ${rest}`;

test("pairs a confirm back to the recall that surfaced it", () => {
  const found = harvest([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", `${JSON.stringify("tests are failing")}  hits=1 ids=abc12345`),
    line("2026-01-01T00:02:00Z", "confirm", "tests need docker compose up  id=abc12345 strength=0.60"),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.query, "tests are failing");
  assert.equal(found[0]?.id, "abc12345");
  assert.equal(found[0]?.title, "tests need docker compose up");
});

test("ignores a confirm whose id no recall in this session returned", () => {
  const found = harvest([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", `${JSON.stringify("q")}  hits=1 ids=abc12345`),
    line("2026-01-01T00:02:00Z", "confirm", "unrelated  id=zzz99999 strength=0.60"),
  ]);
  assert.equal(found.length, 0);
});

test("does not credit a recall from a previous session", () => {
  const found = harvest([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", `${JSON.stringify("q")}  hits=1 ids=abc12345`),
    line("2026-01-01T01:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T01:01:00Z", "confirm", "x  id=abc12345 strength=0.60"),
  ]);
  assert.equal(found.length, 0);
});

test("picks the most recent matching recall when several ran", () => {
  const found = harvest([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", `${JSON.stringify("first query")}  hits=1 ids=abc12345`),
    line("2026-01-01T00:02:00Z", "recall", `${JSON.stringify("second query")}  hits=1 ids=abc12345`),
    line("2026-01-01T00:03:00Z", "confirm", "x  id=abc12345 strength=0.60"),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.query, "second query");
});

test("skips recalls that returned nothing", () => {
  const found = harvest([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", `${JSON.stringify("q")}  hits=0`),
    line("2026-01-01T00:02:00Z", "confirm", "x  id=abc12345 strength=0.60"),
  ]);
  assert.equal(found.length, 0);
});

test("harvests a correct as well, since confirm has never once been called", () => {
  const found = harvest([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", `${JSON.stringify("why do tests fail")}  hits=2 ids=abc12345,def67890`),
    line("2026-01-01T00:02:00Z", "correct", "old title -> new title  old=abc12345"),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.query, "why do tests fail");
  assert.equal(found[0]?.id, "abc12345", "the superseded id is the one recall returned");
  assert.equal(found[0]?.title, "old title", "the seed is the memory as recall surfaced it");
  assert.equal(found[0]?.via, "correct");
});

test("labels which signal produced each pair, so review can weigh them", () => {
  const found = harvest([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", `${JSON.stringify("q1")}  hits=1 ids=abc12345`),
    line("2026-01-01T00:02:00Z", "confirm", "kept  id=abc12345 strength=0.60"),
    line("2026-01-01T00:03:00Z", "recall", `${JSON.stringify("q2")}  hits=1 ids=def67890`),
    line("2026-01-01T00:04:00Z", "correct", "stale -> fixed  old=def67890"),
  ]);
  assert.deepEqual(found.map((c) => c.via), ["confirm", "correct"]);
});

test("ignores a correct on a memory this session never recalled", () => {
  const found = harvest([
    line("2026-01-01T00:00:00Z", "start", "connected  build=b1"),
    line("2026-01-01T00:01:00Z", "recall", `${JSON.stringify("q")}  hits=1 ids=abc12345`),
    line("2026-01-01T00:02:00Z", "correct", "unrelated -> edited  old=999zzzzz"),
  ]);
  assert.equal(found.length, 0, "a correct is only a pair if recall surfaced that memory");
});
