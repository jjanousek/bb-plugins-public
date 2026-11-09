// What the sidebar row says about Comms: one signal, never two, never a
// separator. The component that renders this is
// components/comms/sidebar-accessory.tsx, shared with two other plugins.
//
// The only runtime import is clamp99, from the second shared file. It is plain
// .ts for the same reason this file is: the test runner strips types but
// cannot compile JSX, so anything it exercises has to stay clear of the .tsx
// files. Keeping a private copy of clamp99 here instead would be the silently
// diverging duplicate this whole exercise exists to remove. The extension is spelled out
// because node's ESM resolver, which the tests run under, does not guess it.
import type { ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import { clamp99 } from "./sidebar-accessory-format.ts";
import type { Summary, WaState } from "@/contract";
import type { AccessorySignal } from "./sidebar-accessory";

/**
 * The states where a feed is broken in the way that needs the owner, using the
 * same ones the panel already paints red: a mail account that failed its last
 * sync, or WhatsApp disconnected or logged out. "disabled" is off on purpose,
 * and "connecting", "qr" and "qr-expired" are pairing rather than broken, so
 * none of those is a failure.
 */
const WA_BROKEN: readonly WaState[] = ["disconnected", "logged-out"];

export function topSignal(summary: Summary | null): AccessorySignal | null {
  if (summary === null) return null;
  if (summary.mail.some((account) => !account.ok) || WA_BROKEN.includes(summary.wa.state)) {
    return { level: "urgent", text: "sync failed" };
  }
  const { ready } = summary.counts;
  // The same number the list's "Needs a reply" group shows.
  const needsReply = summary.counts.needsReplyOnly ?? summary.counts.needsReply;
  if (needsReply > 0) return { level: "attention", text: `${clamp99(needsReply)} replies` };
  if (ready > 0) return { level: "attention", text: `${clamp99(ready)} ready` };
  return null;
}

/**
 * The navigation badge for `experimental_useBadge`: a critical dot when a feed
 * is broken, the count of conversations needing a reply, the count of drafts
 * ready to send, or null when nothing is waiting.
 */
export function navBadge(summary: Summary | null): ExperimentalBadge | null {
  if (summary === null) return null;
  if (summary.mail.some((account) => !account.ok) || WA_BROKEN.includes(summary.wa.state)) {
    return { tone: "critical", label: "sync failed" };
  }
  const { ready } = summary.counts;
  const needsReply = summary.counts.needsReplyOnly ?? summary.counts.needsReply;
  if (needsReply > 0) {
    return { count: needsReply, label: needsReply === 1 ? "1 reply" : `${needsReply} replies` };
  }
  if (ready > 0) {
    return { count: ready, label: `${ready} ready` };
  }
  return null;
}
