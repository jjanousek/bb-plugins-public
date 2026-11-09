import { usePrefersReducedMotion } from "@/components/ui/hooks/use-media-query";
import { cn } from "@/lib/utils";
import { DOT_NEUTRAL, URGENCY_DOT, type Urgency } from "./tone";
import { isPulsingStatus } from "./use-cos";

// A 6px dot is the only status ornament on any surface. When the caller knows
// the worker's level it passes `urgency` and the dot speaks the five attention
// levels; otherwise it falls back to the raw bb
// thread status. Urgent is the only dot with a halo, which is what makes it
// readable in monochrome: 8px optical against 6px.
const STATUS_TONE: Record<string, string> = {
  active: "bg-foreground/70",
  starting: "bg-foreground/70",
  provisioning: "bg-foreground/70",
  "waiting-for-host": "bg-muted-foreground/60",
  "host-reconnecting": "bg-muted-foreground/60",
  stopping: "bg-muted-foreground/60",
  idle: "bg-muted-foreground/40",
  error: "bg-destructive",
  missing: "bg-destructive",
  // Claude Code sessions outside bb: a hollow ring, not a bb thread status.
  external: "bg-transparent ring-1 ring-inset ring-muted-foreground/60",
};

export function StatusDot({
  status,
  urgency,
  blocked = false,
  className,
}: {
  status: string;
  /** The row's attention level. Takes precedence over `status`. */
  urgency?: Urgency;
  /** Deprecated alias for `urgency="urgent"`. */
  blocked?: boolean;
  className?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const level: Urgency | null = urgency ?? (blocked ? "urgent" : null);
  const tone = level === null ? (STATUS_TONE[status] ?? DOT_NEUTRAL) : URGENCY_DOT[level];
  // A red pulsing dot is an alarm, and there would routinely be two of them,
  // so anything that wants attention holds still.
  const pulses =
    level !== "urgent" && level !== "attention" && isPulsingStatus(status);
  const label = level === "urgent" || level === "attention" ? `${status}, ${level}` : status;
  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        tone,
        pulses && (reducedMotion ? "ring-1 ring-foreground/30" : "animate-pulse"),
        className,
      )}
    />
  );
}
