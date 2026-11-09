// What counts as "now", in one place, for the two surfaces that show it: the
// Library's strip above the first day and the Jobs tab. Plain .ts with no React
// so the age rules are held by tests rather than by whoever last read the
// components.
//
// The rule underneath both: a failure is news for a while and then it is
// history. A failure stays loud while it is fresh and then takes its place in
// time order like everything else, so an old failure never sits above work
// that has finished since and makes the tab look broken.
import { FAILED_WINDOW_MS } from "../../contract";
import type { Asset } from "../../contract";

/** A failure this recent still sits in the Library's Now strip, with Retry. */
export const STRIP_FAILED_MS = 3600_000;
/** A failure this recent still leads the Jobs tab. The sidebar badge uses the same day. */
export const JOBS_FAILED_MS = FAILED_WINDOW_MS;

/** When a row stopped: the moment it failed or finished, else when it was made. */
export function settledAt(asset: Asset): number {
  return asset.completedAt ?? asset.createdAt;
}

/** Queued, running, or submitted with an outcome not known yet: all still in play. */
function active(asset: Asset): boolean {
  return asset.status === "queued" || asset.status === "running" || asset.status === "unknown";
}

/**
 * The first sentence of an unknown row's reason, for a line too short for the
 * rest. The runner writes the reasons (UNKNOWN_REASON in runner.ts) so that
 * the first sentence says what happened and the rest what the plugin does.
 */
export function unknownHeadline(asset: Asset): string {
  const text = (asset.error ?? "").trim();
  if (text === "") return "Waiting to hear back from Comfy Cloud.";
  const stop = text.indexOf(". ");
  return stop < 0 ? text : text.slice(0, stop + 1);
}

function freshFailure(asset: Asset, nowMs: number, windowMs: number): boolean {
  return asset.status === "failed" && nowMs - settledAt(asset) <= windowMs;
}

export interface LibrarySplit {
  /** Waiting and running rows, oldest first so the one nearest done leads, then fresh failures. */
  strip: Asset[];
  /** Everything else, in the order it came. */
  gallery: Asset[];
}

/**
 * The Library's strip and the gallery under it. A row is in exactly one of the
 * two: a running tile in the grid and a running card above it would be the
 * same news twice.
 */
export function splitLibrary(assets: readonly Asset[], nowMs: number, windowMs = STRIP_FAILED_MS): LibrarySplit {
  const running: Asset[] = [];
  const failed: Asset[] = [];
  const gallery: Asset[] = [];
  for (const asset of assets) {
    if (active(asset)) running.push(asset);
    else if (freshFailure(asset, nowMs, windowMs)) failed.push(asset);
    else gallery.push(asset);
  }
  running.sort((a, b) => a.createdAt - b.createdAt);
  failed.sort((a, b) => settledAt(b) - settledAt(a));
  return { strip: [...running, ...failed], gallery };
}

export interface JobsSplit {
  /** Running first, then not known yet, then waiting, oldest first within each. */
  working: Asset[];
  /** Failures inside the window, newest first. */
  failed: Asset[];
  /** Completed rows and older failures together, newest first, at most `limit`. */
  finished: Asset[];
  /** Every failed row the tab knows about, which is what "Clear failed" removes. */
  allFailed: Asset[];
}

/**
 * The Jobs tab's sections. `active` is what the tab fetched as queued, running
 * and failed; `completed` the latest finished rows.
 */
export function splitJobs(active: readonly Asset[], completed: readonly Asset[], nowMs: number, limit = 8, windowMs = JOBS_FAILED_MS): JobsSplit {
  const running = active.filter((asset) => asset.status === "running").sort((a, b) => a.createdAt - b.createdAt);
  const queued = active.filter((asset) => asset.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
  const unknown = active.filter((asset) => asset.status === "unknown").sort((a, b) => a.createdAt - b.createdAt);
  const allFailed = active.filter((asset) => asset.status === "failed");
  const failed = allFailed.filter((asset) => freshFailure(asset, nowMs, windowMs)).sort((a, b) => settledAt(b) - settledAt(a));
  const fresh = new Set(failed.map((asset) => asset.id));
  const older = allFailed.filter((asset) => !fresh.has(asset.id));
  const seen = new Set<string>();
  const finished = [...completed, ...older]
    .filter((asset) => (seen.has(asset.id) ? false : (seen.add(asset.id), true)))
    .sort((a, b) => settledAt(b) - settledAt(a))
    .slice(0, limit);
  return { working: [...running, ...unknown, ...queued], failed, finished, allFailed };
}
