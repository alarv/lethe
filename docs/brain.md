# How memory actually works in the brain

This is the reference document for Lethe's design. Everything here is real
neuroscience, not metaphor-for-marketing. Where we deviate from biology, we say so
explicitly and give the engineering reason.

Rule of the project: **an anatomical name is only allowed as a nickname for a
component that already earned its existence.** If you cannot describe the module in
one sentence of plain systems language without the brain word, it does not ship.

---

## 1. There is no single "memory". There are several systems with different physics.

The standard taxonomy (Squire; Tulving):

```
memory
├── declarative ("knowing that")      — conscious, verbalisable
│   ├── episodic    — events, bound to a time and place
│   └── semantic    — facts, stripped of when/where you learned them
└── non-declarative ("knowing how")
    ├── procedural  — skills, habits, sequences
    ├── priming
    └── conditioning
```

Two things matter for us:

**Episodic and semantic are the same information at different ages.** You once
learned "Paris is the capital of France" at a specific desk on a specific day. The
fact survived; the desk did not. Semantic memory is what episodic memory *decays
into* when the useful part is extracted and the context is thrown away. That
transformation is the single most important idea in this project.

**Procedural memory is acquired by repetition, not by being told once.** You cannot
learn to ride a bike from a sentence. Something only becomes procedural after the
same pattern recurs enough times.

We implement episodic, semantic, and procedural. We ignore priming and
conditioning — no engineering analogue worth the complexity.

---

## 2. Working memory is tiny, and that is a feature

Working memory (prefrontal cortex) holds roughly **4 chunks**, not the "7±2" you may
have heard — Miller's number was revised down once researchers controlled for
rehearsal. It is maintained by *active* neural firing, which is metabolically
expensive, so anything not being actively rehearsed decays within seconds and is
overwritten by whatever arrives next.

The capacity limit is not a design flaw. A system that could hold everything in
working memory would have no pressure to decide what matters. **The bottleneck is
what forces prioritisation.**

> Harness mapping: the model's context window is working memory. It is already
> capacity-bounded and already overwritten. We do not need to invent this — we need
> to *respect* it, and stop treating "fill the context with everything retrieved" as
> the goal.

---

## 3. The hippocampus and the neocortex are two learning systems, on purpose

