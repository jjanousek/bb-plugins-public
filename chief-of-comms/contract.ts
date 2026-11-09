// Shared RPC contract and DTO types for bb-plugin-chief-of-comms.
//
// server.ts registers handlers against this contract; app.tsx imports only
// the types, so nothing here may pull in server-only modules.
//
// Model: one unified inbox of *conversations*. A conversation is either a
// Gmail thread (channel "mail", account work|personal) or a WhatsApp chat
// (channel "whatsapp"). Each conversation has at most one *pending draft*.
// Mail drafts live in Gmail (visible in Superhuman too); WhatsApp drafts live
// in the plugin database. Both are sent only when the owner presses Send (or
// explicitly tells the chief to send), and then without further confirmation.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MAIL_ACCOUNTS = ["work", "personal"] as const;
export type MailAccount = (typeof MAIL_ACCOUNTS)[number];
export const mailAccountSchema = z.enum(MAIL_ACCOUNTS);

export const channelSchema = z.enum(["mail", "whatsapp"]);
export type Channel = z.infer<typeof channelSchema>;

/** Channel selector used by list filters: mail is split per account. */
export const channelKeySchema = z.enum(["mail:work", "mail:personal", "whatsapp"]);
export type ChannelKey = z.infer<typeof channelKeySchema>;

export function channelKeyOf(channel: Channel, account: MailAccount | null): ChannelKey {
  if (channel === "whatsapp") return "whatsapp";
  return account === "work" ? "mail:work" : "mail:personal";
}

/** needs-reply: their turn. ready: a pending draft waits for the owner to send. all: everything (stale Gmail drafts included). */
/**
 * "waiting" is threads where the owner wrote last and nobody has answered: the
 * follow-up list, where Superhuman's read status matters most.
 */
export const inboxFilterSchema = z.enum(["needs-reply", "ready", "waiting", "all"]);
export type InboxFilter = z.infer<typeof inboxFilterSchema>;

// ---------- WhatsApp connection ----------

export const waStateSchema = z.enum(["disabled", "disconnected", "connecting", "qr", "qr-expired", "connected", "logged-out"]);
export type WaState = z.infer<typeof waStateSchema>;

export const waStatusSchema = z.object({
  state: waStateSchema,
  /** PNG data URL of the pairing QR code while state is "qr". */
  qrDataUrl: z.string().nullable(),
  me: z.object({ jid: z.string(), name: z.string().nullable(), phone: z.string().nullable() }).nullable(),
  sinceMs: z.number().nullable(),
  lastError: z.string().nullable(),
});
export type WaStatus = z.infer<typeof waStatusSchema>;

// ---------- unified conversation model ----------

export const linksSchema = z.object({ gmailUrl: z.string(), superhumanUrl: z.string() });
export type Links = z.infer<typeof linksSchema>;

/**
 * A pending reply. `channel` decides what the UI offers: WhatsApp drafts can
 * be sent from bb; mail drafts can only be edited here and are sent from
 * Gmail or Superhuman (`links`).
 */
/** `worker`: another bb thread wrote it, not the chief and not the owner. */
export const draftOriginSchema = z.enum(["chief", "worker", "you", "unknown"]);

export const draftSchema = z.object({
  id: z.string(),
  channel: channelSchema,
  account: mailAccountSchema.nullable(),
  /** The editable part of the reply: the quoted trailer of a mail draft is kept out of it. */
  text: z.string(),
  /**
   * Mail only: the quoted trailer that was split off `text`. The panel never
   * edits it; the server appends it again when the draft is saved.
   */
  quoted: z.string().nullable(),
  /** Mail only. */
  to: z.string().nullable(),
  cc: z.string().nullable(),
  subject: z.string().nullable(),
  updatedAt: z.number(),
  links: linksSchema.nullable(),
  /** Who wrote it: the chief thread, another thread, the owner (panel/CLI), or unknown (e.g. an old Gmail draft). */
  origin: draftOriginSchema,
  /** For `worker`: the title of the thread that wrote it, when known. */
  authorTitle: z.string().nullable().optional(),
  /** Last send failure for this draft, if any. The draft stays pending so Send can be retried. */
  error: z.string().nullable(),
  /**
   * What the text said before the chief last rewrote it, while the owner has not
   * accepted or undone that change. The dock marks the difference. Absent or
   * null when there is nothing to review.
   */
  previousText: z.string().nullable().optional(),
});
export type Draft = z.infer<typeof draftSchema>;

