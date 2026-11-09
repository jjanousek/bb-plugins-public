// What changed between two versions of a draft, word by word, for the reply
// dock's highlight when the chief rewrites a draft. No imports, so
// the tests load it.
//
// Words and the whitespace between them are separate tokens, so a changed word
// is marked alone and line breaks survive. The comparison is a longest common
// subsequence over tokens: drafts are a few hundred words at most, and above
// MAX_CELLS the whole text is shown as replaced rather than spending time on a
// table nobody would read anyway.

export type DiffPart = { kind: "same" | "added" | "removed"; text: string };

const MAX_CELLS = 400_000;

function tokens(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/** Join neighbours of the same kind, and fold whitespace between two changes into them. */
function tidy(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (last && last.kind === part.kind) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length * b.length > MAX_CELLS) {
    return tidy([
      ...(before === "" ? [] : [{ kind: "removed" as const, text: before }]),
      ...(after === "" ? [] : [{ kind: "added" as const, text: after }]),
    ]);
  }
  // lcs[i][j] = length of the common subsequence of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      parts.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      parts.push({ kind: "removed", text: a[i]! });
      i += 1;
    } else {
      parts.push({ kind: "added", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) parts.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) parts.push({ kind: "added", text: b[j++]! });
  return tidy(parts);
}

/**
 * The word diff grouped for reading. A raw word diff of a sentence the chief
 * reworded alternates one struck word and one new word ("Thanks Sure the a
 * Monday..."), which is unreadable. Here a single
 * unchanged word between two changes is folded into the change, and
 * each change shows everything removed first, then everything added, as whole
 * phrases.
 */
export function groupedDiff(before: string, after: string): DiffPart[] {
  const parts = diffWords(before, after);
  const words = (text: string) => (text.match(/[^\s]+/g) ?? []).length;
  const out: DiffPart[] = [];
  let removed = "";
  let added = "";
  const flush = () => {
    if (removed !== "") out.push({ kind: "removed", text: removed });
    if (added !== "") out.push({ kind: "added", text: added });
    removed = "";
    added = "";
  };
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as DiffPart;
    if (part.kind === "removed") removed += part.text;
    else if (part.kind === "added") added += part.text;
    else {
      const inChange = removed !== "" || added !== "";
      const next = parts[i + 1];
      const shortGap = words(part.text) <= 1 && !part.text.includes("\n");
      if (inChange && shortGap && next !== undefined && next.kind !== "same") {
        removed += part.text;
        added += part.text;
        continue;
      }
      flush();
      out.push(part);
    }
  }
  flush();
  // Keep a space between a struck phrase and the new one, so they do not run together.
  return out.map((p, i) => (p.kind === "removed" && out[i + 1]?.kind === "added" && !/\s$/.test(p.text) ? { ...p, text: `${p.text} ` } : p));
}

/** Share of the original words the change touched, 0 to 1. Above about half, a diff stops helping. */
export function changedShare(before: string, after: string): number {
  const parts = diffWords(before, after);
  const count = (kind: DiffPart["kind"]) =>
    parts.filter((p) => p.kind === kind).reduce((n, p) => n + (p.text.match(/[^\s]+/g) ?? []).length, 0);
  const total = Math.max(count("same") + count("removed"), count("same") + count("added"), 1);
  return Math.max(count("removed"), count("added")) / total;
}

/** Above this share the dock shows the new text plainly and the previous version on request. */
export const REWRITE_SHARE = 0.5;

/** True when the two texts differ in anything but surrounding whitespace. */
export function hasChange(before: string | null | undefined, after: string): boolean {
  return before != null && before.trim() !== after.trim();
}
