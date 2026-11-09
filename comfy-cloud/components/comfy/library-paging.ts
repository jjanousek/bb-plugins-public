// How much of the library the grid asks for. Plain .ts with no SDK import, so a
// test can read the numbers without loading the host app.
//
// The grid asks for the newest LIBRARY_LIMIT rows first, and "Show older"
// raises the limit a page at a time, so every row in the store can be reached
// from the panel.

/** Rows the grid asks for at first, and how many each "Show older" adds. */
export const LIBRARY_LIMIT = 200;

/** The most the store hands back in one call (MAX_LIST_LIMIT in store.ts). */
export const LIBRARY_MAX = 2000;

/** The limit after one more page, never past what the store will answer. */
export function nextLimit(limit: number): number {
  return Math.min(LIBRARY_MAX, limit + LIBRARY_LIMIT);
}

/**
 * True when the list filled the limit it asked for, so older rows may exist.
 * A list shorter than its limit is the whole library for that filter.
 */
export function mayHaveOlder(rows: number, limit: number): boolean {
  return rows >= limit && limit < LIBRARY_MAX;
}
