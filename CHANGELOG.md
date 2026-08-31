# Changelog

Written by hand, not generated. The value of a change here is usually *why* it was made
and what failure it fixes, and no tool derives that from a diff.

Kept in the format of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
follow [semver](https://semver.org/), with the caveat that 0.x means the tool surface may
still move.

The release workflow refuses to publish a version with no section here.

## [Unreleased]

### Changed

- **The ignore rules live in `<repo>/.lethe/.gitignore`, not your repository root.** A
  subdirectory `.gitignore` governs its own directory and wins over shallower patterns,
  so lethe no longer appends to — or has to parse — a file you own, and the entire
  install is one folder you can delete. It is written as a whitelist (`*` plus explicit
  exceptions) so an artifact a later version writes into `.lethe/` cannot reach a commit
  by accident; the old form was a blacklist in the root, which is how it came to be
  protecting a directory that never existed.

  Two `!memory/` lines are the whole sharing decision. `lethe init` toggles them in
  place, leaving any line you added by hand untouched, and reports `foreign` rather than
  overwriting a `.lethe/.gitignore` it did not write. A stale `.lethe/` rule left in your
  root by an older version is overridden by the nested file, so nothing breaks on
  upgrade; `lethe init` points at it so you can delete it.

### Fixed

- **`lethe init --scope=<nonsense>` is now refused.** It used to write the value to
  `config.json`, print "default scope banana", and then silently resolve to `local` — the
  setting appeared to take and did not, which is the exact failure the config rows in
  `lethe doctor` were added to answer. Doctor now also marks a config file whose scope is
  not a scope, instead of pointing at it as the winner.

- **`lethe init` no longer writes a `.gitignore` line for `.lethe/episodes/`.** That
  directory has never existed — episodes live in `~/.lethe/projects/<key>/` whatever the
  scope says — so the line protected nothing while telling the reader, under the heading
  "private working memory, never shared", that their raw session notes were sitting in
  the repository waiting to be committed.

### Added

- **`lethe init` asks where claims should go**, in terms of who ends up able to read them
  rather than in terms of a scope name: in this repo committed, in this repo git-ignored,
  outside the repo, or with you across every project. It then asks whether that is a
  setting for this project or your default everywhere. `--scope` and `--private` still
  work and skip the questions, so scripts and CI are unaffected.
- **`lethe doctor` reports which config file won.** A global `~/.lethe/config.json` and a
  project `.lethe/config.json` can disagree, and until now nothing could answer "I set
  team scope and it did not take".
- **`lethe doctor` fails when scope and git disagree.** `team` scope decides where claims
  are *written*; `.gitignore` decides who can *read* them. A repo configured for team
  scope with `.lethe/memory/` ignored looks shared and is committed nowhere — which is
  what this repository was doing to its own nine claims. Claims written but never
  committed are reported as a warning rather than a failure.

### Changed

- **`lethe init` and `lethe where` always say where episodes live**, not just claims.
  Listing three scopes implied a memory could be in any of them; only claims move.
- **`lethe init --global` run inside a repo that overrides the global default now says
  so**, and prints the paths that directory will actually use rather than the ones the
  global setting implies.

## [0.0.2] — 2026-08-27

Documentation and CI. No behaviour changes.

### Changed

- **The README is written for people deciding whether to use lethe**, rather than for
  someone maintaining it. It now leads with the problem being solved, covers installing
  into Claude Code, opencode, Cursor, Windsurf, Zed and Codex CLI, and calls out the hook
  step — without which the tool mostly does not get called at all.
- `docs/architecture.md` documents the retrieval layering and records why embeddings were
  rejected, replacing the provider design that was never built.
- `docs/compact.md` documents model-directed grouping and the evidence gate, replacing the
  description of lexical clustering.

### Added

- **CI on every push and pull request**, across Node 22 and 24 — the supported floor plus
  one ahead, since `node:sqlite` is experimental and can move underneath us.
- The published tarball is now checked per commit rather than only at release, so an
  internal file entering the package fails immediately instead of shipping.

## [0.0.1] — 2026-08-27

First published version. Capture, retrieval, consolidation and forgetting all work
end to end; the thesis that consolidated memory beats raw session logs is **not yet
proven** — see [`docs/evals.md`](docs/evals.md).

### Added

- **Three memory kinds.** `episode` (what happened, raw, never shared), `claim` (what is
  true, distilled), `pattern` (how we do things here, promoted on repeated use or
  corroboration). Where a memory lives is decided by what it is, not by who asks.
- **Retrieval over an FTS5 index.** BM25 with inverse document frequency, length
  normalisation and stemming, replacing token-overlap scoring. The index stores ids and
  scores and never content, so it is small (4.1 MB per 10,000 memories) and deleting it is
  always a valid recovery. `node:sqlite` is loaded through a runtime feature check, so an
  older Node falls back to the simpler scorer rather than failing.
- **Pattern completion.** Consolidation marks source episodes cold rather than deleting
  them, and those traces stay searchable. A query phrased the way the original session was
  phrased reaches the claim it became — returned once, as the claim.
- **Model-directed consolidation.** Every unconsolidated episode goes to the distiller at
  once; it decides which are about the same problem and returns one claim per group. There
  is no similarity metric, because a measured one could not tell "same project" from "same
  problem".
- **An evidence gate.** A claim that consumes an episode must keep at least one of its
  retrievable strings — a command, a path, a flag, an assignment. Rejected claims leave
  their episodes live and searchable.
- **Forgetting.** Decay with reinforcement on access, and eviction under a capacity
  budget, cheapest loss first: superseded episodes, then unconsolidated ones, then claims.
  Patterns are never evicted, nor is any trace whose claim has gone.
- **Automatic recall.** A `UserPromptSubmit` hook runs recall before the model sees the
  turn (`lethe hook show`), with an opencode plugin for the same. Measured adoption
  without it was 10% across 79 sessions; strengthened tool descriptions and rules files
  both failed to move it.
- **`lethe metrics`.** Adoption, the recall-to-note balance, and what consolidation has
  actually produced. It says outright when the store is raw and recall is serving session
  transcripts.
- **Reconsolidation.** `correct` supersedes a memory that turned out to be wrong;
  `confirm` strengthens one that proved right.
- **Salience-weighted compaction trigger.** Pressure sums salience rather than counting
  episodes, so a few important notes consolidate sooner than many trivial ones, with a
  24-hour ceiling on how long anything stays raw. Both tunable via `LETHE_PRESSURE` and
  `LETHE_MAX_RAW_HOURS`.

### Known limitations

- **The eval reads as a draw, not a win.** Retrieval over claims scores MRR 0.94 against
  0.93 for the raw episodes they came from. At 18 synthetic tasks that difference is noise.
  What changed is that consolidation used to *lose* (0.86 vs 0.94); real dogfooded task
  pairs are the missing piece.
- **Consolidation mostly compresses rather than generalises.** In practice most claims
  come out one-to-one with their episode, because real notes are about different things.
  Whether "many episodes, one claim" happens at useful rates is unproven.
- **Consolidation needs a model.** MCP sampling is unimplemented by the hosts tested, so it
  falls back to an API key, Ollama, or an installed agent CLI. With none of those, nothing
  is consolidated and episodes stay raw — deliberately, since keeping one episode and
  discarding its siblings is not compression.
- **`team` scope is the least-tested path.** Sharing claims through a repository works but
  real multi-author merge behaviour is unproven.
- **No embeddings, by decision.** There is no embeddings endpoint to ask, and every route
  means running a large inference runtime locally or sending memories to a third party.
  The one place they would earn their cost is grouping episodes; see
  [`docs/architecture.md`](docs/architecture.md).

[Unreleased]: https://github.com/alarv/lethe/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/alarv/lethe/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/alarv/lethe/releases/tag/v0.0.1
