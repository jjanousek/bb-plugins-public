// Pure helpers for the decision board's rows. No imports, so core.test.ts can
// exercise them under node without a DOM. The board state names are repeated
// here as a literal union rather than imported from contract.ts for that
// reason; a name added there and not here is a type error at the call site.

export type BoardState = "open" | "addressed" | "resolved" | "dismissed";

/** The past tense the undo strip prints for each destination. */
const WORD_FOR: Record<BoardState, string> = {
  open: "Put back",
  addressed: "Marked addressed",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

/** What the undo strip says happened: "Dismissed 3 items." */
export function undoLabel(state: BoardState, count: number): string {
  return `${WORD_FOR[state]} ${count} item${count === 1 ? "" : "s"}.`;
}

/**
 * Group a remembered set of prior states into one move per destination.
 *
 * A single action can span states: selecting an open item and an addressed one
 * and resolving both leaves two different places to put things back. Order is
 * the order the states were first seen, so a replay reads the way the board
 * looked.
 */
export function undoMoves(
  restore: readonly { id: string; state: BoardState }[],
): { state: BoardState; ids: string[] }[] {
  const byState = new Map<BoardState, string[]>();
  for (const entry of restore) {
    const bucket = byState.get(entry.state);
    if (bucket === undefined) byState.set(entry.state, [entry.id]);
    else bucket.push(entry.id);
  }
  return [...byState].map(([state, ids]) => ({ state, ids }));
}

/**
 * What has happened to one item since it arrived, oldest first.
 *
 * Derived from the stamps the item already carries, not from a new table. The
 * point is that the row itself answers "what has become of this", without
 * asking the chief: a row that says only how old it is, with a note explaining
 * a dismissal visible only behind the closed-list disclosure, does not.
 *
 * What this cannot say, and does not pretend to: how many times an item was
 * drafted, or that it was reopened, because only the newest of each is stamped.
 * Every line here is a fact the column proves.
 */
export function boardHistory(item: {
  createdAt: number;
  draftedAt: number | null;
  addressedAt: number | null;
  resolvedAt: number | null;
  dismissedAt: number | null;
  movedBy: string | null;
  note: string | null;
  sourceLabel: string | null;
}): { at: number; text: string }[] {
  const entries: { at: number; text: string }[] = [];
  entries.push({
    at: item.createdAt,
    text:
      item.sourceLabel === null
        ? "The chief put this on your list"
        : `The chief put this on your list, from ${item.sourceLabel}`,
  });
  if (item.draftedAt !== null) {
    entries.push({ at: item.draftedAt, text: "Draft put it in your composer, not sent" });
  }
  if (item.addressedAt !== null) {
    entries.push({ at: item.addressedAt, text: "You sent the chief a message carrying it" });
  }
  // The mover and the note belong to whichever close actually happened, so a
  // reopened item does not keep printing the note of the dismissal it came back
  // from: `boardSetState` clears the stamp when it puts an item back.
  const closedAt = item.resolvedAt ?? item.dismissedAt;
  if (closedAt !== null) {
    const word = item.resolvedAt !== null ? "Resolved" : "Dismissed";
    const who = item.movedBy === null ? "" : ` by ${item.movedBy}`;
    const why = item.note === null || item.note.trim() === "" ? "" : `: ${item.note.trim()}`;
    entries.push({ at: closedAt, text: `${word}${who}${why}` });
  }
  return entries.sort((a, b) => a.at - b.at);
}

/** The three areas, as the row prints them. Repeated here for the same reason `BoardState` is. */
export type BoardArea = "clients" | "consulting" | "operations";

/**
 * The area's word. One map, here rather than in core.ts, for the reason the
 * reasoning-level tables are here: this file has no imports, so the app can use
 * it without pulling better-sqlite3 into the bundle, and core.ts re-exports it
 * as `BOARD_AREA_LABEL` for the server and every existing caller.
 */
export const BOARD_AREA_LABEL: Record<BoardArea, string> = {
  clients: "Clients",
  consulting: "Consulting",
  operations: "Operations",
};

/**
 * The second line of a collapsed row, as three slots rather than a slice of prose.
 *
 * Built from fields, so it is the same shape on every row and can never
 * truncate mid-thought. Empty slots are dropped by the caller and the line does
 * not render at all when all three are empty: the result is a headline-only
 * row at phone widths without deleting the line from the design.
 *
 * The narrow rule belongs to the caller, not here: `area` and `source` are
 * classification and provenance and drop at `@max-[420px]/cos`; `state` is what
 * has happened to the item and never drops.
 */
export function queueFacts(item: {
  area: BoardArea;
  sourceLabel: string | null;
  state: BoardState;
  draftedAt: number | null;
  movedBy: string | null;
  note: string | null;
}): { area: string; source: string | null; state: string | null } {
  return {
    area: BOARD_AREA_LABEL[item.area],
    source: item.sourceLabel === null ? null : `from ${item.sourceLabel}`,
    state: stateWord(item),
  };
}

function stateWord(item: {
  state: BoardState;
  draftedAt: number | null;
  movedBy: string | null;
  note: string | null;
}): string | null {
  const who = item.movedBy === null ? "" : ` by ${item.movedBy}`;
  const why = item.note === null || item.note.trim() === "" ? "" : `: ${item.note.trim()}`;
  switch (item.state) {
    case "open":
      // The stamp says the text was put in a composer, not that it is still
      // there: it may have been cleared, or addressed on another device. So the
      // words say the part that is certain, which is that nothing was sent.
      return item.draftedAt === null ? null : "drafted, not sent";
    case "addressed":
      return "sent, waiting on the chief";
    // Lower case, because this sits mid-sentence on a line that starts with the
    // area: "Consulting - resolved by the chief". A capital there reads as a new
    // sentence beginning halfway through one.
    case "resolved":
      return `resolved${who}${why}`;
    case "dismissed":
      return `dismissed${who}${why}`;
  }
}

/**
 * Where the cursor goes when the row it is on is about to leave the list.
 *
 * Next row, else the previous one, else nowhere. The caller reads this BEFORE
 * issuing the move and focuses the answer once the server accepts, so
 * `useRovingRows`'s own fallback to the first row never runs. Without it,
 * resolving the third of ten items sends the keyboard back to the top, which
 * is the difference between working a list and restarting it.
 */
export function nextRowKey(keys: readonly string[], current: string | null): string | null {
  if (current === null) return keys[0] ?? null;
  const index = keys.indexOf(current);
  if (index === -1) return keys[0] ?? null;
  return keys[index + 1] ?? keys[index - 1] ?? null;
}

/**
 * The chief's list, oldest first.
 *
 * A list you are adding to sorts newest first. This is a list you work off,
 * and the item that has been waiting longest is the one that has cost the most
 * by waiting; any queue someone owes an answer to reads oldest first. The id
 * tiebreak stops the order flickering between two fetches of the same second.
 */
export function boardOrder<T extends { createdAt: number; id: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt - b.createdAt,
  );
}

