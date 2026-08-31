import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SEED_STRENGTH, SEED_TAG, cited, facts, readWatermark, seed, writeWatermark } from "./learn.js";
import { withStore } from "./testing.js";

function pkg(root: string, body: Record<string, unknown>): void {
  writeFileSync(join(root, "package.json"), JSON.stringify(body, null, 2), "utf8");
}

function workflow(root: string, name: string, body: string): void {
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, "utf8");
}

test("seeds the npm scripts as one claim, not one per script", async () => {
  await withStore(async (store, _home, ws) => {
    pkg(ws, { scripts: { build: "tsc -p .", test: "node --test", lint: "eslint ." } });

    const report = seed(store, ws);
    assert.equal(report.written, 1);

    const claims = store.all().filter((m) => m.tags.includes(SEED_TAG));
    assert.equal(claims.length, 1, "three scripts must not become three claims");
    // Verbatim, because a paraphrased command cannot be found again.
    assert.match(claims[0]!.body, /tsc -p \./);
    assert.match(claims[0]!.body, /node --test/);
    assert.match(claims[0]!.body, /eslint \./);
  });
});

test("seeded claims are claims, and enter weak", async () => {
  await withStore(async (store, _home, ws) => {
    pkg(ws, { scripts: { test: "node --test" } });
    seed(store, ws);

    const claim = store.all().find((m) => m.tags.includes(SEED_TAG))!;
    assert.equal(claim.kind, "claim");
    assert.equal(claim.strength, SEED_STRENGTH);
    assert.ok(claim.strength < 1, "a seed was not earned and must not start at full strength");
  });
});

test("re-seeding revises in place instead of writing a second copy", async () => {
  await withStore(async (store, _home, ws) => {
    pkg(ws, { scripts: { test: "node --test" } });
    seed(store, ws);
    const first = store.all().find((m) => m.tags.includes(SEED_TAG))!;

    // Unchanged repo: nothing new, nothing rewritten.
    const again = seed(store, ws);
    assert.equal(again.written, 0);
    assert.equal(again.unchanged, 1);

    // Changed repo: same claim, revised.
    pkg(ws, { scripts: { test: "node --test", build: "tsc -p ." } });
    const third = seed(store, ws);
    assert.equal(third.written, 0);
    assert.equal(third.revised, 1);

    const all = store.all().filter((m) => m.tags.includes(SEED_TAG));
    assert.equal(all.length, 1, "revision must not leave two claims about the same thing");
    assert.equal(all[0]!.id, first.id, "revising must keep the id, so confirmations survive");
    assert.match(all[0]!.body, /tsc -p \./);
  });
});

test("a revision that changes the title leaves exactly one file", async () => {
  await withStore(async (store, _home, ws) => {
    // The filename embeds a slug of the title, so a retitled memory used to land
    // on a new path and orphan the old file -- two files, one id, and recall
    // returning the stale wording. Caught on lethe's own store.
    pkg(ws, { scripts: { build: "tsc -p ." } });
    seed(store, ws);
    const before = store.all().find((m) => m.tags.includes(SEED_TAG))!;

    // Adding a script changes the title, since the title names what it found.
    pkg(ws, { scripts: { build: "tsc -p .", test: "node --test" } });
    seed(store, ws);

    const after = store.all().filter((m) => m.tags.includes(SEED_TAG));
    assert.equal(after.length, 1, "one id must never be two files");
    assert.equal(after[0]!.id, before.id);
    assert.notEqual(after[0]!.title, before.title, "the title should have changed");
    assert.match(after[0]!.title, /test/, "the new title must be the one that survives");
  });
});

test("a revision keeps strength and confirmations", async () => {
  await withStore(async (store, _home, ws) => {
    pkg(ws, { scripts: { test: "node --test" } });
    seed(store, ws);

    const claim = store.all().find((m) => m.tags.includes(SEED_TAG))!;
    store.confirm(claim, "someone");
    store.touch(claim);
    const strengthened = store.get(claim.id)!.strength;
    const confirmers = store.get(claim.id)!.confirmedBy.length;
    assert.ok(confirmers > 0);

    pkg(ws, { scripts: { test: "node --test", build: "tsc -p ." } });
    seed(store, ws);

    const after = store.get(claim.id)!;
    assert.equal(after.strength, strengthened, "reinforcement must survive a revision");
    assert.equal(after.confirmedBy.length, confirmers);
  });
});