This is **Complementary Learning Systems** theory (McClelland, McNaughton &
O'Reilly, 1995), and it is the theoretical spine of Lethe.

The problem it solves: a single neural network that learns fast suffers
**catastrophic interference** — new information overwrites old. A network that learns
slowly, by averaging over many examples, extracts stable general structure but cannot
record a one-off event. You cannot get both properties from one system, so the brain
runs two:

| | Hippocampus | Neocortex |
|---|---|---|
| Learning rate | Fast — one exposure | Slow — many exposures |
| Representation | **Sparse**, non-overlapping | **Dense**, overlapping, distributed |
| Stores | Specific episodes, bound to context | Generalised structure, schemas |
| Capacity | Small, a buffer | Large, the archive |
| Failure mode | Fills up, interferes | Never learns one-off facts |

The hippocampus is a **fast write-ahead buffer with an index**. It does not durably
store the memory itself; it stores a sparse *pointer pattern* that can reinstate the
distributed cortical pattern that was active during the event.

> Harness mapping: this is exactly a hot append-only episodic log plus a slow,
> curated semantic store. We are not borrowing a metaphor, we are borrowing an
> architecture that exists because of a constraint we also have.

### Pattern separation vs pattern completion

Two subregions do opposite jobs:

- **Dentate gyrus — pattern separation.** Takes similar inputs and forces them apart
  into distinct sparse codes, so today's standup does not smear into yesterday's.
- **CA3 — pattern completion.** Given a partial cue, reinstates the whole pattern.
  This is why a fragment of a smell retrieves an entire childhood scene.

> Harness mapping: separation is deduplication and identity at *write* time — two
> similar-but-distinct debugging sessions must not collapse into one record.
> Completion is retrieval expansion at *read* time — a vague query should pull the
> whole related cluster, not just the literally-matching row. Most memory tools
> implement neither: keyword search does no separation on write and no completion on
> read.

---

## 4. Consolidation: sharp-wave ripples and sleep

Memory does not stay in the hippocampus. **Systems consolidation** gradually
transfers it to cortex, and over months to years the memory becomes
hippocampus-independent — which is why amnesic patients with hippocampal damage
retain childhood memories but cannot form new ones.

The mechanism is **replay**. During slow-wave sleep and quiet rest, the hippocampus
emits **sharp-wave ripples** (~150–250 Hz bursts) during which the neural sequence
from a waking experience is replayed to cortex — compressed roughly 10–20× faster
than it originally occurred. Cortex sees the same pattern repeatedly, at low learning
rate, interleaved with other memories, and slowly extracts what is *common across
episodes* while discarding what was incidental to any one of them.

Critically, replay is **selective**. Events tagged as significant — reward, surprise,
emotional salience (this is the amygdala's actual job, and the only justification for
ever naming a module after it) — are replayed preferentially. Most of the day is
never replayed and is simply lost.

> Harness mapping: this is Lethe's core loop. A deferred, off-critical-path pass that
> reads the episodic buffer, replays clusters of related episodes, distils what is
> invariant across them into a semantic claim, and drops the episodes. It runs on
> idle or at session end — never in the user's latency path, exactly like sleep.
> Nickname: **ripple**.

---

## 5. Forgetting is an active process, and it is what makes memory useful

The naive view is that forgetting is storage failure. It is not — it is *engineered*.

- **Synaptic homeostasis** (Tononi & Cirelli): during waking, synapses potentiate
  broadly. Sleep **downscales them globally**. Weak traces fall below threshold and
  vanish; strong ones survive relatively intact. Signal-to-noise improves *because*
  the total is cut back.
- **Interference**: retrieving one memory actively suppresses competitors. Recall is
  as much inhibition as activation.
- **Generalisation requires loss.** A system that retained every episode in full
  detail could never form the concept "dog" — it would have a million unrelated
  animal encounters. Forgetting the incidental *is* the abstraction step. The
  cautionary case is patients with hyperthymesia and cases like Luria's Shereshevsky,
  who recalled almost everything and were correspondingly poor at abstraction and
  metaphor.

> Harness mapping: this is our differentiator and it is not decoration. The usual
> design is an append-only store that grows without bound. Lethe treats capacity as
> fixed and forces eviction. Decay is global downscaling; reinforcement on access is
> potentiation. **If memory only ever grows, it is a log file, not a brain.**

---

## 6. Reconsolidation: reading a memory rewrites it

When a consolidated memory is retrieved it becomes temporarily **labile** — it must
be re-stabilised (requiring protein synthesis) to persist, and during that window it
can be *modified*. Recall is not a read; it is a read-modify-write. This is why
memories drift toward being self-consistent and plausible rather than accurate, and
why eyewitness testimony degrades each time it is rehearsed.

In biology this is a bug we live with. **For us it is a feature, and one that memory
systems generally skip.** Most expose no way to revise a stored memory at all — an
agent can append and read, but never correct. So when a memory becomes wrong (the auth
middleware moved, the decision got reversed), it stays wrong forever and keeps getting
retrieved.

> Harness mapping: every retrieval is a write opportunity. Retrieved memories carry
> their id; the agent can correct, supersede, or confirm them. Confirmation
> strengthens (potentiation), correction supersedes, silence lets decay run.

---

## 7. Engrams and salience

An **engram** is the physical trace of a memory: a sparse ensemble of cells that were
active during an event and are reactivated on recall. Optogenetic work (Tonegawa's
lab) has tagged these ensembles and artificially reactivated them to trigger recall,
and reactivated ensembles for memories that were behaviourally "forgotten" — showing
that some forgetting is *retrieval failure*, not erasure.

> Harness mapping: two-tier decay. Memories that fall below the retrieval threshold
> stop surfacing but are not immediately destroyed — they go cold and are only purged
> under capacity pressure. This gives us a recoverable middle state and, practically,
> an undo. Given storage is cheap and users will not trust a tool that deletes their
> notes, cold-storage-then-purge is also the only politically viable way to ship
> aggressive forgetting.

---

## 8. The honest summary of the mapping

| Brain | Lethe | Faithful? |
|---|---|---|
| Working memory, ~4 chunks, overwritten | The model's context window | Yes — same constraint, same physics |
| Hippocampus, fast sparse episodic buffer | `episodic` store, append-only, hot | Yes — same reason (CLS) |
| Neocortex, slow dense semantic store | `semantic` store, curated | Yes |
| Procedural memory via repetition | `procedural` store, promoted on recurrence | Yes |
| Sharp-wave ripple replay during rest | `ripple` consolidation pass on idle | Yes in shape; ours uses an LLM, brain uses interleaved replay |
| Selective replay by salience | Salience scoring on write | Loosely |
| Synaptic downscaling in sleep | Global decay pass | Yes in effect, not mechanism |
| Reconsolidation on retrieval | Retrieval returns ids; agent may revise | We do this *better* than biology on purpose |
| Pattern separation (DG) | Write-time dedup / distinctness | Yes in role |
| Pattern completion (CA3) | Retrieval expansion over clusters | Yes in role |
| Amygdala salience tagging | Only if it earns a module. Not in v1. | — |

Where we deliberately break from biology:

1. **Our consolidation uses an LLM.** The brain uses interleaved slow learning. We
   are buying the same outcome — extract the invariant, drop the incidental — with a
   completely different mechanism. This costs money, latency and determinism.
2. **Our forgetting is auditable and reversible.** Biology's is neither. Storage
   backed by git means users will review anything we rewrite, so every consolidation
   must be inspectable and undoable.
3. **We have no amygdala, no priming, no conditioning.** No engineering payoff.

## References

- McClelland, McNaughton & O'Reilly (1995), *Why there are complementary learning
  systems in the hippocampus and neocortex* — the core citation.
- Tulving (1972), episodic vs semantic distinction.
- Squire, taxonomy of declarative vs non-declarative memory.
- Buzsáki, sharp-wave ripples and replay.
- Tononi & Cirelli, synaptic homeostasis hypothesis.
- Nader et al. (2000), reconsolidation.
- Cowan (2001), working memory capacity ≈ 4.
