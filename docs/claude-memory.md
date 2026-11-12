# lethe and Claude Code's built-in memory

"Doesn't Claude Code already remember things?" Yes, and the two do different jobs. This
page says where they overlap, where they don't, and when to use which.

Claims about Claude Code come from its
[memory documentation](https://code.claude.com/docs/en/memory), read 2026-11-12. That
behaviour changes; if this page disagrees with the docs, the docs win.

## What Claude Code has

Two mechanisms, and only one of them is comparable to lethe.

- **CLAUDE.md** is instructions you write: conventions, commands, rules. Loaded in full at
  the start of every session, from the user, project and managed-policy levels. lethe does
  not replace this and you should keep using it.
- **Auto memory** is notes Claude writes itself after a correction or confirmation. A
  `MEMORY.md` index plus topic files under `~/.claude/projects/<project>/memory/`. The
  first 200 lines or 25 KB of the index are loaded each session; topic files are read on
  demand.

## Side by side

| | Claude auto memory | lethe |
|---|---|---|
| Lives in | `~/.claude/projects/<project>/memory/` | claims in `<repo>/.lethe/memory/`, episodes in `~/.lethe/projects/` |
| Shared with a team | no, per machine | claims can be committed and reviewed in a PR; episodes never leave |
| At session start | the whole index, up to 200 lines / 25 KB | about 1.5 KB of claim and pattern titles |
| Finding detail | the model opens topic files | a `recall` tool call: keyword search (BM25), ranked by strength |
| Writing | whatever Claude decides to save | `note` records an episode; compaction distils episodes into claims |
| Forgetting | none automatic in the docs; pruned by hand or by Claude's choice | decay, reinforcement on use, eviction under a capacity budget |
| Fixing a wrong memory | Claude edits the file | `correct` / `confirm`, by id |
| Works in | Claude Code | any MCP host: Claude Code, opencode, Cursor, Codex, Windsurf, Zed |

## Where Claude's is better

- **Zero setup.** It is on by default in local sessions.
- **No tool call to forget.** The index is always in context. lethe's detail is behind
  `recall`, and agents often don't call it unprompted; the briefing helps less than
  you'd hope (see [evals](evals.md) and `lethe metrics`).
- **Nothing to break.** No MCP server, no Node version, no index.

## Where lethe is different

- **A team can review what the agent learned.** Claims are markdown in the repo.
- **It forgets on purpose,** so the store doesn't grow until the index is truncated.
- **Memories have ids and history,** so a wrong one is corrected rather than silently
  contradicted by a newer note.
- **Not tied to one host.** The same memory serves every agent you use on the repo.

## What lethe does not claim

Better retrieval. Claude's auto memory has no search to compare against, and against raw
session logs lethe's recall is roughly a draw ([evals](evals.md)). The case for lethe is
sharing, forgetting and portability, not recall quality.

## Using both

They coexist. A reasonable split:

- **CLAUDE.md / AGENTS.md:** rules you want followed every time.
- **Claude auto memory:** personal preferences, specific to you and this machine.
- **lethe:** what the project has learned, shared with the team.

Both being on means the same fact can be saved twice. To keep one source of truth, turn
auto memory off with `/memory`, or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
