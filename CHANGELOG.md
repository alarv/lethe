# Changelog

Written by hand, not generated. The value of a change here is usually *why* it was made
and what failure it fixes, and no tool derives that from a diff.

Kept in the format of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
follow [semver](https://semver.org/), with the caveat that 0.x means the tool surface may
still move.

The release workflow refuses to publish a version with no section here.

## [Unreleased]

### Added

- **`lethe gc`** — what is in `~/.lethe`, how big each part is, and what is dead in it.
  `--dry-run` says what would go, `--dead` also removes directories whose project is gone,
  `--reindex` throws the index away (it rebuilds on the next recall, and is the escape
  hatch if a filesystem with coarse timestamps ever hides an edit from the mtime check).
- **`lethe init --debug` / `--no-debug`** to turn the log on and off, and a `home` row in
  `lethe doctor` reporting the directory's size, its live project count, and anything
  keyed to a path that has disappeared.
- **`lethe init` asks one question**: should this project's consolidated claims be
  committed, or git-ignored? Two options instead of four across three scope words, and
  both write to the same directory. `--share` and `--private` skip the question;
  `--global --share` sets the answer new projects start from, and is the only setting
  left (`~/.lethe/config.json`, `{ "share": bool }`, read by `init` alone).
- **`lethe doctor` prints both derived paths** — claims and episodes — instead of a scope
  and a list of config files that could contradict each other.

### Changed

- **Consolidation can revise an existing claim instead of writing a second one beside
  it.** It used to see only unconsolidated episodes, so a lesson learned in two sessions
  weeks apart was stored twice and nothing could ever notice. lethe's own store had the
  pair: "Compaction silently fails when the distiller is unavailable" and "All lethe.log
  errors are `distil failed: no model`" — one lesson, recorded 28 hours apart from
  different episodes, both live.

  Live claims are now listed for the distiller as `C1`, `C2`, … and a claim may carry a
  `supersedes:` line. Four rules keep it from becoming churn: a revision needs at least one
  new episode; the evidence gate applies to the claim being replaced as well, so revising
  cannot quietly drop its commands; a claim is replaced at most once per run; and patterns
  are never offered, being the promoted survivors. A replaced claim goes cold on the same
  terms as an episode — the file stays, so a bad revision is recoverable and the old
  wording remains a route to the new claim.

  Detecting duplicates lexically was not an option: `consolidate.ts` already records that
  measurement — 13 hand-labelled pairs, Jaccard 77%, TF-IDF cosine 85%, and unrelated pairs
  scoring *higher* than genuinely related ones. The judgement is semantic.

- **Scopes are gone. Where a memory goes is derived from what it is.** Claims and
  patterns are written to `<repo>/.lethe/memory/`, beside the code they describe;
  episodes to `~/.lethe/projects/<key>/`, never into a repository. Outside a git repo,
  claims fall back to the episode directory. Nothing to pass, nothing to configure.

  There were three scopes, and one word was being asked to answer two questions at once
  — *where do the bytes live* and *who can read them*. `local` and `personal` differed
  only in reach, which neither word said; the author could not reliably predict where his
  own tool would write. Worse, `team` asserted sharing that a `.gitignore` line could
  silently revoke, so the store could sit in a repo looking shared and be committed
  nowhere — which is what this repository was doing to its own nine claims.

  Renaming the three would have kept the defect. The two questions are now answered in
  two places that cannot disagree: the kind decides the path, and `.lethe/.gitignore`
  decides who reads it.

  Nothing needs migrating. Scope was never stored in a memory's frontmatter — it was
  always inferred from the directory — so existing files are read exactly as before, and
  claims already sitting in `~/.lethe` stay findable.
- **Claims live in the repository whether or not they are committed**, so changing your
  mind about sharing moves no files: it flips two lines in `.lethe/.gitignore`. The
  previous design put private claims in `~/.lethe` instead, which meant switching cost a
  file-by-file relocation and a chance to lose them.
- **`lethe doctor` no longer fails on git-ignored claims.** That state used to be a
  contradiction (`team` scope with the claims ignored); it is now simply what
  `lethe init --private` asks for. The one state left worth flagging is claims that are
  neither ignored nor committed — sharing is on and nobody ran `git add` — reported as a
  warning.
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

  The file itself is always committed, even when the memories are not. Having private mode
  ignore it too leaves a perfectly clean `git status` and was briefly implemented that
  way; it is unsafe, because untracking an already-tracked file is a change other people
  receive. A teammate's `git pull` deletes their copy, the rules vanish from their working
  tree, and *their* private memories stop being ignored. A local checkout spanning the
  untracking commit does the same thing, which is how it was caught — in this repository,
  with eleven claims briefly unignored. One committed file saying "ignore everything here"
  is a fair price.
- **`lethe init` and `lethe where` always say where episodes live**, not just claims.
  Listing candidate locations implied a memory could be in any of them, which was never
  true: the kind decides.
- **The derived SQLite index changed shape** (schema 2 → 4): the `scope` column is gone,
  and each row now carries the path, mtime and size of the file behind it. Existing
  `index.db` files rebuild themselves on next use, as they do for any schema change — the
  markdown is the source of truth and the index holds nothing that is not in it.
- **Recall no longer reads the whole store.** It used to parse every memory in every
  project on every query, to hand the index a corpus to fingerprint — so the cost of a
  recall, and of a `note` (which invalidated that fingerprint and forced a full rebuild),
  scaled with everything you had ever written. Measured across 36 projects holding 36,000
  memories: **4.4 seconds per recall, 4.8 for a note followed by one.**

  The unit of change is now a file. Enumeration stats instead of reading; anything whose
  path, mtime and size are unchanged is skipped; only new or modified files are parsed and
  reindexed; anything no longer listed is deleted, which is also how the index prunes
  itself. Then only the hits are read off disk, plus the successors of any that were
  superseded — bounded by the number of results, not by the size of the store.

  Same corpus, same query: **373 ms warm, 574 ms after a note.** At 9,000 memories,
  53 ms. First build after upgrading is slower than the old rebuild (7.8 s at 36,000,
  two new indexes) but happens once per index file rather than once per note.

  mtime is trusted because every write goes through a temp file and a rename, which always
  moves it forward, and size is carried too so an edit inside the same millisecond is still
  seen. Ranking is untouched: the pool handed to bm25 and every multiplier the ranker
  applies are the same, so this is a pure cost change and an eval can still attribute
  anything else.
- **The log is off unless you ask for it.** `lethe init --debug` turns it on for this
  machine, `LETHE_DEBUG=1` for a single run. Appending forever to a file in someone's home
  directory is not a diagnostic — nothing rotated it, nothing capped it, and nobody asked
  for it. When it is on it now rotates at 512 KB and keeps one previous copy; `lethe log`
  and `lethe metrics` read across the rotation so a rename does not look like history
  being thrown away.

  Everything derived from the log — `lethe metrics`, and the activity rows in `status` and
  `doctor` — reports that logging is off rather than reporting zero notes and zero
  recalls. "Nothing happened" and "nothing was written down" are different answers, and
  only one of them is a problem worth sending someone to investigate.
- **`~/.lethe` is collected as compaction passes.** Project directories left behind by
  repositories that no longer exist were never removed: eighteen on the author's machine,
  ten of them `/private/var/folders/.../tmp-xxxx` leftovers from test runs. Directories
  holding **no** memories are now swept during `compact()`, which is already triggered by
  use, already off the latency path, and already the pass that decides what does not
  deserve to survive.

  Directories that still hold memories are never removed automatically, however dead their
  path looks. A source path missing today is as likely to be an unmounted volume, a moved
  checkout or another machine as a deleted repository, and losing memories to a filesystem
  inference is a far worse failure than keeping a stale folder. `lethe doctor` and
  `lethe gc` name them and stop.

### Removed

- **`--scope`, `LETHE_SCOPE`, and `<repo>/.lethe/config.json`.** A project's sharing
  decision is recorded in its `.lethe/.gitignore`, the file git actually reads, so a
  setting that duplicated it could only ever disagree with it. `lethe doctor` names any
  config file still setting `scope` rather than ignoring it in silence — that silence is
  the failure the setting itself used to cause.
- **The `scope` parameter on the `note` MCP tool.** Agents had to understand three words
  to write one memory, and got it wrong. Nothing chooses now.
- **Cross-project (`personal`) scope.** It was largely redundant with a retrieval feature
  that already shipped: recall tops up from neighbouring project stores at a discount, so
  something learned in one repo already surfaces in another. Claims already in
  `~/.lethe/memory/` are still read so they are not orphaned, and `lethe where` shows the
  directory while it has anything in it.

### Fixed

- **An id now resolves to the memory it currently means.** `store.get` returned the direct
  match, so an id whose memory had been superseded resolved to the cold copy — an agent
  that recalled a claim and then had it revised would `confirm` a dead memory, or `correct`
  it and fork the chain. It now walks supersession forward. `forget` deliberately does not:
  asked to delete a memory, deleting its replacement instead is the worst available reading
  of the request.
- **Retrieval follows a chain of supersessions, not one hop.** `rank` resolved a hit
  forward exactly once, which was enough while only episodes were ever superseded. Once a
  claim can be revised, an episode → claim → revised-claim chain landed on the cold middle
  and the episode's route to the live claim was dropped entirely — silently losing the
  pattern completion that consolidation depends on. Cycles terminate rather than hang.

- **`lethe init` no longer writes a `.gitignore` line for `.lethe/episodes/`.** That
  directory has never existed — episodes live in `~/.lethe/projects/<key>/` — so the line
  protected nothing while telling the reader, under the heading "private working memory,
  never shared", that their raw session notes were sitting in the repository waiting to
  be committed.
- **`store.all()` no longer returns every memory twice outside a git repository**, where
  claims and episodes share one directory. The paths are deduplicated before reading,
  which would otherwise have doubled every count in `lethe status` and the pressure
  calculation that triggers compaction.

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
