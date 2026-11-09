// The one signal this plugin's sidebar nav badge renders, and its cascade.
//
// No React and no JSX in this file, and `panel-chrome.tsx` only re-exports it,
// so the logic stays a plain .ts module that any test runner can load. The
// clamp is imported with its file extension for the same reason.
// Tests: test/sidebar.test.tsx.
import { clamp99 } from "./sidebar-accessory-format.ts";
import type { Status } from "@/contract";
import type { AccessorySignal } from "@/components/comfy/sidebar-accessory";

/**
 * The single loudest thing the sidebar row has to say, or nothing.
 *
 * The host clips the accessory to a fixed box, narrower still once the dot is
 * in, so the word is "jobs": "99 jobs" fits where "99 running" would clip, and
 * the pulsing dot already says they are running.
 *
 * Failed comes first and in red because a failed generation costs real credits
 * when it goes unnoticed, and it reads `failedRecent` rather than `failed`
 * because a signal has to be able to go away: see `FAILED_WINDOW_MS` in
 * contract.ts for why a lifetime count cannot feed a red badge. The lifetime
 * figure is still what the panel shows.
 */
export function topSignal(status: Status | null): AccessorySignal | null {
  if (status === null) return null;
  const { running, failedRecent } = status.counts;
  if (failedRecent > 0) return { level: "urgent", text: `${clamp99(failedRecent)} failed` };
  if (running > 0) return { level: "activity", text: `${clamp99(running)} jobs` };
  return null;
}
