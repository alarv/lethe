import { test } from "node:test";
import assert from "node:assert/strict";
import { matchExpression, stem, terms } from "./query.js";

test("tokenises the way the existing scorer does", () => {
  assert.deepEqual(terms("Why is Docker failing?"), ["why", "is", "docker", "failing"]);
  assert.deepEqual(terms("Why is Docker: go/js failing?"), ["why", "is", "docker", "go", "js", "failing"]);
  assert.deepEqual(terms("a i"), [], "single letters are noise");
});

test("builds an OR expression of quoted terms", () => {
  assert.equal(matchExpression("docker compose"), '"docker" OR "compose"');
});

test("returns null when there is nothing to search for", () => {
  assert.equal(matchExpression(""), null);
  assert.equal(matchExpression("a i"), null);
  assert.equal(matchExpression("!!! ??? ..."), null);
});

// Deliberately no stopword list. The naive scorer does not have one either, and
// matching its tokenisation keeps the eval comparing one variable at a time.
// A ubiquitous term is what IDF is for -- "the" matching everything scores
// near-zero on its own, which is the correct outcome rather than a bug.
test("keeps short-but-common words, leaving IDF to discount them", () => {
  assert.equal(matchExpression("the tests"), '"the" OR "tests"');
});

const HOSTILE = [
  "why is docker: failing?",
  "tests -broken",
  "C++ error",
  "auth OR",
  '"unclosed',
  "NEAR(a b)",
  "foo*",
  "a AND b NOT c",
  "docker compose",
];

test("neutralises FTS5 syntax in natural language", () => {
  for (const q of HOSTILE) {
    const expr = matchExpression(q);
    if (expr === null) continue;
    assert.match(expr, /^"[a-z0-9]+"( OR "[a-z0-9]+")*$/,
      `${q} produced an unsafe expression: ${expr}`);
  }
});

test("strips quotes so a term can never escape its own quoting", () => {
  assert.equal(matchExpression('say "hello" now'), '"say" OR "hello" OR "now"');
});

test("stemming agrees with the FTS5 porter tokenizer it is used beside", async (t) => {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return t.skip("node:sqlite unavailable");
  }
  const words = [
    "running", "runs", "run", "tests", "test", "testing", "latest", "tested",
    "embeddings", "embedding", "decisions", "decided", "decide", "failing",
    "failed", "fails", "configuration", "configured", "policies", "policy",
    "relational", "conditional", "operator", "formalize", "electrical",
    "goodness", "revival", "allowance", "inference", "airliner", "adjustable",
    "replacement", "dependent", "adoption", "activate", "effective", "bowdlerize",
    "probate", "rate", "cease", "controll", "roll", "yelling", "youth", "sky",
    "thanks", "thanking", "thank",
  ];
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE fts USING fts5(body, tokenize='porter unicode61')");
  const insert = db.prepare("INSERT INTO fts(rowid, body) VALUES (?, ?)");
  words.forEach((w, i) => insert.run(i + 1, w));
  db.exec("CREATE VIRTUAL TABLE vocab USING fts5vocab(fts, 'instance')");
  const term = db.prepare("SELECT term FROM vocab WHERE doc = ?");
  for (const [i, w] of words.entries()) {
    const indexed = String((term.all(i + 1)[0] as { term?: unknown } | undefined)?.term ?? "");
    assert.equal(stem(w), indexed, `stem(${w}) must match FTS5 porter`);
  }
  db.close();
});

test("every expression is accepted by real FTS5", async (t) => {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return t.skip("node:sqlite unavailable");
  }
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE fts USING fts5(body, content='', contentless_delete=1)");
  db.prepare("INSERT INTO fts(rowid, body) VALUES (?, ?)").run(1, "run docker compose up first");
  for (const q of HOSTILE) {
    const expr = matchExpression(q);
    if (expr === null) continue;
    assert.doesNotThrow(
      () => db.prepare("SELECT rowid FROM fts WHERE fts MATCH ?").all(expr),
      `FTS5 rejected the expression for: ${q}`,
    );
  }
  db.close();
});
