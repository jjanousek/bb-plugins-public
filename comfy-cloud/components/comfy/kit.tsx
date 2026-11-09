// The plugin's own controls. The Library, the Viewer, the Generate form and
// the Jobs list all read their chrome from here, so they cannot drift apart.
//
// House rules: host token classes only (no hand written
// colour), controls 28 px tall with 12 px text, chips 26 px, radius `md`
// everywhere, hairlines instead of shadows and filled grey boxes, and glyphs
// from ./glyphs. Type scale: 10 px uppercase labels, 11 px meta, 12 px
// controls, 13 px body, 15 px prompt.
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Glyph } from "./glyphs";
import type { GlyphName } from "./glyphs";

/** Short transitions that stop under reduced motion. */
export const FADE = "transition-opacity duration-150 motion-reduce:transition-none";

const FOCUS = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const PRESS = "transition-colors duration-150 motion-reduce:transition-none";

/**
 * The one bar at the top of a surface: 40 px, a hairline under it, the
 * gallery's own gutter so the controls line up with the content below. The
 * Library toolbar, the Viewer header and the graph toolbar all use it, so
 * moving between them never shifts the content by a few pixels.
 */
export const BAR = "flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3";

/** The 10 px uppercase line, for the places that cannot use `FieldLabel` itself. */
export const LABEL_CLASS = "text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground";

/**
 * One indeterminate sweep for the whole plugin. Tailwind has no such keyframe
 * and this repo adds no dependencies, so the surfaces that need it render
 * `<SweepStyle />` once and use these two classes: `comfy-sweep` for the 2 px
 * bar on a Jobs row, `comfy-sweep-slow` for the soft band crossing a tile.
 * Reduced motion stops both. Both start on a negative delay so a row or a tile
 * that has just appeared already has the band on screen instead of an empty
 * beat (and so a screenshot, which freezes CSS animations at their start time,
 * catches the band rather than nothing).
 */
const SWEEP_CSS = `
@keyframes comfy-sweep { 0% { transform: translateX(-110%); } 100% { transform: translateX(320%); } }
.comfy-sweep { animation: comfy-sweep 1.6s cubic-bezier(0.45, 0, 0.55, 1) -0.6s infinite; }
.comfy-sweep-slow { animation: comfy-sweep 2.6s linear -1.1s infinite; }
@media (prefers-reduced-motion: reduce) {
  .comfy-sweep { animation: none; transform: none; width: 100%; opacity: 0.6; }
  .comfy-sweep-slow { animation: none; opacity: 0; }
}
`;

export function SweepStyle() {
  return <style>{SWEEP_CSS}</style>;
}

// ---------- hairline, card ----------

/** One weight of chrome: a 1 px rule, never a border plus a shadow. */
export function Hairline({ vertical = false, className }: { vertical?: boolean; className?: string }) {
  return <div aria-hidden className={cn(vertical ? "w-px self-stretch" : "h-px w-full", "bg-border/60", className)} />;
}

export interface CardProps {
  children: ReactNode;
  className?: string;
  /** Off for a card that owns its own padding. */
  padded?: boolean;
}

/** A hairline box on the card surface. No shadow, no nesting. */
export function Card({ children, className, padded = true }: CardProps) {
  return <div className={cn("rounded-md border border-border/60 bg-card text-card-foreground", padded && "p-4", className)}>{children}</div>;
}

// ---------- labels and fields ----------

export interface FieldLabelProps {
  children: ReactNode;
  /** Renders a real <label> pointing at this control. */
  htmlFor?: string;
  /** Right aligned note on the same line, e.g. the resulting pixel size. */
  hint?: ReactNode;
  className?: string;
}

/** The 10 px uppercase line that names a row of controls. */
export function FieldLabel({ children, htmlFor, hint, className }: FieldLabelProps) {
  const text = LABEL_CLASS;
  if (hint === undefined) {
    return htmlFor === undefined ? (
      <p className={cn(text, className)}>{children}</p>
    ) : (
      <label htmlFor={htmlFor} className={cn(text, "block", className)}>
        {children}
      </label>
    );
  }
  return (
    <div className={cn("flex min-w-0 items-baseline gap-2", className)}>
      {htmlFor === undefined ? (
        <p className={cn(text, "min-w-0")}>{children}</p>
      ) : (
        <label htmlFor={htmlFor} className={cn(text, "min-w-0")}>
          {children}
        </label>
      )}
      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">{hint}</span>
    </div>
  );
}

export interface FieldProps {
  label: string;
  children: ReactNode;
  className?: string;
}

