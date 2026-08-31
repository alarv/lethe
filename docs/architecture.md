# Architecture

## The thesis in one paragraph

Agent memory tools are append-only note stores with a search box. They grow forever,
they never revise, and they never forget. Lethe treats memory as a **fixed-capacity
system under pressure**: episodes are written cheaply, a deferred pass distils what is
invariant across them and discards the rest, unused memories decay, and retrieval is a
read-modify-write so wrong memories get corrected instead of haunting the index
forever.

## "Is this just RAG?" — yes, and that's fine

RAG is not a technology, it is a two-word description of a pattern: *retrieve
something, put it in the prompt, generate*. **Any memory system is RAG by
definition.** The moment you look something up and inject it into context, that's it.
So the question is never "is this RAG" — it is **what are you retrieving over**.

Most tools do RAG over raw material: human-written notes, or raw chat logs. Lethe does
RAG over **distilled claims**.

That is the whole bet. If consolidation works, the index is an order of magnitude
smaller and every row is high-signal — so retrieval gets *easier*, and even mediocre
retrieval performs well. The alternative approach is to win by searching a haystack
better. We are trying to not have a haystack.

This is also why the first thing we build is the eval in `evals/`. It compares exactly
those two conditions. If retrieval over distilled memory does not beat retrieval over
raw logs, the project has no reason to exist, and we learn that in week one rather
than month six.

## The three stores

Mapped from `docs/brain.md` §1. Not identical to biology — biology also has priming
and conditioning, which have no engineering payoff, so we drop them.

### `episodic` — what happened
Fast, cheap, append-only. Hot buffer. **Expected to be deleted.**

```
id, ts, session_id, kind, summary, detail,
files[], entities[], outcome, salience
```

Written during a session with near-zero ceremony. This is the hippocampal buffer: not
the durable record, but raw material for consolidation. Most rows here will never be
read by a human and will be destroyed within days. Because it is disposable and never
shared, it lives only in the local index — it is never committed.

### `semantic` — what is true
Slow, curated, small. The store retrieval mostly hits.

```
id, claim, confidence, provenance[], superseded_by,
created, last_accessed, access_count, strength
```

`claim` is a single durable assertion — *"auth is JWT, verified in
`middleware/auth.ts`"*, *"we rejected Prisma because of the migration story"*.
`provenance` points back at the episode ids it was distilled from, so every claim is
auditable back to the events that produced it. `superseded_by` gives us reconsolidation
without destroying history.

This is the store worth sharing with a team, and the store worth reviewing in a PR.

### `procedural` — how we do things here
Promoted, never written directly. Requires **recurrence**.

```
id, pattern, trigger, steps, evidence_count, strength
```

A pattern is only promoted after the same shape appears N times in episodes — you
cannot learn a habit from one telling. Injected as standing instructions rather than
retrieved on query.

## Storage: text is the source of truth, the database is derived

```
<repo>/.lethe/
  memory/*.md        ← claims and patterns. committed, or not, per .gitignore below.
  .gitignore         ← committed. the whole of the sharing decision.

~/.lethe/
  projects/<key>/
    memory/*.md      ← episodes. never shared, never committed.
    dynamics.json    ← per-machine strength and access counts.
  index.db           ← derived FTS5 index. Disposable; rebuilt from the markdown.
  lethe.log          ← off by default. `lethe init --debug`; rotates at 512 KB.
```

Nothing here grows unattended. The index prunes rows for files that no longer exist, the
log rotates and keeps one previous copy, and project directories left behind by
repositories that no longer exist are collected by `compact()` as it passes — but only
the ones holding no memories. See § Housekeeping.

**Where a memory lives is decided by what it is, not by who asks.**

| Kind | Location | Shared |
|---|---|---|
| `episode` | always `~/.lethe/projects/<key>/` | never |
| `claim`, `pattern` | `<repo>/.lethe/memory/` | if `.lethe/.gitignore` says so |

Episodes are a private scratchpad: verbose, numerous, and deleted by compaction. Three
hundred people's scratchpads is noise, not knowledge, and sharing them is the fastest
way to make shared memory useless. Claims and patterns are what survived, and are the
only things worth anyone else reading -- so **compaction is the promotion step from
private experience to shared knowledge.**

This also removed a defect and then removed its cause. Scope used to travel with a
memory, so compacting a cluster that spanned scopes could silently turn shared memory
private; deriving the path from the kind fixed that. There is now no scope at all — two
of the three names described reach rather than audience, nobody could keep them apart,
and a `team` scope claimed sharing that a `.gitignore` line could silently revoke.

