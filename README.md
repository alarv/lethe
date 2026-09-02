<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dark-seahorse.jpeg">
    <img src="assets/seahorse.jpeg" alt="" width="420">
  </picture>
</p>

<h1 align="center">lethe</h1>

<p align="center"><b>A memory harness for coding agents that forgets on purpose.</b></p>

<p align="center">
  <a href="https://github.com/alarv/lethe/actions/workflows/ci.yml"><img src="https://github.com/alarv/lethe/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://www.npmjs.com/package/@alarv/lethe"><img src="https://img.shields.io/npm/v/@alarv/lethe?color=cb3837&logo=npm" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@alarv/lethe" alt="node"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="license"></a>
</p>

<p align="center">
  <a href="#install">install</a> ·
  <a href="#what-it-does">what it does</a> ·
  <a href="docs/brain.md">how memory works</a> ·
  <a href="#contributing">contributing</a>
</p>

---

Your agent solved it on Tuesday. On Thursday, in a new session, it has no idea.

Every memory tool answers that by storing more. lethe answers it by storing **less,
better** — it distils what happened into what is true, and throws the rest away.

```
tue 14:02  tests failed — 14 errors, all "connection refused"
tue 14:09  checked the test DB config, looked fine
tue 14:15  tried resetting the test database, still refused
tue 14:31  postgres container wasn't running. `docker compose up` fixed it
                              │
                              ▼      later, off the latency path
        ┌────────────────────────────────────────────────┐
        │  Tests need `docker compose up` first.         │
        │  "Connection refused" is almost always the     │
        │  missing container, not the test code.         │
        └────────────────────────────────────────────────┘
```

Four episodes in, one rule out. On Thursday your agent reads one line instead of
rediscovering it over twenty-nine minutes — and you never see any of it, because it
happened while you weren't waiting.

## Install

Works in any host that speaks MCP.

**Claude Code**

```sh
claude mcp add lethe --scope user -- npx -y @alarv/lethe mcp
```

**opencode** — `~/.config/opencode/opencode.json` for every project, or `opencode.json`
in a repo for just that one:

```json
{
  "mcp": {
    "lethe": {
      "type": "local",
      "command": ["npx", "-y", "@alarv/lethe", "mcp"],
      "enabled": true
    }
  }
}
```

**Cursor · Windsurf · Zed** — anything reading `mcp.json`:

```json
{
  "mcpServers": {
    "lethe": { "command": "npx", "args": ["-y", "@alarv/lethe", "mcp"] }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.lethe]
command = "npx"
args = ["-y", "@alarv/lethe", "mcp"]
```

Then confirm it:

```sh
npx @alarv/lethe doctor
```

Needs Node 22+. On older versions retrieval falls back to a simpler ranker rather than
failing.

### Sharing memory

Episodes (raw session logs) never leave `~/.lethe` — always private. Claims (distilled,
reusable facts) land in `<repo>/.lethe/memory/`, and `lethe init` asks once per project
whether to commit them:

```sh
npx @alarv/lethe init
```

Commit only in a private repo — claims can name internal services, deploy steps, and the
reasoning behind decisions. The answer just toggles two lines in `.lethe/.gitignore`, so
changing your mind later moves no files. Skip the prompt with `lethe init --share` or
`lethe init --private`. `lethe doctor` flags the one bad state: sharing on, nothing
committed.

### Seeding memory

An empty store teaches an agent to stop calling `recall`. So there's a `learn` tool: ask
your agent to call it, and it reads the repo and writes down what the project already
says about itself — conventions, commands, gotchas — instead of starting from nothing.

Every fact it writes must cite a real file and quote it verbatim, or it's rejected.
Seeded claims start weak and decay if nothing ever confirms them; one that proves useful
gets reinforced.

```sh
lethe learn      # what has been seeded from this repo, and how strong it still is
```

### Make recall automatic

Left alone, an agent mostly doesn't call a memory tool — it has other things on its mind.
A hook fixes that by running `recall` before the model even sees your message, so
whatever it finds is already in context:

```sh
lethe hook show      # prints a hook config to add to your host
```

opencode gets the same via [`plugins/opencode.js`](plugins/opencode.js).

## What it does

Three kinds of memory, and **where a memory lives is decided by what it is, not by who
asks**:

| | | |
|---|---|---|
| `episode` | what happened | raw, verbose, never leaves your machine |
| `claim` | what is true | distilled from episodes, shareable |
| `pattern` | how we do things here | promoted once a claim has earned it |

And three things memory tools generally don't do:

**Consolidation.** A deferred pass hands your raw episodes to a model, which decides which
of them are about the same underlying problem and writes down what was invariant across
them. Runs off the latency path, never while you wait.

**Forgetting.** Memories decay, are reinforced when used, and are evicted under a capacity
budget — weakest first, cheapest loss first. Capacity is treated as fixed.

**Reconsolidation.** A memory that turns out to be wrong gets corrected, instead of sitting
in the index being confidently wrong forever.

### Memory is text, in your repo

```
.lethe/memory/
  a1b2c3d4-tests-need-containers.md
  e5f6a7b8-async-state-is-a-race.md
```

Readable, diffable, reviewable in a pull request. `git blame` works on your agent's
memory. Nothing is locked in a database you can't inspect — and if you delete lethe
tomorrow, you keep the markdown.