/** The key a draft's unreviewed change is stored under. */
export function draftRevisionRef(draft: Pick<Draft, "channel" | "account" | "id">): string {
  return draft.channel === "whatsapp" ? `wa:${draft.id}` : `mail:${draft.account ?? "?"}:${draft.id}`;
}

/**
 * Conversation keys: `mail:<account>:<gmailThreadId>`,
 * `mail:<account>:draft:<draftId>` (a mail draft without a known thread, e.g. a new email),
 * `wa:<jid>`.
 */
export const conversationSchema = z.object({
  key: z.string(),
  channel: channelSchema,
  account: mailAccountSchema.nullable(),
  /** Mail: subject. WhatsApp: contact or group name. */
  title: z.string(),
  /** Mail: display name/address of the other side. WhatsApp: phone (direct) or member count hint (group). */
  counterpart: z.string(),
  preview: z.string(),
  lastAt: z.number().nullable(),
  lastFromMe: z.boolean(),
  /** Mail: thread has unread messages. WhatsApp: last message is incoming and newer than the last time the chat was opened in bb. */
  unread: z.boolean(),
  /** Last message is from the other side, not dismissed, and no reply sent since. */
  needsReply: z.boolean(),
  /**
   * The thread would need a reply but is answered elsewhere
   * or never, so it is out of Needs reply and every count. Still listed (a
   * quiet group under Needs reply), searchable and openable. `elsewhere`: a
   * shared mailbox answered elsewhere, or a mailing list; `own`: his own forward; `calendar`:
   * a calendar reply; `no-reply`: a sender that never needs one.
   */
  quiet: z.enum(["elsewhere", "own", "calendar", "no-reply"]).nullable().optional(),
  /** Superhuman's AI marked this thread "Waiting": the owner wrote last and awaits their answer. */
  waiting: z.boolean(),
  /** A pending draft is waiting for the owner to press Send (WhatsApp draft, or a Gmail draft on a live thread). Never hidden by dismissal or age. */
  readyToSend: z.boolean(),
  /** A leftover Gmail draft with no live conversation behind it (old, thread-less or long untouched). Listed only under "all", grouped separately, excluded from counts. */
  stale: z.boolean(),
  isGroup: z.boolean(),
  dismissed: z.boolean(),
  /**
   * Mute handle of the other side: `mail:<lowercased address>` or `wa:<jid>`.
   * Null when there is no other side yet (a mail draft to nobody).
   */
  senderId: z.string().nullable(),
  /** The sender is muted: never counted as needing a reply, never auto-drafted. */
  muted: z.boolean(),
  draft: draftSchema.nullable(),
  links: linksSchema.nullable(),
  /** Mail: number of cached messages in the thread. WhatsApp: stored messages. */
  messageCount: z.number(),
  /**
   * Mail sent through Superhuman only: whether the last message comms sent in
   * this thread was opened. Filled in by conversation_get, not the list.
   * `unknown` means the feed could not be read, and is never shown as unread.
   */
  /** Mail: the newest message is Superhuman's "remind me" mail, not the other side writing. */
  reminder: z.boolean().optional(),
  /** Mail: the last message comms sent here through Superhuman has been opened at least once. */
  opened: z.boolean().optional(),
  readStatus: z
    .object({
      state: z.enum(["opened", "not-opened", "unknown", "pending"]),
      text: z.string(),
      /** Each open, oldest first, as epoch ms with who opened it. Empty until the first open is seen. */
      opens: z.array(z.object({ at: z.number(), recipient: z.string().nullable() })).optional(),
    })
    .nullable()
    .optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const messageSchema = z.object({
  id: z.string(),
  at: z.number(),
  fromMe: z.boolean(),
  /** Display name (WhatsApp push/contact name, or mail From header). */
  sender: z.string(),
  text: z.string(),
  /** "text" | "image" | "audio" | "document" | ... for WhatsApp; "mail" for email. */
  kind: z.string(),
  /** Mail only: To/Cc headers. */
  to: z.string().nullable(),
  cc: z.string().nullable(),
  /** WhatsApp media that was downloaded: file name inside the plugin's media directory, and its MIME type. */
  mediaPath: z.string().nullable(),
  mediaMime: z.string().nullable(),
  /** Original file name of a WhatsApp document, when known. */
  fileName: z.string().nullable(),
});
export type Message = z.infer<typeof messageSchema>;

// ---------- summary / status ----------

export const mailSyncStateSchema = z.object({
  account: mailAccountSchema,
  email: z.string(),
  lastSyncAt: z.number().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
  syncing: z.boolean(),
  /** How Send goes out on this account: through Superhuman (read status, one minute undo) or straight from Gmail. */
  sendPath: z.enum(["superhuman", "gmail"]).optional(),
});
export type MailSyncState = z.infer<typeof mailSyncStateSchema>;

export const summarySchema = z.object({
  chiefThreadId: z.string().nullable(),
  chiefStatus: z.string().nullable(),
  wa: waStatusSchema,
  mail: z.array(mailSyncStateSchema),
  counts: z.object({
    needsReply: z.number(),
    /**
     * Needs a reply and has no draft ready: the list's "Needs a reply" group.
     * The header and sidebar show this beside `ready`, so the two pills add up
     * to the To do total instead of counting the overlap twice. Optional for an older server.
     */
    needsReplyOnly: z.number().optional(),
    /** Conversations with a pending draft ready for the owner to send. */
    ready: z.number(),
    /** Old thread-less Gmail drafts kept out of the actionable counts. */
    staleDrafts: z.number(),
    /** Gmail drafts discarded in the last 24 hours and still restorable. */
    discarded: z.number(),
    /** Threads where the owner wrote last and nobody answered yet. */
    waiting: z.number().optional(),
    byChannel: z.record(channelKeySchema, z.object({ needsReply: z.number(), ready: z.number(), total: z.number() })),
  }),
  autoDraft: z.string(),
  /** One line on the Superhuman send path, for the Connections view. Null until asked. */
  superhuman: z.object({ connected: z.boolean(), line: z.string() }).optional(),
});
export type Summary = z.infer<typeof summarySchema>;

// ---------- discarded drafts ----------

/** One Gmail draft in the 24 hour trash, as the panel lists it. */
export const discardedDraftSchema = z.object({
  account: mailAccountSchema,
  draftId: z.string(),
  to: z.string(),
  subject: z.string(),
  /** First line or so of the body, to tell two drafts to the same person apart. */
  preview: z.string(),
  discardedAt: z.number(),
  /** When the copy is purged. After this the draft is gone from both sides. */
  expiresAt: z.number(),
  /** The conversation it was written in, when it still exists. */
  key: z.string().nullable(),
});
export type DiscardedDraft = z.infer<typeof discardedDraftSchema>;

// ---------- activity ----------

export const activityKindSchema = z.enum([
  "chief-created",
  "mail-draft",
  "mail-sent",
  "mail-sync",
  "wa-draft",
  "wa-sent",
  "wa-discarded",
  "wa-incoming",
  "wa-connection",
  "auto-draft-requested",
  "voice",
  "dismissed",
  "muted",
  "error",
]);
export type ActivityKind = z.infer<typeof activityKindSchema>;

export const activitySchema = z.object({
  id: z.number(),
  at: z.number(),
  kind: activityKindSchema,
  text: z.string(),
  /** Conversation key or draft id the event is about, when known. */
  ref: z.string().nullable(),
  /**
   * Who triggered it, for the events where that is the point: "panel", "cli",
   * or "agent <threadId>". Null on everything the plugin did by itself, and on
   * rows written before this field existed.
   */
  actor: z.string().nullable(),
});
export type Activity = z.infer<typeof activitySchema>;

// ---------- muted senders ----------

/**
 * A sender the owner does not want in the queue. Mail is muted by bare address,
 * WhatsApp by canonical jid (a group jid mutes the group). Muting hides the
 * sender from "needs reply" and stops automatic drafting for it. A draft that
 * already exists is never hidden.
 */
export const mutedSenderSchema = z.object({
  /** `mail:<lowercased address>` or `wa:<jid>`. */
  id: z.string(),
  channel: channelSchema,
  /** Name to show: display name for mail, push or group name for WhatsApp. */
  label: z.string(),
  /** Address or phone number behind the label. */
  handle: z.string(),
  createdAt: z.number(),
  /** Conversations in the cache that this mute covers. */
  conversationCount: z.number(),
});
export type MutedSender = z.infer<typeof mutedSenderSchema>;

// ---------- thread execution (vendored from chief-of-staff; keep the two in step) ----------

export const reasoningLevelSchema = z.string().min(1);
export const permissionModeSchema = z.enum(["accept-edits", "auto", "full"]);
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;
export type PermissionMode = z.infer<typeof permissionModeSchema>;

const choiceSchema = z.object({
  value: z.string(),
  label: z.string(),
  short: z.string(),
  description: z.string().optional(),
});

/** A thread's execution options for its next turn and the choices it may switch to. */
export const threadExecutionSchema = z.object({
  threadId: z.string(),
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema,
  /** The provider's models for this thread's environment, current one first when uncatalogued. */
  models: z.array(choiceSchema),
  /** Levels the current model supports. */
  reasoningLevels: z.array(choiceSchema),
  /** Modes the provider supports, capped at the machine's ceiling. */
  permissionModes: z.array(choiceSchema),
  /** Set when the provider's catalog could not be loaded; the current values still print. */
  catalogError: z.string().nullable(),
});
export type ThreadExecution = z.infer<typeof threadExecutionSchema>;
export type ExecutionChoice = z.infer<typeof choiceSchema>;

const okText = z.object({ ok: z.boolean(), text: z.string() });

export const rpcContract = defineRpcContract({
  summary: { input: z.null(), output: summarySchema },
  chief_ensure: { input: z.null(), output: z.object({ threadId: z.string(), created: z.boolean() }) },
  /** Send free text to the chief thread (creates the chief if needed). */
  ask_chief: { input: z.object({ text: z.string().min(1) }), output: okText },

  /** The unified inbox list. `channels` omitted = all channels. */
  conversations: {
    input: z.object({
      filter: inboxFilterSchema.default("needs-reply"),
      channels: z.array(channelKeySchema).optional(),
      query: z.string().optional(),
      limit: z.number().int().positive().max(300).optional(),
    }),
    output: z.object({
      conversations: z.array(conversationSchema),
      /** How many conversations matched before `limit` cut the list; total > conversations.length means the list is truncated. */
      total: z.number(),
    }),
  },
  /** One conversation with its messages (oldest first) and pending draft. Fetches mail bodies on demand. Marks a WhatsApp chat as opened. */
  conversation_get: {
    input: z.object({ key: z.string() }),
    output: z.object({ conversation: conversationSchema, messages: z.array(messageSchema), draft: draftSchema.nullable() }),
  },
  /**
   * The pending draft on a conversation, or null when there is none. Reads
   * only: no mail fetch, no marking a chat read, nothing published. It answers
   * for any well-formed key, including one comms has never cached, which the
   * `conversations` filters cannot see. Use it before overwriting a draft you
   * did not write.
   */
  draft_get: { input: z.object({ key: z.string() }), output: z.object({ draft: draftSchema.nullable() }) },
  /** Create or update the pending draft of a conversation. Mail: creates a threaded Gmail reply draft or updates the existing one. Never sends. */
  draft_save: { input: z.object({ key: z.string(), text: z.string().min(1) }), output: draftSchema },
  /**
   * The contact's voice file as markdown, for the About card. `editable` is
   * the part the owner may change: who they are, the notes and the avoid list.
   * The samples are refreshed from his sent messages and are not edited here.
   */
  voice_get: {
    input: z.object({ key: z.string() }),
    output: z.object({
      contactId: z.string().nullable(),
      name: z.string(),
      exists: z.boolean(),
      editable: z.string(),
      samples: z.number(),
      reviewedAt: z.number().nullable(),
      chiefLines: z.number(),
    }),
  },
  /** Replace the editable part of a contact's voice file. The samples are kept. */
  voice_save: { input: z.object({ key: z.string(), editable: z.string().max(8000) }), output: okText },
  /**
   * The owner has seen the chief's change on this draft: "accept" keeps the new
   * text, "undo" puts the previous text back. Either way the highlight goes.
   */
  draft_review: {
    input: z.object({ key: z.string(), action: z.enum(["accept", "undo"]) }),
    output: okText,
  },
  /** Send the pending draft now, mail or WhatsApp. This is the panel Send button and it does not ask again. */
  /**
   * `expectText` is the draft text the panel is showing. When given, the send
   * is refused if the pending draft now says something else, so a draft the
   * chief rewrote after the screen last refreshed is never sent unseen.
   */
  draft_send: {
    /**
     * `expectDraftId` is the draft the panel's text belongs to. When given,
     * the send refuses if the stored draft is a different one, even when the
     * text happens to match: a thread can hold one draft after another.
     */
    /**
     * `intent` is the one-time code the panel's Send fetches from the plugin's
     * /send-intent route (send-block.ts). Optional only so a call without one
     * gets the plain refusal rather than a schema error; the handler refuses it.
     */
    input: z.object({ key: z.string(), expectText: z.string().optional(), expectDraftId: z.string().optional(), intent: z.string().optional() }),
    output: z.object({ ok: z.boolean(), text: z.string(), links: linksSchema.nullable() }),
  },
  /**
   * Cancel a work email still inside Superhuman's undo window. It only ever
   * cancels: `cancelled` means Superhuman confirmed it and the draft is back
   * in Gmail, `too_late` means it went, `failed` means it still counts as sent.
   */
  send_undo: {
    input: z.object({ sendId: z.number().int() }),
    output: z.object({ sendId: z.number().int(), outcome: z.enum(["cancelled", "too_late", "failed"]), text: z.string() }),
  },
  /** Work emails sent through Superhuman whose undo window is still open, newest first. */
  sends_undoable: {
    input: z.null().optional(),
    output: z.object({
      sends: z.array(z.object({ sendId: z.number().int(), to: z.string(), subject: z.string(), undoUntil: z.number(), key: z.string().nullable() })),
    }),
  },
  /** Discard the pending draft (mail: deletes the Gmail draft). */
  /**
   * Throw a draft away. A Gmail draft is hard-deleted at Google and kept in a
   * local trash for a day, so `restore` carries what draft_restore needs to
   * put it back. Null for WhatsApp, which soft-deletes its own row already.
   */
  draft_discard: {
    input: z.object({ key: z.string() }),
    output: okText.extend({
      restore: z.object({ account: mailAccountSchema, draftId: z.string() }).nullable().optional(),
    }),
  },
  /** Put a discarded Gmail draft back, inside the restore window. */
  draft_restore: {
    input: z.object({ account: mailAccountSchema, draftId: z.string() }),
    output: okText,
  },
  /**
   * Gmail drafts thrown away in the last 24 hours, newest first. This is how a
   * discard is found again without knowing the draft id: the Undo in the toast
   * only works for the person who is looking at the screen at that moment.
   */
  draft_trash_list: { input: z.null(), output: z.object({ drafts: z.array(discardedDraftSchema) }) },
  /** WhatsApp only: send text immediately without a draft. */
  send_now: { input: z.object({ key: z.string(), text: z.string().min(1), intent: z.string().optional() }), output: okText },
  /** Ask the chief to draft a reply for this conversation (context is attached server-side). */
  request_draft: { input: z.object({ key: z.string(), note: z.string().optional() }), output: okText },
  /**
   * Hide a conversation from "needs reply" until a new message arrives, and
   * stop the chief drafting for the messages it has already seen.
   */
  dismiss: { input: z.object({ key: z.string(), dismissed: z.boolean() }), output: okText },
  /** Mute or unmute the other side of a conversation. The server resolves the sender behind the key. */
  sender_mute: { input: z.object({ key: z.string(), muted: z.boolean() }), output: z.object({ ok: z.boolean(), text: z.string(), senderId: z.string().nullable() }) },
  /** Every muted sender, newest first. */
  muted_list: { input: z.null(), output: z.object({ senders: z.array(mutedSenderSchema) }) },
  /** Unmute (or mute) a sender by its handle, for the muted list. */
  muted_set: { input: z.object({ id: z.string(), muted: z.boolean() }), output: okText },
  /**
   * The About card in the chief drawer for one conversation: who the person
   * is and the thread in at most four lines. Reads only; nothing is written
   * or sent.
   */
  conversation_about: {
    input: z.object({ key: z.string() }),
    output: z.object({
      name: z.string(),
      steps: z.array(z.object({ text: z.string(), at: z.number(), tone: z.enum(["plain", "open", "now"]) })),
    }),
  },
  /**
   * Where a local file link in the chief drawer's chat points, for bb's file
   * panel: the thread's storage, then its workspace, then bb's machine. The
   * order is bb's own; a PDF will not preview as a bare host file from a
   * plugin surface. Null when it cannot be opened. Reads only.
   */
  file_target: {
    input: z.object({ threadId: z.string().min(1).nullable(), path: z.string().min(2) }),
    output: z.object({
      target: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("thread-storage"), threadId: z.string(), path: z.string() }),
          z.object({ kind: z.literal("workspace"), environmentId: z.string(), path: z.string() }),
          z.object({ kind: z.literal("host"), hostId: z.string(), path: z.string() }),
        ])
        .nullable(),
    }),
  },
  /** Force a mail sync now (both accounts). */
  mail_sync: { input: z.null(), output: okText },

  /** Short-lived base URL that serves the WhatsApp media directory; append the encoded mediaPath. */
  media_preview: { input: z.null(), output: z.object({ baseUrl: z.string(), expiresAtMs: z.number() }) },
  wa_login: { input: z.null(), output: waStatusSchema },
  wa_logout: { input: z.null(), output: waStatusSchema },

  activity_list: {
    input: z.object({ limit: z.number().int().positive().max(500).optional() }),
    output: z.object({ events: z.array(activitySchema) }),
  },
  /**
   * What a thread runs with and what it could run with: the resolved model,
   * reasoning level and permission mode for its next turn, plus the provider's
   * catalog for the picker. Null when the thread is gone.
   */
  thread_execution_get: {
    input: z.object({ threadId: z.string() }),
    output: threadExecutionSchema.nullable(),
  },
  /**
   * Change one field. Model and reasoning level are the thread's sticky
   * overrides (bb PATCH /threads/:id, the same call the host's picker makes).
   * Permission mode is per turn in bb, so it is stored by the plugin and sent
   * with every turn the plugin dispatches to that thread. Returns the new state.
   */
  thread_execution_set: {
    input: z.object({
      threadId: z.string(),
      model: z.string().optional(),
      reasoningLevel: reasoningLevelSchema.optional(),
      permissionMode: permissionModeSchema.optional(),
    }),
    output: threadExecutionSchema,
  },
});
export type RpcContract = typeof rpcContract;

