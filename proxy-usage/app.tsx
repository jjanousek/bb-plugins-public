// bb-plugin-proxy-usage: frontend.
//
// One sidebar footer button next to bb's own usage indicator, plus a compact
// live status strip above the footer menu: one row per subscription (dot,
// label, mini bar, percent) and one row for the server checks. Hover on the
// button, or a click or tap on either, opens a popup listing every account
// with its limits and the server check results. The host paints the button
// itself (sidebarFooterAction is icon-only), so the popup, the strip, and the
// small status dot on the button come from a content script.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { AccountUsage, UsageState, UsageWindow } from "./server";
import {
  accountVouchedFor,
  activeFreshnessState,
  ageText,
  buildServerMetrics,
  freshnessText,
  isAccountInUse,
  POLL_WINDOW_MS,
  SERVER_METRICS_WINDOW_MS,
  stripUsageRows,
  switchWarning,
  vouchedFor,
  type HealthLevel,
  type ServerHealth,
  type ServerMetricRow,
  type ServerMetrics,
  type StripUsageRow,
} from "./usage";

const PLUGIN_ID = "proxy-usage";
const ACTION_ID = "accounts";
const BUTTON_SELECTOR = `[data-testid="plugin-sidebar-footer-action-${PLUGIN_ID}-${ACTION_ID}"]`;
const TOGGLE_EVENT = "proxy-usage:toggle";
/** The footer's overflow button (bb 0.46), used as the anchor when ours is in its menu. */
const MORE_SELECTOR = 'button[aria-label="More footer actions"]';
const FOOTER_SELECTOR = 'div[data-sidebar="footer"]';
const STRIP_CLASS = "proxy-usage-strip";
/** Below this width the strip shows only its dots, on one line. */
const STRIP_NARROW_PX = 160;

const POLL_MS = 60_000;
const METRICS_POLL_MS = 12_000;
const MIN_GAP_MS = 10_000;
const HOVER_MS = 250;
const CLOSE_GRACE_MS = 250;
/** How long to wait after a tap before replaying a render it held back. */
const REPLAY_MS = 300;

const WARN = 60;
const DANGER = 85;

// --- data -------------------------------------------------------------------

async function rpc<T>(method: string, input: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input ?? null),
    signal,
  });
  const envelope = await response.json();
  if (!envelope?.ok) throw new Error(envelope?.error?.message ?? "rpc failed");
  return envelope.result as T;
}

function tone(percent: number | null): string {
  if (percent === null) return "var(--muted-foreground)";
  if (percent > DANGER) return "var(--destructive-text, var(--destructive))";
  if (percent >= WARN) return "var(--warning-text, var(--warning))";
  return "var(--primary, var(--foreground))";
}

function levelTone(level: HealthLevel): string {
  switch (level) {
    case "green":
      return "var(--success)";
    case "amber":
      return "var(--warning-text, var(--warning))";
    case "red":
      return "var(--destructive-text, var(--destructive))";
    default:
      return "var(--muted-foreground)";
  }
}

// --- failure reporting --------------------------------------------------------

const warned = new Set<string>();
/** Logs the first failure of each kind and nothing after, so a broken poll cannot flood the console. */
function warnOnce(where: string, error?: unknown): void {
  if (warned.has(where)) return;
  warned.add(where);
  if (error === undefined) console.warn(`[proxy-usage] ${where}`);
  else console.warn(`[proxy-usage] ${where}:`, error instanceof Error ? error.message : error);
}

/** Wraps a timer or observer callback so a throw is logged once instead of escaping. */
function safely(where: string, fn: () => void): () => void {
  return () => {
    try {
      fn();
    } catch (error) {
      warnOnce(where, error);
    }
  };
}

/** Runs a promise nobody awaits, logging its first rejection. */
function background(where: string, promise: Promise<unknown>): void {
  promise.catch((error: unknown) => warnOnce(where, error));
}

function worstPercent(state: UsageState | null): number | null {
  if (!state) return null;
  let worst: number | null = null;
  for (const account of state.accounts) {
    if (!isAccountInUse(account)) continue;
    for (const window of account.windows) {
      if (worst === null || window.usedPercent > worst) worst = window.usedPercent;
    }
  }
  if (state.antigravity && isAccountInUse(state.antigravity)) {
    for (const window of state.antigravity.windows) {
      if (worst === null || window.usedPercent > worst) worst = window.usedPercent;
    }
  }
  return worst;
}

/**
 * "Resets in 2h 15m · Tue 9:00 PM". The countdown is the unambiguous part;
 * the clock time is a courtesy. Beyond 24 hours the date is spelled out, so a
 * reset several days out is never mistaken for one today.
 */
