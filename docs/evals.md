# Evaluation

The claim is that an agent with Lethe gets to the right answer with less context and
fewer wasted steps. That is measurable, and if it is not true the project should stop.

This document defines what we measure and how, before there is anything to measure —
deliberately, so the metrics are not chosen after seeing which ones flatter us.

## The claim, stated so it can fail

> Given a task whose answer was discovered in an earlier session, an agent with
> compacted memory reaches a correct result in **fewer turns and fewer context tokens**
> than the same agent with no memory or with raw session logs.

Falsifiable three ways: the turns do not drop; the token cost of retrieval exceeds what
it saves; or compaction loses the detail that made the memory useful, so distilled
memory loses to raw logs.

## Conditions

Every task runs under four conditions, same model, same seed, same repo state:

| Condition | Memory available |
|---|---|
| `cold` | None. The baseline every agent starts from today. |
| `raw` | Every episode from the earlier session, retrieved by search. |
| `compact` | Episodes distilled into claims by `lethe compact`. **The bet.** |
| `oracle` | The one relevant memory, hand-written, injected directly. The ceiling. |

`raw` is the honest competitor — it is what every existing memory tool does. Beating
`cold` proves nothing; **beating `raw` is the entire thesis.** `oracle` bounds how much
of the remaining gap is retrieval quality versus the memory itself.

## Metrics

**Primary — turns to correct.** Number of agent turns before the task is solved. This
is what a developer feels. Report the median and the distribution, not the mean; a few
catastrophic runs matter more than the average suggests.

**Primary — context tokens consumed.** Total tokens across the episode. Retrieval is not
free: memory injected is context spent, and a system that saves two turns while adding
4k tokens of recalled noise has not helped.

**Secondary — rediscovery rate.** Fraction of tasks where the agent re-derives something
already in memory. This isolates *retrieval* failure from *memory* failure: if
rediscovery is high while `oracle` wins comfortably, the store is fine and search is
broken.

**Secondary — success rate.** Tasks solved at all. Guards against a system that is fast
because it confidently does the wrong thing.

**Health — compaction ratio.** Episodes in, claims out, and bytes before versus after.
If this trends toward 1.0 we are not compacting, just relabelling.

**Health — staleness.** Fraction of retrieved memories that are wrong or superseded.
Rises over time, and is what `lethe_correct` exists to hold down. A memory system that
gets *worse* the longer you use it is worse than none.

## Tasks

Each task is a pair: a **seed session** that discovers something, and a **probe
session**, in a fresh context, that needs it.

```
seed  : "the tests won't run"        → discovers the missing container
probe : "CI is failing on the auth   → needs: run docker compose up first
         suite, sort it out"
```

The probe must not be a paraphrase of the seed. Real value comes from a memory
surfacing for a task that *looks* different, which also means keyword retrieval should
fail these and semantic retrieval should not — a useful diagnostic on its own.

Target 30–50 pairs, drawn from real sessions captured while dogfooding rather than
invented. Invented tasks encode our assumptions about what memory is for, which is
precisely what we are trying to test.

**Harvesting them.** A recall query paired with a memory that was later confirmed useful
is exactly a (probe, seed) pair, discovered instead of invented. `lethe eval candidates`
mines the activity log for that pairing and appends new ones to `evals/candidates.jsonl`,
idempotently — rerunning it only reports what's new. It undercounts the way every
log-derived metric here does, since confirm has to be called by the model, so treat it as
a trickle to review by hand, not a pipeline that feeds the eval unsupervised: promote the
good ones into `tasks.jsonl` and `fixtures.json` yourself.

Categories worth covering separately, because they may behave differently:

- **environment traps** — setup, tooling, "you must run X first"
- **decisions** — what was chosen and why, including rejected options
- **conventions** — how this codebase does a thing
- **debugging lessons** — a symptom and its non-obvious cause
- **dead ends** — approaches already tried that do not work

## Method

1. Capture real sessions by dogfooding. This is why capture shipped before retrieval.
2. Label the pairs by hand. Slow, and the reason this stays small.
3. Run each task under all four conditions, `n ≥ 5` per cell — agents are
   nondeterministic and single runs will lie.
4. Grade by assertion where possible (did it run the right command, edit the right
   file), not by asking a model whether the answer was good. LLM-as-judge only for
   free-text, and never as the headline number.
5. Report every condition including the ones we lose.

## Publishing

The table is the marketing, so it has to be honest enough to survive someone rerunning
it. Publish the tasks, the harness, the raw runs, and the model and date — results will
not reproduce across model versions, and pretending otherwise is how benchmarks lose
credibility.

