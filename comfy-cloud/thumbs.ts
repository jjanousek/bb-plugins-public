// Small copies of a generated asset, so the Library does not put a
// multi-megabyte original in a small grid tile.
//
// The tile, the Jobs row, the Based on card and the viewer's neighbour preload
// all show a picture far smaller than the original, so each of them asks for a
// derivative instead of `asset.file`.
//
// Two derivatives, both webp, both made with `ffmpeg`, which is already on PATH
// and already used by `probeVideo` in runner.ts:
//
//   thumb   512 px long edge, q65    the grid, the Jobs row, Based on, Variants
//   medium 2048 px long edge, q82    what the viewer opens on and settles on
//
// **The viewer settles on the medium, not the original**: thumbnails small
// and quick, the opened image medium to decently high, the download full
// resolution. The original is only ever fetched by Download,
// which is the untouched file at full size.
//
// The filter fits the **long edge**, not the width: capping the width alone
// makes a portrait thumbnail taller than it needs to be, for pixels the tile
// crops away. The qualities are the lowest at which the copy looks the same as
// the original at the size it is shown; higher settings add bytes for nothing
// visible. A picture smaller than the edge is re-encoded at its own size,
// never upscaled.
//
// A size change reaches existing rows through DERIVATIVE_REVISION: the backfill
// redoes every row made at an older revision, writes the new copy under the
// same name, and the media route's version token (size and mtime, see media.ts)
// changes with the bytes, so a browser holding the old copy asks again.
//
// Nothing here throws into the job loop. A derivative that cannot be made
// leaves its column null and every surface falls back to the original.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AssetKind } from "./contract";

export type DerivativeKind = "thumb" | "medium";

/** Long edge and webp quality per kind. qscale on webp runs 0 (worst) to 100. */
export const DERIVATIVES: Record<DerivativeKind, { edge: number; quality: number }> = {
  thumb: { edge: 512, quality: 65 },
  medium: { edge: 2048, quality: 82 },
};

/**
 * Which DERIVATIVES a row's small copies were made with. Stored per row
 * (`derivative_rev`); the backfill redoes any row below this. Raise it by one
 * whenever DERIVATIVES or the filter in `derivativeArgs` changes what comes out.
 *
 *   null  no revision recorded: 512 wide at q72 and 1280 wide at q80
 *   2     512 and 2048 long edge at q65 and q82
 */
export const DERIVATIVE_REVISION = 2;

/** How long one ffmpeg run may take before it is abandoned. A PNG of a few MB takes well under a second. */
const TIMEOUT_MS = 30_000;

/**
 * `<folder>/<id>.thumb.webp` beside the asset, so the media route and the
 * preview base both serve it by the same relative path and `deleteAsset` can
 * find it by name.
 *
 * The path is stored in a column rather than derived at read time on purpose:
 * a derived path has to be checked against the filesystem on every render to
 * know whether it exists, and the answer would be a second copy of a fact the
 * row already knows.
 */
export function derivativePath(assetPath: string, kind: DerivativeKind): string {
  const folder = path.dirname(assetPath);
  const base = path.basename(assetPath, path.extname(assetPath));
  return path.join(folder, `${base}.${kind}.webp`);
}

/**
 * The ffmpeg arguments, separated from running them so a test can read them
 * without a subprocess.
 *
 * A video is seeked one second in before the frame is taken, because frame zero
 * of a generated clip is often a fade from black. `-frames:v 1` makes the
 * output a still even from a video. `scale` fits the picture inside an edge by
 * edge box, so the **long** edge is the one capped whatever the orientation,
 * and `min(edge, iw)` and `min(edge, ih)` leave a picture smaller than the box
 * alone rather than upscaling it. `force_divisible_by=2` keeps both sides even.
 * `-f webp` names the format, because the destination is a `.part` file whose
 * extension says nothing.
 */
export function derivativeArgs(src: string, dest: string, kind: DerivativeKind, assetKind: AssetKind, seek = true): string[] {
  const { edge, quality } = DERIVATIVES[kind];
  return [
    "-y",
    "-loglevel",
    "error",
    ...(assetKind === "video" && seek ? ["-ss", "1"] : []),
    "-i",
    src,
    "-frames:v",
    "1",
    "-vf",
    `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    "-qscale:v",
    String(quality),
    "-f",
    "webp",
    dest,
  ];
}

/**
 * Writes one derivative and answers with its path, or null when ffmpeg is
 * missing, times out or fails. Never rejects: a generation that succeeded must
 * not be reported as failed because a thumbnail did not.
 */
export async function makeDerivative(src: string, kind: DerivativeKind, assetKind: AssetKind): Promise<string | null> {
  const made = await runDerivative(src, kind, assetKind, true);
  // A clip of a second or less has nothing at the one second seek, so ffmpeg
  // writes an empty file and the run fails. Frame zero is a fine poster for it.
  if (made === null && assetKind === "video") return runDerivative(src, kind, assetKind, false);
  return made;
}

function runDerivative(src: string, kind: DerivativeKind, assetKind: AssetKind, seek: boolean): Promise<string | null> {
  const final = derivativePath(src, kind);
  // Written beside the final name and renamed over it, so the media route never
  // serves a half written copy while the backfill is regenerating one, and a
  // failed regeneration leaves the old copy in place rather than nothing.
  const dest = `${final}.part`;
  return new Promise((resolve) => {
    execFile("ffmpeg", derivativeArgs(src, dest, kind, assetKind, seek), { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error) => {
      // ffmpeg opens the destination before it decodes the source, so a failure
      // can leave an empty file behind. Left there it would sit beside the asset
      // looking like a thumbnail and serve as a broken image, so a run that did
      // not work takes its own output with it. A zero length result counts as
      // not working.
      let bytes = 0;
      try {
        bytes = fs.statSync(dest).size;
      } catch {
        bytes = 0;
      }
      if (error === null && bytes > 0) {
        try {
          fs.renameSync(dest, final);
          return resolve(final);
        } catch {
          // Fall through and clean up the part file.
        }
      }
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        // Nothing to clean up, or the folder is gone with the asset.
      }
      resolve(null);
    });
  });
}
