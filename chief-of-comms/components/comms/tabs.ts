// Stable references to the Comms panel, its in-panel views and its deep links.
// Free of component imports so any surface can build a route without a module
// cycle.

export const COMMS_PANEL_ID = "comms";
export const COMMS_PANEL_PATH = "comms";

/**
 * Secondary panel views, reached by sub path. The panel registers no host
 * fixed tabs: bb draws the same identity mark on each of them, so Activity and
 * Connections live inside the panel, and the chief chat lives in a drawer
 * on the page (chief-drawer.tsx).
 */
export const PANEL_VIEWS = ["activity", "connections", "discarded"] as const;
export type PanelView = (typeof PANEL_VIEWS)[number];

export function viewFromSubPath(subPath: string): PanelView | null {
  const trimmed = subPath.replace(/^\/+|\/+$/g, "");
  return (PANEL_VIEWS as readonly string[]).includes(trimmed) ? (trimmed as PanelView) : null;
}

export const VIEW_TITLES: Record<PanelView, string> = {
  activity: "Activity",
  connections: "Connections",
  discarded: "Discarded",
};

/** Deep link to one conversation: `c/<encoded conversation key>`. */
const CONVERSATION_PREFIX = "c/";

export function conversationSubPath(key: string): string {
  return `${CONVERSATION_PREFIX}${encodeURIComponent(key)}`;
}

export function conversationKeyFromSubPath(subPath: string): string | null {
  const trimmed = subPath.replace(/^\/+|\/+$/g, "");
  if (!trimmed.startsWith(CONVERSATION_PREFIX)) return null;
  let raw = trimmed.slice(CONVERSATION_PREFIX.length);
  if (raw === "") return null;
  // The host encodes the sub path once more on navigation, so a key can arrive
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

/** The one prompt both the dashboard button and the palette action send. */
export const TRIAGE_PROMPT =
  "Triage now: run comms_inbox, group what needs a reply, draft replies (mail with comms_mail_draft threaded via replyToMessageId, WhatsApp with comms_wa_draft), dismiss noise with comms_dismiss, and report in a few lines with the conversation keys.";
