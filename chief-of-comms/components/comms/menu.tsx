// A small overflow menu, built here rather than pulled in as a dependency.
// With a pointer: one trigger glyph, one absolutely positioned panel, closing
// on an outside press or Escape. Deliberately plain: no submenus, no icons on
// the rows except the external-link mark, and no animation.
//
// Under a finger the same actions open as a bottom sheet:
// 44px rows, and a destructive row sits last, on its own, 12px below the rest
// so a thumb aimed at Dismiss cannot land on Discard draft.
import { useEffect, useRef, useState } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { ResponsiveDrawerShell } from "@/components/ui/responsive-overlay";
import { cn } from "@/lib/utils";
import { Glyph } from "./glyph";
import { FINGER_ICON, ICON_BUTTON } from "./signals";
import { useIsFingerSurface } from "./use-comms";

export interface MenuAction {
  key: string;
  label: string;
  /** Renders as a link that leaves bb, with the external mark. */
  href?: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Destructive rows are rose; everything else takes the foreground colour. */
  danger?: boolean;
}

export interface ActionsMenuProps {
  label: string;
  actions: readonly MenuAction[];
  className?: string;
}

const ROW =
  "flex w-full min-w-0 cursor-pointer items-center gap-2 text-left no-underline transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-50";
const POINTER_ROW = "px-3 py-1.5 text-[12px]";
const FINGER_ROW = "min-h-11 rounded-md px-4 text-[15px]";

export function ActionsMenu({ label, actions, className }: ActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const finger = useIsFingerSurface();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // The popover closes itself on an outside press or Escape. The sheet has its
  // own backdrop and Escape handling in the drawer shell.
  useEffect(() => {
    if (!open || finger) return;
    const onPointerDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, finger]);

  if (actions.length === 0) return null;

  const row = (action: MenuAction) => {
    const shape = cn(ROW, finger ? FINGER_ROW : POINTER_ROW);
    return action.href === undefined ? (
      <button
        key={action.key}
        type="button"
        role="menuitem"
        disabled={action.disabled}
        onClick={() => {
          setOpen(false);
          action.onSelect?.();
        }}
        className={cn(shape, action.danger === true ? "text-rose-600" : "text-foreground")}
      >
        <span className="min-w-0 flex-1 truncate">{action.label}</span>
      </button>
    ) : (
      <UrlLink key={action.key} href={action.href} role="menuitem" onClick={() => setOpen(false)} className={cn(shape, "text-foreground")}>
        <span className="min-w-0 flex-1 truncate">{action.label}</span>
        <Glyph name="external" size={12} className="text-muted-foreground" />
      </UrlLink>
    );
  };

  // Destructive rows go last, apart from the rest, whatever order they came in.
  const safe = actions.filter((action) => action.danger !== true);
  const danger = actions.filter((action) => action.danger === true);

  return (
    <div ref={rootRef} className={cn("relative shrink-0", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup={finger ? "dialog" : "menu"}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(ICON_BUTTON, finger ? FINGER_ICON : "size-6", open && "text-foreground")}
      >
        <Glyph name="more" size={14} />
      </button>

      {finger ? (
        <ResponsiveDrawerShell open={open} onOpenChange={setOpen} srLabel={label} contentClassName="pb-[max(env(safe-area-inset-bottom),12px)]">
          <div role="menu" aria-label={label} className="px-2 pb-1">
            {safe.map(row)}
            {danger.length === 0 ? null : <div className="mt-3 border-t border-border pt-3">{danger.map(row)}</div>}
          </div>
        </ResponsiveDrawerShell>
      ) : open ? (
        <div
          role="menu"
          aria-label={label}
          className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-md border border-border bg-card py-1 shadow-md"
        >
          {[...safe, ...danger].map(row)}
        </div>
      ) : null}
    </div>
  );
}
