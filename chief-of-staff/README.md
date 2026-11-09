# Chief of Staff (bb plugin)

One orchestrator thread, "the chief", that manages your work across all your bb
projects by delegating to reusable worker threads. The chief never does the work
itself: it picks or creates a worker per topic, briefs it, tracks its reports and
tells you what needs you. Workers can be grouped under manager threads. A side
panel shows the roster, a decision list ("For you"), activity and execution
settings; a `bb cos` CLI does the same things from a shell.

## What it needs

- bb `>= 0.40` and `@get-bb/plugin-sdk` `>= 0.5.9` (see `package.json`).
- A provider bb can run threads on. The provider and model settings ship
  blank, which means bb's project default provider and its default model; see
  "Defaults you will want to change" below. On `acp-omp` and
  `acp-antigravity` the chief and workers use the `bb cos` CLI because native
  tools are not exposed there.
- Node with `better-sqlite3` for the tests (the plugin's store is SQLite).
- Nothing else is required. Some features assume a particular setup and do
  nothing, or point at missing files, without it:
  - Standing instructions are read from `$HOME/CLAUDE.md` and `$HOME/.bb/AGENTS.md`.
  - Agent memory reads `<memoryRoot>/<role>/MEMORY.md` for the roles in
    `memoryRoles` (`$HOME/agents` by default; set `memoryRoot`, for example to
    `~/projects/agents`).
  - Worktrees are used only for projects under `worktreeRoots`, which is
    empty by default (every project gets its own checkout). Set it to the
    folder holding repos that need a worktree per worker, for example
    `~/projects/bb-plugins`.
  - A thread named `chief-of-comms` is treated as the companion
    `chief-of-comms` plugin's thread when it is moved to a new provider; its
    skill is looked up in a `chief-of-comms` folder beside this plugin's folder.
  - Avatars are exported to `$HOME/.bb/cos-avatars`.
  - On `acp-omp` and `acp-antigravity` threads the plugin sets
    `ANTHROPIC_BASE_URL` to `https://api.anthropic.com` and clears
    `ANTHROPIC_AUTH_TOKEN`, so a base URL or token inherited from bb's own
    environment does not reach those providers.
  - `bb cos remodel` and `bb cos remodel-chief` move sidebar nesting to the
    new thread by writing `parent_thread_id` in `~/.bb/bb.db` with the
    `sqlite3` command-line tool; without it the new thread is not nested.
  - The sidebar faces draw on bb's own sidebar markup (as of bb 0.48.1),
    which bb does not promise to keep, and switch off cleanly when it is missing.
- Time zone: every clock the plugin reads or prints is in `HOME_TIME_ZONE`
  (`core.ts`), which ships as `UTC`. Set it, `HOME_ZONE_LABEL` next to it and
  `HOME_UTC_OFFSET_MS` in `components/cos/day.ts` to your own zone. The nightly
  compaction runs at 04:15 server time and refuses to run when the server clock
  does not show the home zone's time.
- Decision list areas are fixed to `clients`, `consulting` and `operations`
  (`BOARD_AREAS` in `core.ts`, labels in `components/cos/board-rows.ts`, and
  the enum in `contract.ts`). Change all three together if they do not fit you.

## Not included

This copy has no auto-titling of threads, no automatic board staleness check
and no model-written handover summary. All three needed the plugin to make
its own model call with the user's own login, so they were left out. Instead:

- Thread titles: use bb's own cloud AI titles, or name a thread by hand.
- Old decision items: close them yourself from the "For you" list, or with
  `bb cos board resolve <id>` or `bb cos board dismiss <id>`. The board
  changes only when you, the chief or a worker changes it (items with an
  expiry day still close on their own the day after).
- Handovers (`bb cos remodel`, `bb cos move` to a folder): a thread over the
  250k-token cap gets its newest messages in full and a line saying how many
  older ones were left out and how to read them (`bb thread output <id>`).

## Roster

There is one chief. Under it you create workers by topic (`docs-qa`,
`app-builder`, `copy-editor`) and, when one area has enough workers that their
reports cost the chief turns, a manager over them (`ops-lead`, `coordinator`)
with `bb cos spawn-manager <name> --team a,b`. A worker's slug becomes its
title (`docs-qa` shows as "Docs QA"); rename with `bb cos brand`. None of these
names are built in: the tests and skills use them only as examples.

## Install from this repo

```sh
cd chief-of-staff
npm ci --ignore-scripts
npm rebuild better-sqlite3   # only needed to run the tests
bb plugin install "$PWD" --yes
```

Then open **Chief of Staff** in the sidebar and press **Start chief of staff**,
or run `bb cos start`. Reload after changing settings with
`bb plugin reload chief-of-staff`.

Check it with `npm test` (typecheck, then `node --test`).

## Defaults you will want to change

- `chiefProviderId`, `chiefModel`, `workerProviderId`, `workerModel` are blank,
  so threads run on bb's project default provider and model. Set them to the
  provider and model you use (for example `claude-code`, or `acp-omp` with a
  model your omp logins can run). `bb cos remodel` and `bb cos remodel-chief`
  refuse to run with no provider given and none set.
- `OMP_MODELS` in `server.ts` is an example list of `acp-omp` models named to
  the chief as remodel targets. Edit it to the models your omp logins can run,
  and keep the model list in `skills/chief-of-staff/SKILL.md` in step (a test
  checks that every listed model appears there).

## Settings

| Setting | Default | What it does |
|---|---|---|
| `chiefProject` | personal project | Project the chief thread lives in. |
| `chiefProviderId`, `chiefModel` | blank (project default) | Provider and model of the chief. |
| `workerProviderId`, `workerModel` | blank (project default) | Defaults for new workers. |
| `workerPermissionMode` | `full` | Permission mode workers are dispatched with. |
| `workerReasoningLevel` | `high` | Reasoning level pinned on new workers. |
| `workerVisibility` | `visible` | Whether worker threads show in the sidebar. |
| `threadMarks` | `on` | Mark sidebar rows that failed, wait on you, are rate-limited, or finished unread. |
| `sidebarFaces` | `on` | Each worker's avatar at the start of its sidebar row. |
| `worktreeRoots` | empty | Projects under these paths get a git worktree; everything else gets the project's own checkout. Example: `~/projects/bb-plugins`. |
| `memoryRoles` | `chief` | Thread roles that load a `MEMORY.md` index (`chief`, or a manager's name). |
| `memoryRoot` | `$HOME/agents` | Folder holding one sub-folder per role. |

`bb plugin config chief-of-staff` shows the current values.

## Commands

`bb cos help` prints the full list. The main ones:

- `bb cos start`, `bb cos brief`, `bb cos roster`: start the chief, see the state.
- `bb cos delegate <project> <worker> <message> [--spawn] [--wait]`: send a task.
- `bb cos read <worker>`, `bb cos wait <worker>`: read or wait for a report.
- `bb cos steer`, `bb cos stop`, `bb cos retry`, `bb cos answer`: manage a running turn.
- `bb cos spawn-manager`, `bb cos assign`: managers and their teams.
- `bb cos board [list|add|update|resolve|dismiss|reopen]`: the decision list.
- `bb cos remodel`, `bb cos remodel-chief`, `bb cos relevel`: provider, model and reasoning level.
- `bb cos sessions`, `bb cos import`: take over Claude Code sessions running outside bb.
- `bb cos compact [--dry-run]`: the overnight context compaction, run by hand.
- `bb cos retire`, `bb cos dismiss`, `bb cos adopt`, `bb cos brand`, `bb cos move`.

The chief and workers get the same operations as native `cos_*` tools where the
provider exposes them. The skills in `skills/` (`chief-of-staff`, `cos-manager`,
`cos-worker`) are the operating manuals the threads load.

## Files

- `server.ts`: plugin server: settings, tools, CLI, RPCs, background sweeps.
- `core.ts`: pure logic and the SQLite store; `core.test.ts` tests it.
- `contract.ts`: RPC schemas shared by server and panel.
- `app.tsx`, `components/`: the panel.
