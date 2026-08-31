# `lethe compact`

The consolidation and decay pass. This is the feature the rest of the system exists to
support.

Named for what developers already know it as — log compaction, LSM compaction, database
vacuum: merging many records into fewer. Internally, and in `docs/brain.md`, the same
process is called **sleep**, because that is when brains do it. `lethe sleep` is kept as
an alias, but `compact` is the documented command: it tells you what happens without
requiring you to have read any neuroscience.

## What it does

Biological reference: `docs/brain.md` §4 and §5. During rest the hippocampus replays
the day's episodes to cortex, which extracts what is common across them and discards
what was incidental to any one. In the same window, synapses are globally downscaled —
weak traces fall below threshold and vanish. Signal-to-noise improves *because* the
total is cut back.

`lethe compact` does the same three things, in order:

Consolidation is also the moment a memory becomes shareable: episodes are always
private, and the claim distilled from them is what reaches the team (see
`docs/architecture.md` § Storage).

### 1. Consolidate

Cluster related episodes, distil the invariant into a durable claim, discard the raw
episodes.

```
episodic:
  "tests failed — 14 errors, all connection refused"
  "checked the test DB config, looked fine"
  "tried resetting the test database, still refused"
  "postgres container wasn't running; docker compose up fixed it"
                              │
                              ▼
semantic:
  claim: "Tests need `docker compose up` first. Connection-refused
          failures are almost always the missing container, not the
          test code."
  provenance: [ep_1a2, ep_1b7, ep_1c3, ep_1d9]
  confidence: 0.8
```

Four episodes become one claim, and the episodes are deleted. The `provenance` field
keeps the audit trail even though the source rows are gone — every claim can be traced
to what produced it.

Consumed episodes are marked superseded rather than deleted. A claim is a lossy
summary -- it keeps the lesson and drops the exact command, path or error string
that often made the episode worth having -- so the sources stay on disk, out of
recall but resolvable by id. A consolidation that turns out to be too vague is
recoverable, and a mistaken one is no longer destructive.

Only episodes above the salience threshold are considered (`docs/architecture.md` §
Salience). Most of the buffer is never consolidated and is simply dropped, which is the
intended behaviour, not a failure.

**Existing claims go in too, and may be revised.** For a long time this step ran blind: it
saw only unconsolidated episodes, so a lesson learned in two sessions weeks apart was
written twice and nothing could notice. Measured in lethe's own store — "Compaction
silently fails when the distiller is unavailable" and "All lethe.log errors are `distil
failed: no model`" are one lesson, recorded 28 hours apart from different episodes, both
live.

So live claims are listed alongside the episodes as `C1`, `C2`, …, and a claim may carry a
`supersedes:` line naming the ones it replaces:

```
CLAIM
supersedes: C1
sources: 3
title: ...
END
```

Four rules keep that from becoming churn:

1. **A revision needs new evidence.** At least one episode in `sources`, always. A rewrite
   with nothing behind it is churn, and the evidence gate would have nothing to check.
2. **The evidence gate applies to the replaced claim too.** Supersede a claim and you must
   keep at least one of its retrievable strings — the same rule as for episodes, one level
   up. Otherwise "revising" is how a claim's commands quietly disappear.
3. **A claim is replaced at most once per run.** Two revisions of one claim would leave the
   loser pointing at a memory that is already cold.
4. **Patterns are not offered.** They are the promoted survivors; letting an automatic pass
   demote one is a bigger decision than this step should make. `lethe_correct` still
   reaches them.

A replaced claim goes cold on exactly the same terms as an episode: the file stays, its id
keeps resolving forward, and the old wording remains a route to the new claim.

Detecting duplicates lexically is not an option, for the reason recorded in § Grouping is
the model's job: on a single-project store, unrelated pairs score higher than genuinely
related ones. The judgement is semantic, so it belongs to the model — and the mechanical
gate still sits behind it.

### 2. Promote

Scan for shapes that have recurred `n` times and promote them to `procedural`. A single
occurrence is an episode; the same thing five times is how we do things here.

### 3. Decay

Global downscaling across `semantic` and `procedural`:

```sql
UPDATE memories SET strength = strength * :decay_rate;
```

Access reinforces (`recall` bumps `strength` and `last_accessed`; `confirm`
bumps harder). Memories below threshold go **cold** — they stop surfacing in retrieval
but are not destroyed. Only under capacity pressure are cold memories purged, oldest and
weakest first.

