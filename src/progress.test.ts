import { strict as assert } from "node:assert";
import { test } from "node:test";
import { animated, spinning, task } from "./progress.js";

/**
 * A stream that records what was written, standing in for stderr.
 *
 * `isTTY` and `columns` are settable because the whole point of the module is
 * behaving differently in a terminal and in a pipe, and testing that must not
 * need a pty.
 */
function fake(isTTY: boolean, columns = 80) {
  const chunks: string[] = [];
  const stream = {
    isTTY,
    columns,
    write(s: string) {
      chunks.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, text: () => chunks.join("") };
}

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("does not animate outside a TTY", () => {
  withEnv({ CI: undefined, LETHE_PROGRESS: undefined }, () => {
    const { stream } = fake(false);
    assert.equal(animated(stream), false);
  });
});

test("does not animate under CI, where \\r means a megabyte of build log", () => {
  withEnv({ CI: "true", LETHE_PROGRESS: undefined }, () => {
    const { stream } = fake(true);
    assert.equal(animated(stream), false);
  });
});

test("LETHE_PROGRESS overrides the terminal in both directions", () => {
  withEnv({ CI: undefined, LETHE_PROGRESS: "0" }, () => {
    assert.equal(animated(fake(true).stream), false);
  });
  withEnv({ CI: "true", LETHE_PROGRESS: "1" }, () => {
    assert.equal(animated(fake(false).stream), true);
  });
});

test("a non-animated task still says what it is doing, once per label", () => {
  withEnv({ LETHE_PROGRESS: "0" }, () => {
    const { stream, text } = fake(false);
    const t = task("reading this repo", { total: 3, stream });
    t.step();
    t.step();
    t.label("writing claims");
    t.step();
    t.done();

    const out = text();
    assert.match(out, /reading this repo\.\.\./);
    assert.match(out, /writing claims\.\.\./);
    // No redraws: the whole reason this mode exists.
    assert.ok(!out.includes("\r"), "a pipe must never receive carriage returns");
  });
});

test("nothing is written to stdout, ever", () => {
  withEnv({ LETHE_PROGRESS: "1" }, () => {
    // Stdout is the MCP transport; a single stray byte corrupts the session.
    const { stream, text } = fake(true);
    const t = task("working", { stream });
    t.step();
    t.done("done");
    assert.ok(text().length > 0, "the injected stream is the only one written to");
  });
});

test("an animated task hides the cursor and always restores it", () => {
  withEnv({ CI: undefined, LETHE_PROGRESS: "1" }, () => {
    const { stream, text } = fake(true);
    const t = task("working", { total: 2, stream });
    t.step();
    t.done();

    const out = text();
    assert.ok(out.includes("\x1b[?25l"), "hides the cursor while drawing");
    assert.ok(out.includes("\x1b[?25h"), "an unrestored cursor outlives the process");
  });
});

test("fail() restores the cursor too, and leaves the reason behind", () => {
  withEnv({ CI: undefined, LETHE_PROGRESS: "1" }, () => {
    const { stream, text } = fake(true);
    const t = task("working", { stream });
    t.fail("no model available");

    const out = text();
    assert.ok(out.includes("\x1b[?25h"));
    assert.match(out, /no model available/);
  });
});

test("done() is idempotent, so a finally after a fail is safe", () => {
  withEnv({ CI: undefined, LETHE_PROGRESS: "1" }, () => {
    const { stream, text } = fake(true);
    const t = task("working", { stream });
    t.fail("broke");
    t.done("should not appear");
    assert.doesNotMatch(text(), /should not appear/);
  });
});

test("a determinate task renders a fraction", () => {
  withEnv({ CI: undefined, LETHE_PROGRESS: "1" }, () => {
    const { stream, text } = fake(true);
    const t = task("reading", { total: 4, stream });
    t.step();
    t.step();
    t.done();
    assert.match(text(), /2\/4/);
  });
});

test("step() past the total does not overrun the bar or the fraction", () => {
  withEnv({ CI: undefined, LETHE_PROGRESS: "1" }, () => {
    const { stream, text } = fake(true);
    const t = task("reading", { total: 2, stream });
    t.step(5);
    t.done();
    assert.match(text(), /2\/2/);
    assert.doesNotMatch(text(), /5\/2/);
  });
});

test("with no total it shows elapsed against the deadline, not a fake percentage", () => {
  withEnv({ CI: undefined, LETHE_PROGRESS: "1" }, () => {
    const { stream, text } = fake(true);
    const t = task("distilling", { deadline: 90, stream });
    t.done();
    assert.match(text(), /0s \/ 90s/);
    assert.doesNotMatch(text(), /%/, "a percentage on one model call would be invented");
  });
});

test("a narrow terminal still renders without wrapping", () => {
  withEnv({ CI: undefined, LETHE_PROGRESS: "1" }, () => {
    const { stream, text } = fake(true, 30);
    const t = task("reading this repository", { total: 3, stream });
    t.step();
    t.done();
    for (const line of text().split("\r")) {
      assert.ok(line.replace(/\x1b\[[\d?]*[a-zA-Z]/g, "").length <= 60);
    }
  });
});

test("spinning() finishes the task even when the work throws", async () => {
  await withEnv({ CI: undefined, LETHE_PROGRESS: "1" }, () => {});
  const { stream, text } = fake(true);
  process.env.LETHE_PROGRESS = "1";
  try {
    await assert.rejects(
      spinning("working", async () => {
        throw new Error("boom");
      }, { stream }),
      /boom/,
    );
    assert.ok(text().includes("\x1b[?25h"), "a throw must not leave the cursor hidden");
  } finally {
    delete process.env.LETHE_PROGRESS;
  }
});

test("spinning() returns the work's value", async () => {
  const { stream } = fake(false);
  process.env.LETHE_PROGRESS = "0";
  try {
    assert.equal(await spinning("working", async () => 42, { stream }), 42);
  } finally {
    delete process.env.LETHE_PROGRESS;
  }
});