/**
 * The For you items the home card leads with: open (a drafted item is still
 * open; addressed, resolved and dismissed are not) and at priority "now",
 * oldest first, so the one item the chief marked "now" is never crowded off
 * the card by the two oldest worker decisions.
 */
export function homeNowItems<T extends { createdAt: number; id: string; state: string; priority: BoardPriority }>(
  items: readonly T[],
): T[] {
  return boardOrder(items.filter((item) => item.priority === "now" && item.state === "open"));
}

/** How soon an item needs attention. Repeated here for the same reason `BoardState` is. */
export type BoardPriority = "now" | "soon" | "whenever";

export const BOARD_PRIORITY_ORDER: readonly BoardPriority[] = ["now", "soon", "whenever"];

/** What each band promises, as the header prints it. */
export const PRIORITY_WORD: Record<BoardPriority, string> = {
  now: "Now",
  soon: "This week",
  whenever: "Whenever",
};

export interface BoardBand<T> {
  priority: BoardPriority;
  label: string;
  count: number;
  /** Oldest first, across the whole band. Not grouped by anything. */
  items: T[];
}

/**
 * The list, in bands by how soon it needs attention, and inside each band by
 * the area of work it belongs to.
 *
 * Two levels so that both questions are answered at a glance: what needs
 * attention next, and what it is about. Priority is the outer one because it
 * is the question the list exists to answer; a flat list sorted by age is a
 * column of rows of identical weight that cannot be prioritised from.
 *
 * An empty band is dropped, so a quiet day is short rather than three headers
 * over nothing. Inside a band, areas keep their fixed order and items stay
 * oldest first.
 */
export function boardBands<
  T extends { createdAt: number; id: string; priority: BoardPriority },
>(items: readonly T[]): BoardBand<T>[] {
  const bands: BoardBand<T>[] = [];
  for (const priority of BOARD_PRIORITY_ORDER) {
    const inBand = boardOrder(items.filter((item) => item.priority === priority));
    if (inBand.length === 0) continue;
    bands.push({ priority, label: PRIORITY_WORD[priority], count: inBand.length, items: inBand });
  }
  return bands;
}


