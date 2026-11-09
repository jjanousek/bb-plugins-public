// The plugin's whole colour vocabulary, as complete Tailwind class literals.
//
// Two host facts decide these values (contrast against each mode's canvas,
// WCAG 2.1):
//   - `--attention` is 2.35:1 on white, below even the 3:1 floor for a
//     meaningful graphic, so it is never used. `--warning-text` (5.12:1 light,
//     7.81:1 dark) carries attention instead, which is bb's own amber idiom.
//   - `--destructive` is 3.56:1 in dark, fine as a 6px dot but not as text, so
//     urgent text uses `--destructive-text` (8.04:1 light, 5.24:1 dark).
//   - `--muted-foreground` is 9.14:1 in dark against a 10.13:1 foreground and
//     de-emphasises nothing, so the tertiary tier uses `--subtle-foreground`
//     (6.00:1 light, 6.35:1 dark), a real step down in both modes.
//
// Classes must stay complete literals, never composed at runtime, or Tailwind
// will not see them. Fallbacks keep the plugin legible under a palette that
// omits a token.
import type { Urgency } from "@/contract";

export type { Urgency };

/** Text colours. */
export const TEXT_URGENT = "text-[color:var(--destructive-text,var(--destructive))]";
export const TEXT_ATTENTION = "text-[color:var(--warning-text,var(--destructive))]";
export const TEXT_TERTIARY = "text-[color:var(--subtle-foreground,var(--muted-foreground))]";

/** Dot fills. The halo is what makes urgent readable in monochrome: 8px optical vs 6px. */
export const DOT_URGENT = "bg-destructive ring-2 ring-destructive/25";
export const DOT_ATTENTION = "bg-[color:var(--warning-text,var(--destructive))]";
export const DOT_ACTIVE = "bg-foreground/70";
export const DOT_NEUTRAL = "bg-muted-foreground/40";

export const URGENCY_DOT: Record<Urgency, string> = {
  urgent: DOT_URGENT,
  attention: DOT_ATTENTION,
  active: DOT_ACTIVE,
  neutral: DOT_NEUTRAL,
};