Two tiers, not one, for the reason in `docs/brain.md` §7: some biological forgetting is
retrieval failure rather than erasure, and more practically, **nobody will trust a tool
that hard-deletes their notes.** Cold storage gives us aggressive forgetting with an
undo.

## Usage

```sh
lethe compact                # consolidate + promote + decay
lethe compact --dry-run      # print the diff, change nothing
lethe compact --deep         # also purge cold memories under capacity pressure

lethe sleep                  # alias for `lethe compact`
```

## When it runs

A nightly cron was the obvious answer and it is the wrong one: it needs a key in CI,
which contradicts local-first, and it fires whether or not there is anything to do.

**Compaction triggers on pressure, not on a clock.** When the episodic buffer crosses a
threshold, the next tool call runs it. This is how LSM compaction already works — you do
not compact a database at 3am, you compact it when level 0 has too many files.

It is also what the biology does. Sleep is not scheduled; **sleep pressure accumulates
while you are awake** (adenosine builds, the homeostatic Process S rises) and discharges
when it gets high enough. A long day means earlier, deeper sleep. A long session means
earlier, heavier compaction.

```
episode written ──► pressure += salience
                         │
                    pressure > threshold?
                         │ yes
                         ▼
              next tool call runs compaction
              (the session is live, so the
               host's model is reachable)
```

| Trigger | Fires when | Default |
|---|---|---|
| **Pressure** | Episodic buffer crosses the threshold | on |
| Idle | No tool call for *n* minutes and pressure is non-zero | on |
| Session end | The transport closes | best effort |
| Manual | `lethe compact` | — |
| Scheduled | Cron or CI | opt-in, needs a key |

Pressure is the primary trigger. Idle is the mop-up for sessions that write a lot and
then go quiet. Session end is best-effort only — the connection is closing, so there may
be no model to reach; anything not compacted stays in the buffer and is picked up by the
next session, which is the correct failure mode.

**This resolves the token problem.** Compaction happens inside a live session, so it
uses the model the user is already talking to, via MCP sampling. No key, no cron, no
extra cost, and no configuration. The scheduled path remains for teams that want a
reviewable nightly PR, but it is an option rather than the mechanism.

## Who actually runs the model

Consolidation needs judgement, which means a model. **Trigger and execution are separate
concerns**, and conflating them is the easiest way to design something that cannot run.
Four paths, with honest tradeoffs:

| Path | Model provided by | Needs a key | Runs in CI |
|---|---|---|---|
| **In-session (MCP sampling)** | The user's own agent, via the host | No | No |
| **Local CLI** | A provider the user configured, or a local model | Yes | No |
| **CI** | An API called from the workflow | Yes, repo secret | Yes |
| **None available** | Nobody | No | — |

**In-session is the default and the one to get right.** MCP has a `sampling` capability:
the server asks the *client* for a completion, so consolidation runs on whatever model
the user is already paying for. No key ever touches Lethe, nothing leaves the machine
that was not already going to the user's provider, and there is no separate cost.

The catch is that sampling support across MCP clients is inconsistent — in practice none
of the hosts tested implement it. So the server degrades: host sampling, then a
configured API key, then Ollama, then an agent CLI already installed and authenticated
(`opencode`, `claude`). If none is available, **nothing is consolidated**. Episodes are
kept intact and wait for a session that can distil them.

That last point is deliberate. There is no extractive fallback that keeps the most
representative episode and discards its siblings: that is not compression, it is losing
eleven memories to keep one. A store that cannot consolidate should stay raw and
searchable rather than be quietly thinned.

## The maintenance window: compaction as a pull request

Because project memory is markdown in git, a scheduled compaction can open a PR the team
reviews before anything becomes shared knowledge.

**This path requires an API key in repo secrets**, which conflicts with the local-first
default. It is therefore opt-in and explicitly not the recommended starting point — or
it simply does not run, and the episodes wait for a session that has a model.

```yaml
# .github/workflows/lethe-compact.yml
on:
  schedule:
    - cron: "0 3 * * *"
jobs:
  compact:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx @alarv/lethe compact
        env:
          LETHE_API_KEY: ${{ secrets.LETHE_API_KEY }}
      - uses: peter-evans/create-pull-request@v6
        with:
          title: "lethe: nightly consolidation"
          branch: lethe/compact
```

The resulting diff is legible:

