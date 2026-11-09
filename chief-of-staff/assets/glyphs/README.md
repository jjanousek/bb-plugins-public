# Glyphs

Pictograms drawn for this plugin with Seedream 5.0 Pro on Comfy Cloud, then
traced to single-path SVGs. Rendered inline by
`components/cos/glyph.tsx`. Nothing here comes from a stock icon set.

Every prompt opens with: "Minimal pictogram icon, one single solid black shape
on a pure white background, flat vector style, no outline strokes, no
gradients, no shadow, no text, no border, centered with wide empty margins,
geometric with softly rounded corners, consistent heavy weight. The shape:"

| file | use | comfy asset | the shape, as prompted |
| --- | --- | --- | --- |
| `adopt.svg` | adopt-as-worker header control | img_example01 | a simple person bust silhouette, a round head above rounded shoulders, and separately a small bold plus sign in the upper right corner, not touching the person |
| `more.svg` | row action sheet trigger | img_example02 | exactly three separate solid black filled circles in one horizontal row, identical size, with clear white gaps, not connected by any line |
| `plus.svg` | Delegate button | img_example03 | a bold plus sign made of two equal thick bars crossing at the centre, rounded ends |
| `chevron.svg` | disclosure rows (rotated 90 degrees when open) | img_example04 | a single chevron pointing to the right, two thick bars meeting at a rounded point |
| `close.svg` | dialog close control | img_example05 | a bold letter X made of two equal thick diagonal bars crossing at the centre, rounded ends |
| `check.svg` | checkbox and select item indicator | img_example06 | a bold check mark tick, one short thick bar down to the right joined to one long thick bar up to the right, rounded ends |
| `orgchart.svg` | spare: a heavier cut of the plugin mark, not in use | img_example07 | one solid circle at the top centre connected by two short thick lines to two smaller circles below |
| `empty-board.svg` | "Nothing waiting on you" on the For you tab | img_example08 | an empty inbox tray seen from the front, a wide solid rectangle with a large rectangular opening cut cleanly out of its upper two thirds, leaving a thick base and two thick side walls |

Board areas have no glyph: an area is a filing category the reader takes no
different action on, and the row already names it in words.

## On disk, not in use

`at-rest.svg`, `broken.svg` (img_example16) and `empty-activity.svg`
(img_example15) are traced but absent from `PATHS` in `glyph.tsx`:

- `broken.svg` (a bar with a gap in it) adds nothing to the word "failed"
  beside it, and a glyph is only used where it is load bearing.
- `at-rest.svg` (a wide low stone on a ground bar, hand-authored) stands for a
  state, which a word already conveys.
- `empty-activity.svg` (a ruled sheet) has its rule lines knocked out, and
  because a glyph is drawn in `currentColor` it reads differently in light and
  dark themes. A shape that means two things in two themes is worse than none.

## Adding one

1. Generate with `bb comfy` or the comfy tools, Seedream 5.0 Pro, 1K square,
   using the prompt opener above and one plain sentence for the shape. Pick
   the seed that gives one clean silhouette; reject anything with a stem,
   a joining bar, or an outline.
2. Trace it with `trace.mjs` in this folder (sharp threshold at 150, crop to
   the ink with a 6 percent margin, potrace, scale 512 to 24). It needs
   `sharp` and `potrace`, which are not plugin dependencies:

   ```
   mkdir -p /tmp/trace && cd /tmp/trace && npm i sharp potrace --silent
   node /path/to/assets/glyphs/trace.mjs in.png out.svg 150
   ```

3. Paste the `d` attribute into `PATHS` in `components/cos/glyph.tsx`, add a
   row to the table above with the asset id and prompt sentence, and
   check the result at 14 and 16 px in both themes before using it.

`Glyph` renders every path with `fill-rule="evenodd"`, so a traced shape with a
hole in it keeps the hole.

If a shape does not read, drop it rather than shipping it small enough to hide
the problem.
