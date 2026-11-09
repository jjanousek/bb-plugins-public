// The one place an answer to a board item is typed, used by both the list row
// (board-tab.tsx) and the queue (queue-view.tsx), so the two cannot drift
// apart. The box stays open until the draft is accepted, so a refused draft
// keeps its text.
//
// Enter keeps a new line (answers are often two sentences); Cmd or Ctrl with
// Enter saves, and so does the button. Escape cancels and stages nothing.
// Every key is stopped here, so the surface's own row keys never fire while the
// user types.
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { TEXT_TERTIARY } from "./tone";
import { BAR_WORD_HIT_AREA, QuietButton, useIsFingerSurface } from "./ui";

export function AnswerBox({
  headline,
  value,
  onChange,
  onSave,
  onCancel,
  saveLabel,
  busy = false,
  className,
}: {
  headline: string;
  value: string;
  onChange: (text: string) => void;
  /** Called with the trimmed text; never with an empty one. */
  onSave: (text: string) => void;
  onCancel: () => void;
  saveLabel: string;
  /** A save in flight: the button says so and a second save is ignored. */
  busy?: boolean;
  className?: string;
}) {
  const finger = useIsFingerSurface();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: false });
  }, []);
  const empty = value.trim() === "";
  const save = () => {
    if (empty || busy) return;
    onSave(value.trim());
  };
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <textarea
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          event.stopPropagation();
        }}
        rows={3}
        aria-label={`Your answer to: ${headline}`}
        placeholder="Your answer, in your own words"
        className={cn(
          "w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-[14px] leading-5 text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-foreground",
          finger && "text-[16px]",
        )}
      />
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={save}
          disabled={empty || busy}
          className={cn(
            "rounded-md bg-foreground px-3 py-1.5 text-[13px] font-medium text-background disabled:opacity-40",
            finger && "min-h-11 px-4",
          )}
        >
          {busy ? "Adding" : saveLabel}
        </button>
        <QuietButton onClick={onCancel} className={finger ? BAR_WORD_HIT_AREA : undefined}>
          Cancel
        </QuietButton>
        {finger ? null : <span className={cn("text-[11px]", TEXT_TERTIARY)}>Ctrl or Cmd with Enter. Nothing is sent.</span>}
      </div>
    </div>
  );
}
