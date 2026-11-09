# Panel assets

Every mark in the Comms panel was drawn for this plugin, so the UI carries no
third party icon font and no emoji.

## How a glyph is made

1. Generate the artwork on Comfy Cloud with Seedream 5 pro. An example prompt
   scaffold (vary only the subject, keep the rest):

   > A single minimal pictogram of SUBJECT, centered on a pure white background.
   > Solid black shapes with BOLD heavy uniform stroke weight, thick chunky
   > lines roughly one tenth of the icon width, rounded caps and corners,
   > geometric flat vector icon designed to stay legible at very small sizes.
   > One simple shape, no inner detail, generous even margin. No text, no
   > letters, no gradients, no shadows, no color, no frame, no border.

   `bb comfy image "<prompt>" --seed <n>`

2. Trace it: `node tools/asset-pipeline/trace.mjs <name> <image.png> <outDir>`.
   The script trims to the ink, thresholds, traces with potrace, scales the
   path into a 100 unit box and centres it in a square viewBox, so glyphs share
   an optical size whatever their aspect. It needs `sharp` and `potrace`
   installed somewhere (they are not plugin dependencies).

3. Paste the resulting `{viewBox, d}` into `components/comms/glyph-data.ts` and
   use it as `<Glyph name="..." />`.

Ink coverage between roughly 0.25 and 0.5 survives 14px. Below that the mark
goes spidery; above it thin interior gaps close up and the shape traces as a
blob.

The manifest icon is `assets/brand.svg`, the same pipeline applied to the
plugin's own mark. The host serves it and draws it as a currentColor mask.
