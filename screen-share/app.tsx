// bb-plugin-screen-share — frontend.
//
// A sidebar footer button and a thread panel action. Both start the share
// through RPC. The footer button opens the noVNC viewer in a new tab; the
// panel action embeds it in a bb side panel tab so the login can happen next
// to the conversation.
import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ShareStatus, rpcContract } from "./server";

const PLUGIN_ID = "screen-share";
const POLL_MS = 5_000;

async function rpc<T>(method: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
    signal,
  });
  const envelope = await response.json();
  if (!envelope?.ok) throw new Error(envelope?.error?.message ?? "rpc failed");
  return envelope.result as T;
}

function describe(state: ShareStatus): string {
  if (!state.active) return "Screen share is off.";
  const viewers = `${state.viewers} viewer${state.viewers === 1 ? "" : "s"}`;
  const browser = state.browserOpen ? "" : " No browser window is open; the desktop is empty until an agent navigates somewhere.";
  return `Screen share is on, ${viewers}.${browser}`;
}
// index.html routes by pointer type; point phones straight at the touch UI.
function mobileViewerUrl(viewerUrl: string): string {
  try {
    const url = new URL(viewerUrl);
    if (url.pathname.endsWith("/")) url.pathname += "m.html";
    else url.pathname = url.pathname.replace(/index\.html$/, "m.html");
    return url.toString();
  } catch {
    return viewerUrl;
  }
}

// Coarse-pointer sizing for the panel. React inline styles cannot hold media
// queries, so the touch rules live here and the markup carries ss-* classes.
const COARSE_CSS = [
  "@media (pointer: coarse) {",
  "  .ss-bar { flex-wrap: wrap; row-gap: 0.6rem; }",
  "  .ss-bar .ss-status { flex: 1 1 100%; }",
  "  .ss-bar .ss-spacer { display: none; }",
  "  .ss-bar .ss-btn { flex: 1 1 100%; min-height: 44px; display: flex; align-items: center; justify-content: center; padding: 0 0.9rem; font-size: 0.9rem; box-sizing: border-box; }",
  "  .ss-open-viewer { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 44px; box-sizing: border-box; border-radius: 0.4rem; border: 1px solid var(--border); background: var(--secondary); color: inherit; text-decoration: none; font-size: 0.9rem; }",
  "}",
].join("\n");

// --- panel -----------------------------------------------------------------

function SharePanel() {
  const client = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ShareStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  // Touch device: (pointer: coarse) selects touch
  // behaviour. Sizing lives in COARSE_CSS; the viewer embed decision is here.
  const [coarse, setCoarse] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // The interval fires on a clock, not on completion. status() shells out to
  // systemctl, ss and pgrep, and `run` allows each 15 s, so a wedged systemctl
  // would have three polls in flight at once, each spawning its own processes.
  // Skip a tick rather than queue behind one.
  const polling = useRef(false);
  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const next = await client.call("status", null);
      if (alive.current) { setState(next); setError(null); }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      polling.current = false;
    }
  }, [client]);

  const act = useCallback(async (method: "start" | "stop") => {
    setBusy(true);
    try {
      const next = await client.call(method, null);
      if (alive.current) { setState(next); setError(next.message); }
      if (next.message) toast.error(next.message);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (alive.current) setError(text);
      toast.error(text);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [client]);

  // Opening the panel reports status only. The share starts on the explicit
  // Start button (or the footer action), never as a side effect of looking.
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [refresh]);

  const bar: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.4rem 0.6rem",
    fontSize: "0.78rem", borderBottom: "1px solid var(--border, #3a3a3a)",
    color: "var(--foreground, #e5e5e5)", background: "var(--background, #1c1c1c)", flex: "0 0 auto",
  };
  const button: React.CSSProperties = {
    padding: "0.2rem 0.55rem", borderRadius: "0.4rem", border: "1px solid var(--border, #3a3a3a)",
    background: "var(--secondary, transparent)", color: "inherit", cursor: busy ? "wait" : "pointer",
  };
  const muted: React.CSSProperties = { color: "var(--muted-foreground, #8a8a8a)" };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <style>{COARSE_CSS}</style>
      <div style={bar} className="ss-bar">
        <span aria-live="polite" className="ss-status">{state ? describe(state) : "Checking screen share status…"}</span>
        <span style={{ flex: 1 }} className="ss-spacer" />
        {state?.active ? (
          <>
            <a href={state.viewerUrl} target="_blank" rel="noreferrer" style={{ ...button, textDecoration: "none" }} className="ss-btn">Open in tab</a>
            <button type="button" style={button} className="ss-btn" disabled={busy} onClick={() => void act("stop")}>Stop</button>
          </>
        ) : (
          <button type="button" style={button} className="ss-btn" disabled={busy} onClick={() => void act("start")}>Start</button>
        )}
      </div>
      {error ? <div style={{ ...muted, padding: "0.5rem 0.6rem", color: "var(--destructive, #e5484d)" }}>{error}</div> : null}
      {state?.active ? (
        coarse ? (
          <div style={{ padding: "1rem 0.6rem" }}>
            <a href={mobileViewerUrl(state.viewerUrl)} target="_blank" rel="noreferrer" className="ss-open-viewer">Open viewer</a>
            <div style={{ ...muted, marginTop: "0.6rem" }}>The embedded desktop is too small on a phone. Open the touch viewer instead and log in by hand there.</div>
          </div>
        ) : (
          <iframe
            title="Agent browser screen share"
            src={state.viewerUrl}
            style={{ flex: 1, border: 0, width: "100%", minHeight: 0, background: "#000" }}
            allow="clipboard-read; clipboard-write"
          />
        )
      ) : (
        <div style={{ ...muted, padding: "1rem 0.6rem" }}>
          Press Start to bring up the live view of the agent browser. Log in by hand there; the session is saved in the shared Chrome profile.
          {" The share is permanent, so it is normally already on; if you are reading this, something stopped it."}
        </div>
      )}
    </div>
  );
}

// --- registration -----------------------------------------------------------

export default definePluginApp((app) => {
  // Both slots open the same panel: the thread view and the New thread screen.
  // No `run`: the host's own fallback opens a panel tab titled after the
  // action, which is what this needs.
  const panel = { title: "Screen share", icon: "AppWindow", layout: "flush" as const, component: SharePanel };
  app.slots.threadPanelAction({ id: "view", ...panel });
  app.slots.experimental_newThreadPanelAction({ id: "view-new", ...panel });

  app.slots.sidebarFooterAction({
    id: "open",
    title: "Screen share of the agent browser (opens in a new tab)",
    icon: "AppWindow",
    run: async () => {
      // Open the tab synchronously so the click is not lost to popup blocking,
      // then point it at the viewer once the share is up.
      const tab = window.open("about:blank", "_blank");
      try {
        const state = await rpc<ShareStatus>("start");
        if (!state.active) {
          tab?.close();
          toast.error(state.message ?? "Screen share did not start.");
          return;
        }
        if (tab) tab.location.href = state.viewerUrl;
        else window.open(state.viewerUrl, "_blank");
        toast.success(describe(state));
      } catch (e) {
        tab?.close();
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
  });
});
