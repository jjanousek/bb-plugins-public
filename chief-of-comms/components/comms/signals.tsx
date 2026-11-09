// The shared visual language of the inbox: hue carries state, glyph carries
// channel, type size carries rank. Everything that has to agree on one of
// those reads it from here.
//
// Colour rule: this plugin never uses Tailwind's dark variant. The panel's
// CSS compiles that variant to a media query, which disagrees with the host's
// class-based theme switch. Signal colour is therefore mid shades only (600)
// plus /10 and /30 tints, which read correctly on both themes.
import type { ReactNode } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { WaState } from "../../contract";
import { Glyph, type GlyphName } from "./glyph";
import { tokenizeLinks, waStateLabel } from "./format";

/** Plain text buttons: the panel's only secondary action shape. */
export const TEXT_BUTTON =
  "cursor-pointer whitespace-nowrap text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-50";

/** Icon-only buttons: a glyph that brightens on hover, no box. */
export const ICON_BUTTON =
  "inline-flex shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";

/**
 * Under a finger a word grows to a 44px tap box. The
 * vertical padding is pulled back out by the margin so the line stays where
 * it was; the sideways padding is the width the finger needs.
 */
export const FINGER_WORD = "-mx-1 -my-3 inline-flex min-h-11 items-center px-1";

/** The same 44px box for a 24px glyph button: grown 10px each side, bled back out. */
export const FINGER_ICON = "-m-2.5 size-11";

/**
 * The four signal hues, mid shades only. Amber is "their turn", emerald is
 * "ready / done", rose is a failure, sky and violet mark the two mailboxes.
 * Nothing in this panel introduces a fifth.
 */
export const SIGNAL_TEXT = {
  ready: "text-emerald-600",
  attention: "text-amber-600",
  neutral: "text-muted-foreground",
  error: "text-rose-600",
} as const;

// ---------- section labels ----------

export interface SectionLabelProps {
  glyph?: GlyphName;
  label: string;
  /** Rendered after the label in tabular numerals; omit or null to hide. */
  count?: number | null;
  /** Colour of the label text; muted by default. */
  className?: string;
}

/** A quiet uppercase label with a hairline running to the right of it. */
export function SectionLabel({ glyph, label, count, className }: SectionLabelProps) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {glyph === undefined ? null : <Glyph name={glyph} size={12} className="text-muted-foreground" />}
      <span className={cn("shrink-0 text-[10.5px] uppercase tracking-[0.08em]", className ?? "text-muted-foreground")}>
        {label}
      </span>
      {count === undefined || count === null ? null : (
        <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">{count}</span>
      )}
      <span className="h-px min-w-4 flex-1 bg-border" aria-hidden />
    </div>
  );
}

// ---------- connection state ----------

export function waDotClass(state: WaState): string {
  if (state === "connected") return "bg-emerald-500";
  if (state === "connecting") return "bg-amber-500 animate-pulse";
  if (state === "qr" || state === "qr-expired") return "bg-amber-500";
  if (state === "disabled") return "bg-muted-foreground/40";
  return "bg-rose-500";
}

export function waTextClass(state: WaState): string {
  if (state === "connected") return "text-muted-foreground";
  if (state === "disconnected" || state === "logged-out") return "text-rose-600";
  if (state === "disabled") return "text-muted-foreground";
  return "text-amber-600";
}

export interface StateDotProps {
  className: string;
  label?: string;
}

/** The one dot shape used for every connection: 8px, never with a ring. */
export function StateDot({ className, label }: StateDotProps) {
  return (
    <span className="inline-flex shrink-0 items-center" title={label}>
      <span className={cn("size-2 shrink-0 rounded-full", className)} aria-hidden />
      {label === undefined ? null : <span className="sr-only">{label}</span>}
    </span>
  );
}

export function WaDot({ state, className }: { state: WaState; className?: string }) {
  return <StateDot className={cn(waDotClass(state), className)} label={waStateLabel(state)} />;
}

export function mailDotClass(account: { ok: boolean; syncing: boolean }): string {
  if (account.syncing) return "animate-pulse bg-muted-foreground/60";
  return account.ok ? "bg-emerald-500" : "bg-rose-500";
}

// ---------- linkified text ----------

export interface RichTextProps {
  text: string;
  className?: string;
}

/**
 * Message text with URLs turned into links. Angle brackets around a URL are
 * dropped and the URL is separated from the word it was glued to, so a long
 * link cannot set the column's minimum width.
 */
export function RichText({ text, className }: RichTextProps) {
  const segments = tokenizeLinks(text);
  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.kind === "link" ? (
          <UrlLink
            // Segments are positional; the index is their identity.
            key={index}
            href={segment.href}
            className="break-all text-sky-600 underline decoration-sky-500/40 underline-offset-2 hover:decoration-sky-600"
          >
            {segment.text}
          </UrlLink>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

// ---------- empty and loading ----------

export interface EmptyStateProps {
  glyph: GlyphName;
  /** 20px inside the list, 28px on the full-height empty page. */
  size?: number;
  tone?: "muted" | "ok";
  /** One line, 12px muted. Nothing here is a headline. */
  title: string;
  children?: ReactNode;
}

/** Type-led empty state: a muted glyph, one line, optional text actions. */
export function EmptyState({ glyph, size = 20, tone = "muted", title, children }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-4 py-10 text-center">
      <Glyph name={glyph} size={size} className={tone === "ok" ? "text-emerald-600" : "text-muted-foreground"} />
      <p className="max-w-[34ch] text-[12px] leading-5 text-muted-foreground">{title}</p>
      {children === undefined ? null : <div className="flex flex-wrap justify-center gap-4">{children}</div>}
    </div>
  );
}

/** Three pulsing rows. The panel never writes the word "Loading". */
export function SkeletonRows({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-4 p-3", className)} aria-hidden>
      {[0, 1, 2].map((row) => (
        <div key={row} className="animate-pulse space-y-1.5">
          <div className="h-3 w-2/3 rounded bg-muted" />
          <div className="h-2.5 w-full rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
