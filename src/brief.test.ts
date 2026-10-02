import { test } from "node:test";
import assert from "node:assert/strict";
import { brief } from "./brief.js";
import type { Memory } from "./store.js";

let n = 0;
function mem(over: Partial<Memory>): Memory {
  n += 1;
  return {
    id: `${String(n).padStart(8, "0")}-x`, kind: "claim", title: `memory ${n}`, body: "body",
    tags: [], files: [], salience: 0.5, strength: 1, decayedAt: "2026-01-01",
    accessCount: 0, created: "2026-01-01", updated: "2026-01-01", lastAccessed: null,
    provenance: [], supersededBy: null, author: "a", confirmedBy: [], ...over,
  };
}

test("lists live claims and patterns, never episodes, superseded or borrowed memories", () => {
  const b = brief([
    mem({ title: "kept claim" }),
    mem({ title: "kept pattern", kind: "pattern" }),
    mem({ title: "raw", kind: "episode" }),
    mem({ title: "old", supersededBy: "y" }),
    mem({ title: "elsewhere", fromProject: "/other" }),
  ]);
  assert.deepEqual(b.listed.map((m) => m.title).sort(), ["kept claim", "kept pattern"]);
  assert.doesNotMatch(b.text, /\b(raw|old|elsewhere)$/m);
});

test("titles and ids only: bodies stay out of the system prompt", () => {
  const b = brief([mem({ title: "t", body: "SECRET-LOOKING DETAIL" })]);
  assert.match(b.text, /\[\d{8}\] t/);
  assert.doesNotMatch(b.text, /DETAIL/);
});

test("salience ranks first, and a confirmation lifts a memory over an equally salient one", () => {
  const b = brief([
    mem({ title: "plain", salience: 0.5 }),
    mem({ title: "confirmed", salience: 0.5, confirmedBy: ["a"] }),
    mem({ title: "salient", salience: 0.9 }),
  ]);
  assert.deepEqual(b.listed.map((m) => m.title), ["salient", "confirmed", "plain"]);
});

test("stays inside the budget and says how many were left out", () => {
  const many = Array.from({ length: 100 }, (_, i) => mem({ title: `a fairly long claim title number ${i}` }));
  const b = brief(many, 400);
  assert.ok(b.text.length <= 450, "budget plus the omission line");
  assert.ok(b.omitted > 0);
  assert.equal(b.listed.length + b.omitted, 100);
  assert.match(b.text, new RegExp(`${b.omitted} more`));
});

test("an empty project gets no briefing at all", () => {
  assert.equal(brief([mem({ kind: "episode" })]).text, "");
});