/** A labelled block in a details column. */
export function Field({ label, children, className }: FieldProps) {
  return (
    <div className={cn("min-w-0", className)}>
      <FieldLabel>{label}</FieldLabel>
      <div className="min-w-0 break-words text-[12px] leading-5 text-foreground [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

// ---------- buttons ----------

export interface GhostButtonClassOptions {
  /** Square, for a glyph with no label. */
  iconOnly?: boolean;
  /** Hover turns red, for delete. */
  danger?: boolean;
}

/** The ghost button look, for the call sites that need it on an anchor. */
export function ghostButtonClass({ iconOnly = false, danger = false }: GhostButtonClassOptions = {}): string {
  return cn(
    "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[12px] font-medium text-muted-foreground",
    "hover:bg-state-hover hover:text-foreground aria-pressed:text-foreground disabled:pointer-events-none disabled:opacity-50",
    "max-md:pointer-coarse:h-11 max-md:pointer-coarse:min-h-11",
    iconOnly ? "w-7 max-md:pointer-coarse:w-11" : "px-2 max-md:pointer-coarse:px-3",
    danger && "hover:bg-transparent hover:text-destructive",
    PRESS,
    FOCUS,
  );
}

export interface GhostButtonProps extends GhostButtonClassOptions {
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
  /** Required when the button holds a glyph and no words. */
  ariaLabel?: string;
  ariaPressed?: boolean;
  /**
   * Takes the focus when its dialog opens. The Cancel in a destructive confirm
   * wants this, so a return key pressed out of habit cancels rather than
   * destroys; nothing outside a dialog should need it.
   */
  autoFocus?: boolean;
}

/** A quiet button: no fill at rest, a hover wash, glyph or glyph plus word. */
export function GhostButton({ children, onClick, disabled, className, title, ariaLabel, ariaPressed, autoFocus, iconOnly, danger }: GhostButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      className={cn(ghostButtonClass({ iconOnly, danger }), className)}
    >
      {children}
    </button>
  );
}

export interface PrimaryButtonClassOptions {
  /** Full width and 36 px tall, for the one submit on a form. */
  block?: boolean;
  /** The destructive confirm; still the only filled control in its dialog. */
  tone?: "default" | "danger";
}

export function primaryButtonClass({ block = false, tone = "default" }: PrimaryButtonClassOptions = {}): string {
  return cn(
    "inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-3 text-[12px] font-medium",
    tone === "danger" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : "bg-foreground text-background hover:bg-foreground/90",
    "disabled:pointer-events-none disabled:opacity-50",
    block ? "h-9 w-full max-md:pointer-coarse:h-11" : "h-7 max-md:pointer-coarse:h-11",
    PRESS,
    FOCUS,
  );
}

export interface PrimaryButtonProps extends PrimaryButtonClassOptions {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** Muted text pinned to the right inside the button, e.g. "about 20 s". */
  meta?: ReactNode;
  /** Swaps the leading glyph for a spinner. */
  busy?: boolean;
  glyph?: GlyphName;
  className?: string;
  title?: string;
  /**
   * The meta on its own line under the label, for a button too narrow to hold
   * both side by side: Regenerate in a half width cell on a phone would
   * otherwise cut its own name to "Regenerat...".
   */
  metaBelow?: boolean;
}

/** The one loud control on a surface: solid, 36 px when full width. */
export function PrimaryButton({ children, onClick, disabled, meta, busy = false, glyph, block = false, tone = "default", className, title, metaBelow = false }: PrimaryButtonProps) {
  const Leading = glyph === undefined ? null : Glyph[glyph];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(primaryButtonClass({ block, tone }), className)}
    >
      {busy ? <Spinner className="shrink-0 text-current" /> : Leading === null ? null : <Leading className="size-3.5 shrink-0" />}
      {metaBelow && meta !== undefined ? (
        <span className="flex min-w-0 flex-col items-start leading-4">
          <span className="max-w-full truncate">{children}</span>
          <span className="max-w-full truncate text-[11px] font-normal opacity-70">{meta}</span>
        </span>
      ) : (
        <>
          <span className="min-w-0 truncate">{children}</span>
          {meta === undefined ? null : <span className="ml-auto shrink-0 pl-2 font-normal opacity-70">{meta}</span>}
        </>
      )}
    </button>
  );
}

// ---------- chips and the segmented control ----------

export interface ChipProps {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  title?: string;
}

