// The finished mark's label, shared by the server that sets it
// (`threadStatusMarks` in core.ts) and the sidebar script that finds bb's glyph
// by it (sidebar-faces.ts). bb copies a plugin status label onto the glyph's
// aria-label, so this string is how the script tells the plugin's own glyph
// from bb's spinner, failure cross and question, which sit in the same slot.
// No imports, so both sides and the tests can load it.
export const FINISHED_LABEL = "Finished, not read yet";
