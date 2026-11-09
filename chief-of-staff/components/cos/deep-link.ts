// A deep link's tab, honoured from inside the panel.
//
// `openFixedTab` only works for a component that is already in the panel.
// Called from the page component on `/plugins/chief-of-staff/chief/mission`
// with Worker last-active, it returns true and the panel stays on Worker
// however often it is repeated, so it is not a race that a retry can win. The
// same call from the Worker tab's own "Open the board" button switches the
// panel. The page's `{ kind: "current" }` surface is simply not the panel it
// can see.
//
// So the tab that is up does the work. Whichever of the two plugin tabs is
// mounted reads the same `subPath` the page reads and selects the tab the link
// named. If neither is up, because the panel is collapsed or showing one of
// bb's own tools, the link cannot reach the panel at all and the page shows the
// surface in its own body instead.
import { useEffect } from "react";
import { experimental_useAppPanel } from "@get-bb/plugin-sdk/app";
import {
  MISSION_SUBPATH,
  MISSION_TAB,
  SESSIONS_SUBPATH,
  WORKER_SUBPATH_PREFIX,
  WORKER_TAB,
  type WorkerTarget,
} from "./tabs";
import { claimDeepLink, currentNavigationKey, releaseDeepLink } from "./deep-link-claim";

export type DeepLinkTab =
  | { tab: "mission" }
  | { tab: "worker"; target: WorkerTarget };

/** Which fixed tab a panel sub path names, or null when it names none. */
export function deepLinkTab(subPath: string): DeepLinkTab | null {
  if (subPath === MISSION_SUBPATH || subPath === SESSIONS_SUBPATH) {
    return { tab: "mission" };
  }
  if (subPath.startsWith(WORKER_SUBPATH_PREFIX)) {
    const threadId = subPath.slice(WORKER_SUBPATH_PREFIX.length);
    if (threadId === "") return null;
    // `focus: true` mirrors the board's "Answer": a link that names a worker
    // with a question should land in the composer where the answer gets typed.
    return { tab: "worker", target: { threadId, focus: true } };
  }
  return null;
}

// A link is honoured once per navigation, then the user's clicks win: see
// `deep-link-claim.ts` for why and how.

/**
 * Call from a fixed tab component with the `subPath` it was handed and its own
 * id. It selects the tab the link named, once per link, unless that is already
 * this one showing the right worker.
 */
export function useDeepLinkTab(
  subPath: string,
  mine: DeepLinkTab["tab"],
  shownThreadId: string | null,
): void {
  const panel = experimental_useAppPanel();
  useEffect(() => {
    const wanted = deepLinkTab(subPath);
    if (wanted === null) return;
    // Already on the right tab and worker: nothing to select, and nothing to
    // claim, so a later mount of the OTHER tab still honours the link.
    if (wanted.tab === mine && (wanted.tab !== "worker" || shownThreadId === wanted.target.threadId)) return;
    const navigationKey = currentNavigationKey();
    if (!claimDeepLink(subPath, navigationKey)) return;
    const ask = () => {
      if (wanted.tab === "mission") {
        panel.openFixedTab({ surface: { kind: "current" }, tab: MISSION_TAB });
        return;
      }
      panel.openFixedTab({
        surface: { kind: "current" },
        tab: WORKER_TAB,
        target: wanted.target,
      });
    };
    if (wanted.tab === mine) {
      // The Worker tab re-targets when the link names a worker other than the
      // one up; the equal case returned above.
      ask();
      return;
    }
    // Select this tab first, then the one the link named. Asking for the other
    // tab straight out is accepted and ignored: arriving on `/chief/mission`
    // with Worker up, the Worker tab's own request for Mission returns true and
    // the panel does not move, while the same request after a hop through
    // Worker moves it at once. The host's restore appears to leave the
    // controller believing it already granted Mission, so a repeat is a no-op
    // and only a real change unsticks it. Selecting the tab that is already up
    // costs nothing on screen.
    if (mine === "mission") {
      panel.openFixedTab({ surface: { kind: "current" }, tab: MISSION_TAB });
    } else {
      // No target: the SDK leaves the tab's own session target alone.
      panel.openFixedTab({ surface: { kind: "current" }, tab: WORKER_TAB });
    }
    let asked = false;
    const frame = requestAnimationFrame(() => {
      asked = true;
      ask();
    });
    return () => {
      cancelAnimationFrame(frame);
      // Re-run before the frame fired: the link was never followed, so the
      // re-run gets to claim it again rather than finding it spent.
      if (!asked) releaseDeepLink(subPath, navigationKey);
    };
  }, [mine, panel, shownThreadId, subPath]);
}
