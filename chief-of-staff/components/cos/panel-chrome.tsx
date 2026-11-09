import { experimental_useAppPanel, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Summary } from "@/contract";
import { Button } from "@/components/ui/button";
import { Glyph } from "./glyph";
import { cn } from "@/lib/utils";
import { useCosBridge } from "./bridge";
import { CHIEF_PANEL_PATH, DELEGATE_SUBPATH, MISSION_TAB } from "./tabs";
import { TEXT_ATTENTION, TEXT_URGENT } from "./tone";
import { chiefTone, useSummary } from "./use-cos";
import { SidebarAccessorySignal, type AccessoryLevel } from "./sidebar-accessory";
import { clamp99 } from "./sidebar-accessory-format.ts";

export interface TopSignal {
  text: string;
  className: string;
  ariaLabel: string;
  /** How the shared sidebar badge draws it. */
  level: AccessoryLevel;
}

/**
 * The one thing worth saying, and never two. Urgent outranks
 * needs-you outranks decisions outranks a dead chief, and a quiet board with a
 * live chief says nothing at all. The header, the sidebar, and the at-a-glance
 * strip all read this, so they can never disagree with each other.
 */
export function topSignal(summary: Summary | null): TopSignal | null {
  if (summary === null) return null;
  if (summary.urgent > 0) {
    return {
      text: `${clamp99(summary.urgent)} urgent`,
      className: TEXT_URGENT,
      level: "urgent",
      ariaLabel: `${summary.urgent} ${summary.urgent === 1 ? "worker is" : "workers are"} urgent. Open Mission.`,
    };
  }
  if (summary.needsYou > 0) {
    return {
      text: `${clamp99(summary.needsYou)} ${summary.needsYou === 1 ? "needs" : "need"} you`,
      className: TEXT_URGENT,
      level: "urgent",
      ariaLabel: `${summary.needsYou} ${summary.needsYou === 1 ? "worker needs" : "workers need"} you. Open Mission.`,
    };
  }
  if (summary.decisions > 0) {
    return {
      text: `${clamp99(summary.decisions)} ${summary.decisions === 1 ? "decision" : "decisions"}`,
      className: TEXT_ATTENTION,
      level: "attention",
      ariaLabel: `${summary.decisions} ${summary.decisions === 1 ? "decision is" : "decisions are"} waiting on you. Open Mission.`,
    };
  }
  // Last, never first: a chief that died overnight matters, but not more than a
  // worker that is blocked right now, and putting it first would suppress a
  // real count. It is also the only branch that fires on a board of all zeroes,
  // which is exactly the state a dead chief produces.
  const chiefFailure = chiefTone(summary.chiefStatus);
  if (chiefFailure !== undefined) {
    return {
      text: "chief failed",
      className: chiefFailure,
      level: "urgent",
      ariaLabel: "The chief thread failed. Open Mission.",
    };
  }
  return null;
}

/**
 * A coarse pointer grows the Delegate button to the host's own 36px toolbar
 * height (`COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS`), and `-my-1` keeps that
 * taller box from changing the 48px header row.
 *
 * The last 8px of the 44px target is bought with a transparent overlay rather
 * than by painting a 44px button: a filled button that tall in a 48px bar is
 * the loudest thing on the page, and this is already the
 * plugin's only filled button here. Painted box 36px, hit box 44px.
 */
const COARSE_DELEGATE_HIT_AREA =
  "max-md:pointer-coarse:h-9 max-md:pointer-coarse:-my-1 " +
  "max-md:pointer-coarse:after:absolute max-md:pointer-coarse:after:inset-x-0 " +
  "max-md:pointer-coarse:after:-inset-y-1 max-md:pointer-coarse:after:content-['']";

/**
 * Right side of the shared title bar: the host's own Delegate button, and a
 * plain word when something is waiting. The nudge is text, not a badge: it is
 * already the only coloured thing on the page.
 */
export function PanelHeaderContent() {
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const summary = useSummary();
  const signal = topSignal(summary.data);

  return (
    <div className="flex items-center gap-3">
      {signal === null ? null : (
        <button
          type="button"
          className={cn(
            // `-my-3 py-3` gives the 20px line a 44px hit area without moving
            // it, the same trick the strip counts use.
            "-my-3 cursor-pointer whitespace-nowrap py-3 text-[12px] leading-5 transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:underline focus-visible:underline-offset-2",
            signal.className,
          )}
          aria-label={signal.ariaLabel}
          onClick={() => {
            panel.openFixedTab({ surface: { kind: "current" }, tab: MISSION_TAB });
          }}
        >
          {signal.text}
        </button>
      )}
      <Button
        size="sm"
        className={cn("relative h-7 gap-1.5 px-2.5 text-xs", COARSE_DELEGATE_HIT_AREA)}
        onClick={() => navigate.toPluginPanel(CHIEF_PANEL_PATH, { subPath: DELEGATE_SUBPATH })}
      >
        <Glyph name="plus" aria-hidden className="size-3" />
        Delegate
      </Button>
    </div>
  );
}

/**
 * Trailing edge of the sidebar row: the loudest live number, and only that,
 * drawn by the shared sidebar badge component. The words and their order stay
 * this plugin's own.
 */
export function SidebarAccessory() {
  useCosBridge();
  const summary = useSummary();
  const signal = topSignal(summary.data);
  return <SidebarAccessorySignal signal={signal === null ? null : { level: signal.level, text: signal.text }} />;
}
