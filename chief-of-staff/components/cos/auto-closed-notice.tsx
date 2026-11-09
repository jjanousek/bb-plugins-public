// What closed on its own since the user last looked: items whose day passed
// and items whose Need was dismissed.
//
// This note is the whole safety of auto-dismissal: nothing is destroyed by it,
// so the only real risk is a closure the user never learns of. Each line quotes
// the reason the item was closed.
//
// It must be easy to make it go away once read. Muted words in the same ink
// as the note read as more of the note, so OK is a button with an edge, at the
// top where the eye starts, so on a phone it is on screen before the long part.
//
// There is no "Show them" link: switching the remembered For you view to the
// list for good would hide the quick review. Getting a wrong closure back is a
// Put back on each item instead.
import type { BoardStateDto } from "@/contract";
import { cn } from "@/lib/utils";
import { BAR_WORD_HIT_AREA, useIsFingerSurface } from "./ui";

export interface AutoClosedItem {
  id: string;
  headline: string;
  note: string | null;
  /** Where it was closed to: dismissed by a passed day or a dismissed Need; resolved or dismissed from a click in another panel. */
  state: BoardStateDto;
}

/** Automatic closures write "Closed automatically: <reason>"; the header already says the first half. */
const AUTO_PREFIX = /^Closed automatically:\s*/;

export function AutoClosedNotice({
  items,
  onOk,
  onPutBack,
  busy,
}: {
  items: readonly AutoClosedItem[];
  /** Mark every closure shown here as seen. */
  onOk: () => void;
  /** Reopen one item that was closed wrongly. */
  onPutBack: (id: string) => void;
  /** OK is in flight: refuse a second press. */
  busy: boolean;
}) {
  const finger = useIsFingerSurface();
  if (items.length === 0) return null;
  const one = items.length === 1;
  return (
    <section aria-label="Closed automatically" className="mb-2 rounded-md border border-border px-3 py-2">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-[12px] leading-5 text-muted-foreground">
          <span className="text-foreground">
            {items.length} item{one ? " was" : "s were"} closed automatically.
          </span>{" "}
          {/* A passed day and a dismissed Need both close items, and each
              line below says which. */}
          Nothing is deleted; each says why.
        </p>
        <button
          type="button"
          onClick={onOk}
          disabled={busy}
          aria-label="OK, hide this note"
          className={cn(
            "shrink-0 cursor-pointer rounded-md border border-border px-3 text-[12px] font-medium leading-5 text-foreground hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50",
            finger ? "min-h-11 min-w-11" : "py-0.5",
          )}
        >
          OK
        </button>
      </div>
      <ul className="mt-2 space-y-2">
        {items.map((item) => {
          const why = item.note === null ? "" : item.note.replace(AUTO_PREFIX, "").trim();
          return (
            <li key={item.id} className="text-[12px] leading-5">
              <div className="flex items-start gap-3">
                <span className="min-w-0 flex-1 text-foreground">{item.headline}</span>
                <button
                  type="button"
                  onClick={() => onPutBack(item.id)}
                  aria-label={`Put back "${item.headline}" on your list`}
                  className={cn(
                    "shrink-0 cursor-pointer text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    finger && BAR_WORD_HIT_AREA,
                  )}
                >
                  Put back
                </button>
              </div>
              {why === "" ? null : <p className="text-muted-foreground">{why}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
