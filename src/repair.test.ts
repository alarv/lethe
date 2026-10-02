import { test } from "node:test";
import assert from "node:assert/strict";
import { repairLeakedArgs } from "./repair.js";

const none = { files: [], tags: [] };

test("recovers files leaked as a parameter tag after </body>", () => {
  const r = repairLeakedArgs({
    ...none,
    body: 'the lesson.</body>\n<parameter name="files">["package.json", "src/store.ts"]',
  });
  assert.equal(r.body, "the lesson.");
  assert.deepEqual(r.files, ["package.json", "src/store.ts"]);
});

test("recovers files and tags leaked as element tags", () => {
  const r = repairLeakedArgs({
    ...none,
    body: 'the lesson.</body>\n<files>["a.py"]</files>\n<tags>["gdpr", "pii"]</tags>',
  });
  assert.equal(r.body, "the lesson.");
  assert.deepEqual(r.files, ["a.py"]);
  assert.deepEqual(r.tags, ["gdpr", "pii"]);
});

test("strips a bare closing tag", () => {
  assert.equal(repairLeakedArgs({ ...none, body: "the lesson.</body>\n</invoke>" }).body, "the lesson.");
});

test("merges with arguments that did arrive", () => {
  const r = repairLeakedArgs({ files: ["a.ts"], tags: ["x"], body: 'b</body><parameter name="files">["a.ts","b.ts"]' });
  assert.deepEqual(r.files, ["a.ts", "b.ts"]);
  assert.deepEqual(r.tags, ["x"]);
});

test("a body that mentions the markup in prose is left alone", () => {
  const body = "the <files> element is ignored by the parser, then more prose follows";
  assert.equal(repairLeakedArgs({ ...none, body }).body, body);
});

test("a clean body is untouched", () => {
  const args = { files: ["a.ts"], tags: [], body: "plain" };
  assert.equal(repairLeakedArgs(args), args);
});

test("strips leaked arguments it has no use for, such as salience", () => {
  const r = repairLeakedArgs({
    ...none,
    body: 'the lesson.</body>\n<files>["a.py"]</files>\n<tags>["pii"]</tags>\n<salience>0.9</salience>\n</invoke>',
  });
  assert.equal(r.body, "the lesson.");
  assert.deepEqual(r.files, ["a.py"]);
  assert.deepEqual(r.tags, ["pii"]);
});
