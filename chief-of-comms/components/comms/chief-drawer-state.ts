// The rules behind the chief drawer's remembered state, without React or the
// browser, so a test can read them. chief-drawer.tsx does the storage.

/** localStorage key for the drawer: "open" or "closed". */
export const DRAWER_STORAGE_KEY = "comms.chiefDrawer";

/** localStorage key for the About card: a map of conversation key to open. */
export const ABOUT_STORAGE_KEY = "comms.aboutOpen";

/** From this viewport width up the drawer starts open when nothing is stored. */
export const DRAWER_DEFAULT_OPEN_PX = 1024;

/** Below this the drawer covers the page, same line as the compact viewport query. */
export const DRAWER_COVERS_BELOW_PX = 768;

/** The card map keeps this many conversations; the oldest remembered go first. */
export const ABOUT_MEMORY_LIMIT = 200;

/**
 * Whether the drawer starts open. A stored choice wins, except on a phone
 * sized viewport: there the drawer covers the whole page, so opening Comms
 * onto the chief instead of the inbox would hide the inbox. Below
 * that line it always starts closed and one tap opens it.
 */
export function initialDrawerOpen(stored: string | null, viewportWidth: number): boolean {
  if (viewportWidth < DRAWER_COVERS_BELOW_PX) return false;
  if (stored === "open") return true;
  if (stored === "closed") return false;
  return viewportWidth >= DRAWER_DEFAULT_OPEN_PX;
}

export type AboutMemory = Record<string, boolean>;

/** Parse the stored map; anything unreadable is an empty map, never a throw. */
export function parseAboutMemory(raw: string | null): AboutMemory {
  if (raw === null || raw === "") return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const out: AboutMemory = {};
    for (const [key, open] of Object.entries(value)) {
      if (typeof open === "boolean") out[key] = open;
    }
    return out;
  } catch {
    return {};
  }
}

/** Open unless the user folded it for this conversation. */
export function aboutOpenFor(memory: AboutMemory, key: string): boolean {
  return memory[key] ?? true;
}

/**
 * The map after the user folds or opens the card for one conversation. The key
 * moves to the end, and the map is cut to the newest ABOUT_MEMORY_LIMIT keys,
 * so the stored value cannot grow for ever.
 */
export function rememberAbout(memory: AboutMemory, key: string, open: boolean): AboutMemory {
  const next: AboutMemory = {};
  const keys = Object.keys(memory).filter((k) => k !== key);
  for (const k of keys.slice(Math.max(0, keys.length - (ABOUT_MEMORY_LIMIT - 1)))) {
    next[k] = memory[k] as boolean;
  }
  next[key] = open;
  return next;
}
