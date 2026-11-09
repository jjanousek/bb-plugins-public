// Undo Send. Comms deletes the Gmail draft the moment Superhuman
// accepts the send, so a confirmed cancel has to write the draft back from the
// copy kept on the send row.
//
// It only ever cancels. Nothing in this file, and nothing it is handed, sends:
// the client it receives is narrowed to `undoSend` and `getDraftSendStatus`,
// and test/undo-send.test.ts fails if a send call appears here or in
// `undoSuperhumanSend` in server.ts.
//
// The send row moves to `cancelled` ONLY once Superhuman confirms the draft is
// idle again. `undo_send` saying "cancelled" is not enough on its own: a cancel
// that did not take would leave an email out in the world that comms shows as
// back in drafts, one press of Send from going a second time. So:
//   cancelled or not found, then draft idle  -> cancelled, back in drafts
//   already_sent, or the draft reads closed  -> too late, it was sent
//   anything else, or an error               -> failed, still counts as sent

import type { SuperhumanSendRow, UndoCopy } from "./store.ts";

export type UndoState = "cancelled" | "too_late" | "failed";

export interface UndoResult {
  sendId: number;
  outcome: UndoState;
  text: string;
}

/** The two Superhuman calls Undo may make. Neither sends. */
export interface UndoClient {
  undoSend(input: { undoToken?: string | null; messageId?: string | null }): Promise<{
    state: "cancelled" | "already_sent" | "not_found" | "unknown";
    detail: string;
  }>;
  getDraftSendStatus(input: { draftId: string; threadId?: string | null }): Promise<{
    state: "idle" | "pending" | "closed" | "unknown";
    detail: string;
  }>;
}

export interface UndoDeps {
  /** Throws when Superhuman is not connected. */
  client(): UndoClient;
  wait(ms: number): Promise<void>;
  /** Moves a row still `sent` to `cancelled`; false when it had already changed. */
  markCancelled(id: number): boolean;
  /** Undo is not offered on this row again. */
  clearUndo(id: number): void;
  /** Write the Gmail draft back from the copy. Returns the new draft id. */
  writeBack(copy: UndoCopy): Promise<string>;
  /** Throw away Superhuman's own copy once Gmail holds the draft again. */
  discardSuperhumanDraft(draftId: string): Promise<void>;
  note(kind: "cancelled" | "too_late" | "failed", text: string): void;
}

/** How many times a `pending` status is asked again, and how long apart. */
export const CONFIRM_ATTEMPTS = 3;
export const CONFIRM_GAP_MS = 1_500;

function reasonOf(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).replace(/[.\s]+$/, "");
}

export function parseUndoCopy(raw: string | null | undefined): UndoCopy | null {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const value = JSON.parse(raw) as Partial<UndoCopy>;
    if (typeof value.to !== "string" || typeof value.body !== "string") return null;
    return {
      to: value.to,
      cc: typeof value.cc === "string" ? value.cc : null,
      subject: typeof value.subject === "string" ? value.subject : "",
      body: value.body,
      threadId: typeof value.threadId === "string" ? value.threadId : null,
      replyToId: typeof value.replyToId === "string" ? value.replyToId : null,
      origin: value.origin === "chief" || value.origin === "you" ? value.origin : "unknown",
      conversationKey: typeof value.conversationKey === "string" ? value.conversationKey : null,
    };
  } catch {
    return null;
  }
}

