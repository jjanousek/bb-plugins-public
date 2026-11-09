// Row actions on a compact viewport.
//
// Hover does not exist on a phone, and three action words plus a name plus an
// age do not fit in 390px. So a row keeps exactly one affordance: a 44px `...`
// button that opens the host's own bottom sheet. The sheet is
// a plain stack of 44px rows, because a menu of words is the same vocabulary
// the desktop rows use, only stacked.
import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Glyph } from "./glyph";
import { ResponsiveDrawerShell } from "@/components/ui/responsive-overlay";
import { cn } from "@/lib/utils";
import { useIsFingerSurface } from "./ui";
import { TEXT_URGENT } from "./tone";

/**
 * One entry in the sheet. `tone: "urgent"` marks a destructive action: it is
 * coloured with `TEXT_URGENT` and separated from the rest by a hairline, so
 * `Retire` never sits flush against `Open thread`.
 */
export interface RowActionItem {
  id: string;
  label: string;
  run: () => void;
  tone?: "urgent";
  /**
   * A statement rather than an action: `imported as site-builder` is text on a
   * desktop row and has nowhere else to go on a phone.
   */
  disabled?: boolean;
  /**
   * One muted line under the label, for a choice that needs explaining before
   * it is taken: a permission mode's "Applies edits inside the workspace
   * automatically". Never on an action; an action is one word.
   */
  detail?: string;
}

export interface RowActionsProps {
  items: RowActionItem[];
  /**
   * Overrides the trigger's accessible name. Callers with a subject in hand
   * pass `Actions for site-builder`; the default keeps a bare row honest.
   */
  ariaLabel?: string;
  /**
   * Resizes the trigger. The 44px default is the phone rule; a 250px panel on
   * a desktop is still a pointer, so that caller shrinks it.
   */
  triggerClassName?: string;
  /**
   * Replaces the `...` glyph inside the trigger, keeping its wiring.
   *
   * The model and effort panel's trigger is the current value itself: the user reads
   * "Fable 5.1" and taps the same word to change it. That surface needs this
   * component rather than a second menu of its own, because the one thing it
   * must not do is open a bottom drawer on a desktop, which is the reason the
   * two-presentation split below exists at all.
   */
  triggerContent?: ReactNode;
  /** Marks the current value with a check, for a menu that picks rather than acts. */
  selectedId?: string;
  /**
   * Which edge the anchored menu hangs from. A `...` at the end of a row opens
   * rightwards; a value word at the start of one opens leftwards, or the menu
   * runs off the panel.
   */
  align?: "left" | "right";
}

export function RowActions({
  items,
  ariaLabel = "More actions",
  triggerClassName,
  triggerContent,
  selectedId,
  align = "right",
}: RowActionsProps) {
  const [open, setOpen] = useState(false);
  const finger = useIsFingerSurface();
  const anchor = useRef<HTMLDivElement | null>(null);

  // A pointer gets a menu anchored to the row it belongs to; only a finger
  // gets the bottom sheet. `ResponsiveDrawerShell` is a bottom drawer at every
  // width, so on a pointer a four-item menu would cover the lower half of a
  // large screen. One menu, two presentations, because a sheet that slides up
  // from the bottom edge of a large screen to answer a click in its top right
  // is not the same gesture at all.
  useEffect(() => {
    if (!open || finger) return;
    const onDown = (event: MouseEvent): void => {
      if (anchor.current !== null && !anchor.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, finger]);

  if (items.length === 0) return null;

  const list = (
    <div className="flex flex-col overflow-y-auto px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1">
      {items.map((item, index) => (
        <Fragment key={item.id}>
          {item.tone === "urgent" && index > 0 && items[index - 1]?.tone !== "urgent" ? (
            <div aria-hidden className="my-1 h-px shrink-0 bg-border" />
          ) : null}
          <button
            type="button"
            disabled={item.disabled}
            onClick={() => {
              setOpen(false);
              item.run();
            }}
            className={cn(
              "flex w-full shrink-0 items-center rounded-sm px-2 text-left text-[13px] leading-5 transition-colors",
              // 44px under a finger; a menu row on a pointer does not need to
              // be a thumb target and 44 of them would be a very tall menu.
              finger ? "min-h-11" : "min-h-8",
              item.disabled === true
                ? "cursor-default text-muted-foreground"
                : cn(
                    // The sheet traps Tab, and `bg-accent/60` alone is a
                    // 1.10:1 tint against the canvas, well under the 3:1
                    // SC 1.4.11 needs. The tint stays so keyboard focus
                    // still looks like hover; the host's ring is what makes
                    // it visible. Mirrors the trigger above.
                    "cursor-pointer hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    item.tone === "urgent" ? TEXT_URGENT : "text-foreground",
                  ),
            )}
          >
            {selectedId === undefined ? null : (
              <Glyph
                name="check"
                aria-hidden
                className={cn("mr-2 mt-1 size-3 shrink-0 self-start", item.id === selectedId ? "opacity-100" : "opacity-0")}
              />
            )}
            {item.detail === undefined ? (
              item.label
            ) : (
              <span className="min-w-0 flex-1 py-1">
                <span className="block">{item.label}</span>
                <span className="block text-[12px] leading-4 text-muted-foreground">{item.detail}</span>
              </span>
            )}
          </button>
        </Fragment>
      ))}
    </div>
  );

  return (
    <div ref={anchor} className="relative shrink-0">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        // -mr-2 pulls the 44px box back so the glyph optically aligns with the
        // age column instead of pushing it off the row.
        className={cn(
          "flex shrink-0 cursor-pointer items-center rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          triggerContent === undefined
            // -mr-2 pulls the 44px box back so the glyph optically aligns with
            // the age column instead of pushing it off the row.
            ? "-mr-2 h-11 w-11 justify-center text-muted-foreground hover:text-foreground"
            : "text-left",
          triggerClassName,
        )}
      >
        {triggerContent ?? <Glyph name="more" aria-hidden className="size-4" />}
      </button>
      {finger ? (
        <ResponsiveDrawerShell open={open} onOpenChange={setOpen} srLabel={ariaLabel}>
          {list}
        </ResponsiveDrawerShell>
      ) : open ? (
        // Anchored to the trigger and right-aligned, so it opens where the
        // click landed. `min-w-44` keeps a two-word menu from being a sliver.
        <div
          role="menu"
          aria-label={ariaLabel}
          className={cn(
            "absolute top-full z-50 mt-1 min-w-44 max-w-[min(26rem,calc(100vw-2rem))] rounded-md border border-border bg-popover py-1 shadow-md",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {list}
        </div>
      ) : null}
    </div>
  );
}
