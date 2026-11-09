// Asset status signalling: the state pill and its dot. Chips, the segmented
// control, buttons, banners, empty states, the spinner and the copy button
// live in ./kit and are re-exported below, so a call site may import them from
// either file. New code should import from ./kit directly.
import { cn } from "@/lib/utils";
import type { AssetStatus } from "../../contract";
import { STATUS_LABEL } from "./format";

export {
  BAR,
  Banner,
  Card,
  CheckBox,
  Chip,
  ChipGroup,
  CopyButton,
  Disclosure,
  EmptyCard,
  EmptyNote,
  EmptyState,
  FADE,
  Field,
  FieldLabel,
  GhostButton,
  Hairline,
  LABEL_CLASS,
  PrimaryButton,
  Segmented,
  Shimmer,
  Spinner,
  SweepStyle,
  copyText,
  ghostButtonClass,
  primaryButtonClass,
} from "./kit";
export type {
  BannerProps,
  CardProps,
  CheckBoxProps,
  ChipProps,
  DisclosureProps,
  EmptyCardProps,
  EmptyStateProps,
  FieldLabelProps,
  FieldProps,
  GhostButtonProps,
  PrimaryButtonClassOptions,
  PrimaryButtonProps,
  SegmentOption,
  SegmentedProps,
} from "./kit";

const PILL_BASE =
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0 text-[10px] font-medium leading-5";

const STATUS_PILL: Record<AssetStatus, string> = {
  queued: "border-border/60 text-muted-foreground",
  running: "border-border/60 text-foreground",
  completed: "border-transparent text-muted-foreground",
  failed: "border-destructive/30 text-destructive",
  cancelled: "border-border/60 text-muted-foreground",
  unknown: "border-border/60 text-foreground",
};

export function statusDotClass(status: AssetStatus): string {
  if (status === "running") return "bg-foreground animate-pulse motion-reduce:animate-none";
  if (status === "queued") return "bg-muted-foreground/60";
  if (status === "failed") return "bg-destructive";
  if (status === "unknown") return "bg-foreground/60";
  return "bg-muted-foreground/40";
}

export interface StatusPillProps {
  status: AssetStatus;
  /** Extra words after the label, e.g. the elapsed time. */
  detail?: string;
  className?: string;
}

/** State badge with a dot that pulses while a job runs. */
export function StatusPill({ status, detail, className }: StatusPillProps) {
  return (
    <span className={cn(PILL_BASE, STATUS_PILL[status], className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", statusDotClass(status))} aria-hidden />
      {STATUS_LABEL[status]}
      {detail === undefined || detail === "" ? null : <span className="tabular-nums text-muted-foreground">{detail}</span>}
    </span>
  );
}