export async function undoSend(row: SuperhumanSendRow | null, sendId: number, deps: UndoDeps): Promise<UndoResult> {
  const failed = (text: string): UndoResult => {
    deps.note("failed", text);
    return { sendId, outcome: "failed", text };
  };
  if (row === null) return failed("There is no such send.");
  if (row.status === "cancelled") return { sendId, outcome: "failed", text: "It is already cancelled and back in drafts." };
  if (row.status !== "sent") return failed(`It is ${row.status}, not sent, so there is nothing to undo.`);
  const copy = parseUndoCopy(row.undo_copy);
  if (row.undo_until === null || row.undo_until === undefined || copy === null) {
    return failed("This email has no undo window on record, so it cannot be undone from here. It still counts as sent.");
  }
  // Without the Superhuman draft id there is no way to confirm a cancel, and
  // an unconfirmable cancel is not attempted.
  if (row.sh_draft_id === "") return failed("There is no Superhuman draft on record to confirm a cancel against, so it was not attempted. It still counts as sent.");

  const tooLate = (detail: string): UndoResult => {
    deps.clearUndo(sendId);
    deps.note("too_late", detail);
    return { sendId, outcome: "too_late", text: "Too late, it was sent." };
  };

  let client: UndoClient;
  try {
    client = deps.client();
  } catch (cause) {
    return failed(`It could not be cancelled because Superhuman is not reachable (${reasonOf(cause)}). It still counts as sent.`);
  }

  let answer: Awaited<ReturnType<UndoClient["undoSend"]>>;
  try {
    answer = await client.undoSend({ undoToken: row.undo_token ?? null, messageId: row.sh_message_id });
  } catch (cause) {
    return failed(`The cancel did not go through (${reasonOf(cause)}). It still counts as sent.`);
  }
  if (answer.state === "already_sent") return tooLate(answer.detail);
  if (answer.state === "unknown") {
    return failed(`Superhuman's answer could not be read, so it is not known whether it was cancelled: "${answer.detail}". It still counts as sent. Check Sent in Superhuman.`);
  }

  // `cancelled` or `not_found`: either way the draft's own send state is the
  // proof. Pending just after a cancel is the server catching up.
  let state: "idle" | "pending" | "closed" | "unknown" = "unknown";
  try {
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
      state = (await client.getDraftSendStatus({ draftId: row.sh_draft_id, threadId: row.thread_id })).state;
      if (state !== "pending") break;
      if (attempt < CONFIRM_ATTEMPTS - 1) await deps.wait(CONFIRM_GAP_MS);
    }
  } catch (cause) {
    return failed(`Superhuman said "${answer.detail}", but comms could not confirm it (${reasonOf(cause)}). It still counts as sent until it is confirmed.`);
  }
  if (state === "closed") return tooLate(`Superhuman said "${answer.detail}", and the draft reads closed.`);
  if (state !== "idle") {
    return failed(`Superhuman said "${answer.detail}", but the draft still reads ${state}, so the cancel is not confirmed. It still counts as sent. Try Undo again while the window is open.`);
  }

  if (!deps.markCancelled(sendId)) return failed("It was cancelled in Superhuman, but the record here had already changed. Check the conversation before sending again.");
  // The Gmail draft is normally gone by now. If deleting it failed after the
  // send, it is still there, and writing a second copy would leave two.
  if (row.gmail_draft_deleted === 0) {
    await deps.discardSuperhumanDraft(row.sh_draft_id).catch(() => undefined);
    deps.note("cancelled", "Cancelled; the Gmail draft had not been deleted, so it is still there.");
    return { sendId, outcome: "cancelled", text: "Cancelled, back in drafts." };
  }
  try {
    const draftId = await deps.writeBack(copy);
    // Gmail holds the draft again, so Superhuman's idle copy would only be a
    // duplicate in his Superhuman drafts. Discarding a draft sends nothing.
    await deps.discardSuperhumanDraft(row.sh_draft_id).catch(() => undefined);
    deps.note("cancelled", `Cancelled inside the undo window; Superhuman confirms the draft is idle. Back in Gmail drafts as ${draftId}.`);
    return { sendId, outcome: "cancelled", text: "Cancelled, back in drafts." };
  } catch (cause) {
    const text = `Cancelled, so nothing went out. It could not be put back in Gmail drafts (${reasonOf(cause)}); the text is still in your Superhuman drafts.`;
    deps.note("cancelled", text);
    return { sendId, outcome: "cancelled", text };
  }
}
