# API design

The tool surface is the product. A developer decides whether to keep Lethe in the few
seconds they spend reading the tool list, and an agent decides whether to call it from
the description alone. Both judgements happen before anyone reads a doc.

## Rules

**Fewest tools that can do the job.** Every tool costs context in every session, for
every user, forever. A tool that could be a parameter should be a parameter. If two
tools are usually called together, they are one tool.

**Names say what happens.** `recall`, not `query_memory_store`. Do not repeat the
server name in the tool name: hosts already namespace by server, so a tool called
`lethe_note` on a server called `lethe` surfaces as `lethe_lethe_note`. No `_v2`, no
`_ex`, no abbreviations that need expanding.

**Descriptions tell the agent *when*, not just *what*.** "Search memory" is useless —
the model already knows what search is. "Call this BEFORE investigating something that
may have been solved before" changes behaviour. Write for a reader who will decide, in
one pass, whether this call is worth a turn.

**Sensible defaults, few required arguments.** `note` should need a title and
nothing else. Every required parameter is a chance for the agent to stall or guess.

**No configuration for the common case.** If the default requires an env var, the
default is wrong. Flags are for the minority; the majority should get correct behaviour
by doing nothing.

**One concept, one name.** If the docs say "claim" and the code says "fact" and the
tool says "memory", the reader has to hold three words for one thing. Pick one.

**Errors say what to do next.** `no memory 3f2a` is a dead end. `no memory 3f2a — run
lethe ls to see ids` is a recovery.

**Delete before adding.** A mode that stores nothing is not a feature, it is "do not
call the tool". Features that only make sense once you have read the source are not
features. When in doubt, cut it — the surface is easier to grow than to shrink, because
removing anything published breaks someone.

## Test

Read the tool list cold, as if you had never seen the project. If you cannot tell what
Lethe does and when to call it, the surface is wrong — not the documentation.