/** A small toggle; used for filters, tiers, aspects and counts. */
export function Chip({ active, onClick, children, disabled, className, ariaLabel, title }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-[26px] cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-50",
        "max-md:pointer-coarse:h-11 max-md:pointer-coarse:min-h-11 max-md:pointer-coarse:min-w-11 max-md:pointer-coarse:px-3",
        active ? "border-foreground/20 bg-foreground/10 text-foreground" : "border-border/60 text-muted-foreground hover:bg-state-hover hover:text-foreground",
        PRESS,
        FOCUS,
        className,
      )}
    >
      {children}
    </button>
  );
}
export function ChipGroup({ ariaLabel, children, className }: { ariaLabel: string; children: ReactNode; className?: string }) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("flex flex-wrap items-center gap-1 max-md:pointer-coarse:gap-2", className)}>
      {children}
    </div>
  );
}
export interface SegmentOption {
  id: string;
  label: string;
  count?: number;
  glyph?: GlyphName;
}

export interface SegmentedProps {
  options: readonly SegmentOption[];
  value: string;
  onSelect: (id: string) => void;
  ariaLabel: string;
  className?: string;
}

export function Segmented({ options, value, onSelect, ariaLabel, className }: SegmentedProps) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("inline-flex h-7 shrink-0 items-center rounded-md border border-border/60 p-0.5 max-md:pointer-coarse:h-auto max-md:pointer-coarse:py-1", className)}>
      {options.map((option) => {
        const active = option.id === value;
        const Leading = option.glyph === undefined ? null : Glyph[option.glyph];
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(option.id)}
            className={cn(
              "inline-flex h-6 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[4px] px-2 text-[12px] font-medium",
              "max-md:pointer-coarse:h-11 max-md:pointer-coarse:min-w-11 max-md:pointer-coarse:justify-center max-md:pointer-coarse:px-3",
              active ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:text-foreground",
              PRESS,
              FOCUS,
            )}
          >
            {Leading === null ? null : <Leading className="size-3.5" />}
            {option.label}
            {option.count === undefined ? null : <span className="tabular-nums text-muted-foreground">{option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---------- select ----------

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** The vendor's own words for why an option is greyed out. */
  title?: string;
}

export interface SelectProps {
  value: string;
  options: readonly SelectOption[];
  onSelect: (value: string) => void;
  /** The accessible name, when no <label> points at this control. */
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
}

/**
 * A native select in the plugin's chrome: the browser's own arrow is switched
 * off (`appearance-none`) and this plugin's chevron is drawn over the right
 * edge instead, so a 70 option list stays one 28 px control and still draws no
 * icon from anyone else's set.
 */
export function Select({ value, options, onSelect, ariaLabel, id, disabled = false, title, className }: SelectProps) {
  return (
    <span className={cn("relative inline-flex min-w-0 items-center", className)}>
      <select
        id={id}
        value={value}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onChange={(event) => onSelect(event.target.value)}
        className={cn(
          "h-7 w-full min-w-0 cursor-pointer appearance-none truncate rounded-md border border-border/60 bg-transparent py-0 pl-2 pr-7 text-[12px] text-foreground max-md:pointer-coarse:h-10 max-md:pointer-coarse:text-base",
          "disabled:cursor-not-allowed disabled:opacity-50",
          PRESS,
          FOCUS,
        )}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled} title={option.title} className="bg-background text-foreground">
            {option.label}
          </option>
        ))}
      </select>
      <Glyph.down className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" />
    </span>
  );
}
export interface CheckBoxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The accessible name; the box itself carries no words. */
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A checkbox drawn with this plugin's own tick. The host `Checkbox` paints an
 * icon-set glyph, which none of these surfaces may show, so the graph's node
 * form uses this instead.
 */
export function CheckBox({ checked, onChange, ariaLabel, disabled = false, className }: CheckBoxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-foreground bg-foreground text-background" : "border-border/60 text-transparent hover:border-foreground/40",
        PRESS,
        FOCUS,
        className,
      )}
    >
      <Glyph.check className="size-3" />
    </button>
  );
}

// ---------- waiting ----------

export function Spinner({ className }: { className?: string }) {
  return <Glyph.spinner className={cn("size-3.5 animate-spin motion-reduce:animate-none", className)} />;
}

/** A soft placeholder while something loads or runs. */
export function Shimmer({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)} />;
}

// ---------- banners and empty states ----------

export interface BannerProps {
  tone?: "info" | "error";
  children: ReactNode;
  action?: ReactNode;
}