/** Realtime channel: published (throttled) after any change the inbox should refetch for. */
export const COMMS_CHANNEL = "comms-changed";

export function parseConversationKey(key: string): { channel: "mail"; account: MailAccount; threadId: string | null; draftId: string | null } | { channel: "whatsapp"; jid: string } | null {
  if (key.startsWith("wa:")) {
    const jid = key.slice(3);
    return jid ? { channel: "whatsapp", jid } : null;
  }
  if (key.startsWith("mail:")) {
    const rest = key.slice(5);
    const colon = rest.indexOf(":");
    if (colon < 0) return null;
    const account = rest.slice(0, colon);
    const tail = rest.slice(colon + 1);
    if (account !== "work" && account !== "personal") return null;
    if (tail.startsWith("draft:")) {
      const draftId = tail.slice(6);
      return draftId ? { channel: "mail", account, threadId: null, draftId } : null;
    }
    return tail ? { channel: "mail", account, threadId: tail, draftId: null } : null;
  }
  return null;
}

export function mailThreadKey(account: MailAccount, threadId: string): string {
  return `mail:${account}:${threadId}`;
}
export function mailDraftKey(account: MailAccount, draftId: string): string {
  return `mail:${account}:draft:${draftId}`;
}
export function waKey(jid: string): string {
  return `wa:${jid}`;
}
