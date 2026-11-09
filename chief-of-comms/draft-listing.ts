// The draft listing reads only drafts that changed. `gw gmail drafts` makes one
// drafts.get per draft, every listing, for metadata comms already has, so a
// mailbox with many old drafts costs many Gmail calls. `--ids-only`
// answers from drafts.list with draft, message and thread ids and no get at all.
//
// A draft edited in Gmail gets a new message id (draft-update keeps the draft
// id and changes the message id), so a draft whose message id is the cached
// one is unchanged and is not read.
// A new draft, or one whose message id moved, is read with draft-get, which
// brings headers and body in one call.

import { bodyToText, parseMailDate, type MailDraftFull } from "./gmail.ts";
import type { MailAccount } from "./contract.ts";

export interface DraftListingMail {
  draftIds(account: MailAccount, max?: number, signal?: AbortSignal): Promise<{ draftId: string; messageId: string | null; threadId: string | null }[]>;
  draftGet(account: MailAccount, draftId: string, signal?: AbortSignal): Promise<MailDraftFull>;
}

export interface DraftListingStore {
  mailDraftRow(account: MailAccount, draftId: string): { message_id: string | null; body: string | null } | null;
  upsertMailDraft(input: {
    account: MailAccount;
    draftId: string;
    messageId: string | null;
    threadId: string | null;
    to: string | null;
    cc: string | null;
    subject: string | null;
    body: string | null;
    updatedAt: number;
  }): void;
}

/** List one account's drafts and refresh only the new or changed ones. Returns the listed ids. */
export async function listDraftsChangedOnly(
  mail: DraftListingMail,
  store: DraftListingStore,
  account: MailAccount,
  limit: number,
  warn: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ ids: string[]; fetched: number; read: number }> {
  const listed = await mail.draftIds(account, limit, signal);
  let read = 0;
  for (const draft of listed) {
    if (signal?.aborted) break;
    const cached = store.mailDraftRow(account, draft.draftId);
    const unchanged = cached !== null && cached.body !== null && draft.messageId !== null && cached.message_id === draft.messageId;
    if (unchanged) continue;
    let full: MailDraftFull;
    try {
      full = await mail.draftGet(account, draft.draftId, signal);
      read += 1;
    } catch (cause) {
      warn(`draft-get ${account}/${draft.draftId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    store.upsertMailDraft({
      account,
      draftId: draft.draftId,
      messageId: draft.messageId ?? full.messageId,
      threadId: draft.threadId ?? full.threadId,
      to: full.to,
      cc: full.cc,
      subject: full.subject,
      body: bodyToText(full.body),
      updatedAt: full.internalDate ?? parseMailDate(full.date) ?? Date.now(),
    });
  }
  return { ids: listed.map((d) => d.draftId), fetched: listed.length, read };
}