### Reading across projects

A repository is not the same thing as a problem. A service, its infrastructure repo and
its client are one system to whoever is working on them, and a lesson learned in one is
routinely needed in another. When the current project has little to say, retrieval falls
back to neighbouring project stores, discounted so anything local still wins, and marks
where each borrowed memory came from. Borrowed memories are not reinforced -- one
project's usage should not distort another's decay.

### Attribution

Every memory records an `author`, taken from `git config user.email`. Confirmations
accumulate the distinct people who found it accurate -- the same person confirming twice
is one voice, not two -- and a claim corroborated by several people is promoted to a
pattern, because a claim three colleagues independently confirmed is settled in a way one
person leaning on it is not.

Confirmations live in the per-machine sidecar, not the committed file, for the same
reason strength does: corroboration aggregates across machines and writing it into shared
frontmatter would bring back the churn that keeping dynamics local removed.

### Why the database is not the source of truth

The tempting design is to commit the SQLite file to the repo as shared team memory. It
fails three ways, and the first is fatal:

1. **Git cannot merge binary files.** Two people add memories on separate branches; on
   merge, one side is discarded wholesale. This is not an edge case — it happens the
   first week two people use it.
2. **Repo bloat.** SQLite scatters writes across pages, so each commit stores an
   effectively-new copy of the whole file. A database touched daily by a team makes
   cloning painful within months.
3. **No review.** `Binary file .lethe/index.db changed` is not a diff. This one is
   disqualifying on its own: consolidation *rewrites people's memories*, and nobody
   will enable a feature that does that invisibly.

### Why there is still a database

Markdown alone cannot support the maintenance passes that are the entire point of this
project:

- **Consolidation must be atomic.** `sleep` reads N episodes, writes 1 claim, deletes N
  rows. If a crash can land halfway, memory is corrupted. Directories of files give no
  transaction.
- **The passes are set operations.** Decay is `UPDATE ... SET strength = strength * k`.
  Eviction is `ORDER BY strength LIMIT n`. Recurrence detection is
  `GROUP BY ... HAVING count(*) > n`. Over flat files each of these means reading
  everything into memory on every pass, which is why file-based tools tend not to have
  maintenance passes at all.
- **Vector search** needs an index, in the same store, without running a service.

So: `better-sqlite3` + `sqlite-vec`, one gitignored file, treated as a **build
artifact**. Same relationship as `package.json` → `node_modules`. Delete it and
`lethe index` reconstructs it from the markdown in seconds. The markdown is what you
own; the database is what makes it fast.

The payoff is that `sleep` produces a **readable diff a team can approve in a PR**. See
`docs/compact.md`.

## Housekeeping

`~/.lethe` is the one place lethe grows where nobody is looking, and until now nothing
collected any of it: project directories accumulated forever, the log had no cap, and the
index rebuilt rather than pruned. On the author's own machine that was eighteen project
directories, ten of them `/private/var/folders/.../tmp-xxxx` leftovers from test runs that
will never exist again.

The rule that decides what may be removed without asking:

> **Scaffolding is disposable. Markdown is not.**

| What | When | Who |
|---|---|---|
| index rows for files that are gone | every sync | the sync diff, no scheduler |
| the log, past 512 KB | on write | one rotation, one previous copy kept |
| project dirs holding **no** memories | during `compact()` | automatic, unmentioned |
| project dirs holding memories, path gone | never automatically | reported; `lethe gc --dead` |

The last row is the important one. A source path that is missing today is as likely to be
an unmounted volume, a moved checkout or a different machine as it is a repository that
was deleted, and losing memories to a filesystem inference is a far worse failure than
keeping a stale folder. `lethe doctor` and `lethe gc` name them and stop there.

Cleanup rides along with `compact()` rather than running on a timer, because compaction is
already triggered by use, already off the latency path, and is already the pass that
decides what does not deserve to survive. Both questions have the same shape.

The log is off by default for the same reason: appending forever to a file in someone's
home directory is not a diagnostic, it is a leak. `lethe init --debug` turns it on.
Everything derived from it — `lethe metrics`, and the activity rows in `status` and
`doctor` — then reports that logging is off rather than reporting zero activity, because
"nothing happened" and "nothing was written down" are different answers and only one of
them is a problem.

## Retrieval

Retrieval is layered, and the layers answer different questions.

```
stat markdown       which files moved since last time    (mtime + size)
   │
   ▼
~/.lethe/index.db   which ids match this query, and how well   (FTS5 + bm25)
   │
   ▼
src/rank.ts         which of those deserve to surface          (memory dynamics)
   │
   ▼
read markdown       only the hits, and their successors
```

