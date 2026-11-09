// The plugin's own media route: every picture and clip the panel draws, served
// from the asset folder with a cache header the browser is allowed to keep.
//
// Why this exists at all: bb's file preview (`bb.sdk.files.createPreview`)
// answers `private, no-cache` and hands out a new random base URL on every
// `preview_base` call, so a browser can never reuse a single byte across two
// openings of the panel. A plugin http route can set its own headers, and bb
// passes them through, so this route serves the media instead. `preview_base`
// stays as the fallback for a panel talking to a server without this route.
//
// It is mounted at `/api/v1/plugins/comfy-cloud/http/media` and matches that
// exact path only, so the file is a query parameter:
//
//   ?p=<path relative to the asset folder>   the same form as asset.file,
//                                            asset.thumbPath and asset.mediumPath
//   &v=<version>                             see below
//   &download=1                              ask the browser to save it
//
// **The version rule, which is what makes `immutable` safe.** A generated file
// is written once and never changes. A small copy can change: the backfill
// rewrites it in place when DERIVATIVES in thumbs.ts moves to a new size. So
// the version is the file's own size and mtime (`mediaVersion`), computed by
// the server when a row leaves through the RPC, and it changes whenever the
// bytes do. A request whose `v` matches the file on disk gets a year and
// `immutable`; a request with no `v`, or a `v` that no longer matches, gets
// `no-cache`, so nothing unversioned can be pinned in a browser forever and a
// stale URL is never pinned to new bytes.
//
// Pure apart from the filesystem: no SDK import, so a test can call
// `serveMedia` with a plain Request and read the Response.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

/** Where the route is mounted inside the plugin's http namespace. */
export const MEDIA_ROUTE = "/media";

/** A year: the longest max-age any browser honours. */
const IMMUTABLE = "private, max-age=31536000, immutable";
const REVALIDATE = "private, no-cache";

/**
 * Only media leaves through this route. The asset folder also holds each row's
 * workflow JSON and sanitized job record, and a half written `.part`; none of
 * those is a picture and none of them is served here.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/**
 * A short token that changes whenever the file's bytes do: size and mtime in
 * base 36. Null when the path is empty, escapes the root or is not a file, so
 * a row whose small copy has gone missing says so rather than advertising a
 * URL that would 404.
 */
export function mediaVersion(root: string, relative: string | null | undefined): string | null {
  if (relative === null || relative === undefined || relative === "") return null;
  const full = insideRoot(root, relative);
  if (full === null) return null;
  try {
    const stat = fs.statSync(full);
    return stat.isFile() ? versionOf(stat) : null;
  } catch {
    return null;
  }
}

function versionOf(stat: fs.Stats): string {
  return `${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}`;
}

/**
 * The absolute path `relative` names under `root`, or null when it would leave
 * it. Checked twice: once on the resolved string, which refuses `..` and an
 * absolute path, and once on the real path, which refuses a symlink that
 * points outside. Nothing this plugin writes is a symlink, so the second check
 * only ever refuses something somebody else put there.
 */
function insideRoot(root: string, relative: string): string | null {
  if (relative.includes("\0")) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, relative);
  if (!isUnder(base, full)) return null;
  try {
    const realBase = fs.realpathSync(base);
    const realFull = fs.realpathSync(full);
    return isUnder(realBase, realFull) ? realFull : null;
  } catch {
    // Missing: the caller answers 404 either way.
    return null;
  }
}

function isUnder(base: string, full: string): boolean {
  const rel = path.relative(base, full);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface MediaRequest {
  method: string;
  /** Query `p`. */
  p: string | undefined;
  /** Query `v`. */
  v: string | undefined;
  /** Query `download`, "1" to ask for an attachment. */
  download: string | undefined;
  ifNoneMatch: string | undefined;
  range: string | undefined;
  ifRange: string | undefined;
}

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra } });
}

/** One byte range, or "unsatisfiable", or null to serve the whole file. Multiple ranges are served whole, which HTTP allows. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, from, to] = match as unknown as [string, string, string];
  if (from === "" && to === "") return null;
  if (size === 0) return "unsatisfiable";
  if (from === "") {
    // A suffix: the last N bytes.
    const length = Number(to);
    if (length === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/** `If-None-Match` may list several tags, or `*`. */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(",").some((tag) => {
    const t = tag.trim();
    return t === "*" || t === etag || t === `W/${etag}`;
  });
}

/**
 * Answer one media request. Never throws: a missing file is a 404 and an
 * unreadable one a 500, both plain text, so bb never has to turn a throw into
 * its own error page.
 */
export function serveMedia(root: string, req: MediaRequest): Response {
  const head = req.method.toUpperCase() === "HEAD";
  const relative = req.p ?? "";
  const type = CONTENT_TYPES[path.extname(relative).toLowerCase()];
  if (relative === "" || type === undefined) return plain(404, "Not found");
  const full = insideRoot(root, relative);
  if (full === null) return plain(404, "Not found");

  let fd: number;
  try {
    fd = fs.openSync(full, "r");
  } catch {
    return plain(404, "Not found");
  }
  // Everything below reads the open descriptor, so the size, the tag and the
  // bytes all describe the same file even if the backfill renames a new copy
  // over it mid request.
  let keepOpen = false;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return plain(404, "Not found");
    const version = versionOf(stat);
    const etag = `"${version}"`;
    const headers: Record<string, string> = {
      "content-type": type,
      "cache-control": req.v !== undefined && req.v === version ? IMMUTABLE : REVALIDATE,
      etag,
      "last-modified": stat.mtime.toUTCString(),
      "accept-ranges": "bytes",
      "x-content-type-options": "nosniff",
    };
    if (req.download === "1") headers["content-disposition"] = `attachment; filename="${path.basename(full).replace(/["\\\r\n]/g, "_")}"`;

    if (matchesEtag(req.ifNoneMatch, etag)) return new Response(null, { status: 304, headers });

    // If-Range: a range only applies to the version the client already holds.
    const rangeAllowed = req.ifRange === undefined || req.ifRange.trim() === etag;
    const range = rangeAllowed ? parseRange(req.range, stat.size) : null;
    if (range === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${stat.size}` } });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? stat.size - 1;
    const length = stat.size === 0 ? 0 : end - start + 1;
    headers["content-length"] = String(length);
    if (range !== null) headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
    const status = range === null ? 200 : 206;
    if (head || length === 0) return new Response(null, { status, headers });

    const stream = fs.createReadStream("", { fd, start, end, autoClose: true });
    keepOpen = true;
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers });
  } catch {
    return plain(500, "Could not read the file");
  } finally {
    if (!keepOpen) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}
