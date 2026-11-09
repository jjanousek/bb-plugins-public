// What a draft write replaced. A chat or a
// mail thread holds one pending draft, and a second write replaces the first
// in place. The reply says whether it replaced one, and whose text it was, so
// an agent cannot overwrite someone's draft without seeing it.

export interface ReplacedDraft {
  text: string;
  /** Who wrote the replaced text, as it reads in the reply. */
  by: string;
  updatedAt: number;
}

/** The replaced draft, or null when there was none or its text is the same. */
export function replacedBy(
  pending: { text: string; updatedAt: number } | null | undefined,
  newText: string,
  by: string,
): ReplacedDraft | null {
  if (pending === null || pending === undefined) return null;
  if (pending.text.trim() === newText.trim()) return null;
  return { text: pending.text, by, updatedAt: pending.updatedAt };
}

/** "Replaced the pending draft written <time> by <author>; previous text: <first 200 characters>". */
export function replacedLine(replaced: ReplacedDraft, fmtTime: (ms: number) => string): string {
  const previous = replaced.text.length > 200 ? `${replaced.text.slice(0, 199).trimEnd()}…` : replaced.text;
  return `Replaced the pending draft written ${fmtTime(replaced.updatedAt)} by ${replaced.by}; previous text: ${previous}`;
}
