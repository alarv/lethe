import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  type Fact,
  LEARN_INSTRUCTIONS,
  SEED_STRENGTH,
  SEED_TAG,
  cited,
  gate,
  readWatermark,
  seed,
  seeded,
  writeWatermark,
} from "./learn.js";
import { withStore } from "./testing.js";

/** A fact with the boring fields filled in. */
function fact(over: Partial<Fact> = {}): Fact {
  return {
    key: "install",
    title: "Install with uv sync; uv.lock is authoritative",
    body: "Run uv sync. uv.lock is the resolved tree the repo is tested against.",
    files: ["pyproject.toml"],
    quoted: [],
    salience: 0.6,
    ...over,
  };
}

/** Write a fixture repo. No git and no model: neither is involved any more. */
function files(ws: string, contents: Record<string, string>): void {
  for (const [name, body] of Object.entries(contents)) {
    const abs = join(ws, name);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
}

/** Gate then seed, which is exactly what the MCP tool does with `facts`. */
function submit(store: Parameters<typeof seed>[0], ws: string, given: Fact[]) {
  const { kept, rejected } = gate(given, ws);
  return { ...seed(store, kept), rejected, kept };
}

// -------------------------------------------------------------- instructions

test("the instructions say what will be rejected, not only what to write", () => {
  // The agent has to be able to satisfy the gate without discovering it by
  // trial and error, so the rules and the check must agree.
  assert.match(LEARN_INSTRUCTIONS, /VERBATIM/);
  assert.match(LEARN_INSTRUCTIONS, /stable slug/i);
  assert.match(LEARN_INSTRUCTIONS, /source code/i);
  assert.match(LEARN_INSTRUCTIONS, /deploys?|publish/i);
  assert.match(LEARN_INSTRUCTIONS, /facts/);
});

// ---------------------------------------------------------------------- gate

test("a quoted value that is not in the cited file is rejected", async () => {
  await withStore(async (_s, _home, ws) => {
    files(ws, { "pyproject.toml": 'requires-python = ">=3.11"\n' });

    const ok = gate([fact({ quoted: ['requires-python = ">=3.11"'] })], ws);
    assert.equal(ok.kept.length, 1);

    const bad = gate([fact({ quoted: ['requires-python = ">=3.99"'] })], ws);
    assert.equal(bad.kept.length, 0);
    assert.match(bad.rejected[0]!.reason, /quoted value/);
  });
});

test("a fact citing no file, or a file that does not exist, is rejected", async () => {
  await withStore(async (_s, _home, ws) => {
    files(ws, { "pyproject.toml": "x = 1\n" });

    assert.match(gate([fact({ files: [] })], ws).rejected[0]!.reason, /cites no file/);
    assert.match(gate([fact({ files: ["Cargo.toml"] })], ws).rejected[0]!.reason, /do not exist/);
  });
});

test("a fact missing a key, title or body is rejected", async () => {
  await withStore(async (_s, _home, ws) => {
    files(ws, { "pyproject.toml": "x = 1\n" });
    for (const bad of [{ key: "" }, { title: "  " }, { body: "" }]) {
      assert.match(gate([fact(bad)], ws).rejected[0]!.reason, /missing a key, title or body/);
    }
  });
});

test("a fact naming an outward-facing command is rejected whatever it cites", async () => {
  await withStore(async (_s, _home, ws) => {
    files(ws, { "pyproject.toml": "x = 1\n" });

    // Caught for real: a release step was once seeded as a local check.
    for (const cmd of [
      "npm publish --provenance",
      "kubectl apply -f k8s/",
      "twine upload dist/*",
      "git push --follow-tags",
      "terraform apply",
    ]) {
      const r = gate([fact({ body: `Ship it with ${cmd}.` })], ws);
      assert.equal(r.kept.length, 0, `${cmd} must not be seeded`);
      assert.match(r.rejected[0]!.reason, /outward-facing/);
    }
  });
});

test("a fact citing a credentials file is rejected before it is read", async () => {
  await withStore(async (_s, _home, ws) => {
    // A claim body lands in .lethe/memory, which may be committed. Quoting .env
    // would copy a secret out of an ignored file into a tracked one.
    files(ws, { ".env": "DATABASE_PASSWORD=hunter2\n", "id_rsa": "x\n", "app.pem": "x\n" });
    for (const f of [".env", "id_rsa", "app.pem"]) {
      const r = gate([fact({ files: [f] })], ws);
      assert.equal(r.kept.length, 0, `${f} must never back a claim`);
      assert.match(r.rejected[0]!.reason, /credentials/);
    }
  });
});

test("a fact with no quoted values is allowed when its cited file exists", async () => {
  await withStore(async (_s, _home, ws) => {
    // Citation by existence: a lockfile says which installer wins without
    // containing the install command.
    files(ws, { "uv.lock": "version = 1\n" });
    assert.equal(gate([fact({ files: ["uv.lock"] })], ws).kept.length, 1);
  });
});

test("a value only present once JSON escapes are resolved still counts as cited", async () => {
  await withStore(async (_s, _home, ws) => {
    const script = 'LETHE_HOME="${TMPDIR:-/tmp}/t" node --test';
    files(ws, { "package.json": JSON.stringify({ scripts: { test: script } }, null, 2) });

    assert.equal(cited(fact({ files: ["package.json"], quoted: [script] }), ws), true);
  });
});

// ------------------------------------------------------------------- seeding

test("a fact that passes the gate becomes a weak claim", async () => {
  await withStore(async (store, _home, ws) => {
    files(ws, { "pyproject.toml": 'requires-python = ">=3.11"\n' });

    const report = submit(store, ws, [fact({ quoted: ['requires-python = ">=3.11"'] })]);
    assert.equal(report.written, 1);
    assert.equal(report.rejected.length, 0);

    const claims = seeded(store);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.kind, "claim");
    assert.equal(claims[0]!.strength, SEED_STRENGTH, "a seed was not earned");
    assert.ok(claims[0]!.tags.includes(`${SEED_TAG}:install`));
  });
});

