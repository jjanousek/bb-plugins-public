/**
 * What a Gmail discard is allowed to destroy, kept apart from the handlers so
 * it can be tested without deleting anything.
 *
 * Two rules are decided here.
 *
 * A conversation key names a THREAD, not a draft. A thread can hold several
 * drafts, so "the most recently updated draft in this thread" is a guess, not
 * a lookup, and the newest is usually the one just written. Where the thread
 * holds more than one, this refuses and names them, because the caller has to
 * say which.
 *
 * Gmail's drafts.delete destroys rather than trashes, so a draft bb holds no
 * copy of (one written through another tool between syncs) could not be
 * brought back. A discard that cannot be undone is refused rather than
 * performed.
 */

/** The part of a cached draft row this decision reads. */
export interface DraftChoice {
  draft_id: string;
  subject: string | null;
  updated_at: number;
}

export type Chosen =
  | { ok: true; draftId: string }
  | { ok: false; reason: string };

/** How a draft is described when the caller has to pick one. */
function describe(row: DraftChoice): string {
  return `  ${row.draft_id}  ${row.subject?.trim() || "(no subject)"}`;
}

/**
 * Which draft a thread-keyed discard may delete. Exactly one, or none: with
 * several the caller names the id, because picking for them can destroy the
 * wrong draft.
 */
export function chooseThreadDraft(rows: DraftChoice[], threadId: string): Chosen {
  if (rows.length === 0) return { ok: false, reason: "There is no Gmail draft for this conversation." };
  if (rows.length === 1) return { ok: true, draftId: rows[0].draft_id };
  const listed = [...rows].sort((a, b) => b.updated_at - a.updated_at).map(describe).join("\n");
  return {
    ok: false,
    reason:
      `Thread ${threadId} has ${rows.length} Gmail drafts, so "the draft for this conversation" does not name one:\n${listed}\n` +
      `Nothing was deleted. Discard the one you mean by id, with bb comms mail draft-delete <account> <draftId>.`,
  };
}

/** What the retention copy can be built from, before anything is destroyed. */
export interface TrashSource {
  /** bb's cached row, when the draft has been synced. */
  cached: boolean;
  /** Gmail answered a draft-get for this id just now. */
  live: boolean;
}

/**
 * May this delete go ahead? Only when something can be copied first. Gmail
 * keeps nothing, so a delete with no source for the copy is unrecoverable and
 * is refused instead of being performed and then advertised as undoable.
 */
export function mayDelete(source: TrashSource, draftId: string): Chosen {
  if (source.cached || source.live) return { ok: true, draftId };
  return {
    ok: false,
    reason:
      `Draft ${draftId} could not be read back from Gmail, so bb cannot take the copy that makes a discard undoable. ` +
      `Nothing was deleted. Check the id with bb comms mail drafts, or delete it in Gmail if you meant to lose it.`,
  };
}
