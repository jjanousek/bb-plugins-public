// The count format for the sidebar nav badge.
// Plain .ts on purpose: topSignal and its unit tests import this, and keeping
// it free of JSX lets any test runner load it.

/** Counts clamp at 99: "99+" is too wide to fit beside a dot. */
export function clamp99(n: number): string {
  return String(Math.min(Math.max(0, Math.trunc(n)), 99));
}