/** A slim line at the top of a surface; the content below stays visible. */
export function Banner({ tone = "info", children, action }: BannerProps) {
  const Leading = tone === "error" ? Glyph.alert : Glyph.info;
  return (
    <div role="status" className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[12px] leading-5">
      <Leading className={cn("size-3.5 shrink-0", tone === "error" ? "text-destructive" : "text-muted-foreground")} />
      <div className="min-w-0 flex-1 break-words text-foreground [overflow-wrap:anywhere]">{children}</div>
      {action === undefined ? null : <div className="shrink-0">{action}</div>}
    </div>
  );
}

export interface EmptyStateProps {
  /** The generated artwork for this state; falls back to a glyph. */
  art?: ReactNode;
  glyph?: GlyphName;
  title: string;
  /** One or two sentences, or a code block. */
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Artwork, a title, a sentence and the one useful next step. */
export function EmptyState({ art, glyph, title, children, action, className }: EmptyStateProps) {
  const Mark = glyph === undefined ? null : Glyph[glyph];
  return (
    <div className={cn("flex flex-col items-center gap-3 px-4 py-10 text-center", className)}>
      {art !== undefined ? art : Mark === null ? null : <Mark className="size-8 text-muted-foreground/60" />}
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      {children === undefined ? null : <div className="max-w-[46ch] space-y-2 text-[12px] leading-5 text-muted-foreground">{children}</div>}
      {action === undefined ? null : <div className="flex flex-wrap justify-center gap-2 pt-1">{action}</div>}
    </div>
  );
}

export interface EmptyCardProps {
  icon: GlyphName;
  art?: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}

/** EmptyState in a card, for a surface whose whole body is empty. */
export function EmptyCard({ icon, art, title, children, actions }: EmptyCardProps) {
  return (
    <div className="flex min-h-full flex-1 items-start justify-center p-4 sm:items-center">
      <Card className="w-full max-w-md" padded={false}>
        <EmptyState art={art} glyph={icon} title={title} action={actions} className="px-5 py-7">
          {children}
        </EmptyState>
      </Card>
    </div>
  );
}

/** The same state without the card, for an area inside a surface. */
export function EmptyNote({ icon, art, title, hint, children }: { icon: GlyphName; art?: ReactNode; title: string; hint?: string; children?: ReactNode }) {
  return (
    <EmptyState art={art} glyph={icon} title={title} action={children}>
      {hint === undefined || hint === "" ? undefined : <p className="break-words [overflow-wrap:anywhere]">{hint}</p>}
    </EmptyState>
  );
}

// ---------- disclosure ----------

export interface DisclosureProps {
  label: string;
  children: ReactNode;
  /** Muted words on the summary line, e.g. how many rows are inside. */
  meta?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

/** A closed-by-default section: the summary is a row, the body is anything. */
export function Disclosure({ label, children, meta, defaultOpen = false, className }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <div className={cn("min-w-0", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className={cn("flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-[12px] font-medium text-muted-foreground hover:text-foreground max-md:pointer-coarse:h-11", PRESS, FOCUS)}
      >
        {open ? <Glyph.down className="size-3.5 shrink-0" /> : <Glyph.forward className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate">{label}</span>
        {meta === undefined ? null : <span className="ml-auto shrink-0 text-[11px] font-normal text-muted-foreground">{meta}</span>}
      </button>
      <div id={bodyId} hidden={!open} className="min-w-0 px-1 pb-1 pt-1">
        {children}
      </div>
    </div>
  );
}

// ---------- copy ----------

export async function copyText(text: string, done = "Copied"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Could not copy");
  }
}

/**
 * A glyph that copies. On a finger its target is exactly 44 px square and
 * bleeds back out to the size it draws at, so it never pushes the line it sits
 * on. A `box-content` plus padding version would meet the ghost button's own
 * `min-h-11` and grow the line taller than the text beside it.
 * Pass `size` for the glyph's own box when it is not 24 px; the bleed follows.
 */
export function CopyButton({ text, label, done, className, size = "md" }: { text: string; label: string; done?: string; className?: string; size?: "sm" | "md" }) {
  return (
    <GhostButton
      iconOnly
      ariaLabel={label}
      className={cn(
        size === "sm" ? "size-4 max-md:pointer-coarse:-m-3.5" : "size-6 max-md:pointer-coarse:-m-2.5",
        "max-md:pointer-coarse:size-11 max-md:pointer-coarse:min-h-11",
        className,
      )}
      onClick={() => void copyText(text, done)}
    >
      <Glyph.copy className="size-3.5" />
    </GhostButton>
  );
}
