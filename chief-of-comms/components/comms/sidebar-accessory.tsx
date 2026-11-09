// Shared sidebar nav badge, with copies in sibling plugins. If you change it
// here, change the copies too. Text longer than the 64px/54px width budget is
// clipped by the host.
import { cn } from "@/lib/utils";

export type AccessoryLevel = "urgent" | "attention" | "activity";

export interface AccessorySignal {
  level: AccessoryLevel;
  /** "N noun", already clamped. Must fit its level's width budget. */
  text: string;
}

export function SidebarAccessorySignal({ signal }: { signal: AccessorySignal | null }) {
  if (signal === null) return null;
  const text =
    signal.level === "urgent"
      ? "text-[color:var(--destructive-text,var(--destructive))]"
      : "text-muted-foreground";
  const dot =
    signal.level === "attention"
      ? "bg-[color:var(--warning-text,var(--destructive))]"
      : signal.level === "activity"
        ? "bg-foreground/70 motion-safe:animate-pulse"
        : null;
  return (
    <span
      className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[11px] tabular-nums", text)}
      title={signal.text}
    >
      {dot === null ? null : <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-hidden />}
      {signal.text}
    </span>
  );
}