Claims land in the repo so your team can review what the agent learned before it becomes
shared knowledge; whether they are committed is one line in `.lethe/.gitignore` — see
[Sharing memory](#sharing-memory). Episodes never move: they are a private scratchpad
that consolidation eventually consumes.

### Day to day

```sh
lethe recall "why do the tests fail"   # search
lethe ls                               # everything recorded
lethe status                           # is it working?
lethe metrics                          # is it being used, and is it distilling?
lethe learn                            # what has been seeded from this repo
lethe compact --dry-run                # preview consolidation
lethe gc                               # what is in ~/.lethe, and what is dead in it
```

Anything slow reports progress — a bar where the fraction is knowable, and elapsed time
against the timeout where it isn't, because one model call can't report a percentage
without inventing it. It all goes to **stderr**, never stdout: stdout is the MCP transport,
and it's also what `lethe status | grep` reads. Outside a terminal, and under CI, the
animation is off and each phase prints once instead. `LETHE_PROGRESS=0` silences it,
`LETHE_PROGRESS=1` forces it on.

### It cleans up after itself

`~/.lethe` is the one directory lethe grows where you are not looking, so nothing in it is
left to accumulate:

- **The index prunes itself.** Rows for files that no longer exist go on the next sync.
  Recall reads only the files that changed and only the results it returns — it never
  parses the whole store, which is what used to make one recall cost 4.4 seconds on a
  36,000-memory store.
- **The log is off by default**, because appending forever to a file in your home
  directory is not a diagnostic. `lethe init --debug` turns it on; it rotates at 512 KB
  and keeps one previous copy. With it off, `lethe metrics` and the activity rows in
  `status` and `doctor` say so rather than reporting zero.
- **Dead project directories are collected** as compaction passes — but only ones holding
  no memories. A directory that still has memories is never removed automatically, however
  missing its repository looks, because a path that is gone today is as likely to be an
  unmounted disk or a moved checkout. `lethe gc` names those; `lethe gc --dead` removes
  them once you have looked.

```sh
lethe gc --dry-run     # say what would go, change nothing
lethe gc --dead        # also drop directories whose project is gone
lethe gc --reindex     # throw the index away; it rebuilds on the next recall
```

## Why a seahorse

Named for the river of forgetting. The seahorse is the hippocampus — *hippos*, horse;
*kampos*, sea monster — which is what early anatomists thought the structure looked like,
and where episodic memory is written before it is either consolidated or lost.

That is not decoration. The brain doesn't have one memory system, it has several with
different physics, and the reason is a constraint we share: anything that learns fast
enough to record a one-off event cannot also extract stable general structure without
overwriting itself. So the brain runs a fast sparse episodic buffer alongside a slow dense
semantic store, and moves memory between them during sleep by replaying it.

lethe borrows that architecture on purpose, rather than as a metaphor:

| brain | lethe |
|---|---|
| hippocampus — fast episodic buffer, small, overwritten | `episode` store, hot, bounded |
| neocortex — slow semantic store, large, general | `claim` store, curated |
| sharp-wave ripple replay during rest | consolidation, off the latency path |
| synaptic downscaling during sleep | global decay, reinforcement on access |
| pattern completion — a partial cue reinstates the whole | a query in the old wording still finds the new claim |

Forgetting is the part people find surprising, and it's the whole point. Sleep
*downscales* synapses globally: weak traces fall below threshold and vanish, and
signal-to-noise improves because the total was cut back. A system that retained every
episode in full detail could never form the concept "dog" — it would have a million
unrelated animal encounters. **Forgetting the incidental is the same operation as
extracting the general rule.**

[`docs/brain.md`](docs/brain.md) has the full account, with citations and an honest
section on where we break from biology.

## Evaluations

[`docs/evals.md`](docs/evals.md) — public, and it reports where lethe loses.

The claim under test: an agent with distilled memory reaches a correct answer in fewer
turns and fewer tokens than one with raw session logs. If distillation can't beat raw
logs, the project should stop.

## Design

- [`docs/brain.md`](docs/brain.md) — how memory actually works: complementary learning
  systems, ripple consolidation, synaptic downscaling, reconsolidation.
- [`docs/architecture.md`](docs/architecture.md) — the three stores, why text is the
  source of truth, how retrieval is layered, salience.
- [`docs/compact.md`](docs/compact.md) — the consolidation pass, when it runs, and who
  provides the model.
- [`docs/evals.md`](docs/evals.md) — what we measure and why.
- [`docs/api-design.md`](docs/api-design.md) — the rules the tool surface is held to.
- [`CHANGELOG.md`](CHANGELOG.md) — what changed, and which failure it fixed.

## Contributing

Issues and pull requests welcome, particularly:

- **Host integrations.** If lethe doesn't work cleanly in your editor or agent, that's a
  bug worth reporting.
- **Eval tasks.** The eval needs real pairs: something discovered in one session that a
  later session needs. Invented ones encode our assumptions about what memory is for,
  which is exactly what's being tested.
- **Retrieval and consolidation quality.** Both are measured, so an improvement can be
  demonstrated rather than argued.

```sh
git clone https://github.com/alarv/lethe.git && cd lethe
npm install && npm test
```

Commit messages here are prose explaining the *why* and the failure being fixed, rather
than a conventional-commit prefix. [`AGENTS.md`](AGENTS.md) has the conventions,
including how releases work.

## The rule

A memory that only grows is a log file. The value of a memory system is not what it
stores — it is what it refuses to store.

## License

Apache-2.0
