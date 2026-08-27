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
  <a href="docs/compact.md">compaction</a>
</p>

---

Named for the river of forgetting. The seahorse is the hippocampus — *hippos*, horse;
*kampos*, sea monster — which is what early anatomists thought the structure looked
like, and where episodic memory is written before it is either consolidated or lost.

A memory that only grows is a log file. The value of a memory system is not what it
stores — it is what it refuses to store. Forgetting the incidental is the same
operation as extracting the general rule.

> **Status: early, and measured.** Capture, recall, consolidation and forgetting work.
> Retrieval is BM25 over an FTS5 index — no embeddings, no model, no download. Against
> the retrieval eval, consolidation went from losing to raw episodes (MRR 0.86 vs 0.94)
> to drawing with them (0.94 vs 0.93). At 18 synthetic tasks that delta is noise, so the
> honest claim is that the loss disappeared, not that consolidation wins. See
> [`docs/evals.md`](docs/evals.md), including where we lose.

## The idea

Your agent solved this on Tuesday. On Thursday, in a new session, it has no idea.

During a session Lethe records what happened, cheaply and without judgement:

```
tue 14:02  tests failed — 14 errors, all "connection refused"
tue 14:09  checked the test DB config, looked fine
tue 14:15  tried resetting the test database, still refused
tue 14:31  postgres container wasn't running. `docker compose up` fixed it
```

Later, off the latency path, Lethe **compacts**. It hands the raw episodes to a model,
which decides which of them are about the same underlying thing, works out what was
invariant across them, and writes that down:

```
.lethe/memory/testing.md

  Tests need `docker compose up` first.
  "Connection refused" is almost always the missing container,
  not the test code.
```

Four episodes in, one rule out. The episodes go cold rather than being deleted, so they
stay on disk as a second route to the claim — a query phrased the way the original
session was phrased still finds it. Eventually they are evicted, weakest first. On
Thursday the agent reads one line instead of rediscovering it over twenty-nine minutes,
and *you* never see any of this, because it happened while you weren't waiting.

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

## Recall happens without being asked

Left to itself, an agent mostly does not call a memory tool. Measured over 79 sessions of
real use: **76% never touched Lethe at all, and only 10% ever called `recall`.** Two
attempts to fix that by persuasion both failed — strengthened tool descriptions do not
reach the model in hosts that load MCP schemas on demand, and a rules file loses to
everything else competing for attention.

So Lethe does not rely on being asked. A host hook runs recall before the model sees your
turn and injects what it finds:

```sh
lethe hook show      # prints the config to add to ~/.claude/settings.json
```

opencode gets the same via `plugins/opencode.js`. Injecting on every prompt makes
precision the whole problem, so it stays silent unless the prompt shares two content
words with a memory, or one word rare enough in your store to not be a coincidence — and
it prefers distilled claims over raw episodes, which are trimmed to an excerpt and an id.

```sh
lethe metrics        # adoption, recall/note balance, what consolidation produced
```

`metrics` is the honest check. If `distilled per episode` reads 0.00, consolidation has
produced nothing and recall is serving you raw session transcripts.

## Memory lives in your repo, as text

```
~/.lethe/
  projects/
    -users-you-code-api/     one directory per project
      memory/*.md            local scope: this repo, private to you  (default)
      source                 which directory this belongs to
  memory/*.md                personal scope: you, across every repo
  lethe.log

<repo>/.lethe/memory/*.md    team scope: committed, reviewed in PRs
```

By default memory lives under `~/.lethe`, so nothing appears in your repository
unless you ask for it. To keep it in the project instead:

```sh
lethe init                 # store in <repo>/.lethe, and gitignore it
lethe init --commit        # store in <repo>/.lethe and share it with the team
lethe init --global        # apply a choice to every project
```

Where it is stored and whether it is committed are separate decisions: `lethe init`
adds `.lethe/memory/` to `.gitignore` unless you pass `--commit`. Only the memory is
ignored — `.lethe/config.json` is committed, so anyone else working on the repo
inherits the same choice.

Config is read from `<repo>/.lethe/config.json`, then `~/.lethe/config.json`, with
`LETHE_SCOPE` overriding both. `lethe status` shows which scope is in effect.

The project directory is the full path with separators flattened. Using just the
folder name would collide -- everyone has more than one repo called `api` -- and a
hash would be unique but unreadable, which matters the moment you go looking. Run
`lethe projects` rather than reading the directory names.

Nothing is written into your repository unless you ask for it. Writing to someone's
working tree is a decision they opt into, not something they find in `git status`.

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

Compaction can run in CI and open a pull request, so **your team reviews what the brain
learned** before it becomes shared knowledge. Compaction normally runs in-session using
the model your agent already has; the CI path needs its own key, so it is opt-in.

## Running it

> Works today: recording, recall over a BM25 index, consolidation, promotion, decay and
> eviction, plus automatic recall via a host hook. Requires Node 22 or newer for the
> index; on anything older retrieval falls back to a simpler scorer rather than failing.