```diff
- ## tests failed, connection refused
- 14 errors. Checked the test DB config, looked fine.
-
- ## still refused after resetting the test database
-
- ## postgres container wasn't running, docker compose up fixed it
-
+ ## Tests need `docker compose up` first
+ "Connection refused" is almost always the missing container,
+ not the test code.
+
+ confidence: 0.8
+ provenance: ep_1a2, ep_1b7, ep_1c3, ep_1d9
```

Wrong consolidations get caught by the mechanism that already catches wrong code, by
people who already have the habit. This is only possible because the source of truth is
text, and it is the strongest argument for that decision.

## Constraints

Consolidation rewrites people's memories. That makes it the highest-risk operation in
the system, so it is bound by three rules:

1. **Inspectable.** `--dry-run` must show exactly what would change, and the committed
   artifact must be a readable diff. No opaque rewrites.
2. **Reversible.** Consolidation deletes episodes, so the claim must carry `provenance`,
   and where the claims are committed git history is the undo. Where they are not,
   consolidated episodes go to cold storage before deletion.
3. **Conservative when uncertain.** A wrong claim stated confidently is worse than no
   claim. Below a confidence threshold, leave the episodes alone and try again next
   cycle with more evidence.

## Grouping is the model's job, not a metric's

Consolidation used to group episodes by Jaccard word overlap and distil each group. That
does not work, and the reason is measured rather than theoretical: on a single-project
store every note shares vocabulary, so "about the same project" and "about the same
problem" score alike. Over 13 hand-labelled pairs the best achievable accuracy was 77%
for Jaccard and 85% for TF-IDF cosine — and the unrelated pairs scored *higher* than most
genuinely related ones, so no threshold separates them. In practice it fused five
unrelated notes into one claim and would have silently dropped four of them.

So the distiller now receives every unconsolidated episode at once, numbered, and returns
however many claims it finds, citing which episodes each came from. There is no
similarity metric, no threshold and no cluster cap. A lone episode becoming a claim is
the model's judgement rather than a counter crossing a line.

Replay is capped and ordered by salience, which is what selective replay means (§4 of
`docs/brain.md`): a store that went months without a distiller could hold hundreds of
episodes, and the most significant ones should be replayed first.

### The evidence gate

A model asked to compress will sometimes absorb an episode and keep nothing from it. That
is the failure the five-way fusion produced, and it is checked mechanically rather than
trusted: **consume an episode and the claim must retain at least one of its retrievable
strings** — a command, a path, a flag, an environment assignment.

Not *every* string. That rule forbids compression outright, since a 2 KB episode citing
eight files cannot become three lines and keep all eight. A rejected claim leaves its
episodes live and searchable, and the next pass retries. Rejections are logged with what
each orphaned source lost, because a silent rejection is indistinguishable from
consolidation being broken.

## Status

Built: model-directed grouping, distillation, the evidence gate, promotion, decay,
eviction under capacity pressure, and the salience-weighted trigger.

Not built: any evidence that consolidated memory beats raw episodes on real tasks. The
retrieval eval currently reads as a draw on synthetic ones, which is not a win. That
comparison is `docs/evals.md`.

## Open questions

- **Does grouping need an LLM?** Currently yes, and lexical alternatives were measured
  and rejected above. Embeddings for grouping alone remain the honest fallback if the
  model proves unreliable — that is the one place they would earn their cost.
- **Thresholds.** Pressure fires at 6 summed salience, and nothing stays raw beyond 24
  hours. Both are guesses, both are overridable (`LETHE_PRESSURE`,
  `LETHE_MAX_RAW_HOURS`), and the eval should replace them with numbers.
- **Decay rate and thresholds.** Guessed initially, tuned by the eval. Too aggressive
  loses real knowledge; too slow and we are just another store that grows forever.
- **Conflict handling.** Consolidation can now revise a claim it recognises as the same
  lesson, which covers duplication. Contradiction is still open: when a new claim
  *disagrees* with an existing one, is that a supersede, or two claims that are both true
  in different circumstances? The model is only asked about sameness, not truth.
- **Duplicates outside the window.** Only the most salient `MAX_REVISABLE` claims are
  offered for revision, so a duplicate pair that both rank low waits for a run where one
  of them matters more. That is a slower merge, not a lost one, but nothing measures how
  slow.
- **Pure merges.** Two existing claims that duplicate each other cannot be merged without
  a fresh episode to hang the revision on. Deliberate — it keeps the evidence gate
  meaningful — but it means an idle store never tidies itself.
