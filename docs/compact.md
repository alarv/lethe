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
lethe compact --scope=personal
lethe compact --extractive   # no model call; cluster and pick, do not rewrite

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
| **Extractive** | Nobody — clustering only | No | Yes |

**In-session is the default and the one to get right.** MCP has a `sampling` capability:
the server asks the *client* for a completion, so consolidation runs on whatever model
the user is already paying for. No key ever touches Lethe, nothing leaves the machine
that was not already going to the user's provider, and there is no separate cost.

The catch is that sampling support across MCP clients is inconsistent. So the server
must degrade: if the host does not offer sampling, fall back to a configured provider,
and if there is none, fall back to `--extractive`.

**Extractive mode** does no rewriting at all. It clusters related episodes, picks the
most representative one, keeps it verbatim, and discards the others. Worse claims than a
model would write, but free, deterministic, offline, and it runs anywhere. Whether the
quality gap justifies the model is exactly what the eval measures — see
`docs/architecture.md` § Open questions.

## The maintenance window: compaction as a pull request

Because project memory is markdown in git, a scheduled compaction can open a PR the team
reviews before anything becomes shared knowledge.

**This path requires an API key in repo secrets**, which conflicts with the local-first
default. It is therefore opt-in and explicitly not the recommended starting point — or
it can be run with `--extractive`, which needs no key at all but produces blunter claims.

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
      - run: npx @alarv/lethe compact --scope=project
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
   and in project scope git history is the undo. In personal scope, consolidated
   episodes go to cold storage before deletion.
3. **Conservative when uncertain.** A wrong claim stated confidently is worse than no
   claim. Below a confidence threshold, leave the episodes alone and try again next
   cycle with more evidence.

## Status

Built: clustering, distillation (via host sampling, with extractive fallback),
promotion, decay, cold purge, and the pressure trigger.

Not built: embeddings-based clustering, and any evidence that the model path beats
the extractive one. That comparison is `docs/evals.md`.

## Open questions

- **Does step 1 need an LLM?** It is the only part of Lethe that would. Extractive
  approaches (cluster, pick the most central episode, keep it verbatim) are free,
  deterministic, and offline — but produce worse claims. The eval measures the gap and
  decides whether the cost is earned.
- **Clustering method.** Embedding similarity is the obvious start. Whether to also
  cluster on shared `files[]` and `entities[]` is untested.
- **Decay rate and thresholds.** Guessed initially, tuned by the eval. Too aggressive
  loses real knowledge; too slow and we are just another store that grows forever.
- **Conflict handling.** When a new claim contradicts an existing one, is that a
  supersede, or two claims with different scopes? Probably needs the agent, via
  `lethe_correct`.