**Recall never reads the whole store.** It used to: every query parsed every memory in
every project to hand the index a corpus to fingerprint, so the cost of one recall — and
of one `note`, which invalidated that fingerprint — scaled with everything you had ever
written. Measured on a 36,000-memory store across 36 projects, that was 4.4 seconds per
recall.

Now the unit of change is a file. Enumeration stats rather than reads; anything whose
path, mtime and size are unchanged is left alone; only new or modified files are parsed
and reindexed; anything no longer listed is dropped, which is also how the index
garbage-collects itself. Then only the hits are read off disk, plus the successors of any
that were superseded. Same corpus, same query: 373 ms, and 53 ms at 9,000 memories.

mtime is trusted because every write goes through a temp file and a rename, which always
moves it forward; size is carried too, so an edit landing inside the same millisecond is
still seen. A per-directory mtime gate would cut thousands of stat calls to dozens and is
deliberately not done — it would miss a file an editor rewrote in place, and a silently
stale index is the worst outcome available here. `lethe gc --reindex` is the escape hatch
if a filesystem with coarse timestamps ever hides an edit.

The load-bearing property: **the index stores ids and scores, never content.** The FTS5
tables are declared `content=''`, so no memory text is duplicated into the database. That
is why it stays small — measured at 4.1 MB per 10,000 memories against 23.7 MB if the
bodies were stored — and why deleting `index.db` is always a valid recovery. It holds
nothing that is not in the markdown.

`bm25()` supplies the lexical term. It brings what the previous scorer lacked: inverse
document frequency, so a common word no longer counts as much as a rare one; length
normalisation, so a long episode no longer accumulates relevance by being long; and
tokenisation, so `auth` no longer matches inside `author`. The ranker then multiplies
lethe's own signals on top — 1.5x for claims and patterns, 2x for overlap with the paths
in front of you, 0.5x for a memory borrowed from a neighbouring repository, and
`strength`. Decay and consolidation continue to steer results.

`node:sqlite` is built into Node 22, so this costs no dependency. It is loaded through a
runtime feature check rather than a static import, because it is flagged experimental:
when it is unavailable, retrieval falls back to the older in-memory scorer. **The index is
an optimisation, not a requirement** — recall degrades rather than failing.

### Pattern completion

Consolidation marks its source episodes superseded rather than deleting them, and those
cold traces stay in the index. When one of them matches, retrieval does not return it — it
resolves `supersededBy` forward and returns the claim it became, once, at the best score
among its routes.

This is CA3's job in the brain (§3): the hippocampal trace is a pointer that reinstates a
cortical pattern, and consolidation does not sever it — it becomes an additional route.
Practically, it means distillation can never make something unfindable. The worst case is
that a query matches only the original wording, arrives through the cold trace, and
returns the better-written claim.

## Embeddings: rejected, not deferred

Earlier drafts of this document specified an `EmbeddingProvider` interface with a local
quantized ONNX model as the default. That is no longer the plan, and the reasoning is
recorded here because it is the kind of decision that otherwise gets re-litigated.

**There is no model available to ask.** Anthropic ships no embeddings endpoint, and MCP
has a `sampling` primitive for text generation but no embedding primitive. So "have the
host's model embed it" is not an option — there is no API. Every remaining route means
running trained weights somewhere:

| route | cost |
|---|---|
| in-process via transformers.js | ~23 MB of weights plus **~100 MB+ of inference runtime** |
| Ollama | a separate application the user must install, plus its own download |
| an OpenAI-compatible API | memory bodies contain proprietary source; off the table as a default |

**And it would have masked the defect rather than fixing it.** The eval showed
consolidation retrieving worse than the raw episodes it consumed, and the cause was that
distillation paraphrased away the exact strings retrieval matches on — a
consolidation-quality bug. Embeddings would have hidden it at a cost of 123 MB while
still shipping a distiller that loses commands and paths. Proper lexical ranking plus
verbatim evidence retention closed the gap for nothing.

Vector retrieval is also what every competitor already does. Lethe's differentiator is
what happens to a memory over time — consolidation, forgetting, reconsolidation.
Retrieval is the part we share with everyone; it should be good, cheap and unremarkable.

Rejected outright rather than left behind an interface. An interface with no
implementation is speculative generality, and it would keep implying that vectors are the
real answer and this is a stopgap.

