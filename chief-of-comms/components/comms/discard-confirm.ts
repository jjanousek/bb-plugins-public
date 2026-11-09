// Whether discarding a draft has to stop and ask, and what the question says.
// Pure and with no imports, the same reason execution-options.ts has none: the
// test runner strips types but cannot compile JSX, and this rule is the part
// worth pinning.
//
// The rule follows what the server actually does, not what the control looks
// like. A WhatsApp discard is a soft delete: the row flips to "discarded" and
// `bb comms wa drafts --status discarded` still has the text. A mail discard
// calls the Gmail drafts.delete API, which destroys rather than trashes, and
// then drops the local row too. bb takes its own copy first and keeps it for a
// day, so a mail discard is recoverable for 24 hours and permanent after that.
// One of those deserves a question and the other does not, whichever of the
// three controls is used.
//
// A confirm on a truly recoverable action would only teach the user to wave
// confirms through, but this one is not losslessly recoverable: a restore
// writes a new Gmail draft, so the draft id changes, and a handle held before
// the delete no longer works after the restore. So the dialog stays.

/** Only the conversation fields the question needs. */
export interface DiscardSubject {
  channel: string;
  /** Who the draft is addressed to, for naming the thing being deleted. */
  counterpart: string;
}

export interface DiscardPrompt {
  title: string;
  description: string;
  confirmLabel: string;
}

/**
 * The question to ask before discarding, or null when the discard is
 * recoverable and can just happen. The recipient is named because the mis-tap
 * this guards against is discarding on the wrong conversation, and a question
 * that does not say whose draft it is cannot catch that.
 */
export function discardConfirmFor(conversation: DiscardSubject): DiscardPrompt | null {
  if (conversation.channel !== "mail") return null;
  const to = conversation.counterpart.trim();
  const what = to === "" ? "the draft" : `the draft to ${to}`;
  return {
    title: "Delete the Gmail draft?",
    description: `This deletes ${what} in Gmail, not just the row here. bb keeps a copy for 24 hours, so you can put it back today; after that it is gone.`,
    confirmLabel: "Delete draft",
  };
}
