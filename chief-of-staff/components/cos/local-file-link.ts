// Is this link a file on bb's machine, and where does it point? No imports, so
// the tests can load it.
//
// The problem: a link like [x.pdf](/home/user/...) in the chief's chat on the
// Chief page would open a browser tab on bb's home page, while the same
// message in the plain thread view opens the PDF in bb's file panel. bb's
// `ThreadChat` builds its local-file handler from a context only its own thread
// route provides, and takes no prop for it, so on a plugin surface the Markdown
// renders the raw path and the click falls through to the browser.
//
// The rule below mirrors bb's own local-link check in its markdown renderer: an
// absolute path, not `//`, not `/`, no trailing slash, no `?` and no `#` in the
// path, and a last segment that looks like a file (it has a dot, or starts with
// one). That last condition is what keeps app routes such as
// `/projects/proj_x/threads/thr_y` and `/plugins/chief-of-staff/chief` out.
// A `file://` URL with no host is accepted as well, which is how bb itself
// writes the link in its own thread view.

export interface LocalFileLink {
  path: string;
  /** One-based line to reveal, from a `:12` or `#L12` / `#L12-L20` suffix. */
  line: { start: number; end: number } | null;
}

function splitLine(raw: string): LocalFileLink {
  const range = /#L(\d+)(?:-L?(\d+))?$/u.exec(raw);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] === undefined ? start : Number(range[2]);
    return { path: raw.slice(0, range.index), line: start > 0 && end >= start ? { start, end } : null };
  }
  const colon = /:(\d+)(?::\d+)?$/u.exec(raw);
  if (colon) {
    const start = Number(colon[1]);
    return { path: raw.slice(0, colon.index), line: start > 0 ? { start, end: start } : null };
  }
  return { path: raw, line: null };
}

function looksLikeFile(path: string): boolean {
  const last = path.split("/").at(-1) ?? "";
  return last.startsWith(".") || last.includes(".");
}

/** The local file an href names, or null for anything else (web links, app routes, anchors). */
export function localFileLink(href: string | null | undefined): LocalFileLink | null {
  if (typeof href !== "string" || href.length === 0 || href.trim() !== href) return null;
  let raw = href;
  if (/^file:/iu.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.host.length > 0 || url.search.length > 0) return null;
    try {
      raw = decodeURIComponent(url.pathname) + url.hash;
    } catch {
      return null;
    }
  }
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  const link = splitLine(raw);
  const path = link.path;
  if (path === "/" || path.endsWith("/") || /[?#\r\n]/u.test(path)) return null;
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32) return null;
  }
  if (path.split("/").some((part) => part === "." || part === "..")) return null;
  if (!looksLikeFile(path)) return null;
  return link;
}