test("nothing offered means nothing written, and no crash", async () => {
  await withStore(async (store, _home, ws) => {
    files(ws, { "pyproject.toml": "x = 1\n" });
    const report = submit(store, ws, []);
    assert.equal(report.written, 0);
    assert.equal(store.all().length, 0);
  });
});

test("re-seeding revises in place instead of writing a second copy", async () => {
  await withStore(async (store, _home, ws) => {
    files(ws, { "pyproject.toml": "x = 1\n" });

    submit(store, ws, [fact()]);
    const first = seeded(store)[0]!;

    const same = submit(store, ws, [fact()]);
    assert.equal(same.written, 0);
    assert.equal(same.unchanged, 1);

    // Same key, different wording: one claim, revised.
    const changed = submit(store, ws, [fact({ title: "Install with uv sync, never pip" })]);
    assert.equal(changed.written, 0);
    assert.equal(changed.revised, 1);

    const all = seeded(store);
    assert.equal(all.length, 1, "a retitled seed must not leave two claims");
    assert.equal(all[0]!.id, first.id, "revising keeps the id, so confirmations survive");
    assert.match(all[0]!.title, /never pip/);
  });
});

test("a different key is a different claim, so subjects do not collide", async () => {
  await withStore(async (store, _home, ws) => {
    files(ws, { "pyproject.toml": "x = 1\n", "Makefile": "test:\n\tpytest\n" });

    submit(store, ws, [
      fact({ key: "install" }),
      fact({ key: "test", title: "Run the suite with make test", files: ["Makefile"] }),
    ]);
    assert.equal(seeded(store).length, 2);
  });
});

test("a revision keeps strength and confirmations", async () => {
  await withStore(async (store, _home, ws) => {
    files(ws, { "pyproject.toml": "x = 1\n" });
    submit(store, ws, [fact()]);

    const claim = seeded(store)[0]!;
    store.confirm(claim, "someone");
    store.touch(claim);
    const strength = store.get(claim.id)!.strength;
    const confirmers = store.get(claim.id)!.confirmedBy.length;
    assert.ok(confirmers > 0);

    submit(store, ws, [fact({ title: "Install with uv sync, refreshed" })]);

    const after = store.get(claim.id)!;
    assert.equal(after.strength, strength, "reinforcement must survive a revision");
    assert.equal(after.confirmedBy.length, confirmers);
  });
});

test("dry run writes nothing but reports what it would write", async () => {
  await withStore(async (store, _home, ws) => {
    files(ws, { "pyproject.toml": "x = 1\n" });

    const { kept } = gate([fact()], ws);
    assert.equal(seed(store, kept, { dryRun: true }).written, 1);
    assert.equal(store.all().length, 0);
  });
});

test("a rejected fact is reported rather than swallowed", async () => {
  await withStore(async (store, _home, ws) => {
    files(ws, { "pyproject.toml": "x = 1\n" });

    const report = submit(store, ws, [
      fact({ key: "a", quoted: ["not in the file at all"] }),
      fact({ key: "b", body: "Release with npm publish." }),
    ]);
    assert.equal(report.written, 0);
    assert.equal(report.rejected.length, 2);
    // A silent gate looks exactly like a repo with nothing worth learning.
    assert.ok(report.rejected.every((r) => r.reason.length > 0));
  });
});

test("the watermark round-trips and is not what prevents duplicates", async () => {
  await withStore(async (store, _home, ws) => {
    files(ws, { "pyproject.toml": "x = 1\n" });
    submit(store, ws, [fact()]);
    writeWatermark(ws, { at: new Date().toISOString(), seeded: 1 });

    assert.equal(readWatermark(ws)?.seeded, 1);

    // The teammate case: claims present, watermark gone. Must still not duplicate.
    writeFileSync(join(ws, ".lethe", "learned.json"), "not json", "utf8");
    assert.equal(readWatermark(ws), null);
    const again = submit(store, ws, [fact()]);
    assert.equal(again.written, 0);
    assert.equal(again.unchanged, 1);
  });
});
