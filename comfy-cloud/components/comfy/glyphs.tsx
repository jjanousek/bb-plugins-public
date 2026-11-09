// The plugin's own micro glyphs. Nothing here comes from an icon set: every
// path is drawn for this plugin on a 20x20 grid with a 1.5 stroke, round caps
// and joins, no fill, and the colour taken from `currentColor`, so a glyph
// picks up whatever host token class its caller sets.
//
// Rules for adding one: keep the ink inside 3.5 to 16.5 so a 1.5 stroke never
// touches the box, sit the anchors on the 2px grid where the shape allows it,
// and centre the drawing optically rather than by its bounding box. Then look
// at it on a sheet of every glyph at the sizes the panel actually uses.
//
// Each entry of SHAPES is one `<g>` on one line; the sheet generator reads
// this file as text, so keep that shape.
import type { ReactElement } from "react";
import { cn } from "@/lib/utils";

export type GlyphName =
  | "back"
  | "forward"
  | "up"
  | "down"
  | "close"
  | "plus"
  | "minus"
  | "fit"
  | "search"
  | "refresh"
  | "dice"
  | "spark"
  | "sliders"
  | "braces"
  | "nodes"
  | "star"
  | "starFilled"
  | "download"
  | "trash"
  | "copy"
  | "play"
  | "pause"
  | "spinner"
  | "alert"
  | "check"
  | "image"
  | "video"
  | "grid"
  | "clock"
  | "info"
  | "more"
  | "reference"
  | "zoom";

export interface GlyphProps {
  /** Size and colour, e.g. "size-3.5 text-muted-foreground". */
  className?: string;
}

export type GlyphComponent = (props: GlyphProps) => ReactElement;

