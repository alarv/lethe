import { test } from "node:test";
import assert from "node:assert/strict";
import { evidence, unrepresentedSources, droppedFrom } from "./evidence.js";

test("extracts fenced code blocks", () => {
  assert.ok(evidence("prose\n```\ndocker compose up -d\n```\nmore").includes("docker compose up -d"));
});

test("extracts inline code spans", () => {
  assert.ok(evidence("run `npm run build` first").includes("npm run build"));
});

test("extracts paths and known filenames", () => {
  assert.ok(evidence("the bug is in src/store.ts").includes("src/store.ts"));
  assert.ok(evidence("check docker-compose.yml").includes("docker-compose.yml"));
});

test("extracts environment variable assignments", () => {
  assert.ok(evidence("set LETHE_HOME=/tmp/x").includes("LETHE_HOME=/tmp/x"));
});

test("ignores ordinary prose", () => {
  assert.deepEqual(evidence("we decided to guard shared state across awaits"), []);
});

test("a sentence-ending period is not a filename", () => {
  assert.deepEqual(evidence("It failed. Then it worked."), []);
});

test("a URL is not treated as a path", () => {
  assert.deepEqual(evidence("see https://example.com/docs"), []);
});

test("deduplicates repeated evidence", () => {
  assert.equal(evidence("`npm test` then `npm test`").filter((f) => f === "npm test").length, 1);
});

test("a source kept nothing is reported", () => {
  assert.deepEqual(
    unrepresentedSources(["run `docker compose up` first", "the file is src/store.ts"],
      "See src/store.ts for details"),
    [0], "source 0 contributed nothing to the claim",
  );
});

test("compression is allowed: keeping one string from a source is enough", () => {
  assert.deepEqual(
    unrepresentedSources(
      ["run `docker compose up -d`, see docker-compose.yml and src/store.ts"],
      "Run `docker compose up -d` before the suite.",
    ),
    [], "dropping the paths is legitimate compression, not absorption",
  );
});

test("a prose-only source is vacuously satisfied", () => {
  assert.deepEqual(unrepresentedSources(["we decided to guard shared state"], "Guard shared state."), [],
    "there was nothing it could have contributed");
});

test("droppedFrom names what a source lost, for a diagnosable rejection", () => {
  assert.deepEqual(droppedFrom("run `docker compose up` in src/store.ts", "nothing relevant"),
    ["docker compose up", "src/store.ts"]);
});

// The failure the gate exists for: five unrelated episodes fused into one claim
// about FTS5, four of them contributing nothing and losing their content.
test("catches a fusion that absorbs a source without keeping anything", () => {
  assert.deepEqual(
    unrepresentedSources(
      ["run `docker compose up`", "and `npm pack --dry-run` showed the leak"],
      "Start the containers with `docker compose up` before the suite.",
    ),
    [1], "the npm episode was consumed and left no trace in the claim",
  );
});

// Calibration against a real run where six correctly-scoped claims were
// rejected for "missing" things that were never evidence.
test("a bare identifier in backticks is terminology, not evidence", () => {
  assert.deepEqual(evidence("call `recall` first"), []);
  assert.deepEqual(evidence("the `note` tool"), []);
});

test("prose containing slashes is not a path", () => {
  assert.deepEqual(evidence("multiply by strength/kind/path boosts"), []);
  assert.deepEqual(evidence("look in src/ for it"), [],
    "a bare directory is not a string anyone retrieves by");
});

test("but real commands, filenames and flags still count", () => {
  assert.ok(evidence("run `docker compose up -d`").includes("docker compose up -d"));
  assert.ok(evidence("check `docker-compose.yml`").includes("docker-compose.yml"));
  assert.ok(evidence("pass `--dry-run`").includes("--dry-run"));
  assert.ok(evidence("the file src/store.ts").includes("src/store.ts"));
});

test("an assignment does not swallow trailing punctuation", () => {
  assert.ok(evidence("use LETHE_HOME=mktemp, then run it").includes("LETHE_HOME=mktemp"));
});

// Calibration against the rejections that followed: real claims that kept the
// lesson and were thrown away because the gate counted only incidental paths.
test("settings, calls and code symbols in backticks count as evidence", () => {
  assert.ok(evidence("needs `contentless_delete=1` or DELETE fails").includes("contentless_delete=1"));
  assert.ok(evidence("use `content=''` here").includes("content=''"));
  assert.ok(evidence("`bm25()` returns negatives").includes("bm25()"));
  assert.ok(evidence("hidden in `customer_id`").includes("customer_id"));
  assert.ok(evidence("renamed to `rcmCustomerID`").includes("rcmCustomerID"));
  assert.ok(evidence("built into `node:sqlite`").includes("node:sqlite"));
});

test("a claim naming the file keeps a path given in full", () => {
  assert.deepEqual(
    unrepresentedSources(["schemas live in casino_recomm/recomm_domain/schemas/output_schema.py"],
      "Authoritative tables are documented in output_schema.py"),
    [], "the filename is the handle; the directory chain is not",
  );
});

test("a basename too short to be distinctive does not stand for the path", () => {
  assert.deepEqual(unrepresentedSources(["see src/a.ts"], "see a.ts"), [0]);
});

test("formatting differences do not count as dropping a setting", () => {
  assert.deepEqual(
    unrepresentedSources(["`content='', detail='full'` is 4.1 MB"],
      "FTS5 sizing: use content = '' , detail = \"full\" with contentless_delete=1"),
    [],
  );
});

test("a claim that keeps none of a source's handles is still rejected", () => {
  assert.deepEqual(
    unrepresentedSources(["needs `contentless_delete=1`; see src/store.ts"],
      "Use a contentless table to save space"),
    [0], "the widened rules must not make the gate a formality",
  );
});
