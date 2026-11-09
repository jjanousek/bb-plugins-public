// The two host-rendered slivers around the panel: the title bar pills and the
// sidebar row accessory. Both stay narrow enough that the host's "Comms" title
// is never squeezed out: the words hide first, the numbers stay. Two pills,
// the WhatsApp dot and the Chief toggle, never more.
import type { ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { ChiefToggle } from "./chief-drawer";
import { Glyph } from "./glyph";
import { SidebarAccessorySignal } from "./sidebar-accessory";
import { navBadge, topSignal } from "./sidebar-signal";
import { WaDot } from "./signals";
import { useCommsBridge, useSummary } from "./use-comms";

export { navBadge, topSignal } from "./sidebar-signal";

const PILL =
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium";

export function HeaderContent() {
  const summary = useSummary();
  // The toggle does not wait for the summary: the drawer is how the user
  // reaches the chief, including when the summary is the thing failing.
  if (summary.data === null) return <ChiefToggle />;
  const { counts, wa } = summary.data;
  const needsReply = counts.needsReplyOnly ?? counts.needsReply;
  const ready = counts.ready;
  // A zero is not news: an empty count drops its pill and leaves the header quiet.
  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {needsReply > 0 ? (
        <span className={cn(PILL, "border-amber-500/30 bg-amber-500/10 text-amber-600")} title={`${needsReply} to reply`}>
          <span className="tabular-nums">{needsReply}</span>
          <span className="hidden lg:inline">to reply</span>
        </span>
      ) : null}
      {ready > 0 ? (
        <span
          className={cn(PILL, "border-emerald-500/30 bg-emerald-500/10 text-emerald-600")}
          title={`${ready} ready to send`}
        >
          <Glyph name="send" size={10} />
          <span className="tabular-nums">{ready}</span>
          <span className="hidden lg:inline">ready</span>
        </span>
      ) : null}
      <WaDot state={wa.state} />
      <ChiefToggle />
    </div>
  );
}

export function SidebarAccessory() {
  useCommsBridge();
  const summary = useSummary();
  // One signal, chosen in sidebar-signal.ts, rendered by the shared component.
  // The host clips this box at 64px, so a second segment would show as a
  // dangling separator with nothing after it.
  return <SidebarAccessorySignal signal={topSignal(summary.data)} />;
}

export function useCommsBadge(): ExperimentalBadge | null {
  useCommsBridge();
  const summary = useSummary();
  return navBadge(summary.data);
}
