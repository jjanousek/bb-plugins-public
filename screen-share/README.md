# Screen Share

One-click live view of the agent browser on its X display, so you can log into
a site by hand from your laptop or phone inside your tailnet, for example when
an agent hits a sign-in page, a 2FA prompt or a captcha. Agents are told to run
`bb screen-share start` and hand you the link instead of typing credentials.

## How it works

- `screen-share.service` runs `screen-share-serve`: x11vnc on a unix socket, and
  websockify plus noVNC on a second unix socket. No TCP port is opened and
  there is no VNC password.
- `tailscale serve` mounts the websockify socket at `/vnc/` on your machine's
  tailnet HTTPS name. Only devices in your tailnet can reach it. The plugin
  re-adds the mount on start if it went missing.
- The web root is `~/.screen-share/web`: noVNC symlinked from `/usr/share/novnc`, plus
  `web/index.html` (device detection, `?ui=desktop|mobile` to force) and
  `web/m.html`, a touch UI for phones: tap = click, hold = drag, one finger =
  pan, two fingers = scroll, pinch = zoom, and a toolbar with keyboard, Tab,
  Enter, Backspace, Esc, arrows and zoom.
- The panel says whether the agent Chrome is open. It looks for a Chrome
  process started with `--user-data-dir=$HOME/.agent-chrome-profile` (an
  example folder); change `CHROME_PATTERN` in `server.ts` to the profile
  folder your agent browser uses.

## What it needs

The plugin only drives a share that the host provides. On the bb server:

- Linux with systemd, an X display (for example Xvfb) with the agent browser
  on it. Set its number in `SCREEN_SHARE_DISPLAY` in the unit file (`:20` in
  the example).
- `novnc`, `websockify`, `x11vnc`, and the `tailscale` CLI with HTTPS certificates enabled.
- `host/screen-share-serve` copied to `~/bin/screen-share-serve`, and
  `host/screen-share.service.example` installed as
  `/etc/systemd/system/screen-share.service` with your user and paths.
- Passwordless sudo for the bb user for `systemctl start|stop|restart
  screen-share.service` and `tailscale serve`.
- bb 0.41 or newer.

## Install

From a clone of this repository:

```sh
cd screen-share
npm ci --ignore-scripts
bb plugin install . --yes
```

Then set the two settings below to your own machine.

## Settings

- **Viewer URL**: where `tailscale serve` exposes the share, for example
  `https://<machine>.<tailnet>/vnc/` (see `tailscale serve status`). Must be
  reachable from the device you view on.
- **bb URL on the tailnet**: your bb address on the tailnet, used to build
  the one-click start link.

## Surfaces

- Sidebar footer button: starts the share and opens the viewer in a new tab.
- Thread right panel "Screen share": status and a Start button (opening the
  panel never starts the share). On desktop it embeds the viewer next to the
  chat; on a phone it offers an Open viewer button for the touch UI.
- `GET /api/v1/plugins/screen-share/http/open`: starts the share and
  redirects to the viewer.
- `bb screen-share [start|status|stop|link] [--json]`.
