// Shared with the sidebar nav badge component.
// Plain .ts on purpose: topSignal and its unit tests must import this, and
// node --test with native type stripping cannot load a .tsx at all.

/** Counts clamp at 99: "99+" is 59px and clips with a dot. */
export function clamp99(n: number): string {
  return String(Math.min(Math.max(0, Math.trunc(n)), 99));
}
