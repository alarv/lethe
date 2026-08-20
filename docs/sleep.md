# `lethe sleep`

The consolidation and decay pass. This is the feature the rest of the system exists to
support.

## What it does

Biological reference: `docs/brain.md` §4 and §5. During rest the hippocampus replays
the day's episodes to cortex, which extracts what is common across them and discards
what was incidental to any one. In the same window, synapses are globally downscaled —
weak traces fall below threshold and vanish. Signal-to-noise improves *because* the
total is cut back.

`lethe sleep` does the same three things, in order:

### 1. Consolidate

Cluster related episodes, distil the invariant into a durable claim, discard the raw
episodes.

```
episodic:
  "spent 40min on failing auth test, token was expiring"
  "auth test flaky again, clock skew in CI"
  "fixed CI auth flake by freezing the clock in test setup"
                              │
                              ▼
semantic:
  claim: "auth tests are clock-sensitive; freeze the clock in test setup.
          CI failures here are usually skew, not logic."
  provenance: [ep_1a2, ep_1b7, ep_1c3]
  confidence: 0.8
```

Three episodes become one claim, and the episodes are deleted. The `provenance` field
keeps the audit trail even though the source rows are gone — every claim can be traced
to what produced it.

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

Access reinforces (`lethe_recall` bumps `strength` and `last_accessed`; `lethe_confirm`
bumps harder). Memories below threshold go **cold** — they stop surfacing in retrieval
but are not destroyed. Only under capacity pressure are cold memories purged, oldest and
weakest first.

Two tiers, not one, for the reason in `docs/brain.md` §7: some biological forgetting is
retrieval failure rather than erasure, and more practically, **nobody will trust a tool
that hard-deletes their notes.** Cold storage gives us aggressive forgetting with an
undo.

## Usage

```sh
lethe sleep                # consolidate + promote + decay
lethe sleep --dry-run      # print the diff, change nothing
lethe sleep --deep         # also purge cold memories under capacity pressure
lethe sleep --scope=personal
```

## Triggers

| Trigger | When | Default |
|---|---|---|
| Manual | `lethe sleep` | — |
| Session end | The harness signals a session closed | on |
| Idle | No activity for `n` minutes | on |
| Scheduled | Cron / CI maintenance window | opt-in |

Never on the user's latency path. Consolidation is allowed to be slow, exactly as sleep
is allowed to take hours.

## The maintenance window: sleep as a pull request

Because memory is markdown in git (`docs/architecture.md` § Storage), a scheduled
`sleep` on project scope can open a PR:

```yaml
# .github/workflows/lethe-sleep.yml
on:
  schedule:
    - cron: "0 3 * * *"      # nightly, 03:00
jobs:
  sleep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx lethe sleep --scope=project
      - uses: peter-evans/create-pull-request@v6
        with:
          title: "lethe: nightly consolidation"
          branch: lethe/sleep
```

The resulting diff is legible:

```diff
- ## auth test flaky in CI
- Spent 40min. Token expiring mid-run. Third time this month.
-
- ## auth test failed again
- Clock skew? CI box is ahead.
-
+ ## Auth tests are clock-sensitive
+ Freeze the clock in test setup. CI failures in auth tests are usually
+ skew rather than logic.
+
+ confidence: 0.8
+ provenance: ep_1a2, ep_1b7, ep_1c3
```

**The team reviews what the brain learned before it becomes shared knowledge.** Wrong
consolidations are caught by the same mechanism that catches wrong code, by people who
already have the habit.

This is only possible because the source of truth is text. It is the strongest argument
for that decision.

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