/* eslint-disable */
const SHAPES: Record<GlyphName, ReactElement> = {
  back: <g><path d="M12.5 5 L7.5 10 L12.5 15" /></g>,
  forward: <g><path d="M7.5 5 L12.5 10 L7.5 15" /></g>,
  up: <g><path d="M5 12.5 L10 7.5 L15 12.5" /></g>,
  down: <g><path d="M5 7.5 L10 12.5 L15 7.5" /></g>,
  close: <g><path d="M5.6 5.6 L14.4 14.4" /><path d="M14.4 5.6 L5.6 14.4" /></g>,
  plus: <g><path d="M10 4.5 V15.5" /><path d="M4.5 10 H15.5" /></g>,
  minus: <g><path d="M4.5 10 H15.5" /></g>,
  fit: <g><path d="M4 8 V4 H8" /><path d="M12 4 H16 V8" /><path d="M16 12 V16 H12" /><path d="M8 16 H4 V12" /></g>,
  search: <g><circle cx="9" cy="9" r="4.75" /><path d="M12.6 12.6 L16 16" /></g>,
  refresh: <g><path d="M14.5 8.2 A5.2 5.2 0 1 1 10 5.6" /><path d="M7.73 7.25 L10 5.6 L7.73 3.95" /></g>,
  // Tilted, and showing three: an upright square with marks on one diagonal is
  // the same silhouette as `image` at 14 px, which is where both are drawn two
  // rows apart in the Generate tab, so the tilt is what tells them apart and
  // the corners run a little past the usual 3.5 to 16.5 ink box. Three pips of
  // r 1.65 on the anti-diagonal, not five of r 1.05: at 14 px five pips merge
  // into one smudge and the face stops reading as a face.
  dice: <g><g transform="rotate(-16 10 10)"><rect x="4" y="4" width="12" height="12" rx="2.8" /><circle cx="7" cy="13" r="1.65" fill="currentColor" stroke="none" /><circle cx="10" cy="10" r="1.65" fill="currentColor" stroke="none" /><circle cx="13" cy="7" r="1.65" fill="currentColor" stroke="none" /></g></g>,
  spark: <g><path d="M10 3.4 C10.62 7.2 12.8 9.38 16.6 10 C12.8 10.62 10.62 12.8 10 16.6 C9.38 12.8 7.2 10.62 3.4 10 C7.2 9.38 9.38 7.2 10 3.4 Z" /></g>,
  sliders: <g><path d="M3.5 7 H6.2" /><path d="M10.2 7 H16.5" /><circle cx="8.2" cy="7" r="2" /><path d="M3.5 13 H10.8" /><path d="M14.8 13 H16.5" /><circle cx="12.8" cy="13" r="2" /></g>,
  braces: <g><path d="M8.6 4 C7.3 4 6.9 4.7 6.9 5.9 V8 C6.9 9.2 6.2 10 5 10 C6.2 10 6.9 10.8 6.9 12 V14.1 C6.9 15.3 7.3 16 8.6 16" /><path d="M11.4 4 C12.7 4 13.1 4.7 13.1 5.9 V8 C13.1 9.2 13.8 10 15 10 C13.8 10 13.1 10.8 13.1 12 V14.1 C13.1 15.3 12.7 16 11.4 16" /></g>,
  nodes: <g><rect x="3.5" y="3.6" width="5.3" height="4.4" rx="1.2" /><rect x="3.5" y="12" width="5.3" height="4.4" rx="1.2" /><rect x="11.2" y="7.8" width="5.3" height="4.4" rx="1.2" /><path d="M8.8 5.8 L11.2 10" /><path d="M8.8 14.2 L11.2 10" /></g>,
  star: <g><path d="M10 3.8 L11.79 7.93 L16.28 8.36 L12.9 11.34 L13.88 15.74 L10 13.45 L6.12 15.74 L7.1 11.34 L3.72 8.36 L8.21 7.93 Z" /></g>,
  starFilled: <g><path d="M10 3.8 L11.79 7.93 L16.28 8.36 L12.9 11.34 L13.88 15.74 L10 13.45 L6.12 15.74 L7.1 11.34 L3.72 8.36 L8.21 7.93 Z" fill="currentColor" /></g>,
  download: <g><path d="M10 4 V13" /><path d="M6.6 9.6 L10 13 L13.4 9.6" /><path d="M4.5 14 V16 H15.5 V14" /></g>,
  trash: <g><path d="M4 6 H16" /><path d="M8 6 V4.6 H12 V6" /><path d="M6.1 6.5 L6.8 16 H13.2 L13.9 6.5" /><path d="M8.7 9.4 V13.2" /><path d="M11.3 9.4 V13.2" /></g>,
  copy: <g><rect x="3.5" y="7.5" width="9" height="9" rx="2" /><path d="M7 7.5 V5.5 C7 4.4 7.9 3.5 9 3.5 H14.5 C15.6 3.5 16.5 4.4 16.5 5.5 V11 C16.5 12.1 15.6 13 14.5 13 H12.5" /></g>,
  play: <g><path d="M7 5.4 L15 10 L7 14.6 Z" /></g>,
  pause: <g><path d="M7.8 5.5 V14.5" /><path d="M12.2 5.5 V14.5" /></g>,
  spinner: <g><path d="M10 3.5 A6.5 6.5 0 1 1 3.5 10" /></g>,
  alert: <g><circle cx="10" cy="10" r="6.75" /><path d="M10 6.3 V10.8" /><path d="M10 13.5 V13.55" /></g>,
  check: <g><path d="M4.6 10.4 L8.3 14.1 L15.4 5.9" /></g>,
  image: <g><rect x="3.5" y="4.5" width="13" height="11" rx="2" /><circle cx="7.3" cy="8.2" r="1.3" /><path d="M4.4 14.3 L9.3 9.4 L15.6 14.3" /></g>,
  video: <g><rect x="3.5" y="5" width="10" height="10" rx="2" /><path d="M13.5 8.9 L16.5 6.6 V13.4 L13.5 11.1 Z" /></g>,
  grid: <g><rect x="3.5" y="3.5" width="6" height="6" rx="1.5" /><rect x="10.5" y="3.5" width="6" height="6" rx="1.5" /><rect x="3.5" y="10.5" width="6" height="6" rx="1.5" /><rect x="10.5" y="10.5" width="6" height="6" rx="1.5" /></g>,
  clock: <g><circle cx="10" cy="10" r="6.5" /><path d="M10 5.9 V10.3 L12.9 12" /></g>,
  info: <g><circle cx="10" cy="10" r="6.75" /><path d="M10 9.4 V13.6" /><path d="M10 6.4 V6.45" /></g>,
  // Three rings of r 0.9 under a 1.5 stroke draw as 3.3 px dots, which is the
  // smallest mark that still reads as three at 14 px without filling anything.
  more: <g><circle cx="4.8" cy="10" r="0.9" /><circle cx="10" cy="10" r="0.9" /><circle cx="15.2" cy="10" r="0.9" /></g>,
  // A picture with an arrow leaving its corner: this one goes somewhere else to
  // be worked from. Kept apart from `image` by the arrow, which owns the top right.
  reference: <g><rect x="3.5" y="7" width="9.5" height="9.5" rx="2" /><path d="M5.2 14.8 L8.3 11.7 L11.4 14.8" /><path d="M11.8 3.5 H16.5 V8.2" /><path d="M16.5 3.5 L11.6 8.4" /></g>,
  zoom: <g><circle cx="9" cy="9" r="4.75" /><path d="M12.6 12.6 L16 16" /><path d="M9 7 V11" /><path d="M7 9 H11" /></g>,
};
/* eslint-enable */

