import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { badge, c, colorOn, heading, logLine } from "./color.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("plain when not a terminal, which is how tests and pipes see it", () => {
  delete process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  assert.equal(colorOn({ isTTY: false } as NodeJS.WriteStream), false);
  assert.equal(c.red("x"), "x");
});

test("NO_COLOR beats FORCE_COLOR", () => {
  process.env.FORCE_COLOR = "1";
  process.env.NO_COLOR = "1";
  assert.equal(c.red("x"), "x");
});

test("FORCE_COLOR paints even through a pipe; FORCE_COLOR=0 does not", () => {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = "1";
  assert.notEqual(c.red("x"), "x");
  assert.equal(strip(c.red("x")), "x");
  process.env.FORCE_COLOR = "0";
  assert.equal(colorOn({ isTTY: false } as NodeJS.WriteStream), false);
});

test("a badge keeps its four columns when coloured", () => {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = "1";
  for (const s of ["ok", "warn", "FAIL"] as const) assert.equal(strip(badge(s)).length, 4);
});

test("colouring never changes the text", () => {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = "1";
  const line = '2026-10-02T08:23:40.280Z  recall    "q"  hits=3 ids=a pid=1';
  assert.equal(strip(logLine(line)), line);
  assert.equal(strip(heading("adoption — the number")), "adoption — the number");
});
