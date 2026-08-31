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

### Decide whether memory is committed

Memory goes where it belongs without being told. Consolidated **claims** land in
`<repo>/.lethe/memory/`, beside the code they describe; raw **episodes** land in
`~/.lethe/projects/<project>/` and are never written into a repository. There is no scope
to choose and nothing to configure.

That leaves exactly one question, which `lethe init` asks once per project:

```sh
npx @alarv/lethe init
```

```
this project's consolidated claims should be

  1  committed     anyone who can clone this repo inherits them; best for a private repo
  2  git-ignored   you read them in your editor; nobody else ever sees them
```

**Committed is for private repositories.** The audience for committed memory is whoever
can clone the repo, and in a public one that is everybody. Distilled claims routinely name
internal services, deploy steps and the reasoning behind decisions — none of it secret,
all of it context you probably did not mean to publish. lethe cannot check visibility for
you (that is a property of the host, not the checkout) so it says so and leaves the call
to you.

To skip the question — in a script, or because you already know:

```sh
lethe init --share               # committed
lethe init --private             # git-ignored
lethe init --global --share      # what projects that have not chosen start from
```

Both answers write to the same directory, so **changing your mind later moves no files**:
it comments two lines in `.lethe/.gitignore` in or out. That file, not a config setting,
is the decision — which is why nothing can disagree with it. `lethe doctor` asks git what
actually happened.

**lethe never edits your root `.gitignore`.** The rules live in `.lethe/.gitignore`,
which governs its own directory — so the whole install is one folder, and uninstalling
is `rm -rf .lethe`:

```gitignore
*
!.gitignore
!memory/          # comment these two out and claims stay on this machine
!memory/*.md
```

It's a whitelist, so anything a later version writes into that directory is ignored by
default rather than turning up in someone's commit. Those two lines are the entire sharing
decision; `lethe init` toggles them and leaves any line you added by hand alone.

**Commit `.lethe/.gitignore` even when the memories are private.** It is what keeps them
out of git, and it has to be present in everyone's working tree to do that — including
people who never chose it. If it were ignored too, untracking it would be a change others
receive: a `git pull` would delete their copy and their own private memories would stop
being ignored.

**Episodes are not part of this decision.** The raw, verbose record of what happened in
a session always lives in `~/.lethe/projects/<project>/`, is private to you, and is never
written into a repository. `lethe where` shows both paths. The one state still worth
watching for is claims that are neither ignored nor committed — sharing is on and nobody
ran `git add` — and `lethe doctor` warns about exactly that.

### One more step, and it's the one that matters

Left to itself, an agent mostly *doesn't* call a memory tool — it has other things on its
mind. So don't rely on it:

```sh
lethe hook show      # prints a hook config to add to your host
```

That runs recall **before** the model sees your turn and injects what it finds, so memory
arrives whether or not anything thought to ask. opencode gets the same via
[`plugins/opencode.js`](plugins/opencode.js).

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
[Decide whether memory is committed](#decide-whether-memory-is-committed). Episodes never
move: they are a private scratchpad that consolidation eventually consumes.

### Day to day

```sh
lethe recall "why do the tests fail"   # search
lethe ls                               # everything recorded
lethe status                           # is it working?
lethe metrics                          # is it being used, and is it distilling?
lethe compact --dry-run                # preview consolidation
lethe gc                               # what is in ~/.lethe, and what is dead in it
```

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

## Does it actually work?

There's an eval, it's public, and it reports where lethe loses:
[`docs/evals.md`](docs/evals.md).

The claim under test was written down before the measuring started, in a form that can
fail: an agent with distilled memory should reach a correct answer in fewer turns and
fewer tokens than one with raw session logs. If distillation can't beat raw logs, the
project should stop — and the eval exists to find that out rather than to flatter us.

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