function Drawing({ name, className }: { name: GlyphName; className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4 shrink-0", className)}
    >
      {SHAPES[name]}
    </svg>
  );
}

/**
 * Every glyph the plugin draws, as components: `<Glyph.back className="size-3.5" />`.
 * They are always decorative; the accessible name belongs on the control around them.
 */
export const Glyph: Record<GlyphName, GlyphComponent> = {
  back: (props) => <Drawing name="back" {...props} />,
  forward: (props) => <Drawing name="forward" {...props} />,
  up: (props) => <Drawing name="up" {...props} />,
  down: (props) => <Drawing name="down" {...props} />,
  close: (props) => <Drawing name="close" {...props} />,
  plus: (props) => <Drawing name="plus" {...props} />,
  minus: (props) => <Drawing name="minus" {...props} />,
  fit: (props) => <Drawing name="fit" {...props} />,
  search: (props) => <Drawing name="search" {...props} />,
  refresh: (props) => <Drawing name="refresh" {...props} />,
  dice: (props) => <Drawing name="dice" {...props} />,
  spark: (props) => <Drawing name="spark" {...props} />,
  sliders: (props) => <Drawing name="sliders" {...props} />,
  braces: (props) => <Drawing name="braces" {...props} />,
  nodes: (props) => <Drawing name="nodes" {...props} />,
  star: (props) => <Drawing name="star" {...props} />,
  starFilled: (props) => <Drawing name="starFilled" {...props} />,
  download: (props) => <Drawing name="download" {...props} />,
  trash: (props) => <Drawing name="trash" {...props} />,
  copy: (props) => <Drawing name="copy" {...props} />,
  play: (props) => <Drawing name="play" {...props} />,
  pause: (props) => <Drawing name="pause" {...props} />,
  spinner: (props) => <Drawing name="spinner" {...props} />,
  alert: (props) => <Drawing name="alert" {...props} />,
  check: (props) => <Drawing name="check" {...props} />,
  image: (props) => <Drawing name="image" {...props} />,
  video: (props) => <Drawing name="video" {...props} />,
  grid: (props) => <Drawing name="grid" {...props} />,
  clock: (props) => <Drawing name="clock" {...props} />,
  info: (props) => <Drawing name="info" {...props} />,
  more: (props) => <Drawing name="more" {...props} />,
  reference: (props) => <Drawing name="reference" {...props} />,
  zoom: (props) => <Drawing name="zoom" {...props} />,
};

/** The names in drawing order, for the glyph sheet and for anything that iterates. */
export const GLYPH_NAMES = Object.keys(Glyph) as readonly GlyphName[];
