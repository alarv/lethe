# Agent eval scenarios

One directory per scenario:

```
<id>/
  scenario.json
  repo/            # copied to a temp directory for every run
```

`scenario.json`:

```json
{
  "id": "must match the directory name",
  "category": "environment | build | test | release | ...",
  "provenance": "synthetic | harvested",
  "harvestedFrom": { "date": "YYYY-MM-DD", "session": "where the pair came from" },
  "seedPrompt": "the first task; tells the agent the thing it must remember",
  "probePrompt": "the later task, worded differently",
  "seedAnswer": "what a correct result looks like; the mock agent reads this, nothing else does",
  "repoMustNotContain": ["the value the probe must not be able to find"],
  "checkEnv": { "LETHE_EXPECT_URL": "..." },
  "checks": [
    { "kind": "file", "path": "SOLVED", "contains": "..." },
    { "kind": "command", "command": ["node", "check.js"], "expectExit": 0 }
  ]
}
```

## The one rule

**The probe must be unanswerable without memory.** The fact the seed session learns must not
appear in the sandbox repository, in either prompt, or in the agent's environment. If it
does, `cold` finds it, the run is void, and you have measured search rather than memory.
Run `npm run eval:agent -- --agent=mock` and confirm `cold` is 0% solved before spending a
model.

`repoMustNotContain` is checked against every file in the fixture and against the probe
prompt before the run starts; the harness refuses to spend a model on a leaked pair. Every
answer-shaped literal belongs there.

`checkEnv` goes to command checks only, never to the agent. `seedAnswer` goes to the mock
only. Neither is a place to hide an answer the agent will see.

Start from `_template/`: copy it to `<id>/`, edit the id and prompts, and put the fixture
in `repo/`. Directories whose name starts with `_` are never loaded.

The probe starts from a fresh copy of `repo/`. Anything the seed session wrote or edited is
discarded; only the memory stores survive — `.lethe/` for the lethe conditions, plus
`LETHE_HOME` and `CLAUDE_CONFIG_DIR` for all of them.

## Provenance

`harvested` means the pair came from a real session. `synthetic` means it was written by
hand; it can show that a fact survived a fresh checkout, not that real repeated work got
cheaper. The summary records provenance, and a run containing synthetic pairs says so.
Never present synthetic numbers as evidence about real work.

A label is not evidence. A `harvested` pair must name where it came from in
`harvestedFrom: { date, session }` and must declare at least one `repoMustNotContain`
literal. `--validate` refuses a harvested pair without either, so a synthetic pair cannot
be relabelled to look like field data. Keep the session reference in a private note if the
content is sensitive; do not put client names, hosts or credentials in the pair.

Before a pair leaves the machine: replace real hosts and accounts with fixture values,
strip tokens and internal paths, and make sure `repoMustNotContain` covers every form of
the answer. The pair is public; the session is not.

## What makes a usable pair

Harvest from a real session: the agent learns something the repository does not state —
a service URL, which of several scripts to run, a credential's location, an environment
quirk — and a later task depends on it. Write both prompts in the words a user would use,
not the words of the answer.

Good: "The fixture database is at `postgres://…`; get the suite passing and record what a
future session needs" → "A fresh checkout has the same failure; write the command that
fixes it." Bad: anything where `ls`, the README, or the tests reveal the value.

Checks must be assertions a stranger can run: a file with expected content, or the project's
own command exiting a given way. "The answer looked right" is not a check.

## Cost

Measured on 2026-11-12, Claude Code 2.1.322, default model: about **$0.09 per session**
(seed and probe are separate sessions). One scenario, three launch conditions, three
repeats is 18 sessions, roughly **$1.70**. Ten scenarios is roughly **$17**. Repeats add
variance control, not new evidence; new pairs add evidence.

## Running

```sh
npm run build
npm run eval:agent -- --validate                          # no model, checks the pairs
npm run eval:agent -- --agent=mock --scenarios=<id> --conditions=cold,auto,lethe,both
npm run eval:agent -- --scenarios=<id> --repeats=3
```

`--validate` loads every pair, checks required fields, provenance metadata and the leak
guard, and prints a table. It spends no model and needs no key, so run it before a real
run.

The third command is the real one. A fresh `CLAUDE_CONFIG_DIR` has no login, so export
`ANTHROPIC_API_KEY` first — an API key or the token from `claude setup-token`. The run
records the Claude Code version and model in `summary.json` and writes raw runs to
`evals/results/`.

## A run that errored is not a result

Errors are counted separately and the summary is marked **VOID** if any run errored; the
command exits 1. `Credit balance is too low` and a rejected or missing key abort the whole
run after the failing session instead of producing 50 more identical errors. Partial
results are still written to `runs.jsonl`, but they are not evidence. A `!` in the
per-scenario table means that cell contains errored runs.
