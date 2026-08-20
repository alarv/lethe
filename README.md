# lethe

**A memory harness for coding agents that forgets on purpose.**

Named for the river of forgetting.

A memory that only grows is a log file. The value of a memory system is not what it
stores — it is what it refuses to store. Forgetting the incidental is the same
operation as extracting the general rule.

> **Status: design phase.** Nothing works yet. The thinking is in [`docs/`](docs/).

## The idea

Your agent writes down what happened. Later, while you are not waiting on it, Lethe
**sleeps**: it clusters related episodes, distils what was invariant across them into a
durable claim, and throws the raw material away.

```
"spent 40min on failing auth test, token was expiring"
"auth test flaky again, clock skew in CI"                 ──sleep──►
"fixed CI auth flake by freezing the clock in test setup"

    "Auth tests are clock-sensitive; freeze the clock in test setup.
     CI failures here are usually skew, not logic."
```

Three episodes in, one claim out, and the episodes are gone. Unused claims decay.
Claims that get used get stronger. Claims that turn out to be wrong get corrected in
place, because retrieval hands the agent an id and the tools to revise it.

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
- ## auth test flaky in CI
- Spent 40min. Token expiring mid-run. Third time this month.
-
+ ## Auth tests are clock-sensitive
+ Freeze the clock in test setup. CI failures in auth tests are usually
+ skew rather than logic.
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
