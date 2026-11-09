// Which parked drafts are already in a composer's text and which still need
// to go in. No imports, so the tests can load it.

export interface ParkedPart {
  id: number;
  body: string;
}

/**
 * Split parked drafts into the ids already present in `text` (to ack) and the
 * drafts still missing (to append). Each draft is checked on its own: checking
 * them joined would append one a second time whenever it was there and a
 * newer one was not.
 */
export function splitParked(parts: readonly ParkedPart[], text: string): { present: number[]; missing: ParkedPart[] } {
  const present: number[] = [];
  const missing: ParkedPart[] = [];
  for (const part of parts) {
    if (text.includes(part.body)) present.push(part.id);
    else missing.push(part);
  }
  return { present, missing };
}

export interface SentDraft {
  id: number;
  body: string;
  createdAt: number;
  /** The state of every board item this draft carried. */
  itemStates: readonly string[];
}

/**
 * The board blocks this composer's text still holds, split into the ones still
 * open and the ones whose items are all closed (addressed, resolved, dismissed
 * or gone). Matched on the draft's own body, as `splitParked` does.
 *
 * The case this exists for: the chief's composer can hold a block about an
 * item dismissed long ago and already sent once, ahead of a live one, and a
 * banner that counts open items on the server rather than blocks in the text
 * says "1 item". One Enter would then send a settled decision again.
 */
export function blocksInText(drafts: readonly SentDraft[], text: string): { live: SentDraft[]; closed: SentDraft[] } {
  const live: SentDraft[] = [];
  const closed: SentDraft[] = [];
  for (const draft of drafts) {
    if (draft.body.trim() === "" || !text.includes(draft.body)) continue;
    const allClosed = draft.itemStates.length > 0 && draft.itemStates.every((state) => state !== "open");
    (allClosed ? closed : live).push(draft);
  }
  return { live, closed };
}

/** The composer text with these blocks taken out, and the blank lines they leave tidied. */
export function withoutBlocks(text: string, drafts: readonly SentDraft[]): string {
  let out = text;
  for (const draft of drafts) out = out.split(draft.body).join("");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

