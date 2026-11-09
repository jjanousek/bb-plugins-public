// Which navigations a deep link has already been honoured for. No imports, so
// core.test.ts can exercise it under node; `deep-link.ts` is the only caller.
//
// The page deliberately leaves `mission` and `worker/<id>` in the URL (clearing
// it closes the compact drawer the tap just opened, see app.tsx), and every
// fixed tab receives the same `subPath` for as long as it stays there. So the
// deep-link hook runs again each time a tab mounts. Without a claim, on
// `/chief/mission` a click on the Worker tab, or on any worker row, mounts the
// Worker tab, which reads "mission" and sends the panel straight back to the
// board.
//
// Keyed on the navigation, not the sub path: bb's router (react-router) puts a
// fresh `key` in `history.state` on every push, so a second tap on the same
// link is a new key and is honoured again, while a tab mounting under the SAME
// navigation is not. Module scope, because the two fixed tabs mount and unmount
// in turn and the record has to outlive both.

const honoured = new Set<string>();

/** Test seam: forget what has been honoured. */
export function resetHonouredDeepLinks(): void {
  honoured.clear();
}

/** True the first time a navigation is seen for this sub path, false after. */
export function claimDeepLink(subPath: string, navigationKey: string): boolean {
  const key = `${navigationKey}\u0000${subPath}`;
  if (honoured.has(key)) return false;
  honoured.add(key);
  return true;
}

/**
 * Give a claim back, for a request that was cancelled before it ran: the
 * effect that claimed it re-ran first, and the re-run must still honour it.
 */
export function releaseDeepLink(subPath: string, navigationKey: string): void {
  honoured.delete(`${navigationKey}\u0000${subPath}`);
}

/** The router's key for the current history entry, or a constant when there is none. */
export function currentNavigationKey(): string {
  const state = typeof window === "undefined" ? null : (window.history.state as { key?: unknown } | null);
  return typeof state?.key === "string" ? state.key : "no-key";
}
