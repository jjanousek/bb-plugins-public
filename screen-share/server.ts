// bb-plugin-screen-share — backend.
//
// Starts and stops the on-demand screen share of the agent browser display
// and reports whether anyone is watching. The share itself is
// screen-share.service: x11vnc -> websockify + noVNC over unix sockets, mounted by
// tailscale serve at /vnc on the tailnet HTTPS host. No TCP port, no VNC
// password; being inside the tailnet is the authentication.
//
// Surfaces: RPC for the panel, a GET /open route that starts the share and
// redirects to the viewer (one click from anywhere), a `bb screen-share` CLI,
// and a short instruction block so agents know to offer the link when a site
// needs a human login.
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const UNIT = "screen-share.service";
const RUN_DIR = join(homedir(), ".screen-share", "run");
const WEB_SOCK = join(RUN_DIR, "web.sock");
const RFB_SOCK = join(RUN_DIR, "rfb.sock");
const SERVE_PATH = "/vnc";
const START_TIMEOUT_MS = 12_000;
// The agent browser's profile folder. An example path: change it to the one your agent Chrome uses.
const CHROME_PATTERN = `^/opt/google/chrome/chrome.*--user-data-dir=${join(homedir(), ".agent-chrome-profile")}`;
const EXEC_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin" };

const exec = promisify(execFile);

const shareStatus = z.object({
  active: z.boolean(),
  viewers: z.number(),
  /** noVNC page with autoconnect; what a browser tab or iframe should load. */
  viewerUrl: z.string(),
  /** bb route that starts the share and redirects to viewerUrl. */
  openUrl: z.string(),
  /** Is the agent Chrome running on the shared profile? Without it the desktop is an empty gray screen. */
  browserOpen: z.boolean(),
  message: z.string().nullable(),
});
export type ShareStatus = z.infer<typeof shareStatus>;

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: shareStatus },
  start: { input: z.null(), output: shareStatus },
  stop: { input: z.null(), output: shareStatus },
});

async function run(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { env: EXEC_ENV, timeout: 15_000 });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr || e.message || String(error) };
  }
}

