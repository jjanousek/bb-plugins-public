// Pure helpers for For you as a queue. No imports,
// so core.test.ts can exercise them under node without a DOM.
//
// Each item shows a headline and a lead of one or two sentences. Every other
// detail stays behind one press and is not drawn on the page.

/** What has been done with one item in this pass. Nothing here is sent. */
export type QueueMark =
  | { kind: "pick"; label: string }
  /**
   * An answer in the user's own words, typed on the item itself. `text` is
   * what was written; it goes into the draft as the answer. Empty text is
   * never staged, because a bare question staged with nowhere on the board to
   * type leaves no way to tell which item was meant to be answered.
   */
  | { kind: "write"; text: string; drafted?: boolean }
  | { kind: "skip" }
  | { kind: "dismiss" };

/** How long the lead may run before it is cut to its sentences. */
export const LEAD_MAX_CHARS = 180;

/**
 * The first one or two sentences of an item's context, and the rest.
 *
 * Split on sentence ends, never mid-word, so the lead always reads as a
 * complete thought and the rest starts where it stopped. The rest is shown
 * under More, whole, so nothing is lost by cutting: a clamp that hides most of
 * an item with nowhere to read the rest is what this avoids.
 *
 * A context with no sentence end inside the limit is cut at the last space
 * before it, and the remainder goes to `rest` rather than being dropped.
 */
export function splitLead(context: string, max = LEAD_MAX_CHARS): { lead: string; rest: string } {
  const text = context.replace(/\s+/g, " ").trim();
  if (text.length <= max) return { lead: text, rest: "" };
  const ends: number[] = [];
  const re = /[.!?](?=\s|$)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) ends.push(m.index + 1);
  // Up to two sentences that fit, and at least one if the first one fits.
  const fitting = ends.filter((end) => end <= max);
  if (fitting.length > 0) {
    const cut = fitting[Math.min(fitting.length, 2) - 1]!;
    return { lead: text.slice(0, cut).trim(), rest: text.slice(cut).trim() };
  }
  const space = text.lastIndexOf(" ", max);
  const cut = space > max / 2 ? space : max;
  return { lead: `${text.slice(0, cut).trim()}...`, rest: `...${text.slice(cut).trim()}` };
}

/**
 * The next item to show after `from`, skipping everything already marked.
 * Null when there is nothing left, which is the queue's end state.
 */
export function nextUnmarked(
  ids: readonly string[],
  marks: ReadonlyMap<string, QueueMark>,
  from: number,
): number | null {
  for (let i = from + 1; i < ids.length; i += 1) if (!marks.has(ids[i]!)) return i;
  for (let i = 0; i <= from && i < ids.length; i += 1) if (!marks.has(ids[i]!)) return i;
  return null;
}

/** One segment of the progress track, in item order. */
export type TrackState = "current" | "picked" | "cleared" | "todo";

export function trackStates(
  ids: readonly string[],
  marks: ReadonlyMap<string, QueueMark>,
  current: number | null,
): TrackState[] {
  return ids.map((id, i) => {
    if (i === current) return "current";
    const mark = marks.get(id);
    if (mark === undefined) return "todo";
    return mark.kind === "pick" || mark.kind === "write" ? "picked" : "cleared";
  });
}

/**
 * What the tray will do, in the order the server needs it.
 *
 * Picks and "write my own" become one draft. A pick carries its answer, which
 * is what `board_address` already takes per id; a write carries none, so the
 * item lands in the draft as a question and the answer is typed under it. Dismissals are
 * a separate state move. Skips do nothing at all: a skip is "not now", and an
 * item skipped must be exactly where it was on coming back.
 */
export function trayPlan(
  ids: readonly string[],
  marks: ReadonlyMap<string, QueueMark>,
): {
  draft: string[];
  picks: { id: string; label: string }[];
  answers: { id: string; text: string }[];
  dismiss: string[];
} {
  const draft: string[] = [];
  const picks: { id: string; label: string }[] = [];
  const answers: { id: string; text: string }[] = [];
  const dismiss: string[] = [];
  for (const id of ids) {
    const mark = marks.get(id);
    if (mark?.kind === "pick") {
      draft.push(id);
      picks.push({ id, label: mark.label });
    } else if (mark?.kind === "write") {
      // Already in the chief's composer the moment it was saved; the tray must
      // not put it there a second time.
      if (mark.drafted === true) continue;
      draft.push(id);
      const text = mark.text.trim();
      if (text !== "") answers.push({ id, text });
    } else if (mark?.kind === "dismiss") dismiss.push(id);
  }
  return { draft, picks, answers, dismiss };
}
