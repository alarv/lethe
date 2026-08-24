# Working on lethe

## The one rule

An anatomical name is only allowed as a nickname for a component that already earned
its existence. If you cannot describe a module in one sentence of plain systems
language without the brain word, it does not ship. Brain-shaped on the outside, boring
and testable on the inside.

## The API is the product

Read [`docs/api-design.md`](docs/api-design.md) before changing the tool surface, the
CLI, or any user-facing name. Summary: fewest tools that can do the job, descriptions
that say *when* to call rather than *what* it does, no configuration for the common
case, and delete before adding.

A developer decides whether to keep this in the few seconds they spend reading the tool
list. That is the whole budget. Spend it on clarity, not features.

## Before claiming anything works

- `npm run build` must pass.
- Run the thing. `node dist/cli.js where`, write a memory, read it back.
- If it touches storage, verify two different repos do not see each other's memories,
  and that nothing appears in `git status`.

Do not describe something as done because the code looks right.

## Honesty in the docs

The README states what does not work yet, on purpose. Keep it that way. If retrieval is
keyword matching, say so. If compaction is unimplemented, say so and make the command
fail loudly rather than no-op — a stub that silently succeeds is how a project ends up
shipping something that looks finished and does nothing.

## Storage

`local` scope is the default and lives in `~/.lethe/projects/<repo>-<hash>/`. Writing
into someone's repository is a decision they opt into (`team` scope), never something
they discover in `git status`.

## Memory

You have `lethe_*` tools available. Use them here too — this repo is the first place
the thing should prove useful.