/** True when something is actually accepting connections on the unix socket (a stale file is not enough). */
function accepting(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    viewerUrl: {
      type: "string",
      label: "Viewer URL",
      description: "Where tailscale serve exposes the share (index.html picks the phone or desktop UI). Must be reachable from the device you are viewing on.",
      default: "https://my-server.example.com/vnc/",
    },
    bbUrl: {
      type: "string",
      label: "bb URL on the tailnet",
      description: "Used to build the one-click start link printed by the CLI.",
      default: "https://my-server.example.com",
    },
  });

  async function urls(): Promise<{ viewerUrl: string; openUrl: string }> {
    const { viewerUrl, bbUrl } = await settings.get();
    const page = new URL(viewerUrl);
    page.searchParams.set("autoconnect", "1");
    page.searchParams.set("reconnect", "1");
    page.searchParams.set("reconnect_delay", "1500");
    return {
      viewerUrl: page.toString(),
      openUrl: `${bbUrl.replace(/\/$/, "")}/api/v1/plugins/${bb.pluginId}/http/open`,
    };
  }

  /** `is-active` exits non-zero for a stopped unit, so the exit code is not a failure signal here; the word is. */
  async function isUnitActive(): Promise<boolean> {
    const result = await run("systemctl", ["is-active", UNIT]);
    return result.stdout.trim() === "active";
  }

  /**
   * One `ss` call answers both questions about x11vnc: a LISTEN line means it
   * is alive and accepting, and each ESTAB line is one attached viewer.
   *
   * ss prints one line per connection, not one per end: only the accepted
   * end carries the path, the peer shows `* <inode>`. So the ESTAB count is
   * the viewer count as it stands, with no halving.
   *
   * Checking the LISTEN line matters because x11vnc runs with `-bg`, so it is
   * not the unit's main process. It can die with websockify still serving the
   * page, and systemd never notices.
   */
  async function rfbState(): Promise<{ ok: boolean; listening: boolean; viewers: number }> {
    const result = await run("ss", ["-H", "-x", "-a", "src", RFB_SOCK]);
    const states = result.stdout.split("\n").map((line) => line.trim().split(/\s+/)[1]);
    return { ok: result.ok, listening: states.includes("LISTEN"), viewers: states.filter((s) => s === "ESTAB").length };
  }

  async function browserOpen(): Promise<boolean> {
    const result = await run("pgrep", ["-f", CHROME_PATTERN]);
    return result.ok && result.stdout.trim().length > 0;
  }

  async function status(message: string | null = null): Promise<ShareStatus> {
    // Counting unconditionally is the same answer, since a stopped share has
    // no connections to count, and it joins the batch instead of following it.
    const [unitActive, links, chrome, rfb, answering] = await Promise.all([
      isUnitActive(), urls(), browserOpen(), rfbState(), accepting(WEB_SOCK),
    ]);
    // If ss itself failed we cannot tell whether x11vnc is listening, so do not
    // let that alone report the share as down.
    const active = unitActive && answering && (!rfb.ok || rfb.listening);
    return {
      active,
      viewers: active ? rfb.viewers : 0,
      viewerUrl: links.viewerUrl,
      openUrl: links.openUrl,
      browserOpen: chrome,
      message,
    };
  }

  /** tailscale serve keeps its config in tailscaled state; re-add the mount if it went missing. */
  async function ensureServeMount(): Promise<string | null> {
    const current = await run("tailscale", ["serve", "status", "--json"]);
    if (current.ok && current.stdout.includes(`"${SERVE_PATH}"`)) return null;
    const added = await run("sudo", ["-n", "tailscale", "serve", "--bg", "--set-path", SERVE_PATH, `unix:${WEB_SOCK}`]);
    if (!added.ok) return `tailscale serve mount missing and could not be re-added: ${added.stderr.trim()}`;
    bb.log.warn(`re-added tailscale serve mount ${SERVE_PATH}`);
    return null;
  }

  async function start(): Promise<ShareStatus> {
    // status() is the one definition of active: systemd says so, socket answers.
    const current = await status();
    if (current.active) return { ...current, message: await ensureServeMount() };
    // A live unit with a dead share means x11vnc went without systemd seeing
    // it. `start` is a no-op on an active unit, so that case needs a restart.
    const verb = (await isUnitActive()) ? "restart" : "start";
    const started = await run("sudo", ["-n", "systemctl", verb, UNIT]);
    if (!started.ok) return status(`could not ${verb} ${UNIT}: ${started.stderr.trim()}`);
    const deadline = Date.now() + START_TIMEOUT_MS;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      ready = await accepting(WEB_SOCK);
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) return status(`${UNIT} started but nothing answers on ${WEB_SOCK}; see journalctl -u ${UNIT}`);
    bb.log.info("screen share started");
    return status(await ensureServeMount());
  }

  async function stop(): Promise<ShareStatus> {
    const stopped = await run("sudo", ["-n", "systemctl", "stop", UNIT]);
    if (!stopped.ok) return status(`could not stop ${UNIT}: ${stopped.stderr.trim()}`);
    bb.log.info("screen share stopped");
    return status();
  }

  bb.rpc.register(rpcContract, {
    status: () => status(),
    start: () => start(),
    stop: () => stop(),
  });

  // One click from anywhere: start, then land on the viewer.
  bb.http.route("GET", "/open", async () => {
    const state = await start();
    if (!state.active) {
      return new Response(`Screen share is not available.\n${state.message ?? ""}\n`, {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return Response.redirect(state.viewerUrl, 302);
  });

  bb.cli.register({
    name: "screen-share",
    summary: "Screen share of the agent browser display for logging into sites by hand",
    commands: [
      { name: "start", summary: "Start the share and print the viewer link", usage: "bb screen-share start" },
      { name: "status", summary: "Is the share running, how many viewers", usage: "bb screen-share [status] [--json]" },
      { name: "stop", summary: "Stop the share (it is permanent, so it stays off until something starts it)", usage: "bb screen-share stop" },
      { name: "link", summary: "Print the one-click link that starts the share and opens the viewer", usage: "bb screen-share link" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command = "status"] = argv.filter((arg) => arg !== "--json");
      let state: ShareStatus;
      if (command === "start") state = await start();
      else if (command === "stop") state = await stop();
      else if (command === "link") {
        const { openUrl } = await urls();
        return { exitCode: 0, stdout: openUrl };
      } else if (command === "status") state = await status();
      else return { exitCode: 1, stderr: "usage: bb screen-share [start|status|stop|link] [--json]" };
      if (json) return { exitCode: 0, stdout: JSON.stringify(state) };
      const lines = [
        state.active
          ? `Screen share is ON with ${state.viewers} viewer${state.viewers === 1 ? "" : "s"}.`
          : "Screen share is OFF.",
      ];
      if (state.active) lines.push(`Watch: ${state.viewerUrl}`);
      if (!state.browserOpen) lines.push("No agent browser window is open right now, so you get the bare desktop and its panel. Ask an agent to navigate to a page first.");
      lines.push(`One-click start link: ${state.openUrl}`);
      // The example unit makes the share permanent, so say so only when it is actually up; the
      // sentence would be a claim about a unit that is not there otherwise.
      if (state.active) lines.push("Permanent: it does not stop itself.");
      if (state.message) lines.push(`Note: ${state.message}`);
      return { exitCode: state.message ? 1 : 0, stdout: lines.join("\n") };
    },
  });

  bb.agents.contributeInstructions(() =>
    [
      "Screen share of the agent browser: when a site shows a sign-in page, 2FA prompt, or captcha, do not type credentials.",
      "Run `bb screen-share start` and give the user the printed link (tailnet only, no password). They log in by hand in that window; the cookies land in the shared Chrome profile.",
      "The share is permanent, so the link works straight away and keeps working; you do not need to warn them to hurry.",
    ].join(" "),
  );

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