test("dry run writes nothing but reports what it would write", async () => {
  await withStore(async (store, _home, ws) => {
    pkg(ws, { scripts: { test: "node --test" } });

    const report = seed(store, ws, { dryRun: true });
    assert.equal(report.written, 1);
    assert.equal(store.all().filter((m) => m.tags.includes(SEED_TAG)).length, 0);
  });
});

test("the citation gate rejects a value that is not in the cited file", async () => {
  await withStore(async (_store, _home, ws) => {
    pkg(ws, { scripts: { test: "node --test" } });

    assert.equal(
      cited({
        key: "x", title: "t", body: "b", salience: 0.5,
        files: ["package.json"], quoted: ["node --test"],
      }, ws),
      true,
    );
    assert.equal(
      cited({
        key: "x", title: "t", body: "b", salience: 0.5,
        files: ["package.json"], quoted: ["pytest -q"],
      }, ws),
      false,
      "an invented command must not reach the store",
    );
    assert.equal(
      cited({
        key: "x", title: "t", body: "b", salience: 0.5,
        files: ["nope.json"], quoted: [],
      }, ws),
      false,
      "a fact citing a file that does not exist is not cited",
    );
  });
});

test("a value only present once JSON escapes are resolved still counts as cited", async () => {
  await withStore(async (store, _home, ws) => {
    // The shape that made the raw-bytes-only gate reject every correct fact:
    // the parsed script contains real quotes, the file contains escaped ones.
    const script = 'LETHE_HOME="${TMPDIR:-/tmp}/t" node --test "dist/**/*.test.js"';
    pkg(ws, { scripts: { test: script } });

    const found = facts(ws);
    assert.ok(found.some((f) => f.key === "commands"), "escaped JSON must not be rejected");
    seed(store, ws);
    assert.match(store.all().find((m) => m.tags.includes(SEED_TAG))!.body, /TMPDIR:-\/tmp/);
  });
});

test("engines and the lockfile become a runtime claim", async () => {
  await withStore(async (_s, _home, ws) => {
    pkg(ws, { engines: { node: ">=22" } });
    writeFileSync(join(ws, "package-lock.json"), "{}", "utf8");

    const runtime = facts(ws).find((f) => f.key === "runtime");
    assert.ok(runtime, "a stated engines floor is worth a claim");
    assert.match(runtime!.title, />=22/);
    assert.match(runtime!.body, /npm ci/);
  });
});

