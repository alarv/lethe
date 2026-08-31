/**
 * Logging, which is off until someone asks for it.
 *
 * The behaviour worth pinning down is not that lines come out in a format. It
 * is that nothing is written into a stranger's home directory by default, that
 * turning it on bounds the file rather than growing it forever, and that the
 * things derived from it can still see across a rotation -- otherwise adoption
 * metrics appear to reset on a day when nothing happened but a rename.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, logging, tail } from "./log.js";
import { readLog } from "./metrics.js";

/**
 * A disposable home. LETHE_DEBUG is cleared as well as LETHE_HOME: it forces
 * logging on, and a developer running the suite with it set would otherwise see
 * these tests pass for the wrong reason.
 */
function withHome(fn: (home: string, logPath: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "lethe-test-log-"));
  const prevHome = process.env.LETHE_HOME;
  const prevDebug = process.env.LETHE_DEBUG;
  process.env.LETHE_HOME = home;
  delete process.env.LETHE_DEBUG;
  try {
    fn(home, join(home, "lethe.log"));
  } finally {
    if (prevHome === undefined) delete process.env.LETHE_HOME;
    else process.env.LETHE_HOME = prevHome;
    if (prevDebug !== undefined) process.env.LETHE_DEBUG = prevDebug;
    rmSync(home, { recursive: true, force: true });
  }
}

const enable = (home: string, on = true) =>
  writeFileSync(join(home, "config.json"), JSON.stringify({ log: on }));

test("nothing is written unless logging was asked for", () => {
  withHome((home, logPath) => {
    assert.equal(logging(), false, "off is the default");
    log("note", "a memory nobody asked to have recorded");
    assert.equal(existsSync(logPath), false,
      "an unconfigured install must not create a file in someone's home directory");
  });
});

test("`log: false` is respected, not just a missing config", () => {
  withHome((home, logPath) => {
    enable(home, false);
    log("note", "still nothing");
    assert.equal(logging(), false);
    assert.equal(existsSync(logPath), false);
  });
});

test("enabling it writes, and LETHE_DEBUG forces it on for one run", () => {
  withHome((home, logPath) => {
    enable(home);
    log("note", "recorded now");
    assert.ok(existsSync(logPath));
    assert.match(readFileSync(logPath, "utf8"), /note {6}recorded now/);
  });

  withHome((home, logPath) => {
    process.env.LETHE_DEBUG = "1"; // no config file at all
    log("recall", "forced");
    assert.equal(logging(), true);
    assert.ok(existsSync(logPath), "LETHE_DEBUG=1 must not need a config file");
  });
});

test("the file is capped: it rotates instead of growing forever", () => {
  withHome((home, logPath) => {
    enable(home);
    // Comfortably past the 512 KB cap. This is the failure being fixed: the
    // author's log reached 49 KB in a week with nothing to stop it.
    for (let i = 0; i < 12_000; i++) {
      log("recall", `query number ${i} with enough text to move the needle`);
    }
    assert.ok(existsSync(`${logPath}.1`), "expected exactly one rotated file");
    const live = statSync(logPath).size;
    assert.ok(live < 512 * 1024, `current file must be under the cap, was ${live}`);
    assert.equal(existsSync(`${logPath}.2`), false, "one rotation, not a growing series");
  });
});

test("tail and readLog see across a rotation", () => {
  withHome((home, logPath) => {
    enable(home);
    writeFileSync(`${logPath}.1`, "2026-01-01T00:00:00.000Z  note      an older line\n");
    log("note", "a current line");

    // Asking for more than the live file holds has to reach the rotated half,
    // or `lethe log -n 40` looks like the history was thrown away.
    const lines = tail(40);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /an older line/);
    assert.match(lines[1]!, /a current line/);

    // ...but a small request is still answered from the live file alone.
    assert.equal(tail(1).length, 1);
    assert.match(tail(1)[0]!, /a current line/);

    assert.equal(readLog(logPath).length, 2, "metrics must not restart at a rename");
  });
});
