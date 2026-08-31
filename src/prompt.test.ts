/**
 * The init questions. These are the only place a user is told where their
 * memory goes, so the wording is part of the contract, not decoration.
 */

import { Readable, Writable } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import { PLACEMENTS, choose } from "./prompt.js";

/**
 * Deliver one line per tick.
 *
 * Handing readline the whole script as a single chunk drops every line after
 * the first: they arrive before the second question is asked, and nothing is
 * waiting to receive them.
 */
function lines(typed: string[]): Readable {
  return Readable.from((async function* () {
    for (const line of typed) {
      await new Promise((r) => setImmediate(r));
      yield line + "\n";
    }
  })());
}

function io(typed: string[]): { input: Readable; output: Writable; written: () => string } {
  const chunks: string[] = [];
  return {
    input: lines(typed),
    output: new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    }),
    written: () => chunks.join(""),
  };
}

const OPTIONS = [
  { label: "first", detail: "the first one" },
  { label: "second", detail: "the second one" },
];

test("a number picks the option at that position, one-indexed", async () => {
  const { input, output } = io(["2"]);
  assert.equal(await choose("pick", OPTIONS, { input, output }), 1);
});

test("an empty answer takes the first option", async () => {
  const { input, output } = io([""]);
  assert.equal(await choose("pick", OPTIONS, { input, output }), 0);
});

test("a bad answer is re-asked rather than silently defaulted", async () => {
  const { input, output, written } = io(["9","banana","2"]);
  assert.equal(await choose("pick", OPTIONS, { input, output }), 1);
  // Silently falling back to option 1 would write a config the user never
  // chose, and they would find out weeks later when nothing was shared.
  assert.equal((written().match(/not a choice/g) ?? []).length, 2);
});

test("a closed stream cancels instead of throwing", async () => {
  const { input, output } = io([]);
  assert.equal(await choose("pick", OPTIONS, { input, output }), null);
});

test("every option is printed with its number and consequence", async () => {
  const { input, output, written } = io(["1"]);
  await choose("where should they go?", OPTIONS, { input, output });
  const out = written();
  assert.match(out, /where should they go\?/);
  assert.match(out, /1 {2}first/);
  assert.match(out, /the first one/);
  assert.match(out, /2 {2}second/);
  assert.match(out, /the second one/);
});

test("the two placements are the sharing decision and nothing else", () => {
  // Four options across three scope words became two options across one bit.
  // Both write to the same directory; only git's view of it differs.
  assert.deepEqual(PLACEMENTS.map((p) => p.share), [true, false]);
  assert.equal(PLACEMENTS.length, 2);
});

test("no placement label mentions a scope name", () => {
  // The whole point is that a scope word never told anyone whether their
  // memories were shared. Labels describe who can read the files.
  for (const p of PLACEMENTS) {
    assert.doesNotMatch(p.label, /\b(scope|local|team|personal|global|shared)\b/i, `label: ${p.label}`);
  }
});

test("the committed option says who the audience is", () => {
  // Committed memory is readable by whoever can clone the repo, which in a
  // public one is everybody, and distilled claims name internal services and
  // deploy steps. lethe cannot check visibility -- that belongs to the host, not
  // the checkout -- so the option itself has to carry the warning.
  const committed = PLACEMENTS.find((p) => p.share)!;
  assert.match(committed.detail, /private repo/i);
  assert.match(committed.detail, /clone/i);
});
