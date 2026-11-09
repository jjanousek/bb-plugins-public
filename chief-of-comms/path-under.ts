// Is a path inside a folder? Used by `fileTarget` in server.ts to resolve a
// local file link to thread storage or the workspace before a bare host path.

import { posix } from "node:path";

/**
 * `absolute` as a path relative to `root`, or null when it is not strictly
 * inside it. Copied unchanged from chief-of-staff's `relativeUnder` (core.ts);
 * there is no shared code between plugins. Outside means a `..`
 * SEGMENT, not a `..` prefix: a file named `..notes.md` in the root is inside
 * it. A plain prefix test would read it as outside, so a link to such a file
 * would skip the workspace target and fall back to a bare host path, which
 * bb's PDF viewer cannot open.
 */
export function relativeUnder(root: string | null | undefined, absolute: string): string | null {
  if (!root) return null;
  const rel = posix.relative(root, absolute);
  if (rel === "" || rel.startsWith("/")) return null;
  return rel.split("/").some((part) => part === "..") ? null : rel;
}
