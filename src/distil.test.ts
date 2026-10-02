import { test } from "node:test";
import assert from "node:assert/strict";
import { failureDetail } from "./distil.js";

// A real failure logged `opencode exited 1: [0m` -- a colour reset and nothing else.
test("a stderr of only escape codes falls back to stdout", () => {
  assert.equal(failureDetail("\x1b[0m\n", "\x1b[31mError: model not found\x1b[0m\n"), "Error: model not found");
});

test("stderr wins when it says something, with escapes stripped", () => {
  assert.equal(failureDetail("  \x1b[1;31mrate limited\x1b[0m  ", "ignored"), "rate limited");
});

test("only the tail of a long stdout is kept", () => {
  const out = "x".repeat(1000) + " the actual error";
  const d = failureDetail("", out, 50);
  assert.ok(d.length <= 50);
  assert.match(d, /the actual error$/);
});

test("nothing anywhere gives an empty detail", () => {
  assert.equal(failureDetail("\x1b[0m", "\x1b]0;title\x07  "), "");
});
