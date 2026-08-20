<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dark-seahorse.jpeg">
    <img src="assets/seahorse.jpeg" alt="" width="420">
  </picture>
</p>

<h1 align="center">lethe</h1>

<p align="center"><b>A memory harness for coding agents that forgets on purpose.</b></p>

<p align="center">
  <a href="docs/brain.md">how memory works</a> ·
  <a href="docs/architecture.md">architecture</a> ·
  <a href="docs/sleep.md">sleep</a>
</p>

---

Named for the river of forgetting. The seahorse is the hippocampus — *hippos*, horse;
*kampos*, sea monster — which is what early anatomists thought the structure looked
like, and where episodic memory is written before it is either consolidated or lost.

A memory that only grows is a log file. The value of a memory system is not what it
stores — it is what it refuses to store. Forgetting the incidental is the same
operation as extracting the general rule.

> **Status: design phase.** Nothing works yet. The thinking is in [`docs/`](docs/).

## The idea

Your agent solved this on Tuesday. On Thursday, in a new session, it has no idea.

During a session Lethe records what happened, cheaply and without judgement:

```
tue 14:02  tests failed — 14 errors, all "connection refused"
tue 14:09  checked the test DB config, looked fine
tue 14:15  tried resetting the test database, still refused
tue 14:31  postgres container wasn't running. `docker compose up` fixed it
```

Later — on idle, at session end, or nightly in CI — Lethe **sleeps**. It clusters
related episodes, works out what was actually invariant across them, writes that down,
and deletes the rest:

```
.lethe/memory/testing.md

  Tests need `docker compose up` first.
  "Connection refused" is almost always the missing container,
  not the test code.
```

Four episodes in, one rule out, and the episodes are gone. On Thursday the agent reads
one line instead of rediscovering it over twenty-nine minutes — and *you* never see any
of this, because it happened while you weren't waiting.

Rules that keep proving useful get stronger. Rules nobody touches decay and eventually
fall out. Rules that turn out to be wrong get corrected in place, because retrieval
hands the agent an id along with the memory.

## Three things this does that memory tools generally don't

1. **Consolidation** — a deferred pass that distils episodes into durable claims and
   discards the raw material.
2. **Forgetting** — decay, reinforcement on use, cold storage, and eviction under
   capacity pressure. Capacity is treated as fixed.
3. **Reconsolidation** — a memory that has become false can be corrected, instead of
   sitting in the index being confidently wrong forever.

## Memory lives in your repo, as text

```
<repo>/.lethe/memory/*.md    ← team memory. committed, diffable, reviewed in PRs.
~/.lethe/memory/*.md         ← personal memory. never shared.
        .lethe/index.db      ← derived vector index. gitignored, rebuildable.
```

The markdown is the source of truth; SQLite is a build artifact. That is what makes
this possible:

```diff
  # .lethe/memory/testing.md

- ## tests failed, connection refused
- Checked DB config, looked fine. Reset the test database, still refused.
- Turned out the postgres container wasn't running.
-
+ ## Tests need `docker compose up` first
+ "Connection refused" is almost always the missing container,
+ not the test code.
```

A nightly job runs `lethe sleep` and opens a pull request. **Your team reviews what the
brain learned** before it becomes shared knowledge.

## Local first

Embeddings run on-device by default — a ~23MB model, fetched once, no API key, no
configuration, nothing leaving your machine. Hosted providers are opt-in. Your memories
contain your source code; that seemed like the right default.

## Design

- [`docs/brain.md`](docs/brain.md) — how memory actually works: complementary learning
  systems, sharp-wave ripple consolidation, synaptic downscaling, reconsolidation. And
  an honest account of where we break from biology.
- [`docs/architecture.md`](docs/architecture.md) — the three stores, why text is the
  source of truth, embeddings, salience.
- [`docs/sleep.md`](docs/sleep.md) — the consolidation pass, and sleep as a pull
  request.

## The rule

An anatomical name is only allowed as a nickname for a component that already earned
its existence. If you cannot describe a module in one sentence of plain systems
language without the brain word, it does not ship. **Brain-shaped on the outside,
boring and testable on the inside.**

## Roadmap

- [ ] **Prove the thesis.** Eval: retrieval over distilled memory vs. retrieval over
      raw session logs. If distillation doesn't win, stop here.
- [ ] **Core.** SQLite store, three memory types, decay and eviction from day one.
- [ ] **Sleep.** The consolidation pass.
- [ ] **MCP server.** Works in any harness that speaks MCP.
- [ ] **Evals.** Publish the numbers.
- [ ] **Archetypes.** Memory policy as configuration.

## License

Apache-2.0
