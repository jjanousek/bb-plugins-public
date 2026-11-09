// Shared with the sidebar nav badge component, which other plugins copy too.
// Plain .ts on purpose: topSignal and its unit tests must import this, and some
// plugins run node --test with native type stripping, which cannot load a .tsx
// at all. Keep the copies identical.

/** Counts clamp at 99: "99+" is 59px and clips with a dot. */
export function clamp99(n: number): string {
  return String(Math.min(Math.max(0, Math.trunc(n)), 99));
}
