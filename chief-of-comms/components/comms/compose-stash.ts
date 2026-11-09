// Unsaved text in the reply dock, and which draft it belongs to.
//
// Text is tied to the draft it was typed into, not to the conversation key: a
// thread can carry more than one draft over time, and keying by conversation
// would hand old text to a new draft, so the box could show an already-sent
// draft above a new reply, marked "Unsaved changes", one press of Send away.
// When that draft is gone or replaced, the text is not put in
// the box; it is offered beside the stored draft, and Send uses only what is
// in the box. No imports, so the tests load it.

/** Unsaved text, with the draft it was typed into (null before any draft existed). */
export interface Stash {
  text: string;
  draftId: string | null;
}

/**
 * What the dock opens with. `restore` goes in the box and counts as unsaved.
 * `orphan` is text typed into a draft that is no longer the stored one: it is
 * shown as a notice to copy from, never put in the box and never sent.
 */
export function openWith(
  stash: Stash | undefined,
  storedDraftId: string | null,
  storedText: string,
): { text: string; dirty: boolean; orphan: string | null } {
  if (stash === undefined) return { text: storedText, dirty: false, orphan: null };
  const same = stash.draftId === storedDraftId;
  // Typed before any draft existed, and still none: it is the user's new reply.
  if (same) return { text: stash.text, dirty: stash.text !== storedText, orphan: null };
  if (stash.draftId === null && storedDraftId !== null) {
    // A draft appeared since (the chief or another window wrote one). The
    // typed text is kept, but the stored draft is what the box shows.
    return { text: storedText, dirty: false, orphan: stash.text.trim() === storedText.trim() ? null : stash.text };
  }
  return { text: storedText, dirty: false, orphan: stash.text.trim() === "" || stash.text.trim() === storedText.trim() ? null : stash.text };
}
