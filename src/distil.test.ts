import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { failureDetail, listDistillers, probeDistiller, resolveDistiller } from "./distil.js";

const saved = { ...process.env };

beforeEach(() => {
  delete process.env.LETHE_DISTILLER;
  delete process.env.LETHE_CHILD;
  delete process.env.LETHE_API_KEY;
});

afterEach(() => {
  process.env = { ...saved };
});

test("sampling is preferred and needs no machine setup", async () => {
  const r = await resolveDistiller(async () => "a claim");
  assert.equal(r?.via, "host sampling");
  const probe = await probeDistiller(r!);
  assert.deepEqual(probe, { via: "host sampling", ok: true, reason: null });
});

test("a failing distiller reports its own reason", async () => {
  const probe = await probeDistiller({
    via: "opencode (default model)",
    distil: async () => {
      throw new Error("opencode exited 1: Error: You have exceeded your monthly quota");
    },
  });
  assert.equal(probe.ok, false);
  assert.match(probe.reason!, /monthly quota/);
});

test("an empty reply is a failure, not a silent pass", async () => {
  const probe = await probeDistiller({ via: "ollama x", distil: async () => "  \n " });
  assert.deepEqual(probe, { via: "ollama x", ok: false, reason: "empty reply" });
});

test("LETHE_DISTILLER=off offers nothing to probe", async () => {
  process.env.LETHE_DISTILLER = "off";
  assert.deepEqual(await listDistillers(), []);
  assert.equal(await resolveDistiller(), null);
});

test("inside a distiller child no distiller is offered", async () => {
  process.env.LETHE_CHILD = "1";
  assert.deepEqual(await listDistillers(), []);
});

test("sampling-only mode offers nothing without a host", async () => {
  process.env.LETHE_DISTILLER = "sampling";
  assert.deepEqual(await listDistillers(), []);
});

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

test("the reason beats the banner opencode prints first", () => {
  const stderr = "> build · gpt-5.3-codex\n\nError: Payment Required: {\"error\":{\"message\":\"You have exceeded your monthly quota\"}}\n";
  assert.match(failureDetail(stderr, ""), /^Error: Payment Required.*monthly quota/);
});
