// Stable references to the Chief of Staff panel's fixed tabs.
//
// Kept free of component imports so any surface can select a tab without a
// module cycle. app.tsx spreads these into the full `fixedTabs` registrations.
import type { ExperimentalPluginFixedTabReference, JsonValue } from "@get-bb/plugin-sdk/app";

export const CHIEF_PANEL_ID = "chief";
export const CHIEF_PANEL_PATH = "chief";

/**
 * The worker the Worker tab should show. `focus` asks the tab to put the
 * cursor in that worker's composer, which is what "Answer" on a decision
 * wants: the tab bumps `ThreadChat`'s `focusRequest` when it is set.
 */
export type WorkerTarget = { threadId: string; focus?: boolean };

function isWorkerTarget(value: JsonValue): value is WorkerTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const threadId: JsonValue | undefined = value["threadId"];
  if (typeof threadId !== "string" || threadId.length === 0) return false;
  const focus: JsonValue | undefined = value["focus"];
  return focus === undefined || typeof focus === "boolean";
}

export const MISSION_TAB: ExperimentalPluginFixedTabReference = {
  panelId: CHIEF_PANEL_ID,
  id: "mission",
};

export const WORKER_TAB: ExperimentalPluginFixedTabReference<WorkerTarget> = {
  panelId: CHIEF_PANEL_ID,
  id: "worker",
  experimental_target: { validate: isWorkerTarget },
};

export const EXECUTION_TAB: ExperimentalPluginFixedTabReference = {
  panelId: CHIEF_PANEL_ID,
  id: "execution",
};

// There is no Activity tab: the host draws the plugin's own icon for every
// fixed tab, so each extra tab is another identical glyph. Activity lives
// behind the Board / Activity switch inside the Mission tab instead.
//
// Execution IS a third tab rather than a fourth word in that switch: three
// view words fit a 218px content box without wrapping at a 250px panel, and a
// fourth would not. Adding a tab does not touch that layout. The
// identical-glyph cost is accepted: a tab still carries a title, and "Mission,
// Worker, Execution" are told apart by their words the same way the view switch
// is. If the tab strip wraps at 250, this is the note to revisit.

/** Panel sub paths the page component understands. */
export const DELEGATE_SUBPATH = "delegate";
export const ADOPT_SUBPATH_PREFIX = "adopt/";
/** Opens the Mission tab and the import dialog for the first un-imported session. */
export const SESSIONS_SUBPATH = "sessions";
/**
 * Opens the Mission tab and nothing else. The homepage card needs this because
 * a bare `toPluginPanel(CHIEF_PANEL_PATH)` lands on the page body, which is the
 * chief's own transcript; on a phone the panel replaces the page, so a count
 * that says "2 need you" would drop the user into the chief conversation
 * instead of the board it named.
 */
export const MISSION_SUBPATH = "mission";
/**
 * Opens the Execution tab, or renders it in the page body when there is no
 * panel. The page-body route is not a nicety here: at a phone width the panel
 * does not exist, so without it a surface meant for phone use is reachable
 * only on a desktop.
 */
export const EXECUTION_SUBPATH = "execution";
/**
 * `worker/<threadId>` opens the Worker tab on that worker with its composer
 * focused, the same target `Answer` uses on the board. The thread id is opaque
 * to the router, so nothing here needs escaping.
 */
export const WORKER_SUBPATH_PREFIX = "worker/";
