// The panel's only icon primitive.
//
// Marks come from glyph-data.ts (drawn for this plugin, traced to paths), never
// from an icon font or an emoji. Everything inherits currentColor, so a glyph
// takes the colour of the text around it and works in both themes.
import { GLYPHS, type GlyphName } from "./glyph-data";
import { cn } from "@/lib/utils";

export type { GlyphName };

export interface GlyphProps {
  name: GlyphName;
  /** Edge length in pixels. Optical sizes in this panel: 12, 14, 16, 20. */
  size?: number;
  className?: string;
  /** Give a label only when the glyph carries meaning no nearby text repeats. */
  label?: string;
}

export function Glyph({ name, size = 14, className, label }: GlyphProps) {
  const shape = GLYPHS[name];
  return (
    <svg
      viewBox={shape.viewBox}
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={shape.d} fill="currentColor" />
    </svg>
  );
}
