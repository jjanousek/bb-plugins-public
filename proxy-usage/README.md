# Proxy Usage

Shows subscription usage for every OAuth account omp holds in
`~/.omp/agent/agent.db` (Claude Max via Anthropic and Google AI Ultra via
Antigravity), plus server CPU, memory and service health, as a compact status
strip in bb's sidebar footer. A click or hover opens a popup with every usage
window, Switch, Eject and the server check details. It can also resume a turn
that failed on a usage limit once the account's window reopens.

## The proxy

The plugin, its popup and its messages speak of "the proxy". That means a
local gateway that holds OAuth logins for model accounts and refreshes them,
and sends each request to one of those accounts. Here that is omp with more
than one signed-in account. The plugin reads omp's credential store
(`agent.db`) and the gateway's account state (which account is enabled, in
use, on hold or disabled). Eject removes an account from that store, so the
gateway stops using and refreshing it; Switch changes which account it uses.

## What it needs

- bb 0.41 or newer (`bbPluginSdk` 0.4.34 or newer).
- omp installed at `~/.local/bin/omp` (change `OMP_BIN` in `server.ts` if it
  lives elsewhere), signed in to one or more accounts. The
  plugin polls `omp usage --no-extensions --json` and reads only credential
  metadata from `agent.db` (email, expiry, org id), never `auth_credentials.data`.
  Tokens never reach the frontend.
- Node.js 22 or newer on the bb server (`node:sqlite`).
- Linux with systemd for the server check (failed units, `/` free space, one
  watchdog unit you name). On other systems those rows show "unknown".

What depends on your own setup: the server check watches one systemd unit,
`watchdog.service` by default; set your own unit name or ignore the row. A run
older than 10 minutes reads late, older than 30 minutes overdue, so the check
suits a unit that runs every few minutes.

The plugin keeps its own state in `~/.local/state/proxy-usage/`. Besides the
ejected accounts it writes `ejected-accounts.txt`, one auth file name per
line, which any credential tool of yours may read to skip those accounts. The
plugin does not read that list itself.

## Install

From a clone of this repository:

```sh
cd proxy-usage
npm ci --ignore-scripts
bb plugin install . --yes
```

## Features

- Footer strip: one row per active subscription with its closest-to-limit
  window, plus `CPU` and `Memory` rows refreshed every 12 seconds.
- Switch: one account is in use at a time per provider. If something else
  leaves two enabled, the popup and the CLI say so.
- Eject: removes a dead account from `agent.db` and keeps a copy in
  `~/.local/state/proxy-usage/ejected/` (0700, files 0600) for 7 days, with
  Undo. Only a click in the popup can eject: the routes need a one-time code
  that is handed out only to a browser request. There is no CLI command or
  agent tool for it.
- Auto-resume: when a turn fails with a usage-limit 429, the plugin queues a
  retry for when the limit lifts, or now if another enabled account has room,
  and spaces resumed turns apart.

## Settings

- **omp agent.db path**: empty for `~/.omp/agent/agent.db`.
- **Ignored systemd units**: comma-separated units to leave out of the server check.
- **Watchdog systemd unit**: the unit whose last run the server check watches (default `watchdog.service`).

## Commands

```sh
bb proxy-usage [--json]
bb proxy-usage use <[provider:]email-substring>
```

`use` switches the active account for that provider in `agent.db`.

## Tests

```sh
npm test
```
