// Stable references to the Comfy panel, its fixed tabs and its deep links.
// Free of component imports so any surface can select a tab or build a route
// without a module cycle.
import type { ExperimentalPluginFixedTabReference } from "@get-bb/plugin-sdk/app";

export const COMFY_PANEL_ID = "comfy";
export const COMFY_PANEL_PATH = "comfy";

export const GENERATE_TAB: ExperimentalPluginFixedTabReference = { panelId: COMFY_PANEL_ID, id: "generate" };
export const JOBS_TAB: ExperimentalPluginFixedTabReference = { panelId: COMFY_PANEL_ID, id: "jobs" };

/** Deep link that brings the Generate tab forward; the page clears it once handled. */
export const GENERATE_SUBPATH = "generate";

/** Deep link to one asset: `a/<asset id>`. */
const ASSET_PREFIX = "a/";

export function assetSubPath(id: string): string {
  return `${ASSET_PREFIX}${encodeURIComponent(id)}`;
}

export function assetIdFromSubPath(subPath: string): string | null {
  const trimmed = subPath.replace(/^\/+|\/+$/g, "");
  if (!trimmed.startsWith(ASSET_PREFIX)) return null;
  let raw = trimmed.slice(ASSET_PREFIX.length);
  if (raw === "") return null;
  // The host encodes the sub path once more on navigation, so an id can arrive
  // encoded twice. Decode until it stops changing.
  for (let i = 0; i < 3 && raw.includes("%"); i += 1) {
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded === raw) break;
      raw = decoded;
    } catch {
      break;
    }
  }
  return raw;
}

/** The plugin's own settings page; an in-app route, so UrlLink keeps it in SPA history. */
export const SETTINGS_HREF = "/settings/plugins/comfy-cloud";