function resetText(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const now = Date.now();
  const diffMin = Math.round((at.getTime() - now) / 60_000);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diffMin <= 0) return `Reset due · ${time}`;
  const hours = Math.floor(diffMin / 60);
  const minutes = diffMin % 60;
  let inText: string;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    inText = `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    inText = `${hours}h ${minutes}m`;
  } else {
    inText = `${minutes}m`;
  }
  const dayName = at.toLocaleDateString([], { weekday: "short" });
  const when =
    hours >= 24
      ? `${dayName} ${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`
      : `${dayName} ${time}`;
  return `Resets in ${inText} · ${when}`;
}

// --- DOM helpers ------------------------------------------------------------

function el(tag: string, style: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.setAttribute("style", style);
  if (text !== undefined) node.textContent = text;
  return node;
}

const PANEL_STYLE = [
  "position:fixed",
  "z-index:2147483000",
  "width:340px",
  "max-width:calc(100vw - 16px)",
  "max-height:calc(100dvh - 24px)",
  "overflow-y:auto",
  "box-sizing:border-box",
  "padding:0.85rem",
  "border-radius:0.75rem",
  "border:1px solid var(--border)",
  "background:var(--popover, var(--background))",
  "color:var(--popover-foreground, var(--foreground))",
  // A modal sidebar drawer sets pointer-events:none on body; the popup is
  // appended to body, so it has to opt back in to stay tappable.
  "pointer-events:auto",
  "box-shadow:0 8px 28px rgba(0,0,0,0.35)",
  "font-size:0.8rem",
  "line-height:1.35",
  "font-variant-numeric:tabular-nums",
].join(";");

const DANGER_TEXT = "color:var(--destructive-text, var(--destructive))";

const MUTED = "color:var(--muted-foreground);font-size:0.72rem";

/**
 * Touch sizing (44px targets under a coarse pointer) and the strip's narrow
 * collapse. Padding needs !important because the elements carry inline styles.
 */
const COARSE_CSS =
  // bb 0.48.1 sets h-(--bb-app-chrome-row-height) py-0 justify-center (48px)
  // on div[data-sidebar="footer"] in framed desktop mode inside a clipped
  // row-start-2 cell, which slices off the top two rows of the strip and the
  // bottom menu row unless the footer grows to fit its children.
  `div[data-sidebar="footer"]:has(> .${STRIP_CLASS}){height:auto!important;padding-top:0.5rem!important;padding-bottom:var(--bb-frame-footer-inset,0.5rem)!important;justify-content:flex-start!important;}` +
  ".grid > .col-start-1.row-start-2{height:auto!important;align-items:flex-end!important;padding-bottom:var(--bb-frame-footer-inset,7px)!important;}" +
  `.${STRIP_CLASS}:focus-visible{outline:2px solid var(--ring, var(--primary, var(--foreground)));outline-offset:1px;}` +
  `.${STRIP_CLASS}[data-narrow="true"]{flex-direction:row!important;flex-wrap:nowrap;justify-content:center;align-items:center;gap:3px!important;padding-left:3px!important;padding-right:3px!important;overflow:hidden;}` +
  `.${STRIP_CLASS}[data-narrow="true"] .proxy-usage-strip-row{gap:0!important;}` +
  `.${STRIP_CLASS}[data-narrow="true"] .proxy-usage-strip-detail{display:none!important;}` +
  "@media (pointer:coarse){" +
  `.${STRIP_CLASS}{min-height:44px;min-width:44px;padding:6px 10px!important;}` +
  `.${STRIP_CLASS}[data-narrow="true"]{padding-left:3px!important;padding-right:3px!important;}` +
  ".proxy-usage-panel .proxy-usage-btn{min-height:44px;min-width:44px;padding:0 0.75rem!important;}" +
  "}";
let coarseStyleOn = false;
function ensureCoarseStyle(): void {
  if (coarseStyleOn) return;
  coarseStyleOn = true;
  const style = document.createElement("style");
  style.textContent = COARSE_CSS;
  document.head.append(style);
}

// A grey bar for figures the popup cannot vouch for. Keeping the last good
// number is useful; painting it in the danger scale is not, because that is
// what makes a stale reading look like a live one.
function bar(window: UsageWindow, vouched: boolean): HTMLElement {
  const row = el("div", "margin-top:0.6rem");
  const head = el("div", "display:flex;align-items:center;gap:0.4rem");
  head.append(el("span", "font-weight:500", window.label));
  const colour = vouched ? tone(window.usedPercent) : "var(--muted-foreground)";
  // A pool at 100% is not "a high number", it is the thing that stops work.
  // Beside a comfortable blended figure it reads as just another row, so say it.
  if (vouched && window.usedPercent >= 100) {
    head.append(pill("Limit hit", tone(100)));
  }
  head.append(el("span", `margin-left:auto;font-weight:600;color:${colour}`, `${Math.round(window.usedPercent)}%`));
  row.append(head);
  const track = el(
    "div",
    "margin-top:0.3rem;height:6px;border-radius:3px;background:color-mix(in srgb, currentColor 12%, transparent);overflow:hidden",
  );
  const fill = el(
    "div",
    `height:100%;width:${Math.max(0, Math.min(100, window.usedPercent))}%;border-radius:3px;background:${colour}`,
  );
  track.append(fill);
  row.append(track);
  const reset = resetText(window.resetsAt);
  row.append(
    el(
      "div",
      `${MUTED};margin-top:0.25rem`,
      reset || (window.usedPercent === 0 ? "Starts with the next request" : "No reset time reported"),
    ),
  );
  return row;
}

/** A small rounded label; the colour is used for text and a faint tint behind it. */
function pill(text: string, colour: string): HTMLElement {
  return el(
    "span",
    `display:inline-block;padding:0.05rem 0.45rem;border-radius:999px;font-size:0.68rem;font-weight:600;` +
      `color:${colour};background:color-mix(in srgb, ${colour} 14%, transparent);white-space:nowrap`,
    text,
  );
}

/**
 * One line on turns that failed on a limit and will resume by themselves:
 * "2 turns resume after a limit, next Fri 6:30 PM (thr_example)". The alert, when the
 * proxy lost its login and retries stopped, takes the line instead.
 */
function resumeLine(state: UsageState): { text: string; alert: boolean } | null {
  if (state.resumeAlert) return { text: `Auto-resume stopped: ${state.resumeAlert}`, alert: true };
  const now = Date.now();
  const waiting = (state.resumes ?? []).filter((row) => row.sendAt > now);
  if (waiting.length === 0) return null;
  const next = waiting[0];
  const time = new Date(next.sendAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const count = waiting.length === 1 ? "1 turn resumes" : `${waiting.length} turns resume`;
  return { text: `${count} after a limit, next ${time} (${next.threadId})`, alert: false };
}

/** What the popup can ask the backend to do. Each returns after the state was refetched. */
interface Actions {
  refresh: () => void;
  use: (file: string) => void;
  /** Redraw from the state on hand, with no fetch. */
  rerender: () => void;
  /** Remove an account from the proxy, after the popup's confirmation. */
  eject: (file: string) => void;
  /** Put an ejected account back within its 7 days. */
  undoEject: (file: string) => void;
}

/** The account whose Eject confirmation is open. */
let confirmingEject: string | null = null;

/** A warned Switch that has had its first tap, and until when the second one counts. */
let armedSwitch: { file: string; until: number } | null = null;
const ARM_MS = 5_000;

/** Outcome of the last account switch, shown at the bottom of the popup. */
let actionNotice: string | null = null;
/** True while a switch is in flight; the buttons are inert meanwhile. */
let actionBusy = false;

const BUTTON_STYLE =
  "cursor:pointer;border:1px solid var(--border);border-radius:0.4rem;background:transparent;color:inherit;height:1.6rem;padding:0 0.55rem;font-size:0.72rem;font-weight:500;line-height:1;white-space:nowrap";

function smallButton(label: string, onClick: () => void): HTMLElement {
  const button = el("button", BUTTON_STYLE, label);
  button.classList.add("proxy-usage-btn");
  if (typeof matchMedia !== "undefined" && matchMedia("(pointer:coarse)").matches) button.style.fontSize = "0.9rem";
  if (actionBusy) {
    button.setAttribute("disabled", "");
    button.style.opacity = "0.5";
    button.style.cursor = "default";
  }
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!actionBusy) onClick();
  });
  return button;
}

function accountBlock(
  account: AccountUsage,
  last: boolean,
  inUseCount: number,
  vouched: boolean,
  actions?: Actions,
): HTMLElement {
  const inUse = isAccountInUse(account);
  const block = el(
    "div",
    "padding:0.7rem 0.75rem;border-radius:0.55rem;border:1px solid var(--border)" +
      (inUse ? ";border-color:color-mix(in srgb, var(--success) 45%, transparent)" : "") +
      (last ? "" : ";margin-bottom:0.5rem"),
  );
  const head = el("div", "display:flex;justify-content:space-between;align-items:center;gap:0.5rem;min-height:1.6rem");
  const name = el(
    "span",
    "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1",
    account.email,
  );
  name.title = account.email;
  head.append(name);
  // The tag says one thing only: is the proxy sending requests to this account.
  // An account on hold at Anthropic cannot serve requests even if its file on
  // disk still says disabled: false.
  const soleAccount = inUse && inUseCount === 1;
  if (inUse) head.append(pill("Active", "var(--success)"));
  if (account.status === "on-hold") {
    head.append(pill("On hold", tone(100)));
  } else if (actions && !soleAccount) {
    // Switching stays the user's call. When the account is nearly spent the button
    // says so, and the first tap only arms it; the second one switches.
    const warning = vouched ? switchWarning(account, Date.now()) : null;
    if (warning === null) {
      head.append(smallButton("Switch", () => actions.use(account.file)));
    } else {
      const armed = armedSwitch?.file === account.file && armedSwitch.until > Date.now();
      head.append(
        smallButton(armed ? "Tap again to switch" : `Switch · ${warning}`, () => {
          if (armedSwitch?.file === account.file && armedSwitch.until > Date.now()) {
            armedSwitch = null;
            actions.use(account.file);
          } else {
            armedSwitch = { file: account.file, until: Date.now() + ARM_MS };
            actions.rerender();
          }
        }),
      );
    }
  }
  block.append(head);
  if (account.windows.length === 0) {
    block.append(el("div", `${MUTED};margin-top:0.3rem`, account.message ?? "No usage figures yet"));
  } else {
    for (const window of account.windows) block.append(bar(window, vouched));
    if (account.status !== "ok" && account.message) {
      const text =
        account.status === "stale" && account.okAt !== null
          ? `Stale figures (last good ${ageText(account.okAt)}): ${account.message}`
          : account.status === "stale"
            ? `Stale figures: ${account.message}`
            : account.okAt !== null
              // The bars above are from okAt, not from the check that just
              // failed, so the line dates them too.
              ? `Figures ${ageText(account.okAt)}; last check failed: ${account.message}`
              : `Last check failed: ${account.message}`;
      block.append(el("div", `${MUTED};margin-top:0.3rem`, text));
    }
  }
  // Eject removes an account from the proxy. Not offered on the one in use:
  // the backend refuses that too, and an offer that always fails is noise.
  if (actions && !inUse) {
    if (confirmingEject === account.file) {
      const box = el(
        "div",
        `margin-top:0.55rem;padding:0.5rem 0.6rem;border-radius:0.45rem;border:1px solid color-mix(in srgb, ${tone(100)} 45%, transparent)`,
      );
      box.append(
        el(
          "div",
          "font-size:0.75rem;line-height:1.4",
          `Eject ${account.email}? The proxy stops using and refreshing it, and it leaves this list. You can undo for 7 days; after that it needs a fresh login.`,
        ),
      );
      const row = el("div", "display:flex;gap:0.75rem;justify-content:flex-end;margin-top:0.45rem");
      row.append(smallButton("Cancel", () => {
        confirmingEject = null;
        actions.rerender();
      }));
      const go = smallButton("Eject", () => {
        confirmingEject = null;
        actions.eject(account.file);
      });
      go.style.color = tone(100);
      go.style.borderColor = `color-mix(in srgb, ${tone(100)} 55%, transparent)`;
      row.append(go);
      box.append(row);
      block.append(box);
    } else {
      const foot = el("div", "display:flex;justify-content:flex-end;margin-top:0.45rem");
      const eject = smallButton("Eject…", () => {
        confirmingEject = account.file;
        actions.rerender();
      });
      eject.style.color = "var(--muted-foreground)";
      foot.append(eject);
      block.append(foot);
    }
  }
  return block;
}

/** Accounts ejected in the last 7 days, each with Undo. */
function ejectedBlock(ejected: NonNullable<UsageState["ejected"]>, actions?: Actions): HTMLElement {
  const block = el("div", "margin-top:0.6rem");
  block.append(el("div", `${MUTED};margin-bottom:0.3rem`, "Ejected"));
  for (const item of ejected) {
    const row = el("div", "display:flex;align-items:center;gap:0.5rem;min-height:1.6rem");
    const name = el("span", `${MUTED};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1`, item.email);
    name.title = item.email;
    row.append(name);
    const days = Math.max(0, Math.ceil((item.purgeAt - Date.now()) / 86_400_000));
    row.append(el("span", `${MUTED};white-space:nowrap`, `${days} d left`));
    if (actions) row.append(smallButton("Undo", () => actions.undoEject(item.file)));
    block.append(row);
  }
  return block;
}

/** The server checks to show: the backend's, unless missing or older than one poll window. */
function effectiveServerHealth(state: UsageState | null, now: number = Date.now()): ServerHealth {
  const health = state?.serverHealth;
  if (health?.checkedAt) {
    const age = now - Date.parse(health.checkedAt);
    if (Number.isFinite(age) && age <= POLL_WINDOW_MS) return health;
  }
  return { level: "unknown", word: "unknown", tooltip: "Server checks unavailable or stale", checkedAt: null, checks: [] };
}

/** Live CPU and Memory readings from the backend, or unknown if missing or older than SERVER_METRICS_WINDOW_MS. */
function effectiveServerMetrics(state: UsageState | null, now: number = Date.now()): ServerMetrics {
  const metrics = state?.serverMetrics;
  if (metrics?.checkedAt) {
    const age = now - Date.parse(metrics.checkedAt);
    if (Number.isFinite(age) && age <= SERVER_METRICS_WINDOW_MS) return metrics;
  }
  return buildServerMetrics({ checkedAt: null, cpuPercent: null, cores: null, loadavg: null, mem: null }, now);
}

/**
 * A 7px status dot. Unknown is hollow, so it can never be read as a pale
 * green: no claim is made when nothing was measured.
 */
function statusDot(level: HealthLevel): HTMLElement {
  const base = "flex:none;display:inline-block;width:7px;height:7px;border-radius:50%;box-sizing:border-box";
  return el(
    "span",
    level === "unknown"
      ? `${base};background:transparent;border:1.5px solid var(--muted-foreground)`
      : `${base};background:${levelTone(level)}`,
  );
}

/** Every server check spelled out, for touch users who cannot hover the strip. */
function serverBlock(server: ServerHealth, metrics: ServerMetrics): HTMLElement {
  const block = el("div", "margin-top:0.75rem");
  block.setAttribute("data-testid", "proxy-usage-popup-server");
  const head = el("div", "display:flex;align-items:center;gap:0.4rem;font-weight:600");
  head.append(statusDot(server.level));
  head.append(el("span", `color:${levelTone(server.level)}`, `Server · ${server.word}`));
  block.append(head);
  for (const [id, item] of [
    ["cpu", metrics.cpu],
    ["memory", metrics.memory],
  ] as const) {
    const line = el(
      "div",
      `font-size:0.72rem;margin-top:0.25rem;color:${levelTone(item.level)}` +
        (item.level === "unknown" ? ";font-style:italic" : ""),
      item.tooltip,
    );
    line.setAttribute("data-testid", `proxy-usage-popup-server-${id}`);
    line.setAttribute("data-level", item.level);
    block.append(line);
  }
  if (server.checks.length === 0) {
    block.append(el("div", `${MUTED};margin-top:0.25rem;font-style:italic`, server.tooltip));
  }
  for (const check of server.checks) {
    const line = el(
      "div",
      `font-size:0.72rem;margin-top:0.25rem;color:${levelTone(check.level)}` +
        (check.level === "unknown" ? ";font-style:italic" : ""),
      check.detail,
    );
    line.setAttribute("data-testid", `proxy-usage-popup-server-${check.id}`);
    line.setAttribute("data-level", check.level);
    block.append(line);
  }
  return block;
}

class Popup {
  private panel: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  pinned = false;
  private closeTimer: number | null = null;
  /** True between a pointer going down inside the panel and the tap finishing. */
  private holding = false;
  /** A render that arrived mid-tap, replayed once the tap is over. */
  private deferred: { state: UsageState | null; actions?: Actions } | null = null;
  private replayTimer: number | null = null;
  // render() rebuilds every child, so a refresh landing between pointerdown and
  // click detaches the element the finger started on and the click is never
  // dispatched to it. A quick mouse click usually escapes; a thumb is down
  // long enough to lose the tap, so the tap seems to do nothing.
  private onPanelDown = () => {
    this.holding = true;
    this.clearReplay();
  };
  private onDocUp = () => {
    if (!this.holding) return;
    this.holding = false;
    if (!this.deferred) return;
    // Replay after the click has been dispatched, not on pointerup, which
    // still runs before it.
    this.clearReplay();
    this.replayTimer = window.setTimeout(
      safely("popup replay", () => {
        this.replayTimer = null;
        const next = this.deferred;
        this.deferred = null;
        if (next) this.render(next.state, next.actions);
      }),
      REPLAY_MS,
    );
  };
  private onDocPointer = (event: PointerEvent) => {
    if (!this.panel || !this.anchor) return;
    const target = event.target;
    if (target instanceof Node && (this.panel.contains(target) || this.anchor.contains(target))) return;
    this.close();
  };
  // Registered on window in the capture phase, ahead of the sidebar drawer's
  // own Escape handling on document, so Escape closes the popup and nothing else.
  private onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    event.preventDefault();
    this.close();
  };
  // The mobile sidebar drawer closes on a pointerdown or focus outside itself,
  // and the popup lives on body, outside it. Taps inside the popup stay here.
  private keepInside = (event: Event) => {
    event.stopPropagation();
  };
  private onResize = () => {
    this.place();
  };

  get isOpen(): boolean {
    return this.panel !== null;
  }

  /** True while open beside an element that has left the page. */
  get orphaned(): boolean {
    return this.panel !== null && this.anchor !== null && !this.anchor.isConnected;
  }

  /** Moves an orphaned popup to the anchor's replacement, or closes it when there is none. */
  follow(replacementFor: (old: HTMLElement) => HTMLElement | null): void {
    const old = this.anchor;
    if (!this.panel || !old || old.isConnected) return;
    const next = replacementFor(old);
    if (next) {
      this.anchor = next;
      this.place();
    } else {
      this.close();
    }
  }

  open(anchor: HTMLElement, state: UsageState | null, pinned: boolean, actions: Actions): void {
    this.cancelClose();
    this.anchor = anchor;
    this.pinned = this.pinned || pinned;
    if (!this.panel) {
      this.panel = el("div", PANEL_STYLE);
      this.panel.classList.add("proxy-usage-panel");
      if (typeof matchMedia !== "undefined" && matchMedia("(pointer:coarse)").matches) this.panel.style.fontSize = "0.9rem";
      this.panel.addEventListener("pointerenter", () => this.cancelClose());
      this.panel.addEventListener("pointerleave", () => this.armClose());
      this.panel.addEventListener("pointerdown", this.onPanelDown);
      this.panel.addEventListener("pointerdown", this.keepInside);
      this.panel.addEventListener("focusin", this.keepInside);
      document.body.append(this.panel);
      document.addEventListener("pointerdown", this.onDocPointer, true);
      document.addEventListener("pointerup", this.onDocUp, true);
      document.addEventListener("pointercancel", this.onDocUp, true);
      window.addEventListener("keydown", this.onKey, true);
      window.addEventListener("resize", this.onResize);
    }
    this.render(state, actions);
  }

  render(state: UsageState | null, actions?: Actions): void {
    const panel = this.panel;
    if (!panel) return;
    if (this.holding) {
      this.deferred = { state, actions };
      return;
    }
    panel.replaceChildren();
    const makeButtons = () => {
      const buttons = el("div", "display:flex;gap:0.4rem;align-items:center");
      if (actions) buttons.append(smallButton("Refresh", () => actions.refresh()));
      const close = smallButton("\u2715", () => this.close());
      close.setAttribute("aria-label", "Close");
      close.style.padding = "0";
      close.style.width = "1.6rem";
      buttons.append(close);
      return buttons;
    };
    const allAccounts = state?.accounts ?? [];
    const agAccounts = allAccounts.filter((account) => account.provider === "google-antigravity");
    const claudeAccounts = allAccounts.filter((account) => (account.provider ?? "anthropic") !== "google-antigravity");
    const renderSection = (
      headingText: string,
      subtitleText: string,
      sectionAccounts: readonly AccountUsage[],
      withTopButtons: boolean,
      topMargin: boolean,
    ) => {
      const title = el(
        "div",
        "display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem;margin-bottom:0.55rem" +
          (topMargin ? ";margin-top:0.8rem" : ""),
      );
      const heading = el("div", "");
      heading.append(el("div", "font-weight:600;font-size:0.9rem", headingText));
      heading.append(el("div", MUTED, subtitleText));
      title.append(heading);
      if (actions && withTopButtons) title.append(makeButtons());
      panel.append(title);
      const inUseCount = sectionAccounts.filter(isAccountInUse).length;
      if (inUseCount > 1) {
        panel.append(
          el(
            "div",
            `${MUTED};margin-bottom:0.6rem;${DANGER_TEXT}`,
            `${inUseCount} accounts are in use at once, so requests can land on either one. Press Switch on the one to keep.`,
          ),
        );
      }
      const ordered = [...sectionAccounts].sort((a, b) => Number(!isAccountInUse(a)) - Number(!isAccountInUse(b)));
      ordered.forEach((account, index) => {
        panel.append(accountBlock(account, index === ordered.length - 1, inUseCount, accountVouchedFor(account), actions));
      });
    };
    if (state?.message && allAccounts.length > 0) {
      panel.append(el("div", `${MUTED};margin-bottom:0.6rem;${DANGER_TEXT}`, state.message));
    }
    if (agAccounts.length > 0) {
      renderSection("Google AI Ultra", "Subscription usage via Antigravity", agAccounts, true, false);
    }
    if (claudeAccounts.length > 0 || agAccounts.length === 0) {
      if (claudeAccounts.length === 0) {
        const title = el(
          "div",
          "display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem;margin-bottom:0.55rem" +
            (agAccounts.length > 0 ? ";margin-top:0.8rem" : ""),
        );
        const heading = el("div", "");
        heading.append(el("div", "font-weight:600;font-size:0.9rem", "Claude accounts"));
        heading.append(el("div", MUTED, "Subscription usage via omp"));
        title.append(heading);
        if (actions && agAccounts.length === 0) title.append(makeButtons());
        panel.append(title);
        panel.append(el("div", MUTED, state?.message ?? "No Claude accounts found in ~/.omp/agent/agent.db."));
      } else {
        renderSection("Claude accounts", "Subscription usage via omp", claudeAccounts, agAccounts.length === 0, agAccounts.length > 0);
      }
    }
    if (state?.ejected && state.ejected.length > 0) panel.append(ejectedBlock(state.ejected, actions));
    const line = state ? resumeLine(state) : null;
    if (line) panel.append(el("div", `${MUTED};margin-top:0.6rem${line.alert ? `;${DANGER_TEXT}` : ""}`, line.text));
    panel.append(serverBlock(effectiveServerHealth(state), effectiveServerMetrics(state)));
    if (state) {
      const foot = el(
        "div",
        `${MUTED};margin-top:0.75rem;padding-top:0.6rem;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:0.5rem`,
      );
      const fresh = activeFreshnessState(state);
      const warn = !actionBusy && !vouchedFor(fresh) ? DANGER_TEXT : "";
      foot.append(el("span", warn, actionBusy ? "Switching…" : freshnessText(fresh)));
      panel.append(foot);
      if (actionNotice) panel.append(el("div", `${MUTED};margin-top:0.35rem;${DANGER_TEXT}`, actionNotice));
    }
    this.place();
  }

  private place(): void {
    const panel = this.panel;
    const anchor = this.anchor;
    if (!panel || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const size = panel.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.right + 8), Math.max(8, window.innerWidth - size.width - 8));
    const top = Math.min(Math.max(8, rect.bottom - size.height), Math.max(8, window.innerHeight - size.height - 8));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  armClose(): void {
    if (this.pinned) return;
    this.cancelClose();
    this.closeTimer = window.setTimeout(safely("popup close", () => this.close()), CLOSE_GRACE_MS);
  }

  cancelClose(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  private clearReplay(): void {
    if (this.replayTimer !== null) {
      window.clearTimeout(this.replayTimer);
      this.replayTimer = null;
    }
  }

  close(): void {
    this.cancelClose();
    this.clearReplay();
    // A confirmation left open must not greet the next opening armed.
    confirmingEject = null;
    armedSwitch = null;
    if (this.panel) {
      this.panel.remove();
      document.removeEventListener("pointerdown", this.onDocPointer, true);
      document.removeEventListener("pointerup", this.onDocUp, true);
      document.removeEventListener("pointercancel", this.onDocUp, true);
      window.removeEventListener("keydown", this.onKey, true);
      window.removeEventListener("resize", this.onResize);
    }
    this.panel = null;
    this.anchor = null;
    this.pinned = false;
    this.holding = false;
    this.deferred = null;
  }
}

/** A small dot in the button corner, coloured by the worst active window. */
class Dot {
  readonly node: HTMLElement;
  constructor() {
    this.node = el(
      "span",
      "position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;pointer-events:none;background:transparent",
    );
  }
  /**
   * The dot is the only part of this plugin visible without opening anything,
   * so it is the surface where a confident colour over old figures does the
   * most damage. Unvouched figures get the neutral tone: still a dot, no claim.
   */
  draw(percent: number | null, vouched: boolean): void {
    const show = percent !== null && vouched;
    this.node.style.background = percent === null ? "transparent" : show ? tone(percent) : tone(null);
    this.node.style.opacity = show && percent >= WARN ? "1" : "0.55";
  }
}

const STRIP_STYLE = [
  "width:100%",
  "box-sizing:border-box",
  "display:flex",
  "flex-direction:column",
  "gap:3px",
  "margin:0",
  "padding:5px 8px",
  "border-radius:0.5rem",
  "border:1px solid var(--sidebar-border, var(--border))",
  "background:color-mix(in srgb, var(--sidebar-accent, var(--muted)) 55%, transparent)",
  "color:var(--sidebar-foreground, var(--foreground))",
  "font:inherit",
  "font-size:0.72rem",
  "line-height:1.25",
  "font-variant-numeric:tabular-nums",
  "cursor:pointer",
  "text-align:left",
].join(";");

/**
 * The live strip above the footer menu: one line per subscription and one for
 * the server. Visible without opening anything, so unknown is drawn hollow and
 * dimmed rather than in any colour that could pass for a reading.
 */
class StatusStrip {
  readonly node: HTMLButtonElement;
  private readonly resize: ResizeObserver | null;

  constructor() {
    this.node = document.createElement("button");
    this.node.type = "button";
    this.node.className = STRIP_CLASS;
    this.node.setAttribute("style", STRIP_STYLE);
    this.node.setAttribute("data-testid", "proxy-usage-footer-strip");
    this.resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(safely("strip resize", () => this.measure()));
  }

  /** Collapses to a line of dots when the footer is too narrow for labels. */
  private measure(): void {
    const narrow = this.node.getBoundingClientRect().width < STRIP_NARROW_PX ? "true" : "false";
    if (this.node.dataset.narrow !== narrow) this.node.dataset.narrow = narrow;
  }

  /**
   * Puts the strip right above the footer menu. Without a footer it goes above
   * the list holding our button or the "More" button. With neither, it stays
   * out of the page and says so once.
   */
  mount(): void {
    let parent: Element | null = null;
    let before: Element | null = null;
    const footer = document.querySelector(FOOTER_SELECTOR);
    if (footer) {
      const menu = footer.querySelector('ul[data-sidebar="menu"]');
      if (menu?.parentElement) {
        parent = menu.parentElement;
        before = menu;
      } else {
        parent = footer;
        before = footer.firstElementChild;
      }
    } else {
      const list = (document.querySelector(BUTTON_SELECTOR) ?? document.querySelector(MORE_SELECTOR))?.closest("ul");
      if (list?.parentElement) {
        parent = list.parentElement;
        before = list;
      }
    }
    if (!parent) {
      if (document.querySelector("[data-sidebar]")) warnOnce("sidebar footer DOM not found; status strip disabled");
      this.unmount();
      return;
    }
    if (before === this.node) return;
    if (this.node.parentElement === parent && this.node.nextElementSibling === before) return;
    parent.insertBefore(this.node, before);
    this.resize?.observe(this.node);
    this.measure();
  }

  unmount(): void {
    this.resize?.unobserve(this.node);
    this.node.remove();
  }

  dispose(): void {
    this.unmount();
    this.resize?.disconnect();
  }

  draw(state: UsageState | null): void {
    const rows = stripUsageRows(state);
    const metrics = effectiveServerMetrics(state);
    const server = effectiveServerHealth(state);
    const serviceWarn = server.level === "red" || server.level === "amber";
    const lines = rows.map((row) => this.usageLine(row));
    lines.push(this.metricLine("proxy-usage-strip-cpu", "CPU", metrics.cpu));
    lines.push(
      this.metricLine(
        "proxy-usage-strip-memory",
        serviceWarn ? "Memory ⚠" : "Memory",
        metrics.memory,
        serviceWarn ? server.tooltip.split("\n")[0] : undefined,
      ),
    );
    this.node.replaceChildren(...lines);
    const summary = [
      ...rows.map((row) => `${row.label} ${row.text}`),
      `CPU ${metrics.cpu.text}`,
      `Memory ${metrics.memory.text}`,
    ].join(", ");
    this.node.setAttribute("aria-label", `${summary}. Open account usage`);
  }

  private miniBar(usedPercent: number | null, level: HealthLevel): HTMLElement {
    const bar = el(
      "span",
      "flex:none;display:inline-block;width:28px;height:4px;border-radius:2px;background:color-mix(in srgb, currentColor 14%, transparent);overflow:hidden",
    );
    bar.classList.add("proxy-usage-strip-detail");
    const used = Math.max(0, Math.min(100, usedPercent ?? 0));
    bar.append(el("span", `display:block;height:100%;width:${used}%;border-radius:2px;background:${levelTone(level)}`));
    return bar;
  }

  private usageLine(row: StripUsageRow): HTMLElement {
    const line = this.line(`proxy-usage-strip-row-${row.key}`, row.level, row.label, row.text, this.miniBar(row.usedPercent, row.level));
    // The backend's tooltip carries raw ISO resets; swap each in for a live
    // countdown, computed now so it stays current between polls.
    line.title = row.tooltip.replace(/resets (\S+)/gu, (match, iso: string) => resetText(iso) || match);
    return line;
  }

  private metricLine(testId: string, label: string, metric: ServerMetricRow, extraNote?: string): HTMLElement {
    const line = this.line(testId, metric.level, label, metric.text, this.miniBar(metric.usedPercent, metric.level));
    line.title = extraNote ? `${metric.tooltip}\n${extraNote}` : metric.tooltip;
    return line;
  }
  /** Dot, label, optional mini bar, and the right-aligned value. */
  private line(testId: string, level: HealthLevel, label: string, value: string, bar?: HTMLElement): HTMLElement {
    const line = el(
      "span",
      "display:flex;align-items:center;gap:6px;min-width:0" +
        (level === "unknown" ? ";color:var(--muted-foreground);font-style:italic;opacity:0.8" : ""),
    );
    line.classList.add("proxy-usage-strip-row");
    line.setAttribute("data-testid", testId);
    line.setAttribute("data-level", level);
    line.append(statusDot(level));
    const name = el("span", "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", label);
    name.classList.add("proxy-usage-strip-detail");
    line.append(name);
    if (bar) line.append(bar);
    const figure = el(
      "span",
      `flex:none;min-width:2.4em;text-align:right;font-weight:600;white-space:nowrap;color:${levelTone(level)}`,
      value,
    );
    figure.classList.add("proxy-usage-strip-detail");
    line.append(figure);
    return line;
  }
}

// --- registration -----------------------------------------------------------

export default definePluginApp((app) => {
  app.slots.sidebarFooterAction({
    id: ACTION_ID,
    title: "Proxy account usage",
    icon: "proxy-usage/rail",
    run: () => {
      document.dispatchEvent(new CustomEvent(TOGGLE_EVENT));
    },
  });

  app.contentScripts.register({
    id: "proxy-usage-popup",
    mount({ signal }) {
      ensureCoarseStyle();
      const popup = new Popup();
      const dot = new Dot();
      const strip = new StatusStrip();
      let state: UsageState | null = null;
      let button: HTMLElement | null = null;
      let restorePosition: string | null = null;
      let hoverTimer: number | null = null;
      let suppressClick = false;
      let lastFetch = 0;
      let inFlight = false;

      const draw = () => {
        dot.draw(worstPercent(state), state !== null && vouchedFor(activeFreshnessState(state)));
        strip.draw(state);
      };

      const detach = () => {
        dot.node.remove();
        if (button && restorePosition !== null) button.style.position = restorePosition;
        restorePosition = null;
        button = null;
      };

      const attach = (next: HTMLElement) => {
        if (button === next && dot.node.parentNode === next) return;
        if (button !== next) detach();
        button = next;
        if (getComputedStyle(next).position === "static") {
          restorePosition = next.style.position;
          next.style.position = "relative";
        }
        next.append(dot.node);
        draw();
      };

      let scheduled = 0;
      const sync = () => {
        scheduled = 0;
        strip.mount();
        const found = document.querySelector<HTMLElement>(BUTTON_SELECTOR);
        if (found) attach(found);
        else if (button) detach();
        // A re-rendered footer replaces the anchor node; follow it, or close
        // when what the popup pointed at is gone (the drawer closed, say).
        popup.follow((old) => {
          if (old === strip.node) return strip.node.isConnected ? strip.node : null;
          if (old.matches(BUTTON_SELECTOR)) return found;
          return document.querySelector<HTMLElement>(MORE_SELECTOR);
        });
      };
      const syncSafely = safely("footer sync", sync);
      const schedule = () => {
        if (scheduled !== 0) return;
        scheduled = window.requestAnimationFrame(syncSafely);
      };
      const domObserver = new MutationObserver(
        safely("footer observer", () => {
          if (button?.isConnected && dot.node.parentNode === button && strip.node.isConnected && !popup.orphaned) return;
          schedule();
        }),
      );
      domObserver.observe(document.body, { childList: true, subtree: true });
      syncSafely();
      strip.draw(state);

      const refresh = async (force = false, hard = false): Promise<void> => {
        if (document.visibilityState === "hidden" || inFlight || signal.aborted) return;
        const now = Date.now();
        if (!force && now - lastFetch < MIN_GAP_MS) return;
        lastFetch = now;
        inFlight = true;
        try {
          state = await rpc<UsageState>(hard ? "refresh" : "state", null, signal);
        } catch (error) {
          if (!signal.aborted) warnOnce("usage state fetch failed", error);
          return;
        } finally {
          inFlight = false;
        }
        draw();
        popup.render(state, actions);
      };

      /** Switch accounts through the backend, then show the refreshed state. */
      const act = async (method: "useAccount", input: unknown): Promise<void> => {
        if (actionBusy) return;
        actionBusy = true;
        actionNotice = null;
        popup.pinned = true;
        popup.render(state, actions);
        let failed = false;
        try {
          state = await rpc<UsageState>(method, input, signal);
          lastFetch = Date.now();
        } catch (error) {
          actionNotice = error instanceof Error ? error.message : String(error);
          failed = true;
        } finally {
          actionBusy = false;
        }
        draw();
        popup.render(state, actions);
        // A failed call does not mean nothing changed: the switch may have been
        // half applied, or applied and lost on the way back. Re-read rather than
        // leaving the pre-switch list on screen beside an error.
        if (failed) background("refresh after switch", refresh(true, true));
      };

      /**
       * Eject and undo go through the plugin's HTTP routes, not RPC: the route
       * hands out a one-time code only to a request with a browser Origin, so
       * only this button can eject (see eject.ts).
       */
      const ejectCall = async (action: "eject" | "undo", file: string): Promise<void> => {
        if (actionBusy) return;
        actionBusy = true;
        actionNotice = null;
        popup.pinned = true;
        popup.render(state, actions);
        try {
          const base = `/api/v1/plugins/${PLUGIN_ID}/http`;
          const post = async (path: string, body: unknown) => {
            const response = await fetch(`${base}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
              signal,
            });
            const reply = (await response.json()) as { ok?: boolean; error?: string; intent?: string; state?: UsageState };
            if (!reply.ok) throw new Error(reply.error ?? `HTTP ${response.status}`);
            return reply;
          };
          const { intent } = await post("/eject-intent", { file, action });
          const done = await post(action === "eject" ? "/eject" : "/eject-undo", { file, intent });
          if (done.state) state = done.state;
          lastFetch = Date.now();
        } catch (error) {
          actionNotice = error instanceof Error ? error.message : String(error);
        } finally {
          actionBusy = false;
        }
        draw();
        popup.render(state, actions);
      };

      const actions: Actions = {
        refresh: () => background("refresh", refresh(true, true)),
        use: (file) => background("switch", act("useAccount", { file })),
        eject: (file) => background("eject", ejectCall("eject", file)),
        undoEject: (file) => background("undo eject", ejectCall("undo", file)),
        rerender: () => {
          popup.render(state, actions);
          // Disarm on its own, so a stray tap minutes later cannot switch.
          window.setTimeout(safely("disarm rerender", () => popup.render(state, actions)), ARM_MS + 50);
        },
      };
      let metricsInFlight = false;
      const refreshMetrics = async (): Promise<void> => {
        if (document.visibilityState === "hidden" || metricsInFlight || inFlight || signal.aborted) return;
        metricsInFlight = true;
        try {
          const serverMetrics = await rpc<ServerMetrics>("metrics", null, signal);
          if (state) state = { ...state, serverMetrics };
        } catch (error) {
          if (!signal.aborted) warnOnce("server metrics fetch failed", error);
          return;
        } finally {
          metricsInFlight = false;
        }
        draw();
        if (popup.isOpen) popup.render(state, actions);
      };

      background("refresh", refresh(true));
      const timer = window.setInterval(
        safely("poll", () => {
          background("refresh", refresh(true));
          // Redraw even when the fetch is skipped or fails, so stale server
          // checks turn unknown and reset countdowns stay current.
          draw();
        }),
        POLL_MS,
      );
      const metricsTimer = window.setInterval(
        safely("metrics poll", () => {
          background("metrics", refreshMetrics());
          draw();
        }),
        METRICS_POLL_MS,
      );
      document.addEventListener(
        "visibilitychange",
        () => {
          if (document.visibilityState === "visible") background("refresh", refresh());
        },
        { signal },
      );

      const buttonFrom = (target: EventTarget | null): HTMLElement | null =>
        target instanceof Element ? (target.closest(BUTTON_SELECTOR) as HTMLElement | null) : null;
      /** Our footer button or the strip, whichever the event landed on. */
      const triggerFrom = (target: EventTarget | null): HTMLElement | null =>
        buttonFrom(target) ?? (target instanceof Element ? (target.closest(`.${STRIP_CLASS}`) as HTMLElement | null) : null);

      const cancelHover = () => {
        if (hoverTimer !== null) {
          window.clearTimeout(hoverTimer);
          hoverTimer = null;
        }
      };

      const toggle = (from?: HTMLElement | null) => {
        // bb 0.46 moves footer actions that do not fit into the "More footer
        // actions" menu, where our button is never drawn. The menu item still
        // runs us, so open beside the strip or the "More" button instead of
        // giving up.
        const anchor =
          from ?? button ?? (strip.node.isConnected ? strip.node : null) ?? document.querySelector<HTMLElement>(MORE_SELECTOR);
        if (!anchor) return;
        if (popup.isOpen && popup.pinned) {
          popup.close();
          return;
        }
        background("refresh", refresh());
        popup.open(anchor, state, true, actions);
      };

      document.addEventListener(
        "pointerdown",
        (event) => {
          if (event.button !== 0) return;
          const hit = triggerFrom(event.target);
          if (!hit) return;
          cancelHover();
          suppressClick = true;
          toggle(hit);
        },
        { capture: true, signal },
      );
      document.addEventListener(
        "click",
        (event) => {
          const hit = triggerFrom(event.target);
          if (!hit) return;
          if (suppressClick) {
            suppressClick = false;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          // Keyboard activation of the strip: a click with no pointerdown before it.
          if (hit === strip.node) {
            event.preventDefault();
            event.stopPropagation();
            toggle(strip.node);
          }
        },
        { capture: true, signal },
      );
      document.addEventListener(TOGGLE_EVENT, () => toggle(), { signal });
      document.addEventListener(
        "pointerover",
        (event) => {
          if (event.pointerType !== "mouse") return;
          const over = buttonFrom(event.target);
          if (!over) return;
          popup.cancelClose();
          if (popup.isOpen || hoverTimer !== null) return;
          hoverTimer = window.setTimeout(
            safely("hover open", () => {
              hoverTimer = null;
              if (!button) return;
              background("refresh", refresh());
              popup.open(button, state, false, actions);
            }),
            HOVER_MS,
          );
        },
        { capture: true, signal },
      );
      document.addEventListener(
        "pointerout",
        (event) => {
          const out = buttonFrom(event.target);
          if (!out) return;
          const to = event.relatedTarget;
          if (to instanceof Node && out.contains(to)) return;
          cancelHover();
          popup.armClose();
        },
        { capture: true, signal },
      );

      return () => {
        cancelHover();
        if (scheduled !== 0) window.cancelAnimationFrame(scheduled);
        window.clearInterval(timer);
        window.clearInterval(metricsTimer);
        domObserver.disconnect();
        popup.close();
        detach();
        strip.dispose();
      };
    },
  });
});
