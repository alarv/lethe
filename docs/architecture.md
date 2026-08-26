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
id, claim, scope, confidence, provenance[], superseded_by,
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
  memory/*.md        ← committed. team memory. mergeable, diffable, reviewable.
  config.json        ← committed.
  index.db           ← gitignored. derived. rebuild: `lethe index`

~/.lethe/
  memory/*.md        ← personal memory. never shared, never committed.
  index.db           ← derived.
  models/            ← cached embedding model.
```

**Where a memory lives is decided by what it is, not by who asks.**

| Kind | Location | Shared |
|---|---|---|
| `episode` | always `~/.lethe/projects/<key>/` | never |
| `claim`, `pattern` | the configured scope; `team` puts them in the repo | yes, by default |

Episodes are a private scratchpad: verbose, numerous, and deleted by compaction. Three
hundred people's scratchpads is noise, not knowledge, and sharing them is the fastest
way to make shared memory useless. Claims and patterns are what survived, and are the
only things worth anyone else reading -- so **compaction is the promotion step from
private experience to shared knowledge.**

This also removes a defect: scope used to travel with a memory, so compacting a cluster
that spanned scopes could silently turn team memory private.

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

## Embeddings

An embedding turns text into a vector positioned so that texts with similar *meaning*
land near each other — "the auth uses JWT" and "we authenticate with JSON web tokens"
produce nearly identical vectors despite sharing no words. Retrieval embeds the query
and finds the nearest stored memories. This is what makes recall work when the user
does not know the exact wording of what was stored.

Embeddings are **not** the consolidation LLM. They are cheap, fast, deterministic, and
needed on every read. The LLM is only involved in `sleep`, is expensive and
nondeterministic, and is deferred until the eval says whether it earns its cost. A v1
with local embeddings and no LLM at all is a viable product.

One interface, three implementations:

```ts
interface EmbeddingProvider {
  readonly id: string;        // recorded per-vector; changing model forces reindex
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
```

| Provider | Weight | Dims | Notes |
|---|---|---|---|
| **`local`** (default) — `all-MiniLM-L6-v2`, quantized ONNX | ~23 MB, downloaded once, cached in `~/.lethe/models/` | 384 | Offline, no API key, no config, no data leaves the machine |
| `openai` — `text-embedding-3-small` | 0 | 1536 | ~$0.02 / 1M tokens. Better quality, requires a key |
| `endpoint` — any OpenAI-compatible URL | 0 | — | Self-hosted or cloud-tenant deployments |

**Local is the default on purpose.** Memories contain proprietary source code, so
"nothing leaves your machine unless you opt in" is the correct posture for the
environments we want to be adopted in — and it means `npx lethe` works with zero setup.
The ~23MB fetch is lazy, on first use, not at install.

The provider `id` is stored alongside every vector. Switching providers changes the
vector space, so it invalidates the index and triggers a rebuild — cheap, because the
markdown is the source of truth.

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
  centre. Worth measuring whether clustering plus extractive summarisation gets close
  enough. The eval decides.
- **Merge semantics for `semantic` memory.** Markdown makes git merges *possible*, not
  *good*. One claim per file keeps conflicts rare; we should confirm that under real
  team use.
- **Cold storage tier.** `docs/brain.md` §7 argues for below-threshold memories going
  cold rather than being deleted. Where do they live — a `cold/` directory, or a flag?
- **Salience calibration.** The six signals need weights. Guessing is fine to start;
  the eval should tune them.
