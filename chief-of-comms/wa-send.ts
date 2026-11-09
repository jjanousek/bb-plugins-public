// Sending one WhatsApp draft, exactly once.
//
// Checking `status === "pending"` and writing "sent" only after the await
// returns lets two overlapping approvals both pass the check, so the recipient
// gets the message twice. And a send that timed out in the worker may already
// be on the wire, so leaving it pending and retrying can deliver a second copy.
//
// Both holes close the same way. Every draft gets one WhatsApp message id,
// minted and committed to SQLite before the first attempt and reused verbatim
// on every later attempt. WhatsApp keys a message by that id within a chat, so
// a repeat of an id it already accepted is discarded at the far end and the
// recipient sees one message however many times we try. The in-flight map on
// top of that stops a second caller paying for a send already running, and
// refuses it outright when the wording changed under it, which the id alone
// cannot catch: a rewritten draft claims a fresh id (see store.updateDraft).

import type { WaDraft } from "./store";

/** Only what this module needs, so the test can pass a fake. */
export interface WaSendStore {
  draft(id: string): WaDraft | null;
  claimSendMessageId(id: string, minted: string): string | null;
  updateDraft(
    id: string,
    patch: { text?: string; status?: WaDraft["status"]; sentMessageId?: string | null; error?: string | null },
  ): WaDraft | null;
}

export interface WaSendDeps {
  store: WaSendStore;
  /** Sends the text under exactly this message id and resolves with what went out. */
  send(jid: string, name: string, text: string, messageId: string): Promise<{ id: string }>;
  /** A fresh WhatsApp message id, in the format Baileys generates. */
  mintMessageId(): string;
  /** Writes an activity row. */
  record(text: string, chatJid: string): void;
  /** Tells the panel something changed. */
  changed(): void;
}

export type WaSendResult = { ok: true; draft: WaDraft } | { ok: false; text: string };

/**
 * One send per draft id at a time. A second caller arriving mid-flight waits
 * for the first instead of starting its own, so the two cannot interleave
 * between the status check and the status write. The text is kept with the
 * promise: joining a send of different wording would report success for a
 * message that never went out.
 */
const inFlight = new Map<string, { text: string; promise: Promise<WaSendResult> }>();

export function sendWaDraftOnce(deps: WaSendDeps, id: string): Promise<WaSendResult> {
  const running = inFlight.get(id);
  if (running) {
    const now = deps.store.draft(id);
    if (now !== null && now.text !== running.text) {
      return Promise.resolve({
        ok: false,
        text: "This draft is already being sent with the earlier wording. Wait for that send to finish, then send again.",
      });
    }
    return running.promise;
  }
  const draft = deps.store.draft(id);
  const promise = attempt(deps, id).finally(() => {
    inFlight.delete(id);
  });
  inFlight.set(id, { text: draft?.text ?? "", promise });
  return promise;
}

async function attempt(deps: WaSendDeps, id: string): Promise<WaSendResult> {
  const { store } = deps;
  let draft = store.draft(id);
  if (!draft) return { ok: false, text: `No draft ${id}.` };
  // Older rows may still sit in "failed"; Send is the retry.
  if (draft.status === "failed") draft = store.updateDraft(id, { status: "pending" }) ?? draft;
  if (draft.status !== "pending") return { ok: false, text: `Draft ${id} is ${draft.status}, not pending.` };

  // Claim the id before the send, not after. If the process dies between the
  // claim and the wire, the retry reuses the claimed id and WhatsApp decides
  // whether it already has it; that is the whole point.
  const messageId = store.claimSendMessageId(id, deps.mintMessageId());
  if (messageId === null) return { ok: false, text: `No draft ${id}.` };

  try {
    const sent = await deps.send(draft.chatJid, draft.chatName, draft.text, messageId);
    // The whole guarantee rests on WhatsApp having taken the id we asked for.
    // If it did not, a retry of this draft would arrive as a second message,
    // so say so loudly rather than let it pass. The message is already out, so
    // this is a warning, not a failure: failing here would cause the retry.
    if (sent.id !== messageId) {
      deps.record(
        `Draft ${id} went out as ${sent.id}, not the id ${messageId} it claimed. Retrying it could deliver twice.`,
        draft.chatJid,
      );
    }
    const updated = store.updateDraft(id, { status: "sent", sentMessageId: sent.id, error: null });
    deps.changed();
    if (!updated) return { ok: false, text: `Draft ${id} vanished while sending.` };
    return { ok: true, draft: updated };
  } catch (cause) {
    const text = cause instanceof Error ? cause.message : String(cause);
    // Stay pending: the link usually comes back and Send retries. Safe now,
    // because the retry goes out under the id claimed above.
    store.updateDraft(id, { error: text });
    deps.record(`Sending draft ${id} to ${draft.chatName} failed: ${text}`, draft.chatJid);
    deps.changed();
    return { ok: false, text: `Sending failed: ${text}` };
  }
}

/** Test seam: forget any in-flight sends. Not used by the plugin. */
export function resetInFlightForTests(): void {
  inFlight.clear();
}