**One honest caveat.** The place embeddings *would* earn their cost is grouping episodes
for consolidation, not retrieval. Deciding whether two notes are about the same *problem*
rather than merely the same *project* is a semantic judgement, and lexical similarity
provably cannot make it: measured over 13 hand-labelled pairs, the best achievable
accuracy was 77% for Jaccard and 85% for TF-IDF cosine, with unrelated pairs scoring
higher than most genuinely related ones. That grouping is currently done by the
distilling model itself (see `docs/compact.md`), which has the semantics without the
download. If that proves unreliable, embeddings for clustering alone is the first thing
to revisit.

## Salience

Salience is **how much a memory deserves to survive**. In the brain, significant events
are preferentially replayed during sleep, and most of the day is never replayed and is
simply lost (`docs/brain.md` §4).

We need it because consolidation must be selective. If `sleep` treats every episode
equally it will distil noise into permanent claims — and a confidently-stated wrong
memory is worse than no memory.

Scored at write time, all signals cheap and model-free:

| Signal | Rationale |
|---|---|
| **Surprise** | Did this contradict an existing memory? Contradiction is the highest-value signal we have. |
| **Cost** | A bug that took three hours matters more than one that took thirty seconds. |
| **Recurrence** | The same thing coming up repeatedly. Also the trigger for procedural promotion. |
| **Explicit marking** | The user or agent said "remember this." Trust it. |
| **Blast radius** | Touched twelve files, not one. |
| **Resolved failure** | Something broke and was then fixed. Empirically the most valuable memory in a codebase: it encodes a trap and its escape. |

Salience gates what `sleep` bothers to look at, and contributes to initial `strength`,
which decay then erodes and access reinforces.

## The loop

```
                 ┌──────────────────────────────────────────┐
   session       │  agent working (context = working memory) │
   ───────────►  └───────────────┬──────────────────────────┘
                                 │
                    write cheap  │        ┌──────────────┐
                    ────────────►│        │  retrieval   │
                                 ▼        │  ◄───────────┤
                          ┌────────────┐  │              │
                          │  episodic  │  │  returns ids │
                          │  (hot)     │  │  so agent    │
                          └─────┬──────┘  │  can revise  │
                                │         └──────┬───────┘
        ── idle / session end ──│                │
        ── or scheduled ────────│                │
                                ▼                │
                        ┌───────────────┐        │
                        │  sleep pass   │        │
                        │  cluster      │        │
                        │  → distil     │        │
                        │  → discard    │        │
                        └───────┬───────┘        │
                                ▼                │
                          ┌────────────┐         │
                          │  semantic  │◄────────┘  reconsolidation:
                          │            │            confirm → strengthen
                          └─────┬──────┘            correct → supersede
                                │  recurrence       silence → decay
                                ▼
                          ┌────────────┐
                          │ procedural │
                          └────────────┘

        decay runs over semantic + procedural
        below threshold → cold; capacity pressure → purge
```

All maintenance happens off the user's latency path. Detail in `docs/compact.md`.

## Integration

An MCP server is the distribution strategy: one implementation, working in every host
that speaks MCP. Provisional tools:

| Tool | Purpose |
|---|---|
| `recall` | Retrieve relevant memory. Returns ids. |
| `note` | Write an episode. Cheap, fire-and-forget. |
| `confirm` | This memory was right → strengthen. |
| `correct` | This memory is wrong → supersede. |
| `forget` | Explicit removal. |

`confirm` and `correct` are reconsolidation (`docs/brain.md` §6). Retrieval
returning ids is what makes them possible: an agent that discovers a memory is stale can
fix it in place, instead of the store accumulating confident falsehoods.

## Non-goals for v1

- **Not an agent runtime.** We do not own the loop. We are a memory layer any harness
  can use.
- **No hosted service, no telemetry.** Local-first. The memories contain proprietary
  source.
- **No archetypes.** Memory policy as configuration is a real idea, but it is config
  over a core that has to be right first.
- **No web UI.** The diff is the UI.

## Open questions

- **Does consolidation need an LLM?** Our only model dependency and the entire cost
  centre. Worth measuring whether a cheaper distiller gets close
  enough. The eval decides.
- **Merge semantics for `semantic` memory.** Markdown makes git merges *possible*, not
  *good*. One claim per file keeps conflicts rare; we should confirm that under real
  team use.
- **Cold storage tier.** `docs/brain.md` §7 argues for below-threshold memories going
  cold rather than being deleted. Where do they live — a `cold/` directory, or a flag?
- **Salience calibration.** The six signals need weights. Guessing is fine to start;
  the eval should tune them.
