// The thread a bb route shows. No imports, so core.test.ts can check it under
// node; row-marks.ts is the caller.

/** `/threads/<id>` or `/projects/<project>/threads/<id>`, with or without a trailing part. */
export function threadIdFromPath(pathname: string): string | null {
  const match = /\/threads\/(thr_[a-z0-9]+)(?:\/|$)/.exec(pathname);
  return match ? match[1]! : null;
}