```sh
git clone https://github.com/alarv/lethe.git && cd lethe
npm install && npm run build
npm link          # puts `lethe` on your PATH
```

Point opencode at it — `~/.config/opencode/opencode.json` for every project, or
`opencode.json` in a repo for just that one:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "lethe": {
      "type": "local",
      "command": ["/absolute/path/to/node", "/absolute/path/to/lethe/dist/cli.js", "mcp"],
      "enabled": true
    }
  }
}
```

The server registers `recall`, `note`, `confirm`, `correct` and `forget`. Harnesses
namespace them by server, so they surface as `lethe_recall` in opencode and
`mcp__lethe__recall` in Claude Code.

**Then tell your agent when to use them**, or it mostly won't. In `AGENTS.md`:

```md
Before investigating anything non-trivial, call lethe's `recall` first — it may
already be known. When you learn something durable (a fix, a gotcha, a decision
and its reasoning, a dead end worth not repeating), record it with `note`.
If a recalled memory turns out to be wrong, fix it with `correct`.
```

For **Claude Code**:

```sh
claude mcp add lethe --scope user -- "$(which node)" /absolute/path/to/lethe/dist/cli.js mcp
```

Use an absolute path to `node`, not the bare name. A harness launched from Finder or a
Dock icon does not inherit your shell `PATH`, so `node` may not resolve and the server
fails to start with nothing to show for it.

Claude Code reads `~/.claude/CLAUDE.md` rather than `AGENTS.md`; symlink one to the
other so a single rules file serves both.

### Is it working?

```sh
lethe doctor         # diagnose setup problems
lethe status         # counts, pressure, and when each tool last fired
lethe log -n 40      # recent activity
```

MCP servers are long-lived child processes, so **a rebuild does not reach a server that
is already running** — the harness keeps using the version it started with. After
changing Lethe, restart opencode or Claude Code. `lethe status` warns when the running
server is older than the built code.

Run these from anywhere — the log is global. `status` also reports the store for
whichever repo you are currently in, so run it there to see that repo's memories.

`status` is the one to check after a session. If it says no activity, the agent never
called the tools — usually because the harness did not start the server, or because
nothing told the agent to use it. Note that `stdout` is the MCP transport, so nothing is
ever printed to the terminal; the log file at `~/.lethe/lethe.log` is the only trace.
`LETHE_DEBUG=1` also mirrors it to stderr.

Inspect the store by hand:

```sh
lethe where          # where memory is stored
lethe ls             # everything recorded
lethe recall "auth"  # search
lethe compact --dry-run
```

Memory lands in `.lethe/memory/*.md` — commit it to share with your team, or use
`scope: "personal"` to keep it in `~/.lethe/`.

## Local first

Embeddings run on-device by default — a ~23MB model, fetched once, no API key, no
configuration, nothing leaving your machine. Hosted providers are opt-in. Your memories
contain your source code; that seemed like the right default.

## Design

- [`docs/brain.md`](docs/brain.md) — how memory actually works: complementary learning
  systems, sharp-wave ripple consolidation, synaptic downscaling, reconsolidation. And
  an honest account of where we break from biology.
- [`docs/architecture.md`](docs/architecture.md) — the three stores, why text is the
  source of truth, how retrieval is layered, salience, and why embeddings were rejected.
- [`docs/compact.md`](docs/compact.md) — the consolidation pass, when it runs, and who
  provides the model.
- [`docs/evals.md`](docs/evals.md) — how we intend to prove any of this works, written
  before there was anything to measure.
- [`docs/api-design.md`](docs/api-design.md) — the rules the tool surface is held to.

## The rule

An anatomical name is only allowed as a nickname for a component that already earned
its existence. If you cannot describe a module in one sentence of plain systems
language without the brain word, it does not ship. **Brain-shaped on the outside,
boring and testable on the inside.**

## Roadmap

- [x] **Core.** Three memory types, decay and eviction.
- [x] **Compaction.** Consolidate, promote, decay — triggered by salience pressure.
- [x] **MCP server.** Works in any harness that speaks MCP.
- [x] **Retrieval.** BM25 over a derived FTS5 index, with cold episodes routing forward
      to the claims they became.
- [x] **Automatic recall.** A host hook, because relying on the model to ask produced 10%
      adoption.
- [x] **Forgetting.** Bounded capacity, evicted cheapest-loss-first.
- [ ] **Prove the thesis.** The retrieval eval currently reads as a draw on 18 synthetic
      tasks. Real dogfooded task pairs are the missing piece; a draw is not a win.
- [ ] **Publish the numbers**, including where we lose.
- [ ] **Archetypes.** Memory policy as configuration.

Embeddings are **not** on the roadmap. There is no embeddings endpoint to ask — Anthropic
ships none and MCP has no such primitive — so every route means running ~123 MB of
inference runtime locally or sending your memories to a third party, and the defect they
would have masked was a consolidation bug rather than a retrieval one. See
[`docs/architecture.md`](docs/architecture.md) for the full record. The one place they
would genuinely earn their cost is grouping episodes, where lexical similarity provably
cannot work — that stays open.

## License

Apache-2.0
