// The Viewer's `...` sheet: the actions a phone header has no room for. It is
// the host dialog, which the host turns into a bottom drawer on compact with
// its own safe area padding and swipe to dismiss, so the sheet looks and
// behaves like every other sheet in bb. On a wider screen it is a small
// centred dialog, which only a narrow panel on a desktop ever reaches.
//
// Rows are 44px. Delete is last and set apart (touch-geometry.ts holds the
// arithmetic), and it does not delete: it closes the sheet and opens the one
// confirm this plugin has, whose rules are in delete-dialog.tsx.
import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Glyph } from "./glyphs";
import type { GlyphName } from "./glyphs";
import { SHEET_DELETE_SEPARATOR, SHEET_ROW } from "./touch-geometry";

export interface SheetAction {
  id: string;
  label: string;
  glyph: GlyphName;
  /** Muted words after the label, e.g. the file size of the original. */
  hint?: string;
  disabled?: boolean;
  pressed?: boolean;
  onSelect: () => void;
}

export interface ActionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One line under the title, e.g. the prompt's first words. */
  description?: string;
  actions: readonly SheetAction[];
  /** The destructive action, drawn last and apart. */
  destructive?: SheetAction;
}

function Row({ action, danger = false, autoFocus = false, onClose }: { action: SheetAction; danger?: boolean; autoFocus?: boolean; onClose: () => void }) {
  const Leading = Glyph[action.glyph];
  return (
    <button
      type="button"
      role="menuitem"
      autoFocus={autoFocus}
      disabled={action.disabled}
      aria-pressed={action.pressed}
      onClick={() => {
        onClose();
        action.onSelect();
      }}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-md px-3 text-left text-[13px] font-medium",
        SHEET_ROW.class,
        "hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        danger ? "text-destructive" : "text-foreground",
      )}
    >
      <Leading className={cn("size-5 shrink-0", danger ? "text-destructive" : "text-muted-foreground")} />
      <span className="min-w-0 flex-1 truncate">{action.label}</span>
      {action.hint === undefined ? null : <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">{action.hint}</span>}
    </button>
  );
}

export function ActionSheet({ open, onOpenChange, title, description, actions, destructive }: ActionSheetProps): ReactNode {
  const close = () => onOpenChange(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The host X is an icon-set glyph; Escape, a tap outside and the drawer's
          own swipe already close this. */}
      <DialogContent hideCloseButton className="max-w-sm gap-2 p-2 sm:p-3">
        <DialogHeader className="space-y-0.5 px-3 pb-1 pt-1">
          <DialogTitle className="text-[13px]">{title}</DialogTitle>
          <DialogDescription className={cn("truncate text-[11px] leading-4", description === undefined && "sr-only")}>{description ?? title}</DialogDescription>
        </DialogHeader>
        <div role="menu" aria-label={title} className="flex flex-col">
          {actions.map((action, index) => (
            // The first row takes the focus, so Escape and the keyboard reach the sheet.
            <Row key={action.id} action={action} autoFocus={index === 0} onClose={close} />
          ))}
          {destructive === undefined ? null : (
            <div className={SHEET_DELETE_SEPARATOR.class}>
              <Row action={destructive} danger onClose={close} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
