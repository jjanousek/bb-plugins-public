# bb-plugin-usage

Track coding-agent token usage and estimated API cost across every machine enrolled in BB.

This plugin is based on the MIT-licensed [MayankBansal12/bb-plugin-usage](https://github.com/MayankBansal12/bb-plugin-usage). The licence and the attribution stay in `LICENSE`. This version adds omp, Antigravity, Cursor-account and OpenCode Go collection, the 1-hour cache-write rate, project breakdown and stale-data handling.

Needs: BB 0.36 or newer, and Node.js on each enrolled machine (see the data sources below). No other plugin and no login is needed beyond the agents' own local logs and credentials.

## Features

- Collect usage from Codex, Claude Code, Cursor, FX, Grok Agent, OpenCode, Pi, Prime Agent, Antigravity, and omp.
- Separate the coding agent from the underlying model provider.
- Group charts and cost summaries by agent or model provider.
- Break usage down by model, project, or day.
- Filter by machine, agent, model provider, and the last 7, 30, or 90 days.
- Show exact, alias-matched, agent-reported, and unknown pricing in the breakdown table.
- Show OpenCode Go plan windows (rolling 5-hour, weekly, and monthly) in the usage-limits section.
- Resolve model prices from [models.dev](https://models.dev), refreshed daily at runtime with the bundled snapshot as fallback, without inventing prices for ambiguous models.
- Price Claude Code's 1-hour cache writes at Anthropic's 1-hour rate, twice the input price, and 5-minute writes at the rate models.dev lists. Claude Code's logs split the two; other harnesses report one cache-write total, which is priced at the listed rate.
- Sync automatically every 15 minutes or manually from the dashboard.

## Supported data sources

- Codex: `~/.codex/sessions/**/rollout-*.jsonl`
- Claude Code: `~/.claude/projects/**/*.jsonl`
- Cursor: the account's own billing record, via `aiserver.v1.DashboardService/GetFilteredUsageEvents` on `api2.cursor.sh`, authenticated with the `accessToken` in `~/.config/cursor/auth.json` on each machine
- FX: `~/.fx/usage.jsonl`
- Grok Agent: `~/.grok/logs/unified.jsonl` (a different product from the Cursor harness above)
- Pi: `~/.pi/agent/sessions/**/*.jsonl`, plus optional extra roots in plugin settings
- Prime Agent: root sessions in `~/.prime/agent/sessions/*.jsonl` and recursive-agent sessions under `~/.prime/agent/session-artifacts/**/*.jsonl`, plus optional custom session directories in plugin settings
- omp: `~/.omp/agent/sessions/**/*.jsonl` (Pi session format). Rows from a locally proxied Claude subscription provider are recorded under the canonical Anthropic model id and priced at Anthropic list; `google-antigravity` rows resolve against Google or Anthropic by model family; free-tier ids listed in `modelPriceAliases` in `lib/pricing.ts` keep their own id and are priced at their paid tier (the shipped `opencode/quill-3-free` entry is an example). `lib/pricing.ts` ships one example id for such a provider, `my-claude-proxy`; add the ids of your own local Anthropic providers to `providerAliases` there
- OpenCode: assistant-message usage from the last 90 days, recorded by `opencode db`
- Antigravity: `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl` from the `agy` CLI (taking the configured model from `~/.gemini/antigravity-cli/settings.json` when the transcript does not name one), plus `~/.antigravity-acp/usage.jsonl` when written by the `bb-plugin-antigravity-acp` provider bridge
- OpenCode Go limits: plan windows from `https://opencode.ai/zen/go/v1/usage`, authenticated with the `opencode-go` credential in `~/.local/share/opencode/auth.json` on each machine

JSON-log collection requires Node.js on each enrolled machine. Logs are streamed and reduced to usage metadata on that machine, so large histories are not transferred through BB's file API. A metadata-only per-file cache in `~/.cache/bb-plugin-usage/json-log-scan-v1/` makes later syncs reparse only changed files. The initial 365-day scan can take longer on machines with large histories.

FX history follows the rolling retention of FX's local usage ledger. The plugin reads generation usage facts only; FX sessions and prompts are not scanned.

OpenCode collection requires an OpenCode CLI with `opencode db --format json` support on each enrolled machine. The fixed `SELECT` query aggregates assistant-message usage from the last 90 calendar days—the longest range the dashboard supports—returns only usage metadata, is limited to 900 KB of output, and times out after 60 seconds. OpenCode costs use only positive values recorded by OpenCode; providers with no recorded cost remain unknown with zero cost.

Cursor collection requires Node.js and a signed-in `cursor-agent` on the enrolled machine. Cursor's local session stores and tracking database hold no token counts and no cost, and the ACP bridge BB drives does not forward Cursor's token usage. So the collector reads the account's billing record instead, which also covers Cursor usage that does not go through ACP.

The credential stays on the machine: the collector reads `accessToken` there, uses it as a bearer header, and returns only dates, Cursor's own model ids, token counts, billed-request counts, and money. The access token, the per-event `conversationId` and the owning user id are never returned, which `lib/cursor-account.test.ts` asserts. A machine with no signed-in Cursor is skipped rather than failed, and a sync whose API call fails keeps the last good Cursor rows and reports the error.

Cursor costs are Cursor's own `chargedCents`, never an API-rate estimate, because Cursor prices the call itself and a rate card would be a guess about somebody else's pricing. A Cursor row carries no project: its billing record has no working directory, so there is nothing to join on.

OpenCode Go limit collection requires `curl` plus either `jq` or Node.js on the enrolled machine, and an OpenCode Go subscription configured in OpenCode's auth file. The API key stays on that machine: the collector reads it locally, calls the usage endpoint, and reports only window percentages and reset times. Machines without a Go credential or plan are skipped silently. Transient failures retain the last successful snapshot and are shown alongside the cached values.

The two collectors that call a vendor API use only the local login of the user who installed the plugin, on each enrolled machine. They hold no shared or bundled credential:

- Cursor account collector (`lib/cursor-account.ts`, `lib/host/cursor-account.host.ts`): reads `~/.config/cursor/auth.json` (the `accessToken` written by `cursor-agent` sign-in) and calls `api2.cursor.sh`.
- OpenCode Go collector (`lib/opencode-go.ts`): reads `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json` (the `opencode-go` entry written by OpenCode) and calls `opencode.ai`.

The plugin never stores prompts or message content. It stores timestamps, agent/model identifiers, token buckets, pricing status, and aggregate cost. To break usage down by project it also records the working directory's final segment (the project folder name, e.g. `bb-plugin-usage`) for agents that log one; the full directory path is never stored or transferred. FX uses the spend recorded in its local usage ledger, OpenCode uses positive agent-recorded costs only, and other agents use standard API-rate estimates when models.dev can resolve a model, then agent-reported cost when available. They are not subscription-billing totals.

Missing log roots are treated as normal “no data” results. Offline machines, unreadable files, malformed collector output, missing runtime tools, query failures, and timeouts are retained as per-agent sync states so available history remains visible with an error notice.

## Install

Requires BB 0.36 or newer. From a clone of this repository:

```sh
cd usage
npm ci --ignore-scripts
bb plugin install . --yes
```

Open BB and select **Usage** from the plugin sidebar. The plugin scans supported local data on connected machines and refreshes automatically every 15 minutes, or when you press sync.

## Settings

- **Extra Pi session roots**: semicolon-separated absolute paths, scanned in addition to `~/.pi/agent/sessions`.
- **Extra Prime Agent session roots**: semicolon-separated absolute session directories, scanned in addition to `~/.prime/agent/sessions`.

There is no CLI command and no agent tool; everything is in the panel at `/plugins/usage/usage`.

## Develop

```sh
cd usage
npm ci --ignore-scripts
npm run check
npm test
npm run build
```

Install the local build and start development mode:

```sh
bb plugin install . --yes
bb plugin dev
```

### Host collectors

The code that reads agent logs and the Cursor account runs on each enrolled machine in a bare `node -e`, not inside bb-server. Its source is in `lib/host/`, one function per file, and it ships as text from `lib/generated/host-scripts.ts`. After editing anything in `lib/host/`, regenerate that file:

```sh
npm run build:host-scripts
```

Do not send a server-side function with `fn.toString()`. bb builds the server bundle minified with esbuild's `keepNames`, which inserts calls to a bundle-level helper inside every function body, and the host process does not have that helper, so such a function fails there. `lib/host-scripts.bundle.test.ts` builds the scripts the way bb does, runs them in a bare node process, and fails if the generated file is stale.

## Contributions

Ideas, fixes, and improvements are welcome.