Report where we lose. A memory system that helps on environment traps and does nothing
for architectural decisions is a useful finding and a more believable claim than a clean
sweep.

## Anti-goals

**No aggregate score.** One number invites tuning to it and hides where the system
fails.

**No comparison against other tools in v1.** Fair comparison needs equal effort tuning
each, which we cannot honestly claim. Compare Lethe against Lethe's own ablations first;
`compact` versus `raw` is the interesting question anyway, and `raw` is a faithful stand
in for what everyone else does.

**Do not tune on the eval set.** Hold out at least a third from the start and do not
look at it until the design is frozen.

## Status

Built, at `evals/run.ts`. `npm run eval` measures retrieval quality only — it does not run
agents, so it does not yet measure the primary metrics above (turns to correct, context
tokens). It measures the layer underneath them: if retrieval over distilled claims cannot
beat retrieval over the episodes they came from, nothing downstream can.

The 18 tasks are synthetic, which is the largest caveat on everything below. Real
dogfooded pairs remain the goal.

## Results

Run under both retrieval mechanisms, because three changes to retrieval landed in
sequence and a single table cannot say which one moved the numbers.

| mechanism | raw MRR | compact MRR | compact hit@1 | cost-to-answer delta |
|---|---|---|---|---|
| `naive` — token overlap, substring matching | 0.94 | 0.86 | 78% | +190 chars |
| `fts5` — BM25, IDF, length normalisation, porter | 0.93 | 0.94 | 89% | +89 chars |

**What changed.** Under the naive scorer, compaction lost by 0.08 MRR and the harness
printed "the thesis failing, not a tuning problem". Under BM25 that loss is gone.

**What that is not.** It is not a win. At 18 tasks a 0.02 MRR difference is noise, and the
honest reading is a draw rather than a victory. What moved is real, though: the *loss*
disappeared, and `hit@1` for compact rose 11 points.

The diagnosis behind it holds up. Part of raw's original 0.94 was the scorer's own
weakness flattering longer documents — no IDF, no length normalisation, and substring
matching, so an episode accumulated relevance by being long. Fixing the ranking removed an
advantage that was never about the memories.

On the `hard` subset — queries deliberately worded unlike what was recorded — compact
reaches 0.92 against raw's 0.89, which is the direction the thesis predicts: distilled
memory should help most where wording differs.

**Still losing on cost.** Compact takes more context to reach an answer, because a claim
body is fuller than the single episode that would have answered. Halved by better ranking,
not eliminated.

### Precision, and questions with no answer (2026-09-29)

hit@k and MRR only ask whether the answer appeared. Real recalls showed the failure they
cannot see: every one came back with exactly 8 hits, and one memory was in all 8 whatever
the topic. So the eval now has six **no-answer tasks** (`difficulty: "negative"`) — questions
that share an everyday word with the store and have no answer in it — and two columns:
**precision** (of what came back for answerable tasks, the share from the right scenario)
and **off-topic** (share of no-answer tasks that returned anything). The no-answer tasks
are excluded from hit@k and MRR, so the earlier rows did not move.

A third mechanism, `recall`, is what the recall tool returns: fts5 plus a relevance floor
(the prompt hook's rule — two content terms from the question, or one rare term), applied
to every hit but the first.

| mechanism, compact | MRR | precision | off-topic |
|---|---|---|---|
| `fts5` | 0.94 | 42% | 100% |
| floor on every hit (rejected) | 0.78 | 77% | 50% |
| `recall` — floor on all but the top hit | 0.89 | 75% | 100% |

**The trade, stated.** The floor buys 33 points of precision for 0.05 MRR: two paraphrased
questions whose answer sat at rank 2 sharing one ordinary word. Flooring the top hit too
was worse — it dropped rank-1 answers for the same reason. A paraphrase and an unrelated
memory can each share exactly one word with a question, and no lexical rule separates
them. Off-topic stays at 100%: recall still always answers. That is the ceiling of
keyword retrieval, not a tuning problem.

On the real store the floor alone did little (mean hits 8.0 -> 7.5): real questions are
long and one project's memories share a vocabulary, so two common terms are easy to match.
Most of the real noise came from reinforcement instead — every recall strengthened every
hit it returned, and strength multiplies rank, so a memory ranked because it had ranked
before. Recall now reinforces weakly and ranking counts strength only up to 1; together
the memory that was in 8 of 8 real recalls is in 3 of 8. The eval cannot see that change —
its fixtures all have default strength — which is a gap worth closing.