test("a lockfile with no engines still seeds, cited by existence", async () => {
  await withStore(async (_s, _home, ws) => {
    pkg(ws, { name: "x" });
    writeFileSync(join(ws, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");

    const runtime = facts(ws).find((f) => f.key === "runtime");
    assert.ok(runtime, "requiring a quoted value dropped every lockfile-only repo");
    assert.match(runtime!.body, /pnpm install --frozen-lockfile/);
  });
});

test("CI services are extracted, because that is the docker-compose lesson", async () => {
  await withStore(async (_s, _home, ws) => {
    workflow(ws, "ci.yml", [
      "jobs:",
      "  test:",
      "    services:",
      "      postgres:",
      "        image: postgres:16",
      "      redis:",
      "        image: redis:7",
      "    steps:",
      "      - run: npm ci",
      "      - run: npm test",
    ].join("\n"));

    const ci = facts(ws).find((f) => f.key === "ci");
    assert.ok(ci);
    assert.match(ci!.title, /postgres, redis/);
    assert.match(ci!.body, /npm ci/);
    assert.match(ci!.body, /npm test/);
  });
});

test("templated and block-scalar CI steps are left out", async () => {
  await withStore(async (_s, _home, ws) => {
    workflow(ws, "ci.yml", [
      "jobs:",
      "  test:",
      "    steps:",
      "      - run: npm ci",
      "      - run: echo ${{ matrix.node }}",
      "      - run: |",
      "          set -e",
      "          echo a fifty line shell program",
    ].join("\n"));

    const ci = facts(ws).find((f) => f.key === "ci")!;
    assert.match(ci.body, /npm ci/);
    assert.doesNotMatch(ci.body, /\$\{\{/, "a half-expanded expression is worse than no memory");
    assert.doesNotMatch(ci.body, /fifty line/, "block scalars are shell programs, not memories");
  });
});

test("a release workflow is not a check, so it is not read at all", async () => {
  await withStore(async (_s, _home, ws) => {
    // Caught for real on lethe's own repo: publish.yml contributed
    // `npm publish --provenance --access public` to a claim that told the agent
    // to run these locally.
    workflow(ws, "ci.yml", "jobs:\n  t:\n    steps:\n      - run: npm test\n");
    workflow(ws, "publish.yml", [
      "jobs:",
      "  p:",
      "    steps:",
      "      - run: npm publish --provenance --access public",
      "      - run: npm i -g npm@^11",
    ].join("\n"));

    const ci = facts(ws).find((f) => f.key === "ci")!;
    assert.match(ci.body, /npm test/);
    assert.doesNotMatch(ci.body, /npm publish/, "never hand an agent a publish command");
    assert.doesNotMatch(ci.body, /npm i -g/);
    assert.deepEqual(ci.files, [join(".github", "workflows", "ci.yml")]);
  });
});

test("an outward-facing command inside ci.yml is dropped too", async () => {
  await withStore(async (_s, _home, ws) => {
    // The filename filter is not enough: plenty of repos put a deploy job in
    // the same workflow as the tests.
    workflow(ws, "ci.yml", [
      "jobs:",
      "  t:",
      "    steps:",
      "      - run: npm test",
      "      - run: kubectl apply -f k8s/",
      "      - run: docker push example/app:latest",
      "      - run: gh release create v1",
    ].join("\n"));

    const ci = facts(ws).find((f) => f.key === "ci")!;
    assert.match(ci.body, /npm test/);
    for (const bad of [/kubectl apply/, /docker push/, /gh release/]) {
      assert.doesNotMatch(ci.body, bad, "a local check must not act on the outside world");
    }
  });
});

test("a repo with nothing recognisable seeds nothing rather than guessing", async () => {
  await withStore(async (store, _home, ws) => {
    writeFileSync(join(ws, "README.md"), "# just prose\n", "utf8");

    assert.deepEqual(facts(ws), []);
    const report = seed(store, ws);
    assert.equal(report.considered, 0);
    assert.equal(store.all().length, 0);
  });
});

test("every seeded fact is gated, so facts() and seed() cannot disagree", async () => {
  await withStore(async (store, _home, ws) => {
    pkg(ws, { scripts: { build: "tsc -p ." }, engines: { node: ">=22" } });
    workflow(ws, "ci.yml", "jobs:\n  t:\n    steps:\n      - run: npm ci\n");

    const found = facts(ws);
    const report = seed(store, ws);
    assert.equal(report.considered, found.length);
    assert.equal(report.written, found.length);
    for (const f of found) assert.ok(f.files.length, `${f.key} must cite a file`);
  });
});

test("the watermark round-trips and is not what prevents duplicates", async () => {
  await withStore(async (store, _home, ws) => {
    pkg(ws, { scripts: { test: "node --test" } });
    seed(store, ws);
    writeWatermark(ws, { at: new Date().toISOString(), seeded: 1, historyThrough: null });

    const mark = readWatermark(ws);
    assert.equal(mark?.seeded, 1);
    assert.equal(mark?.historyThrough, null);

    // The teammate case: claims present, watermark gone. Must still not duplicate.
    writeFileSync(join(ws, ".lethe", "learned.json"), "not json", "utf8");
    assert.equal(readWatermark(ws), null);
    const again = seed(store, ws);
    assert.equal(again.written, 0);
    assert.equal(again.unchanged, 1);
  });
});
