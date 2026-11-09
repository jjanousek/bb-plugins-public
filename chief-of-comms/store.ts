// SQLite persistence for the unified inbox: WhatsApp chats/messages/drafts,
// a cache of Gmail threads/messages/drafts, per-conversation attention state,
// and the activity log.
//
// Pure data access: no bb API here, so it is unit-testable and the server file
// stays wiring only. Migrations are append-only by index.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  channelKeyOf,
  mailDraftKey,
  mailThreadKey,
  parseConversationKey,
  waKey,
  type Activity,
  type ActivityKind,
  type ChannelKey,
  type Conversation,
  type Draft,
  type InboxFilter,
  type MailAccount,
  type Message,
  type MutedSender,
  // Spelled with the extension because test/mail-draft-trash.test.ts loads
  // this module under node --test, whose ESM resolver does not guess it.
} from "./contract.ts";
import { addressOf, displayNameOf, mailLinks } from "./gmail.ts";
import { quietReason, type QuietRules } from "./quiet-mail.ts";
import { splitQuoted } from "./quoted.ts";

export type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

// ---------- WhatsApp value types ----------

export type WaDraftStatus = "pending" | "sent" | "discarded" | "failed";

export interface WaChat {
  jid: string;
  name: string;
  phone: string | null;
  isGroup: boolean;
  lastMessageAt: number | null;
  lastMessageText: string | null;
  lastFromMe: boolean;
  unanswered: boolean;
  pendingDrafts: number;
}

export interface WaMessage {
  id: string;
  chatJid: string;
  senderJid: string | null;
  senderName: string | null;
  fromMe: boolean;
  text: string;
  kind: string;
  timestamp: number;
  /** Downloaded media: file name inside the media directory, and MIME type. */
  mediaPath?: string | null;
  mediaMime?: string | null;
  /** Original file name of a document, when WhatsApp sent one. */
  fileName?: string | null;
}

export interface WaDraft {
  id: string;
  chatJid: string;
  chatName: string;
  text: string;
  status: WaDraftStatus;
  createdAt: number;
  updatedAt: number;
  sourceThreadId: string | null;
  sentMessageId: string | null;
  /**
   * The WhatsApp message id this draft will be sent under, minted and stored
   * before the first attempt. Reusing it on a retry lets WhatsApp drop the
   * duplicate, so a send that timed out cannot arrive twice.
   */
  sendMessageId: string | null;
  error: string | null;
}

export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS wa_chats (
    jid TEXT PRIMARY KEY,
    name TEXT,
    phone TEXT,
    is_group INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER,
    last_message_text TEXT,
    last_from_me INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS wa_messages (
    id TEXT PRIMARY KEY,
    chat_jid TEXT NOT NULL,
    sender_jid TEXT,
    sender_name TEXT,
    from_me INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    timestamp INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS wa_messages_chat_time ON wa_messages (chat_jid, timestamp)`,
  `CREATE TABLE IF NOT EXISTS wa_contacts (
    jid TEXT PRIMARY KEY,
    name TEXT,
    notify TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS wa_drafts (
    id TEXT PRIMARY KEY,
    chat_jid TEXT NOT NULL,
    chat_name TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source_thread_id TEXT,
    sent_message_id TEXT,
    error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS wa_drafts_status ON wa_drafts (status, created_at)`,
  `CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    ref TEXT
  )`,
  // --- unified inbox: cached Gmail threads, messages and drafts ---
  `CREATE TABLE IF NOT EXISTS mail_threads (
    account TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    subject TEXT,
    last_at INTEGER,
    last_from TEXT,
    last_from_me INTEGER NOT NULL DEFAULT 0,
    preview TEXT,
    unread INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER,
    PRIMARY KEY (account, thread_id)
  )`,
  `CREATE TABLE IF NOT EXISTS mail_messages (
    account TEXT NOT NULL,
    id TEXT NOT NULL,
    thread_id TEXT,
    date_ms INTEGER,
    from_header TEXT,
    to_header TEXT,
    cc_header TEXT,
    subject TEXT,
    body TEXT,
    from_me INTEGER NOT NULL DEFAULT 0,
    labels TEXT,
    PRIMARY KEY (account, id)
  )`,
  `CREATE INDEX IF NOT EXISTS mail_messages_thread ON mail_messages (account, thread_id, date_ms)`,
  `CREATE TABLE IF NOT EXISTS mail_drafts (
    account TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    message_id TEXT,
    thread_id TEXT,
    to_header TEXT,
    cc_header TEXT,
    subject TEXT,
    body TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account, draft_id)
  )`,
  `CREATE TABLE IF NOT EXISTS attention (
    key TEXT PRIMARY KEY,
    dismissed_at INTEGER,
    opened_at INTEGER
  )`,
  // --- WhatsApp media downloads ---
  `ALTER TABLE wa_messages ADD COLUMN media_path TEXT`,
  `ALTER TABLE wa_messages ADD COLUMN media_mime TEXT`,
  // --- original file name of a downloaded WhatsApp document ---
  `ALTER TABLE wa_messages ADD COLUMN media_name TEXT`,
  // --- WhatsApp addresses one contact both as <digits>@lid and <phone>@s.whatsapp.net ---
  `CREATE TABLE IF NOT EXISTS wa_jid_alias (lid TEXT PRIMARY KEY, pn TEXT NOT NULL)`,
  // --- who wrote a Gmail draft: the chief thread or the owner ---
  `CREATE TABLE IF NOT EXISTS mail_draft_origin (
    account TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    PRIMARY KEY (account, draft_id)
  )`,
  // One-off cleanup: WhatsApp link churn and group chatter are no longer
  // recorded, so the old rows of both kinds are removed too.
  `DELETE FROM activity WHERE kind = 'wa-connection'
     AND (text LIKE 'WhatsApp connected as%' OR text LIKE 'WhatsApp disconnected%')`,
  `DELETE FROM activity WHERE kind = 'wa-incoming'
     AND ref IN (SELECT 'wa:' || jid FROM wa_chats WHERE is_group = 1)`,
  // The id a draft is sent under, so a retry of a send that timed out reuses
  // it and WhatsApp discards the duplicate instead of delivering it twice.
  `ALTER TABLE wa_drafts ADD COLUMN send_message_id TEXT`,
  // --- messages this plugin injected into the chief thread (auto-draft requests,
  // panel ask-chief). The chief's send tools look the current turn's opening
  // message up here and refuse to send when the plugin, not the owner, started
  // the turn. Keyed by sha256 of the exact text sent.
  `CREATE TABLE IF NOT EXISTS chief_injections (hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`,

  // --- senders the owner muted. Keyed "mail:<lowercased address>" or "wa:<jid>".
  // A muted sender never counts as needing a reply and is never auto-drafted;
  // a draft that already exists stays visible so nothing in flight is lost.
  `CREATE TABLE IF NOT EXISTS muted_senders (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    label TEXT NOT NULL,
    handle TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // --- how far the automatic drafting has got in a chat. Kept on disk so a
  // plugin reload does not draft the same burst again after the owner has
  // dismissed it. handled_at is the timestamp of the newest message the
  // chief was already asked about, or that the owner dismissed or discarded.
  `CREATE TABLE IF NOT EXISTS auto_draft_marks (
    jid TEXT PRIMARY KEY,
    handled_at INTEGER NOT NULL
  )`,
  // --- bulk mailings. `gw` reports List-Unsubscribe and a bulk Precedence;
  // marketing sent from a person's own address, which Gmail files under
  // CATEGORY_PERSONAL, has no other tell. 0 until the message is synced again.
  `ALTER TABLE mail_messages ADD COLUMN bulk INTEGER NOT NULL DEFAULT 0`,
  // --- who triggered a send. The plugin sends only on a path the owner started,
  // so the record has to say which one it was: the panel Send button, the
  // bb comms CLI, or an agent tool call in a named thread. Rows written before
  // this column existed have no actor.
  `ALTER TABLE activity ADD COLUMN actor TEXT`,
  // --- discarded Gmail drafts, kept for a day so a mis-tap is recoverable.
  // Gmail's drafts.delete destroys rather than trashes, so the copy has to be
  // ours: everything needed to put the draft back goes in here before the
  // delete runs, and RESTORE_WINDOW_MS later the row is purged. in_reply_to is
  // read from Gmail while the draft still exists, because it is what puts a
  // restored reply back in its own thread rather than starting a new one.
  `CREATE TABLE IF NOT EXISTS mail_draft_trash (
    account TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    thread_id TEXT,
    to_header TEXT,
    cc_header TEXT,
    subject TEXT,
    body TEXT,
    in_reply_to TEXT,
    origin TEXT,
    conversation_key TEXT,
    discarded_at INTEGER NOT NULL,
    PRIMARY KEY (account, draft_id)
  )`,
  // Gmail's draft API threads a reply by its own message id, not by the
  // In-Reply-To header the draft carries, so the id is resolved while the
  // thread is still cached and kept alongside the header, because
  // a threaded restore otherwise answered "Invalid id value".
  `ALTER TABLE mail_draft_trash ADD COLUMN reply_to_id TEXT`,
  // Every attempt to destroy a Gmail draft, written before the delete and not
  // conditional on it working, so the record can say which caller did it: the
  // panel RPC arrives over HTTP and leaves no bb event, and an activity row
  // written after the delete leaves no trace when the delete throws. `outcome`
  // is filled in afterwards and starts null, which is itself readable: a row
  // that never got an outcome is a delete that crashed mid-flight. Appended, never
  // inserted: the migration loop checks each statement against the index it
  // recorded, so changing an earlier one refuses the whole reload.
  `CREATE TABLE IF NOT EXISTS mail_discard_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    account TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    thread_key TEXT,
    caller TEXT NOT NULL,
    copy_taken INTEGER NOT NULL,
    outcome TEXT
  )`,
  // When the chief was last asked about this chat. The handled mark alone cannot
  // tell "asked and answered" from "asked and the turn died", and an in-memory
  // timer as the only record of an outstanding ask would let a reload inside
  // the wait drop the burst.
  //
  // Appended at the very end, which is the whole point: the loop checks each
  // statement against the index it recorded, so inserting anywhere above shifts
  // every later index and the reload refuses.
  `ALTER TABLE auto_draft_marks ADD COLUMN asked_at INTEGER`,
  // Consecutive asks for this chat that produced nothing. Without it a chat the
  // chief never drafts for is re-asked every cycle for as long as it stays
  // unanswered. Appended at the end, like everything above it, because the
  // migration loop matches statements by index.
  `ALTER TABLE auto_draft_marks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
  // One row per comms draft handed to Superhuman to send.
  // Written BEFORE send_draft is called, so a send that dies mid-flight still
  // leaves a row, and a Gmail draft whose row says `sent` is refused a second
  // send even if deleting it from Gmail failed. `thread_id` is the Gmail
  // thread id of the work mailbox, which is also Superhuman's; it starts null
  // for a new thread because send_draft returns a draft id there, and the
  // read sync looks the real one up. Appended at the end: the migration loop
  // matches statements by index.
  `CREATE TABLE IF NOT EXISTS superhuman_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    gmail_draft_id TEXT NOT NULL,
    sh_draft_id TEXT NOT NULL,
    sh_message_id TEXT,
    thread_id TEXT,
    to_header TEXT,
    subject TEXT,
    actor TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    gmail_draft_deleted INTEGER NOT NULL DEFAULT 0,
    opens INTEGER NOT NULL DEFAULT 0,
    readers TEXT,
    first_read_at INTEGER,
    last_read_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS superhuman_sends_draft ON superhuman_sends (account, gmail_draft_id)`,
  `CREATE INDEX IF NOT EXISTS superhuman_sends_thread ON superhuman_sends (account, thread_id)`,
  // Every open of a message comms sent through Superhuman, one row each.
  // superhuman_sends keeps only a count, first and last; this keeps the time
  // of each open. The feed returns the same event on
  // every read inside its window, so (send, recipient, time) is the key and a
  // re-read inserts nothing. Appended at the end: migrations match by index.
  `CREATE TABLE IF NOT EXISTS superhuman_opens (
    send_id INTEGER NOT NULL,
    recipient TEXT NOT NULL DEFAULT '',
    opened_at INTEGER NOT NULL,
    device TEXT,
    PRIMARY KEY (send_id, recipient, opened_at)
  )`,
  // The text a draft held just before the chief rewrote it,
  // so the reply dock can mark what changed. One row per
  // draft, keyed like the conversation it belongs to; cleared when the owner
  // accepts, undoes, edits, sends or discards. Appended: migrations match by index.
  `CREATE TABLE IF NOT EXISTS draft_revisions (
    draft_ref TEXT PRIMARY KEY,
    before_text TEXT NOT NULL,
    after_text TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  // Undo Send. Superhuman's undo token and deadline for the
  // send, and a copy of what was sent (JSON: to, cc, subject, body, thread,
  // reply target, origin), because the Gmail draft is deleted the moment the
  // send is accepted and a confirmed cancel has to write it back. A cancelled
  // send ends as status 'cancelled'. Appended: migrations match by index.
  `ALTER TABLE superhuman_sends ADD COLUMN undo_token TEXT`,
  `ALTER TABLE superhuman_sends ADD COLUMN undo_until INTEGER`,
  `ALTER TABLE superhuman_sends ADD COLUMN undo_copy TEXT`,
];

/** How far back the Waiting list looks. Past this a thread is finished, not waiting. */
export const WAITING_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Waiting: the owner wrote last, in the last two weeks, to one person, and has
 * not marked it done. Older chats and groups are not a follow-up list: most
 * of them are simply finished.
 * One function, so the list and its count cannot differ.
 */
function isWaiting(c: Conversation, now: number): boolean {
  return (
    c.lastFromMe &&
    !c.stale &&
    !c.muted &&
    !c.dismissed &&
    !c.isGroup &&
    c.lastAt !== null &&
    c.lastAt >= now - WAITING_MAX_AGE_MS &&
    !(c.channel === "mail" && c.messageCount === 0)
  );
}

/** How long a discarded Gmail draft can be brought back. */
export const RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------- row shapes ----------

interface ChatRow {
  jid: string;
  name: string | null;
  phone: string | null;
  is_group: number;
  last_message_at: number | null;
  last_message_text: string | null;
  last_from_me: number;
  pending_drafts: number;
}

interface MessageRow {
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  sender_name: string | null;
  from_me: number;
  text: string;
  kind: string;
  timestamp: number;
  media_path: string | null;
  media_mime: string | null;
  media_name: string | null;
}

interface DraftRow {
  id: string;
  chat_jid: string;
  chat_name: string;
  text: string;
  status: WaDraftStatus;
  created_at: number;
  updated_at: number;
  source_thread_id: string | null;
  sent_message_id: string | null;
  send_message_id: string | null;
  error: string | null;
}

interface ActivityRow {
  id: number;
  at: number;
  kind: ActivityKind;
  text: string;
  ref: string | null;
  actor: string | null;
}

export interface MailThreadRow {
  account: string;
  thread_id: string;
  subject: string | null;
  last_at: number | null;
  last_from: string | null;
  last_from_me: number;
  preview: string | null;
  unread: number;
  message_count: number;
  synced_at: number | null;
}

export interface MailMessageRow {
  account: string;
  id: string;
  thread_id: string | null;
  date_ms: number | null;
  from_header: string | null;
  to_header: string | null;
  cc_header: string | null;
  subject: string | null;
  body: string | null;
  from_me: number;
  labels: string | null;
}

/** One recorded attempt to destroy a Gmail draft. */
export interface MailDiscardAuditRow {
  id: number;
  at: number;
  account: string;
  draft_id: string;
  thread_key: string | null;
  caller: string;
  copy_taken: number;
  /** null while in flight, and still null if the delete never returned. */
  outcome: string | null;
}

export interface MailDraftRow {
  account: string;
  draft_id: string;
  message_id: string | null;
  thread_id: string | null;
  to_header: string | null;
  cc_header: string | null;
  subject: string | null;
  body: string | null;
  updated_at: number;
}

/** One comms draft handed to Superhuman to send. `status`: sending | sent | uncertain | failed | cancelled. */
export interface SuperhumanSendRow {
  id: number;
  account: string;
  gmail_draft_id: string;
  sh_draft_id: string;
  sh_message_id: string | null;
  thread_id: string | null;
  to_header: string | null;
  subject: string | null;
  actor: string | null;
  status: string;
  error: string | null;
  created_at: number;
  sent_at: number | null;
  gmail_draft_deleted: number;
  opens: number;
  readers: string | null;
  first_read_at: number | null;
  last_read_at: number | null;
  undo_token?: string | null;
  undo_until?: number | null;
  undo_copy?: string | null;
}

/** What a send carried, kept so a confirmed Undo can write the Gmail draft back. */
export interface UndoCopy {
  to: string;
  cc: string | null;
  subject: string;
  body: string;
  threadId: string | null;
  replyToId: string | null;
  origin: DraftOriginValue;
  conversationKey: string | null;
}

export interface MailDraftTrashRow {
  account: string;
  draft_id: string;
  thread_id: string | null;
  to_header: string | null;
  cc_header: string | null;
  subject: string | null;
  body: string | null;
  in_reply_to: string | null;
  /** Gmail's own id for the message this draft answers, resolved while the thread was still cached. */
  reply_to_id: string | null;
  origin: string | null;
  conversation_key: string | null;
  discarded_at: number;
}

export interface AttentionRow {
  key: string;
  dismissed_at: number | null;
  opened_at: number | null;
}

/** WhatsApp chats older than this never count as needing a reply. */
const WA_NEEDS_REPLY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Inbound mail this recent needs a reply even after the owner has read it.
 * Opening a thread does not take it out of the queue, so mail read and not
 * answered stays on the list.
 */
export const MAIL_NEEDS_REPLY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Mute handle of a mail sender, "" when the header carries no address. */
export function mailSenderId(header: string | null | undefined): string {
  const address = addressOf(header);
  return address === "" ? "" : `mail:${address}`;
}

/** Mute handle of a WhatsApp chat or group. */
export function waSenderId(jid: string): string {
  return `wa:${jid}`;
}

/**
 * A Gmail draft with no cached conversation behind it stays actionable for
 * this long; after that it is a leftover ("stale") and only shows under "All".
 */
export const MAIL_DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Rows Gmail returns for the unsent draft itself; never real messages. */
const NOT_DRAFT = `(labels IS NULL OR labels NOT LIKE '%"DRAFT"%')`;

function isDraftRow(labels: string | null): boolean {
  return (labels ?? "").includes('"DRAFT"');
}

/** Drop the device suffix so 123:5@lid and 123@lid are the same address. */
function bareJid(jid: string): string {
  const at = jid.indexOf("@");
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(":")[0] ?? "";
  return `${user}@${jid.slice(at + 1)}`;
}

const AUTOMATED_CATEGORIES = ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"];
const AUTOMATED_LOCAL_PART =
  /^(no-?reply|noreply|do-?not-?reply|donotreply|notifications?|notify|newsletter|news|mailer-daemon|postmaster|alerts?|digest|updates?|marketing|promo|bounce|automated|auto-?reply|system)([.+_-].*)?$/i;
const AUTOMATED_SUBDOMAIN = /@(notifications?|email|mail|news|newsletter|updates?|alerts?|marketing|noreply|no-reply|mailer|info|comms)\./i;

function parseLabels(json: string | null): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

/** Mail nobody replies to: Gmail category labels first, then the sender address shape. */
/** Superhuman's "remind me if no reply" mail, which lands in the thread it is about. */
export function isSuperhumanReminder(fromHeader: string | null): boolean {
  return addressOf(fromHeader).toLowerCase() === "reminder@superhuman.com";
}

export function isAutomatedMail(fromHeader: string | null, labelsJson: string | null): boolean {
  if (labelsJson) {
    try {
      const labels = JSON.parse(labelsJson) as unknown;
      if (Array.isArray(labels) && labels.some((l) => AUTOMATED_CATEGORIES.includes(String(l)))) return true;
    } catch {
      // ignore malformed labels
    }
  }
  const address = addressOf(fromHeader).toLowerCase();
  if (address === "") return false;
  const at = address.indexOf("@");
  const local = at >= 0 ? address.slice(0, at) : address;
  return AUTOMATED_LOCAL_PART.test(local) || AUTOMATED_SUBDOMAIN.test(address);
}

/** Human-readable phone from a phone-number jid, null for LID/group jids. */
export function phoneOfJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const at = jid.indexOf("@");
  if (at < 0) return null;
  const domain = jid.slice(at + 1);
  if (domain !== "s.whatsapp.net" && domain !== "c.us") return null;
  const digits = jid.slice(0, at).split(":")[0] ?? "";
  return /^\d{5,}$/.test(digits) ? `+${digits}` : null;
}

function chatOf(row: ChatRow): WaChat {
  const phone = row.phone ?? phoneOfJid(row.jid);
  return {
    jid: row.jid,
    name: row.name ?? phone ?? row.jid,
    phone,
    isGroup: row.is_group === 1,
    lastMessageAt: row.last_message_at,
    lastMessageText: row.last_message_text,
    lastFromMe: row.last_from_me === 1,
    unanswered: row.last_message_at !== null && row.last_from_me === 0,
    pendingDrafts: row.pending_drafts,
  };
}

function messageOf(row: MessageRow): WaMessage {
  return {
    id: row.id,
    chatJid: row.chat_jid,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    fromMe: row.from_me === 1,
    text: row.text,
    kind: row.kind,
    timestamp: row.timestamp,
    mediaPath: row.media_path,
    mediaMime: row.media_mime,
    fileName: row.media_name,
  };
}

function draftOf(row: DraftRow): WaDraft {
  return {
    id: row.id,
    chatJid: row.chat_jid,
    chatName: row.chat_name,
    text: row.text,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceThreadId: row.source_thread_id,
    sentMessageId: row.sent_message_id,
    sendMessageId: row.send_message_id,
    error: row.error,
  };
}

const CHAT_SELECT = `SELECT c.*, (SELECT COUNT(*) FROM wa_drafts d WHERE d.chat_jid = c.jid AND d.status = 'pending') AS pending_drafts FROM wa_chats c`;
/** A chat is searchable under its own name and under the contact's. */
const CHAT_SELECT_NAMED = `${CHAT_SELECT} LEFT JOIN wa_contacts ct ON ct.jid = c.jid`;
const CHAT_NAME_EXPR = `COALESCE(c.name, ct.name, ct.notify)`;

/** A LIKE pattern fragment that matches `text` literally, for use with ESCAPE '\'. */
function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function accountOf(value: string): MailAccount {
  return value === "work" ? "work" : "personal";
}

function shorten(text: string | null | undefined, max = 200): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Is a conversation hidden by a dismissal? It holds until the OTHER side
 * writes again. A newer message from the owner, or the chief's reply landing
 * a minute later, does not lift it, so dismissing a chat and then replying to
 * it keeps it dismissed. `lastIncomingAt` is the newest
 * message not from the owner; null means there is none, and the dismissal holds.
 */
function isDismissed(dismissedAt: number | null, lastIncomingAt: number | null): boolean {
  if (dismissedAt === null) return false;
  if (lastIncomingAt === null) return true;
  return dismissedAt >= lastIncomingAt;
}

/** Per-account Gmail label ids that carry Superhuman's AI triage verdicts. */
export interface LabelRoles {
  /** "[Superhuman]/AI/Respond": the thread needs a reply. */
  respond: Set<string>;
  /** "[Superhuman]/AI/Waiting": the owner wrote last, the other side owes an answer. */
  waiting: Set<string>;
  /** Marketing/News/Social/Pitch/AutoArchived/Muted: nobody replies to these. */
  automated: Set<string>;
}

export interface StoreOptions {
  /** Address used for Gmail and Superhuman deep links. */
  emailOf?: (account: MailAccount) => string;
  /** Superhuman label roles for an account, when known (null = no signal). */
  labelRoles?: (account: MailAccount) => LabelRoles | null;
  /** Which threads leave Needs reply (quiet-mail.ts). Absent means none. */
  quietRules?: (account: MailAccount) => QuietRules | null;
  /** The chief thread's id, so a draft from any other thread reads as `worker`. */
  chiefThreadId?: () => string | null;
  /** A thread's title from the server's cache, or null when not known yet. */
  threadTitle?: (threadId: string) => string | null;
}

/** Where a draft came from, for the panel badge. */
export type DraftOriginValue = "chief" | "worker" | "you" | "unknown";

/**
 * Who wrote a draft, from the thread that wrote it.
 * No thread is the owner; the chief's thread is the chief; any other thread is a
 * worker, so a worker's draft never shows as "Your draft". When the chief's id
 * is not known, a thread still counts as the chief.
 */
export function originOfThread(threadId: string | null | undefined, chiefThreadId: string | null): DraftOriginValue {
  if (threadId === null || threadId === undefined || threadId === "") return "you";
  if (chiefThreadId === null || threadId === chiefThreadId) return "chief";
  return "worker";
}

export interface ConversationQuery {
  filter?: InboxFilter;
  channels?: ChannelKey[];
  query?: string;
  limit?: number;
}

/**
 * Is this connection still open, across the two drivers this store runs on?
 *
 * Production is better-sqlite3, which the host hands over as
 * `bb.storage.database()` and which names the flag `open`. The tests build the
 * real schema in memory on `node:sqlite`, which names it `isOpen`. Reading only
 * one of them would make the guard a no-op in production or, worse, silently
 * drop every write under test. An unrecognised driver is treated as open, so a
 * future swap fails loudly on the real error rather than quietly writing
 * nothing.
 */
function dbIsOpenOf(db: unknown): boolean {
  const handle = db as { open?: unknown; isOpen?: unknown };
  if (typeof handle.open === "boolean") return handle.open;
  if (typeof handle.isOpen === "boolean") return handle.isOpen;
  return true;
}

export function createStore(db: PluginDatabase, options: StoreOptions = {}) {
  const dbIsOpen = (): boolean => dbIsOpenOf(db);
  const emailOf = options.emailOf ?? (() => "");
  const chiefIdOf = options.chiefThreadId ?? (() => null);
  const titleOf = options.threadTitle ?? (() => null);

  const upsertChatStmt = db.prepare(
    `INSERT INTO wa_chats (jid, name, phone, is_group) VALUES (@jid, @name, @phone, @is_group)
     ON CONFLICT(jid) DO UPDATE SET
       name = COALESCE(excluded.name, wa_chats.name),
       phone = COALESCE(excluded.phone, wa_chats.phone),
       is_group = MAX(wa_chats.is_group, excluded.is_group)`,
  );
  const touchChatStmt = db.prepare(
    `UPDATE wa_chats SET last_message_at = @at, last_message_text = @text, last_from_me = @from_me
     WHERE jid = @jid AND (last_message_at IS NULL OR last_message_at <= @at)`,
  );
  const insertMessageStmt = db.prepare(
    `INSERT OR IGNORE INTO wa_messages (id, chat_jid, sender_jid, sender_name, from_me, text, kind, timestamp)
     VALUES (@id, @chat_jid, @sender_jid, @sender_name, @from_me, @text, @kind, @timestamp)`,
  );
  const upsertContactStmt = db.prepare(
    `INSERT INTO wa_contacts (jid, name, notify) VALUES (@jid, @name, @notify)
     ON CONFLICT(jid) DO UPDATE SET
       name = COALESCE(excluded.name, wa_contacts.name),
       notify = COALESCE(excluded.notify, wa_contacts.notify)`,
  );
  const contactNameStmt = db.prepare(`SELECT name, notify FROM wa_contacts WHERE jid = ?`);
  const chatStmt = db.prepare(`${CHAT_SELECT} WHERE c.jid = ?`);
  const insertDraftStmt = db.prepare(
    `INSERT INTO wa_drafts (id, chat_jid, chat_name, text, status, created_at, updated_at, source_thread_id)
     VALUES (@id, @chat_jid, @chat_name, @text, 'pending', @now, @now, @source_thread_id)`,
  );
  const draftStmt = db.prepare(`SELECT * FROM wa_drafts WHERE id = ?`);
  const insertActivityStmt = db.prepare(`INSERT INTO activity (at, kind, text, ref, actor) VALUES (?, ?, ?, ?, ?)`);

  // --- mail statements ---
  const newerLastAt = `excluded.last_at IS NOT NULL AND (mail_threads.last_at IS NULL OR excluded.last_at >= mail_threads.last_at)`;
  const upsertMailThreadStmt = db.prepare(
    `INSERT INTO mail_threads (account, thread_id, subject, last_at, last_from, last_from_me, preview, unread, message_count, synced_at)
     VALUES (@account, @thread_id, @subject, @last_at, @last_from, @last_from_me, @preview, @unread, @message_count, @synced_at)
     ON CONFLICT(account, thread_id) DO UPDATE SET
       subject = COALESCE(excluded.subject, mail_threads.subject),
       unread = excluded.unread,
       message_count = MAX(mail_threads.message_count, excluded.message_count),
       synced_at = excluded.synced_at,
       last_at = CASE WHEN ${newerLastAt} THEN excluded.last_at ELSE mail_threads.last_at END,
       last_from = CASE WHEN ${newerLastAt} THEN excluded.last_from ELSE mail_threads.last_from END,
       last_from_me = CASE WHEN ${newerLastAt} THEN excluded.last_from_me ELSE mail_threads.last_from_me END,
       preview = CASE WHEN ${newerLastAt} THEN excluded.preview ELSE mail_threads.preview END`,
  );
  const upsertMailHeaderStmt = db.prepare(
    `INSERT INTO mail_messages (account, id, thread_id, date_ms, from_header, to_header, cc_header, subject, body, from_me, labels, bulk)
     VALUES (@account, @id, @thread_id, @date_ms, @from_header, @to_header, @cc_header, @subject, NULL, @from_me, @labels, @bulk)
     ON CONFLICT(account, id) DO UPDATE SET
       thread_id = COALESCE(excluded.thread_id, mail_messages.thread_id),
       date_ms = COALESCE(excluded.date_ms, mail_messages.date_ms),
       from_header = COALESCE(excluded.from_header, mail_messages.from_header),
       to_header = COALESCE(excluded.to_header, mail_messages.to_header),
       cc_header = COALESCE(excluded.cc_header, mail_messages.cc_header),
       subject = COALESCE(excluded.subject, mail_messages.subject),
       from_me = excluded.from_me,
       bulk = excluded.bulk,
       labels = COALESCE(excluded.labels, mail_messages.labels)`,
  );
  const upsertMailFullStmt = db.prepare(
    `INSERT INTO mail_messages (account, id, thread_id, date_ms, from_header, to_header, cc_header, subject, body, from_me, labels, bulk)
     VALUES (@account, @id, @thread_id, @date_ms, @from_header, @to_header, @cc_header, @subject, @body, @from_me, @labels, @bulk)
     ON CONFLICT(account, id) DO UPDATE SET
       thread_id = COALESCE(excluded.thread_id, mail_messages.thread_id),
       date_ms = COALESCE(excluded.date_ms, mail_messages.date_ms),
       from_header = COALESCE(excluded.from_header, mail_messages.from_header),
       to_header = COALESCE(excluded.to_header, mail_messages.to_header),
       cc_header = COALESCE(excluded.cc_header, mail_messages.cc_header),
       subject = COALESCE(excluded.subject, mail_messages.subject),
       body = excluded.body,
       from_me = excluded.from_me,
       bulk = excluded.bulk,
       labels = COALESCE(excluded.labels, mail_messages.labels)`,
  );
  const upsertMailDraftStmt = db.prepare(
    `INSERT INTO mail_drafts (account, draft_id, message_id, thread_id, to_header, cc_header, subject, body, updated_at)
     VALUES (@account, @draft_id, @message_id, @thread_id, @to_header, @cc_header, @subject, @body, @updated_at)
     ON CONFLICT(account, draft_id) DO UPDATE SET
       message_id = excluded.message_id,
       thread_id = COALESCE(excluded.thread_id, mail_drafts.thread_id),
       to_header = COALESCE(excluded.to_header, mail_drafts.to_header),
       cc_header = excluded.cc_header,
       subject = COALESCE(excluded.subject, mail_drafts.subject),
       body = COALESCE(excluded.body, mail_drafts.body),
       updated_at = excluded.updated_at`,
  );
  // Unsent drafts come back from Gmail as ordinary thread messages; they must
  // never act as the last message or show up as a bubble (the dock shows them).
  const newestMessageStmt = db.prepare(
    `SELECT from_header, to_header, cc_header, subject, labels, bulk FROM mail_messages WHERE account = @account AND thread_id = @thread_id AND ${NOT_DRAFT} ORDER BY date_ms DESC LIMIT 1`,
  );
  const threadLabelsStmt = db.prepare(
    `SELECT labels FROM mail_messages WHERE account = @account AND thread_id = @thread_id AND labels IS NOT NULL`,
  );
  const threadFactsStmt = db.prepare(
    `SELECT COUNT(*) AS n,
            (SELECT from_header FROM mail_messages WHERE account = @account AND thread_id = @thread_id AND from_me = 0 AND ${NOT_DRAFT} ORDER BY date_ms DESC LIMIT 1) AS other_from,
            (SELECT to_header FROM mail_messages WHERE account = @account AND thread_id = @thread_id AND ${NOT_DRAFT} ORDER BY date_ms DESC LIMIT 1) AS last_to
     FROM mail_messages WHERE account = @account AND thread_id = @thread_id AND ${NOT_DRAFT}`,
  );
  const overtakenStmt = db.prepare(
    `SELECT 1 FROM mail_messages WHERE account = @account AND thread_id = @thread_id AND from_me = 1 AND ${NOT_DRAFT} AND date_ms > @at LIMIT 1`,
  );
  const lastIncomingMailStmt = db.prepare(
    `SELECT MAX(date_ms) AS at FROM mail_messages WHERE account = @account AND thread_id = @thread_id AND from_me = 0 AND ${NOT_DRAFT}`,
  );
  const lastIncomingWaStmt = db.prepare(`SELECT MAX(timestamp) AS at FROM wa_messages WHERE chat_jid = ? AND from_me = 0`);
  const lastOutgoingWaStmt = db.prepare(`SELECT MAX(timestamp) AS at FROM wa_messages WHERE chat_jid = ? AND from_me = 1`);
  const otherFromsStmt = db.prepare(
    `SELECT from_header FROM mail_messages WHERE account = @account AND thread_id = @thread_id AND from_me = 0 AND ${NOT_DRAFT} ORDER BY date_ms DESC LIMIT 20`,
  );
  const myLastToStmt = db.prepare(
    `SELECT to_header FROM mail_messages WHERE account = @account AND thread_id = @thread_id AND from_me = 1 AND ${NOT_DRAFT} ORDER BY date_ms DESC LIMIT 1`,
  );
  const openedStmt = db.prepare(
    `SELECT opens FROM superhuman_sends WHERE account = ? AND thread_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`,
  );
  const waMessageCountStmt = db.prepare(`SELECT COUNT(*) AS n FROM wa_messages WHERE chat_jid = ?`);
  const attentionStmt = db.prepare(`SELECT * FROM attention WHERE key = ?`);
  const dismissStmt = db.prepare(
    `INSERT INTO attention (key, dismissed_at, opened_at) VALUES (@key, @at, NULL)
     ON CONFLICT(key) DO UPDATE SET dismissed_at = @at`,
  );
  const openStmt = db.prepare(
    `INSERT INTO attention (key, dismissed_at, opened_at) VALUES (@key, NULL, @at)
     ON CONFLICT(key) DO UPDATE SET opened_at = @at`,
  );
  const aliasStmt = db.prepare(`SELECT pn FROM wa_jid_alias WHERE lid = ?`);
  const aliasLidsStmt = db.prepare(`SELECT lid FROM wa_jid_alias WHERE pn = ?`);
  const upsertAliasStmt = db.prepare(
    `INSERT INTO wa_jid_alias (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn`,
  );
  const draftOriginStmt = db.prepare(`SELECT origin FROM mail_draft_origin WHERE account = ? AND draft_id = ?`);
  const setDraftOriginStmt = db.prepare(
    `INSERT INTO mail_draft_origin (account, draft_id, origin) VALUES (?, ?, ?)
     ON CONFLICT(account, draft_id) DO UPDATE SET origin = excluded.origin`,
  );
  const mutedAllStmt = db.prepare(`SELECT * FROM muted_senders ORDER BY created_at DESC`);
  const muteStmt = db.prepare(
    `INSERT INTO muted_senders (id, channel, label, handle, created_at)
     VALUES (@id, @channel, @label, @handle, @created_at)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, handle = excluded.handle`,
  );
  const unmuteStmt = db.prepare(`DELETE FROM muted_senders WHERE id = ?`);
  const autoDraftMarkStmt = db.prepare(`SELECT handled_at FROM auto_draft_marks WHERE jid = ?`);
  const setAutoDraftMarkStmt = db.prepare(
    `INSERT INTO auto_draft_marks (jid, handled_at, asked_at) VALUES (@jid, @at, @askedAt)
     ON CONFLICT(jid) DO UPDATE SET
       handled_at = MAX(auto_draft_marks.handled_at, excluded.handled_at),
       asked_at = excluded.asked_at`,
  );
  // Compare and delete in one statement. The mark is monotonic by design, so it
  // cannot be lowered through the setter above; putting a chat back to
  // unhandled needs its own path, and the `handled_at = @at` clause is the
  // "only if it is still the value that ask wrote" check done atomically rather
  // than as a read followed by a write that a newer burst could land between.
  //
  // An UPDATE to 0 rather than a DELETE: the row also
  // holds `attempts`, and deleting it reset the counter on every rollback, so
  // the MAX_ASK_ATTEMPTS cap never fired. Every reader treats 0 as unhandled:
  // autoDraftMark returns it, unaskedWaBursts compares last_message_at > 0, the
  // stale-ask sweep needs asked_at, which is cleared here, and the setter's
  // MAX() takes the next mark over 0.
  const clearAutoDraftMarkStmt = db.prepare(
    `UPDATE auto_draft_marks SET handled_at = 0, asked_at = NULL WHERE jid = @jid AND handled_at = @at`,
  );

  /** The phone-number jid of a LID address when we know it, else the input. */
  function canonicalJid(jid: string): string {
    if (!jid.endsWith("@lid")) return jid;
    const row = aliasStmt.get(bareJid(jid)) as { pn: string } | undefined;
    return row?.pn ?? jid;
  }

  /** Old deep links may carry the LID form of a chat; resolve them the same way. */
  function canonicalKey(key: string): string {
    if (!key.startsWith("wa:")) return key;
    const jid = key.slice(3);
    const canonical = canonicalJid(jid);
    return canonical === jid ? key : waKey(canonical);
  }

  /** Every known address of one contact: the phone jid plus its LID forms. */
  function jidForms(jid: string): string[] {
    const canonical = canonicalJid(jid);
    const lids = (aliasLidsStmt.all(canonical) as { lid: string }[]).map((r) => r.lid);
    return [...new Set([canonical, jid, ...lids])];
  }

  function contactNameOf(jid: string): string | null {
    for (const form of jidForms(jid)) {
      const row = contactNameStmt.get(form) as { name: string | null; notify: string | null } | undefined;
      const name = row?.name ?? row?.notify ?? null;
      if (name && name.trim() !== "") return name;
    }
    return null;
  }

  /**
   * Chat as the panel shows it: address book name (under either address),
   * then push name, then the phone number, then the raw jid.
   */
  function toChat(row: ChatRow): WaChat {
    const base = chatOf(row);
    if (row.name && row.name.trim() !== "") return base;
    return { ...base, name: contactNameOf(row.jid) ?? base.phone ?? row.jid };
  }

  /** Move everything stored under a LID address onto the phone-number address. */
  function mergeJid(lid: string, pn: string): void {
    if (lid === pn) return;
    const lidRow = chatStmt.get(lid) as ChatRow | undefined;
    const lidContact = contactNameStmt.get(lid) as { name: string | null; notify: string | null } | undefined;
    if (lidRow) {
      upsertChatStmt.run({
        jid: pn,
        name: lidRow.name,
        phone: phoneOfJid(pn),
        is_group: lidRow.is_group,
      });
      if (lidRow.last_message_at !== null) {
        touchChatStmt.run({
          jid: pn,
          at: lidRow.last_message_at,
          text: lidRow.last_message_text,
          from_me: lidRow.last_from_me,
        });
      }
    }
    if (lidContact && (lidContact.name || lidContact.notify)) {
      upsertContactStmt.run({ jid: pn, name: lidContact.name, notify: lidContact.notify });
    }
    db.prepare(`UPDATE OR REPLACE wa_messages SET chat_jid = ? WHERE chat_jid = ?`).run(pn, lid);
    db.prepare(`UPDATE wa_drafts SET chat_jid = ? WHERE chat_jid = ?`).run(pn, lid);
    const from = attentionStmt.get(waKey(lid)) as AttentionRow | undefined;
    if (from) {
      const to = attentionStmt.get(waKey(pn)) as AttentionRow | undefined;
      const dismissedAt = Math.max(from.dismissed_at ?? 0, to?.dismissed_at ?? 0) || null;
      const openedAt = Math.max(from.opened_at ?? 0, to?.opened_at ?? 0) || null;
      db.prepare(
        `INSERT INTO attention (key, dismissed_at, opened_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET dismissed_at = excluded.dismissed_at, opened_at = excluded.opened_at`,
      ).run(waKey(pn), dismissedAt, openedAt);
      db.prepare(`DELETE FROM attention WHERE key = ?`).run(waKey(lid));
    }
    db.prepare(`DELETE FROM wa_chats WHERE jid = ?`).run(lid);
  }

  /** Newest message from the other side, which is what lifts a dismissal. */
  function lastIncomingOf(key: string): number | null {
    const parsed = parseConversationKey(canonicalKey(key));
    if (!parsed) return null;
    if (parsed.channel === "whatsapp") return (lastIncomingWaStmt.get(parsed.jid) as { at: number | null }).at;
    if (parsed.threadId) return (lastIncomingMailStmt.get({ account: parsed.account, thread_id: parsed.threadId }) as { at: number | null }).at;
    return null;
  }

  function lastAtOf(key: string): number | null {
    const parsed = parseConversationKey(canonicalKey(key));
    if (!parsed) return null;
    if (parsed.channel === "whatsapp") return store.chat(parsed.jid)?.lastMessageAt ?? null;
    if (parsed.threadId) {
      const thread = store.mailThread(parsed.account, parsed.threadId);
      if (thread) return thread.last_at;
      const draft = store.mailDraftForThread(parsed.account, parsed.threadId);
      return draft?.updated_at ?? null;
    }
    return parsed.draftId ? (store.mailDraftRow(parsed.account, parsed.draftId)?.updated_at ?? null) : null;
  }

  // A worker's mail draft is stored as `worker:<threadId>` in the one origin
  // column, so the title can be looked up without a second table.
  function mailDraftOrigin(account: string, draftId: string): DraftOriginValue {
    const row = draftOriginStmt.get(account, draftId) as { origin: string } | undefined;
    if (row?.origin === "chief" || row?.origin === "you") return row.origin;
    if (row?.origin.startsWith("worker:")) return "worker";
    return "unknown";
  }

  function mailDraftAuthorTitle(account: string, draftId: string): string | null {
    const row = draftOriginStmt.get(account, draftId) as { origin: string } | undefined;
    return row?.origin.startsWith("worker:") ? titleOf(row.origin.slice("worker:".length)) : null;
  }

  function waDraftDtoFor(draft: WaDraft): Draft {
    const dto = waDraftDto(draft, originOfThread(draft.sourceThreadId, chiefIdOf()));
    return dto.origin === "worker" && draft.sourceThreadId ? { ...dto, authorTitle: titleOf(draft.sourceThreadId) } : dto;
  }

  /** A WhatsApp draft DTO with its unreviewed change, when there is one. */
  function withRevision(dto: Draft): Draft {
    return { ...dto, previousText: store.draftRevision(`wa:${dto.id}`, dto.text)?.before ?? null };
  }

  function mailDraftDto(row: MailDraftRow): Draft {
    const account = accountOf(row.account);
    // Gmail keeps the quoted trailer inside the draft body. The trailer is
    // split off here, so the panel's edit box holds only the reply, and put
    // back when the draft is saved.
    const split = splitQuoted(row.body ?? "");
    return {
      id: row.draft_id,
      channel: "mail",
      account,
      text: split.body,
      quoted: split.quoted === "" ? null : split.quoted,
      to: row.to_header,
      cc: row.cc_header,
      subject: row.subject,
      updatedAt: row.updated_at,
      links: mailLinks(emailOf(account), row.thread_id, true),
      origin: mailDraftOrigin(row.account, row.draft_id),
      authorTitle: mailDraftAuthorTitle(row.account, row.draft_id),
      // Gmail sends are not retried from a stored draft, so there is no error to carry.
      error: null,
      previousText: store.draftRevision(`mail:${account}:${row.draft_id}`, split.body)?.before ?? null,
    };
  }

  const store = {
    // ================= WhatsApp =================

    /** The phone-number address of a chat when WhatsApp told us about it. */
    canonicalJid,
    canonicalKey,

    /**
     * Learn that one contact is addressed both ways and fold the LID chat into
     * the phone-number chat. Returns true when this was new information.
     */
    setJidAlias(lidRaw: string, pnRaw: string): boolean {
      const lid = bareJid(lidRaw);
      const pn = bareJid(pnRaw);
      if (!lid.endsWith("@lid") || !pn.endsWith("@s.whatsapp.net")) return false;
      const known = aliasStmt.get(lid) as { pn: string } | undefined;
      if (known?.pn === pn) {
        // Already known, but a chat row may have been created under the LID since.
        if (!chatStmt.get(lid)) return false;
        mergeJid(lid, pn);
        return true;
      }
      upsertAliasStmt.run(lid, pn);
      mergeJid(lid, pn);
      return true;
    },


    upsertChat(chat: { jid: string; name?: string | null; phone?: string | null; isGroup?: boolean }): void {
      const jid = canonicalJid(chat.jid);
      upsertChatStmt.run({
        jid,
        name: chat.name ?? null,
        phone: chat.phone ?? phoneOfJid(jid),
        is_group: chat.isGroup ? 1 : 0,
      });
    },

    /** Store one message; also bumps the chat's last-message columns. Returns true when the row was new. */
    addMessage(message: WaMessage): boolean {
      const chatJid = canonicalJid(message.chatJid);
      const info = insertMessageStmt.run({
        id: message.id,
        chat_jid: chatJid,
        sender_jid: message.senderJid,
        sender_name: message.senderName,
        from_me: message.fromMe ? 1 : 0,
        text: message.text,
        kind: message.kind,
        timestamp: message.timestamp,
      });
      touchChatStmt.run({
        jid: chatJid,
        at: message.timestamp,
        text: message.text.slice(0, 200),
        from_me: message.fromMe ? 1 : 0,
      });
      return info.changes > 0;
    },

    /**
     * Attach a downloaded media file to a stored message. Only the first
     * attachment counts: a re-download must not look like a new fact.
     */
    setMessageMedia(id: string, mediaPath: string, mediaMime: string | null, fileName: string | null = null): boolean {
      const info = db
        .prepare(`UPDATE wa_messages SET media_path = ?, media_mime = ?, media_name = ? WHERE id = ? AND media_path IS NULL`)
        .run(mediaPath, mediaMime, fileName, id);
      return info.changes > 0;
    },

    /** The chat a stored message belongs to, or null when it is gone. */
    messageChatJid(id: string): string | null {
      const row = db.prepare(`SELECT chat_jid FROM wa_messages WHERE id = ?`).get(id) as { chat_jid: string } | undefined;
      return row?.chat_jid ?? null;
    },

    upsertContact(contact: { jid: string; name?: string | null; notify?: string | null }): void {
      upsertContactStmt.run({ jid: canonicalJid(contact.jid), name: contact.name ?? null, notify: contact.notify ?? null });
    },

    /** Give a chat a display name only when it has none yet (push names must not override contact names). */
    setChatNameIfMissing(jid: string, name: string): void {
      db.prepare(`UPDATE wa_chats SET name = ? WHERE jid = ? AND (name IS NULL OR name = '')`).run(name, canonicalJid(jid));
    },

    /** Contact names win over push names: overwrite whatever the chat had. */
    setChatName(jid: string, name: string): void {
      db.prepare(`UPDATE wa_chats SET name = ? WHERE jid = ?`).run(name, canonicalJid(jid));
    },

    contactName(jid: string): string | null {
      return contactNameOf(jid);
    },

    chat(jid: string): WaChat | null {
      const row = chatStmt.get(canonicalJid(jid)) as ChatRow | undefined;
      return row ? toChat(row) : null;
    },

    chats(options: { limit?: number; query?: string } = {}): WaChat[] {
      const limit = options.limit ?? 50;
      const query = options.query?.trim();
      const rows = query
        ? (db
            .prepare(
              `${CHAT_SELECT_NAMED} WHERE (${CHAT_NAME_EXPR} LIKE ? OR c.phone LIKE ? OR c.jid LIKE ?)
               ORDER BY c.last_message_at DESC NULLS LAST LIMIT ?`,
            )
            .all(`%${query}%`, `%${query}%`, `%${query}%`, limit) as ChatRow[])
        : (db
            .prepare(`${CHAT_SELECT} WHERE c.last_message_at IS NOT NULL ORDER BY c.last_message_at DESC LIMIT ?`)
            .all(limit) as ChatRow[]);
      return rows.map(toChat);
    },

    /** Chats matching a name, phone, or jid fragment, for resolving a human reference. */
    findChats(reference: string): WaChat[] {
      const jid = canonicalJid(reference);
      const rows = db
        .prepare(
          `${CHAT_SELECT_NAMED} WHERE c.jid = ? OR c.phone = ? OR LOWER(${CHAT_NAME_EXPR}) = LOWER(?) ORDER BY c.last_message_at DESC`,
        )
        .all(jid, reference, reference) as ChatRow[];
      if (rows.length > 0) return rows.map(toChat);
      // Digits only count as a phone fragment when there are enough of them:
      // an empty digit string would match every chat that has a number.
      const digits = reference.replace(/\D/g, "");
      const fuzzy =
        digits.length >= 4
          ? (db
              .prepare(
                `${CHAT_SELECT_NAMED} WHERE ${CHAT_NAME_EXPR} LIKE ? OR c.phone LIKE ? ORDER BY c.last_message_at DESC LIMIT 10`,
              )
              .all(`%${reference}%`, `%${digits}%`) as ChatRow[])
          : (db
              .prepare(`${CHAT_SELECT_NAMED} WHERE ${CHAT_NAME_EXPR} LIKE ? ORDER BY c.last_message_at DESC LIMIT 10`)
              .all(`%${reference}%`) as ChatRow[]);
      return fuzzy.map(toChat);
    },


    messages(chatJid: string, limit = 30): WaMessage[] {
      const rows = db
        .prepare(`SELECT * FROM wa_messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?`)
        .all(canonicalJid(chatJid), limit) as MessageRow[];
      return rows.reverse().map(messageOf);
    },

    createDraft(draft: { id: string; chatJid: string; chatName: string; text: string; sourceThreadId: string | null }): WaDraft {
      const now = Date.now();
      insertDraftStmt.run({
        id: draft.id,
        chat_jid: canonicalJid(draft.chatJid),
        chat_name: draft.chatName,
        text: draft.text,
        now,
        source_thread_id: draft.sourceThreadId,
      });
      return store.draft(draft.id) as WaDraft;
    },

    draft(id: string): WaDraft | null {
      const row = draftStmt.get(id) as DraftRow | undefined;
      return row ? draftOf(row) : null;
    },

    drafts(options: { status?: WaDraftStatus; limit?: number } = {}): WaDraft[] {
      const limit = options.limit ?? 50;
      const rows = options.status
        ? (db
            .prepare(`SELECT * FROM wa_drafts WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
            .all(options.status, limit) as DraftRow[])
        : (db.prepare(`SELECT * FROM wa_drafts ORDER BY created_at DESC LIMIT ?`).all(limit) as DraftRow[]);
      return rows.map(draftOf);
    },

    /**
     * True when a pending WhatsApp draft has been overtaken: the owner wrote in
     * the chat after it was saved, so it is not waiting for him. The `wa
     * drafts` listings flag these, so a drafts-waiting list built from them
     * does not offer them as live.
     */
    waDraftIsOvertaken(draft: WaDraft): boolean {
      if (draft.status !== "pending") return false;
      const out = (lastOutgoingWaStmt.get(canonicalJid(draft.chatJid)) as { at: number | null }).at;
      return waDraftOvertaken(draft.updatedAt, out);
    },

    /**
     * The chief read the newest messages and the pending draft still answers
     * them. Stamps `updated_at` and changes nothing
     * else, so verifyAsk sees a draft written at or after the burst and settles
     * instead of re-asking. Refused for a draft the owner overtook: stamping it
     * would make his own later message look older than the draft and put it
     * back in Ready to send. Returns the kept draft, or null when nothing moved.
     */
    keepPendingDraft(chatJid: string, at: number = Date.now()): WaDraft | null {
      const draft = store.pendingDraftFor(chatJid);
      if (draft === null || store.waDraftIsOvertaken(draft)) return null;
      db.prepare(`UPDATE wa_drafts SET updated_at = ? WHERE id = ? AND status = 'pending'`).run(Math.max(at, draft.updatedAt), draft.id);
      return store.pendingDraftFor(chatJid);
    },

    /** Newest pending draft for one chat: the one the reply dock shows. */
    /**
     * The pending draft, or null when the owner has written in the chat since it
     * was saved. An overtaken draft is not "ready to send", and another plugin
     * asking draft_get must not be told it is still waiting, or a plugin that
     * refuses to update an overtaken draft is left stuck on it.
     */
    /** When he last wrote in this chat himself, or null. */
    lastOwnWaMessageAt(chatJid: string): number | null {
      return (lastOutgoingWaStmt.get(canonicalJid(chatJid)) as { at: number | null }).at;
    },

    livePendingDraftFor(chatJid: string): WaDraft | null {
      const draft = store.pendingDraftFor(chatJid);
      if (draft === null) return null;
      const out = (lastOutgoingWaStmt.get(canonicalJid(chatJid)) as { at: number | null }).at;
      return waDraftOvertaken(draft.updatedAt, out) ? null : draft;
    },

    pendingDraftFor(chatJid: string): WaDraft | null {
      const row = db
        .prepare(`SELECT * FROM wa_drafts WHERE chat_jid = ? AND status = 'pending' ORDER BY updated_at DESC, created_at DESC LIMIT 1`)
        .get(canonicalJid(chatJid)) as DraftRow | undefined;
      return row ? draftOf(row) : null;
    },


    /**
     * Who wrote the draft last: a thread id for the chief, null for the owner.
     * The badge follows the newest writer, so a draft he started and the chief
     * rewrote reads "Draft by the chief", matching the highlight under it.
     */
    setDraftAuthor(id: string, sourceThreadId: string | null): void {
      db.prepare(`UPDATE wa_drafts SET source_thread_id = ? WHERE id = ?`).run(sourceThreadId, id);
    },

    updateDraft(
      id: string,
      patch: { text?: string; status?: WaDraftStatus; sentMessageId?: string | null; error?: string | null },
    ): WaDraft | null {
      const current = store.draft(id);
      if (!current) return null;
      const text = patch.text ?? current.text;
      // The claimed id belongs to the text it was claimed for. Rewriting the
      // draft after a send that timed out and then reusing the id would let
      // WhatsApp drop the correction as a duplicate, leaving the reader with
      // the old wording and the panel saying sent. Editing releases the id.
      const sendMessageId = text === current.text ? current.sendMessageId : null;
      db.prepare(
        `UPDATE wa_drafts SET text = ?, status = ?, sent_message_id = ?, send_message_id = ?, error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        text,
        patch.status ?? current.status,
        patch.sentMessageId === undefined ? current.sentMessageId : patch.sentMessageId,
        sendMessageId,
        patch.error === undefined ? current.error : patch.error,
        Date.now(),
        id,
      );
      return store.draft(id);
    },

    /**
     * Give this draft the message id it will be sent under, once and for all.
     * The first caller writes `minted`; every later caller, including a retry
     * after a timeout, gets the same id back. The write is one conditional
     * UPDATE, so two callers cannot mint two ids for one draft.
     */
    claimSendMessageId(id: string, minted: string): string | null {
      db.prepare(`UPDATE wa_drafts SET send_message_id = ? WHERE id = ? AND send_message_id IS NULL`).run(
        minted,
        id,
      );
      const row = db.prepare(`SELECT send_message_id FROM wa_drafts WHERE id = ?`).get(id) as
        | { send_message_id: string | null }
        | undefined;
      return row?.send_message_id ?? null;
    },

    // ================= chief turn provenance =================

    /** Remember a message this plugin sent into the chief thread, so the send tools can tell a plugin-started turn from one the owner started. */
    recordChiefInjection(hash: string): void {
      const now = Date.now();
      db.prepare(`INSERT OR REPLACE INTO chief_injections (hash, created_at) VALUES (?, ?)`).run(hash, now);
      db.prepare(`DELETE FROM chief_injections WHERE created_at < ?`).run(now - 30 * 24 * 60 * 60 * 1000);
    },

    isChiefInjection(hash: string): boolean {
      return db.prepare(`SELECT 1 FROM chief_injections WHERE hash = ?`).get(hash) !== undefined;
    },

    // ================= mail cache =================

    upsertMailThread(input: {
      account: MailAccount;
      threadId: string;
      subject: string | null;
      lastAt: number | null;
      lastFrom: string | null;
      lastFromMe: boolean;
      preview: string | null;
      unread: boolean;
      messageCount: number;
      syncedAt?: number;
    }): void {
      upsertMailThreadStmt.run({
        account: input.account,
        thread_id: input.threadId,
        subject: input.subject,
        last_at: input.lastAt,
        last_from: input.lastFrom,
        last_from_me: input.lastFromMe ? 1 : 0,
        preview: input.preview,
        unread: input.unread ? 1 : 0,
        message_count: input.messageCount,
        synced_at: input.syncedAt ?? Date.now(),
      });
    },

    /** Store a message header. Leaves any cached body alone. */
    upsertMailHeader(input: {
      account: MailAccount;
      id: string;
      threadId: string | null;
      dateMs: number | null;
      from: string | null;
      to: string | null;
      cc: string | null;
      subject: string | null;
      fromMe: boolean;
      labels: string[];
      bulk: boolean;
    }): void {
      upsertMailHeaderStmt.run({
        account: input.account,
        id: input.id,
        thread_id: input.threadId,
        date_ms: input.dateMs,
        from_header: input.from,
        to_header: input.to,
        cc_header: input.cc,
        subject: input.subject,
        from_me: input.fromMe ? 1 : 0,
        labels: JSON.stringify(input.labels),
        bulk: input.bulk ? 1 : 0,
      });
    },

    /** Store a message together with its plain-text body. */
    upsertMailMessage(input: {
      account: MailAccount;
      id: string;
      threadId: string | null;
      dateMs: number | null;
      from: string | null;
      to: string | null;
      cc: string | null;
      subject: string | null;
      body: string;
      fromMe: boolean;
      labels: string[];
      bulk: boolean;
    }): void {
      upsertMailFullStmt.run({
        account: input.account,
        id: input.id,
        thread_id: input.threadId,
        date_ms: input.dateMs,
        from_header: input.from,
        to_header: input.to,
        cc_header: input.cc,
        subject: input.subject,
        body: input.body,
        from_me: input.fromMe ? 1 : 0,
        labels: JSON.stringify(input.labels),
        bulk: input.bulk ? 1 : 0,
      });
    },

    mailThread(account: MailAccount, threadId: string): MailThreadRow | null {
      const row = db.prepare(`SELECT * FROM mail_threads WHERE account = ? AND thread_id = ?`).get(account, threadId) as
        | MailThreadRow
        | undefined;
      return row ?? null;
    },

    mailMessageRows(account: MailAccount, threadId: string): MailMessageRow[] {
      return db
        .prepare(`SELECT * FROM mail_messages WHERE account = ? AND thread_id = ? ORDER BY date_ms ASC, id ASC`)
        .all(account, threadId) as MailMessageRow[];
    },

    /** Cached messages of a thread without the unsent draft Gmail returns with it. */
    mailMessageRowsSent(account: MailAccount, threadId: string): MailMessageRow[] {
      return store.mailMessageRows(account, threadId).filter((row) => !isDraftRow(row.labels));
    },

    /** Drop cached messages of a thread that Gmail no longer returns. */
    pruneMailMessages(account: MailAccount, threadId: string, keepIds: string[]): number {
      const keep = new Set(keepIds);
      let removed = 0;
      for (const row of store.mailMessageRows(account, threadId)) {
        if (keep.has(row.id)) continue;
        db.prepare(`DELETE FROM mail_messages WHERE account = ? AND id = ?`).run(account, row.id);
        removed += 1;
      }
      return removed;
    },

    /** Remove DRAFT-labelled message rows whose Gmail draft is gone (sent, deleted or pruned). */
    pruneOrphanDraftMessages(account?: MailAccount): number {
      const rows = (
        account
          ? (db.prepare(`SELECT account, id FROM mail_messages WHERE account = ? AND NOT ${NOT_DRAFT}`).all(account) as {
              account: string;
              id: string;
            }[])
          : (db.prepare(`SELECT account, id FROM mail_messages WHERE NOT ${NOT_DRAFT}`).all() as { account: string; id: string }[])
      );
      let removed = 0;
      for (const row of rows) {
        const draft = db.prepare(`SELECT 1 FROM mail_drafts WHERE account = ? AND message_id = ?`).get(row.account, row.id);
        if (draft) continue;
        db.prepare(`DELETE FROM mail_messages WHERE account = ? AND id = ?`).run(row.account, row.id);
        removed += 1;
      }
      return removed;
    },

    /**
     * Recompute every cached thread from its messages, ignoring drafts. Heals
     * threads whose cached last message is the owner's own unsent draft, and
     * drops thread rows that hold nothing but a draft.
     */
    repairMailThreads(account?: MailAccount): number {
      const rows = (
        account
          ? (db.prepare(`SELECT account, thread_id FROM mail_threads WHERE account = ?`).all(account) as {
              account: string;
              thread_id: string;
            }[])
          : (db.prepare(`SELECT account, thread_id FROM mail_threads`).all() as { account: string; thread_id: string }[])
      );
      let repaired = 0;
      for (const row of rows) {
        const acct = accountOf(row.account);
        const all = store.mailMessageRows(acct, row.thread_id);
        if (all.length === 0) continue;
        if (all.every((m) => isDraftRow(m.labels))) {
          db.prepare(`DELETE FROM mail_threads WHERE account = ? AND thread_id = ?`).run(row.account, row.thread_id);
          repaired += 1;
          continue;
        }
        store.refreshMailThreadFromMessages(acct, row.thread_id);
        repaired += 1;
      }
      return repaired;
    },

    /** Forget threads the inbox query no longer returns and that fell out of the lookback. */
    pruneMailThreads(account: MailAccount, keepThreadIds: string[], olderThan: number): number {
      const keep = new Set(keepThreadIds);
      const rows = db.prepare(`SELECT thread_id, last_at FROM mail_threads WHERE account = ?`).all(account) as {
        thread_id: string;
        last_at: number | null;
      }[];
      let removed = 0;
      for (const row of rows) {
        if (keep.has(row.thread_id)) continue;
        if (row.last_at !== null && row.last_at >= olderThan) continue;
        // A thread with a draft waiting is still actionable, keep it.
        if (store.mailDraftForThread(account, row.thread_id)) continue;
        db.prepare(`DELETE FROM mail_threads WHERE account = ? AND thread_id = ?`).run(account, row.thread_id);
        db.prepare(`DELETE FROM mail_messages WHERE account = ? AND thread_id = ?`).run(account, row.thread_id);
        removed += 1;
      }
      return removed;
    },

    /**
     * True when the cached thread is not good enough to show: nothing cached,
     * a message without a body, or a message newer than the newest cached body.
     */
    mailThreadNeedsFetch(account: MailAccount, threadId: string): boolean {
      const rows = store.mailMessageRows(account, threadId);
      if (rows.length === 0) return true;
      if (rows.some((row) => row.body === null)) return true;
      const thread = store.mailThread(account, threadId);
      const newestBody = rows.reduce((max, row) => (row.body !== null ? Math.max(max, row.date_ms ?? 0) : max), 0);
      return thread?.last_at != null && thread.last_at > newestBody;
    },

    /** Recompute a thread's last-message columns from the cached messages. */
    refreshMailThreadFromMessages(account: MailAccount, threadId: string, fallbackSubject: string | null = null): void {
      const rows = store.mailMessageRows(account, threadId);
      // An unsent draft in the thread is not a reply: it must not become the
      // "last message" or the needs-reply logic thinks the owner already answered.
      const sent = rows.filter((row) => !isDraftRow(row.labels));
      // Nothing but a draft: this is not a conversation, do not fabricate one.
      if (sent.length === 0) return;
      const last = sent[sent.length - 1] as MailMessageRow;
      const unreadNow = sent.some((row) => (row.labels ?? "").includes("UNREAD"));
      const existing = store.mailThread(account, threadId);
      db.prepare(
        `INSERT INTO mail_threads (account, thread_id, subject, last_at, last_from, last_from_me, preview, unread, message_count, synced_at)
         VALUES (@account, @thread_id, @subject, @last_at, @last_from, @last_from_me, @preview, @unread, @message_count, @synced_at)
         ON CONFLICT(account, thread_id) DO UPDATE SET
           subject = COALESCE(excluded.subject, mail_threads.subject),
           last_at = excluded.last_at,
           last_from = excluded.last_from,
           last_from_me = excluded.last_from_me,
           preview = excluded.preview,
           unread = excluded.unread,
           message_count = excluded.message_count,
           synced_at = excluded.synced_at`,
      ).run({
        account,
        thread_id: threadId,
        subject: existing?.subject ?? last.subject ?? fallbackSubject,
        last_at: last.date_ms,
        last_from: last.from_header,
        last_from_me: last.from_me,
        preview: shorten(last.body ?? existing?.preview ?? ""),
        unread: unreadNow ? 1 : 0,
        message_count: sent.length,
        synced_at: Date.now(),
      });
    },

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
    }): void {
      upsertMailDraftStmt.run({
        account: input.account,
        draft_id: input.draftId,
        message_id: input.messageId,
        thread_id: input.threadId,
        to_header: input.to,
        cc_header: input.cc,
        subject: input.subject,
        body: input.body,
        updated_at: input.updatedAt,
      });
    },

    /** Replace a draft's cached body outright (used right after an edit). */
    setMailDraftBody(account: MailAccount, draftId: string, body: string): void {
      db.prepare(`UPDATE mail_drafts SET body = ?, updated_at = ? WHERE account = ? AND draft_id = ?`).run(
        body,
        Date.now(),
        account,
        draftId,
      );
    },

    mailDraftRow(account: MailAccount, draftId: string): MailDraftRow | null {
      const row = db.prepare(`SELECT * FROM mail_drafts WHERE account = ? AND draft_id = ?`).get(account, draftId) as
        | MailDraftRow
        | undefined;
      return row ?? null;
    },

    /** Newest cached draft attached to a Gmail thread. */
    /**
     * Write down that a discard is about to happen, before anything is
     * destroyed. Returns the row id so the outcome can be filled in after.
     * Never wrap this in a try/catch at the call site: if the audit cannot be
     * written the discard must not proceed, because an unlogged delete cannot
     * be explained afterwards.
     */
    recordMailDiscardAttempt(entry: {
      account: MailAccount;
      draftId: string;
      threadKey: string | null;
      caller: string;
      copyTaken: boolean;
    }): number {
      const info = db
        .prepare(
          `INSERT INTO mail_discard_audit (at, account, draft_id, thread_key, caller, copy_taken, outcome)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(Date.now(), entry.account, entry.draftId, entry.threadKey, entry.caller, entry.copyTaken ? 1 : 0);
      return Number(info.lastInsertRowid);
    },

    /** How the discard ended. A row still null here is a delete that never came back. */
    setMailDiscardOutcome(id: number, outcome: string): void {
      db.prepare(`UPDATE mail_discard_audit SET outcome = ? WHERE id = ?`).run(outcome.slice(0, 300), id);
    },

    /** The discard log, newest first. */
    mailDiscardAudit(limit = 50): MailDiscardAuditRow[] {
      return db
        .prepare(`SELECT * FROM mail_discard_audit ORDER BY id DESC LIMIT ?`)
        .all(limit) as MailDiscardAuditRow[];
    },

    /** Every cached draft in one thread. A thread can hold several, which is what the discard has to refuse on. */
    mailDraftRowsForThread(account: MailAccount, threadId: string): MailDraftRow[] {
      return db
        .prepare(`SELECT * FROM mail_drafts WHERE account = ? AND thread_id = ? ORDER BY updated_at DESC`)
        .all(account, threadId) as MailDraftRow[];
    },

    mailDraftForThread(account: MailAccount, threadId: string): MailDraftRow | null {
      const row = db
        .prepare(`SELECT * FROM mail_drafts WHERE account = ? AND thread_id = ? ORDER BY updated_at DESC LIMIT 1`)
        .get(account, threadId) as MailDraftRow | undefined;
      return row ?? null;
    },

    mailDraftRows(account?: MailAccount): MailDraftRow[] {
      return account
        ? (db.prepare(`SELECT * FROM mail_drafts WHERE account = ? ORDER BY updated_at DESC`).all(account) as MailDraftRow[])
        : (db.prepare(`SELECT * FROM mail_drafts ORDER BY updated_at DESC`).all() as MailDraftRow[]);
    },

    deleteMailDraft(account: MailAccount, draftId: string): void {
      const row = store.mailDraftRow(account, draftId);
      db.prepare(`DELETE FROM mail_drafts WHERE account = ? AND draft_id = ?`).run(account, draftId);
      db.prepare(`DELETE FROM mail_draft_origin WHERE account = ? AND draft_id = ?`).run(account, draftId);
      // The draft also sits in the thread cache as a DRAFT-labelled message row.
      if (row?.message_id) {
        db.prepare(`DELETE FROM mail_messages WHERE account = ? AND id = ?`).run(account, row.message_id);
      }
      if (row?.thread_id) {
        const rest = store.mailMessageRowsSent(account, row.thread_id);
        if (rest.length === 0) {
          db.prepare(`DELETE FROM mail_threads WHERE account = ? AND thread_id = ?`).run(account, row.thread_id);
          db.prepare(`DELETE FROM mail_messages WHERE account = ? AND thread_id = ?`).run(account, row.thread_id);
        }
      }
    },

    /**
     * Copy a draft into the trash before Gmail is told to delete it. Called
     * with what the panel already has cached plus the reply header, which only
     * Gmail knows. Overwrites any older trash row for the same draft id.
     */
    trashMailDraft(input: {
      account: MailAccount;
      draftId: string;
      threadId: string | null;
      to: string | null;
      cc: string | null;
      subject: string | null;
      body: string | null;
      inReplyTo: string | null;
      replyToId: string | null;
      conversationKey: string | null;
      at?: number;
    }): void {
      db.prepare(
        `INSERT INTO mail_draft_trash
           (account, draft_id, thread_id, to_header, cc_header, subject, body, in_reply_to, reply_to_id, origin, conversation_key, discarded_at)
         VALUES (@account, @draft_id, @thread_id, @to_header, @cc_header, @subject, @body, @in_reply_to, @reply_to_id, @origin, @conversation_key, @discarded_at)
         ON CONFLICT(account, draft_id) DO UPDATE SET
           thread_id = excluded.thread_id,
           to_header = excluded.to_header,
           cc_header = excluded.cc_header,
           subject = excluded.subject,
           body = excluded.body,
           in_reply_to = excluded.in_reply_to,
           reply_to_id = excluded.reply_to_id,
           origin = excluded.origin,
           conversation_key = excluded.conversation_key,
           discarded_at = excluded.discarded_at`,
      ).run({
        account: input.account,
        draft_id: input.draftId,
        thread_id: input.threadId,
        to_header: input.to,
        cc_header: input.cc,
        subject: input.subject,
        body: input.body,
        in_reply_to: input.inReplyTo,
        reply_to_id: input.replyToId,
        origin: mailDraftOrigin(input.account, input.draftId),
        conversation_key: input.conversationKey,
        discarded_at: input.at ?? Date.now(),
      });
    },

    /** The draft the newest discard threw away, if it is still inside the window. */
    newestTrashedMailDraft(now = Date.now()): MailDraftTrashRow | null {
      const row = db
        .prepare(`SELECT * FROM mail_draft_trash WHERE discarded_at > ? ORDER BY discarded_at DESC LIMIT 1`)
        .get(now - RESTORE_WINDOW_MS) as MailDraftTrashRow | undefined;
      return row ?? null;
    },

    /** Everything still inside the window, newest first: what the panel lists. */
    trashedMailDrafts(now = Date.now()): MailDraftTrashRow[] {
      return db
        .prepare(`SELECT * FROM mail_draft_trash WHERE discarded_at > ? ORDER BY discarded_at DESC`)
        .all(now - RESTORE_WINDOW_MS) as MailDraftTrashRow[];
    },

    trashedMailDraft(account: MailAccount, draftId: string): MailDraftTrashRow | null {
      const row = db
        .prepare(`SELECT * FROM mail_draft_trash WHERE account = ? AND draft_id = ?`)
        .get(account, draftId) as MailDraftTrashRow | undefined;
      return row ?? null;
    },

    dropTrashedMailDraft(account: MailAccount, draftId: string): void {
      db.prepare(`DELETE FROM mail_draft_trash WHERE account = ? AND draft_id = ?`).run(account, draftId);
    },

    /** Trash rows past the window. Nothing else reads them, so they are dropped. */
    purgeTrashedMailDrafts(now = Date.now()): number {
      const result = db.prepare(`DELETE FROM mail_draft_trash WHERE discarded_at <= ?`).run(now - RESTORE_WINDOW_MS);
      return result.changes;
    },

    /** Record who wrote a Gmail draft, for the origin badge in the panel. */
    /** `authorThreadId` is kept for a worker, so its title can be shown. */
    setMailDraftOrigin(account: MailAccount, draftId: string, origin: DraftOriginValue, authorThreadId: string | null = null): void {
      setDraftOriginStmt.run(account, draftId, origin === "worker" && authorThreadId ? `worker:${authorThreadId}` : origin);
    },

    /**
     * Cached drafts in a thread where the owner has sent something newer than
     * the draft. Those are the ones likely sent or replaced elsewhere.
     */
    overtakenMailDrafts(account: MailAccount): MailDraftRow[] {
      return db
        .prepare(
          `SELECT d.* FROM mail_drafts d WHERE d.account = ? AND d.thread_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM mail_messages m WHERE m.account = d.account AND m.thread_id = d.thread_id
               AND m.from_me = 1 AND ${NOT_DRAFT} AND m.date_ms > d.updated_at)`,
        )
        .all(account) as MailDraftRow[];
    },

    /** Drop cached drafts of one account that Gmail no longer lists. */
    pruneMailDrafts(account: MailAccount, keepDraftIds: string[]): number {
      const keep = new Set(keepDraftIds);
      let removed = 0;
      for (const row of store.mailDraftRows(account)) {
        if (keep.has(row.draft_id)) continue;
        store.deleteMailDraft(account, row.draft_id);
        removed += 1;
      }
      return removed;
    },

    /** Contract DTO for a cached Gmail draft. */
    mailDraftDto(account: MailAccount, draftId: string): Draft | null {
      const row = store.mailDraftRow(account, draftId);
      return row ? mailDraftDto(row) : null;
    },

    /**
     * Remember what a draft said before the chief rewrote it. `ref` is the
     * draft's own id with its channel (`wa:<id>`, `mail:<account>:<id>`). A
     * rewrite on top of an unreviewed one keeps the older "before", so the
     * highlight shows everything changed since the owner last looked.
     */
    recordDraftRevision(ref: string, before: string, after: string): void {
      if (before.trim() === after.trim()) return;
      db.prepare(
        `INSERT INTO draft_revisions (draft_ref, before_text, after_text, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(draft_ref) DO UPDATE SET after_text = excluded.after_text, at = excluded.at`,
      ).run(ref, before, after, Date.now());
    },

    /** The unreviewed change on a draft, or null. Stale when the draft no longer says `after`. */
    draftRevision(ref: string, currentText: string): { before: string; after: string; at: number } | null {
      const row = db.prepare(`SELECT before_text, after_text, at FROM draft_revisions WHERE draft_ref = ?`).get(ref) as
        | { before_text: string; after_text: string; at: number }
        | undefined;
      if (!row || row.after_text.trim() !== currentText.trim()) return null;
      return { before: row.before_text, after: row.after_text, at: row.at };
    },

    clearDraftRevision(ref: string): void {
      db.prepare(`DELETE FROM draft_revisions WHERE draft_ref = ?`).run(ref);
    },

    /**
     * One-to-one contacts with a message either way since `since`, for the
     * voice files. WhatsApp chats by jid; mail by the other side's address,
     * read from his sent mail (To) and their mail to him (From). Groups never.
     */
    activeVoiceContacts(since: number, myAddresses: readonly string[]): { contactId: string; name: string; channel: "mail" | "whatsapp"; lastAt: number }[] {
      const out: { contactId: string; name: string; channel: "mail" | "whatsapp"; lastAt: number }[] = [];
      const chats = db
        .prepare(
          `SELECT c.jid AS jid, COALESCE(c.name, ct.name, ct.notify, c.jid) AS name, MAX(m.timestamp) AS last_at
             FROM wa_messages m JOIN wa_chats c ON c.jid = m.chat_jid LEFT JOIN wa_contacts ct ON ct.jid = c.jid
            WHERE c.is_group = 0 AND m.timestamp >= ?
            GROUP BY c.jid`,
        )
        .all(since) as { jid: string; name: string; last_at: number }[];
      for (const chat of chats) {
        if (chat.jid.endsWith("@g.us") || chat.jid.endsWith("@broadcast") || chat.jid.endsWith("@newsletter")) continue;
        out.push({ contactId: waSenderId(chat.jid), name: chat.name, channel: "whatsapp", lastAt: chat.last_at });
      }
      const mine = new Set(myAddresses.map((a) => a.toLowerCase()));
      const rows = db
        .prepare(
          `SELECT from_header, to_header, from_me, date_ms FROM mail_messages
            WHERE date_ms >= ? AND ${NOT_DRAFT} AND (bulk IS NULL OR bulk = 0)`,
        )
        .all(since) as { from_header: string | null; to_header: string | null; from_me: number; date_ms: number }[];
      // A person counts only if he wrote to them himself in the window: a
      // newsletter or a one-off sender that never got a reply has no voice.
      const wroteTo = new Map<string, { name: string; lastAt: number }>();
      for (const row of rows) {
        if (row.from_me !== 1) continue;
        const recipients = (row.to_header ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");
        // One-to-one only: a message to several people is not a voice sample for any one of them.
        if (recipients.length !== 1) continue;
        const address = addressOf(recipients[0] as string).toLowerCase();
        if (address === "" || mine.has(address)) continue;
        const prev = wroteTo.get(address);
        const name = displayNameOf(recipients[0] as string) || address;
        if (!prev || row.date_ms > prev.lastAt) wroteTo.set(address, { name: prev && prev.name !== address ? prev.name : name, lastAt: row.date_ms });
      }
      for (const [address, info] of wroteTo) out.push({ contactId: `mail:${address}`, name: info.name, channel: "mail", lastAt: info.lastAt });
      return out;
    },

    /** His sent WhatsApp texts to one chat, newest first. */
    sentWaTexts(jid: string, limit: number): { at: number; text: string }[] {
      return (
        db
          .prepare(
            `SELECT timestamp AS at, text FROM wa_messages WHERE chat_jid = ? AND from_me = 1 AND kind = 'text' ORDER BY timestamp DESC LIMIT ?`,
          )
          .all(canonicalJid(jid), limit) as { at: number; text: string }[]
      );
    },

    /** His sent mail to one address alone, newest first, with whatever body is cached. */
    sentMailTo(address: string, since: number, limit: number): { account: string; id: string; at: number; body: string | null }[] {
      const rows = db
        .prepare(
          `SELECT account, id, date_ms AS at, body, to_header FROM mail_messages
            WHERE from_me = 1 AND ${NOT_DRAFT} AND date_ms >= ? AND LOWER(to_header) LIKE ? ESCAPE '\\'
            ORDER BY date_ms DESC LIMIT ?`,
        )
        .all(since, `%${likeEscape(address.toLowerCase())}%`, limit * 3) as { account: string; id: string; at: number; body: string | null; to_header: string | null }[];
      // The LIKE only narrows; the parsed address decides. A substring match
      // gave an@x.invalid the mail sent to dan@x.invalid.
      const want = address.toLowerCase();
      return rows
        .filter((row) => {
          const recipients = (row.to_header ?? "").split(",").filter((p) => p.trim() !== "");
          return recipients.length === 1 && addressOf(recipients[0] as string).toLowerCase() === want;
        })
        .slice(0, limit)
        .map(({ account, id, at, body }) => ({ account, id, at, body }));
    },

    /** Contract DTO for a WhatsApp draft. */
    waDraftDto(id: string): Draft | null {
      const draft = store.draft(id);
      return draft ? withRevision(waDraftDtoFor(draft)) : null;
    },

    // ================= attention =================

    attention(key: string): AttentionRow | null {
      const row = attentionStmt.get(canonicalKey(key)) as AttentionRow | undefined;
      return row ?? null;
    },

    /**
     * Dismiss or un-dismiss a conversation. The stamp is at least one
     * millisecond past the newest message, so a sender whose clock runs ahead
     * of the local clock can still be dismissed. Returns true when something changed.
     */
    setDismissed(key: string, dismissed: boolean): boolean {
      const canonical = canonicalKey(key);
      const before = store.attention(canonical)?.dismissed_at ?? null;
      if (!dismissed) {
        if (before === null) return false;
        dismissStmt.run({ key: canonical, at: null });
        return true;
      }
      const lastAt = lastIncomingOf(canonical) ?? lastAtOf(canonical);
      const at = Math.max(Date.now(), (lastAt ?? 0) + 1);
      if (before !== null && before >= (lastAt ?? 0)) return false;
      dismissStmt.run({ key: canonical, at });
      return true;
    },

    /**
     * Record that the conversation was opened in bb (drives the WhatsApp unread
     * flag). Returns true only when this actually cleared an unread chat, so
     * readers do not publish a change on every open.
     */
    markOpened(key: string, at = Date.now()): boolean {
      const canonical = canonicalKey(key);
      const parsed = parseConversationKey(canonical);
      if (parsed?.channel !== "whatsapp") return false;
      const chat = store.chat(parsed.jid);
      if (!chat || chat.lastMessageAt === null || chat.lastFromMe) return false;
      const openedAt = store.attention(canonical)?.opened_at ?? null;
      if (openedAt !== null && openedAt >= chat.lastMessageAt) return false;
      // Never below the newest message: a phone clock that runs ahead would
      // otherwise keep the chat unread and make every read publish a change.
      openStmt.run({ key: canonical, at: Math.max(at, chat.lastMessageAt) });
      return true;
    },

    // ================= muted senders =================

    /** Handles of every muted sender, for one cheap lookup per list build. */
    mutedIds(): Set<string> {
      const rows = mutedAllStmt.all() as { id: string }[];
      return new Set(rows.map((row) => row.id));
    },

    /**
     * Mute or unmute a sender. `label` and `handle` are only for the list in
     * the panel; the id is what the inbox and the auto-draft check read.
     * Returns true when the state changed.
     */
    setMuted(
      senderId: string,
      muted: boolean,
      meta: { channel: "mail" | "whatsapp"; label: string; handle: string } = { channel: "mail", label: "", handle: "" },
    ): boolean {
      if (senderId === "") return false;
      const known = store.mutedIds().has(senderId);
      if (!muted) {
        if (!known) return false;
        unmuteStmt.run(senderId);
        return true;
      }
      muteStmt.run({
        id: senderId,
        channel: meta.channel,
        label: meta.label || meta.handle || senderId,
        handle: meta.handle || senderId.slice(senderId.indexOf(":") + 1),
        created_at: Date.now(),
      });
      return !known;
    },

    /** The muted list for the panel, newest mute first, with cached conversation counts. */
    mutedSenders(): MutedSender[] {
      const rows = mutedAllStmt.all() as {
        id: string;
        channel: string;
        label: string;
        handle: string;
        created_at: number;
      }[];
      if (rows.length === 0) return [];
      const counts = new Map<string, number>();
      for (const conversation of store.allConversations()) {
        if (!conversation.senderId) continue;
        counts.set(conversation.senderId, (counts.get(conversation.senderId) ?? 0) + 1);
      }
      return rows.map((row) => ({
        id: row.id,
        channel: row.channel === "whatsapp" ? ("whatsapp" as const) : ("mail" as const),
        label: row.label,
        handle: row.handle,
        createdAt: row.created_at,
        conversationCount: counts.get(row.id) ?? 0,
      }));
    },

    // ================= automatic drafting =================

    /**
     * Timestamp of the newest message the chief was already asked about in this
     * chat, or that the owner dismissed or discarded a draft for. 0 when the
     * chat was never handled. Persisted, so a plugin reload cannot make the
     * chief draft the same burst twice.
     */
    autoDraftMark(jid: string): number {
      const row = autoDraftMarkStmt.get(canonicalJid(jid)) as { handled_at: number } | undefined;
      return row?.handled_at ?? 0;
    },

    /** Move the mark forward. It never goes backwards, so a late sync cannot reopen a burst. */
    setAutoDraftMark(jid: string, at: number, askedAt: number | null = null): void {
      if (!Number.isFinite(at) || at <= 0) return;
      setAutoDraftMarkStmt.run({ jid: canonicalJid(jid), at, askedAt });
    },

    /**
     * Chats whose ask is older than `before` and which have nothing to show for
     * it: no pending draft, not dismissed, not muted, and he has not replied
     * himself. Derived from what is on disk rather than from a timer, so a
     * reload or a restart cannot lose an outstanding ask: the mark is durable,
     * so the intention to check it must be too.
     */
    /**
     * One-to-one chats whose newest message came from the other side, after
     * `since`, and is not yet asked about. A deferred ask lives only as an
     * in-memory timer, so a reload inside a hold or a cooldown loses it; this
     * is what finds those again. runAutoDraft still decides each one.
     */
    unaskedWaBursts(since: number): string[] {
      return (
        db
          .prepare(
            `SELECT c.jid AS jid FROM wa_chats c
               LEFT JOIN auto_draft_marks m ON m.jid = c.jid
              WHERE c.is_group = 0 AND c.last_from_me = 0
                AND c.last_message_at IS NOT NULL AND c.last_message_at >= ?
                AND c.last_message_at > COALESCE(m.handled_at, 0)`,
          )
          .all(since) as { jid: string }[]
      ).map((row) => row.jid);
    },

    staleAutoDraftAsks(before: number): { jid: string; handledAt: number; askedAt: number }[] {
      return db
        .prepare(
          `SELECT m.jid AS jid, m.handled_at AS handledAt, m.asked_at AS askedAt
             FROM auto_draft_marks m
             JOIN wa_chats c ON c.jid = m.jid
            WHERE m.asked_at IS NOT NULL
              AND m.asked_at <= ?
              AND c.last_from_me = 0
              AND c.last_message_at IS NOT NULL
              AND c.last_message_at <= m.handled_at
              AND NOT EXISTS (SELECT 1 FROM wa_drafts d WHERE d.chat_jid = m.jid AND d.status = 'pending')
              AND NOT EXISTS (
                SELECT 1 FROM attention a
                 WHERE a.key = 'wa:' || m.jid
                   AND a.dismissed_at IS NOT NULL
                   AND a.dismissed_at >= c.last_message_at
              )
              AND NOT EXISTS (SELECT 1 FROM muted_senders s WHERE s.handle = m.jid)`,
        )
        .all(before) as { jid: string; handledAt: number; askedAt: number }[];
    },

    /** When the chief was last asked about this chat, or null once that has been settled. */
    autoDraftAskedAt(jid: string): number | null {
      const row = db.prepare(`SELECT asked_at FROM auto_draft_marks WHERE jid = ?`).get(canonicalJid(jid)) as
        | { asked_at: number | null }
        | undefined;
      return row?.asked_at ?? null;
    },

    /** Consecutive asks for this chat that produced nothing. */
    autoDraftAttempts(jid: string): number {
      const row = db.prepare(`SELECT attempts FROM auto_draft_marks WHERE jid = ?`).get(canonicalJid(jid)) as
        | { attempts: number | null }
        | undefined;
      return row?.attempts ?? 0;
    },

    setAutoDraftAttempts(jid: string, attempts: number): void {
      db.prepare(`UPDATE auto_draft_marks SET attempts = ? WHERE jid = ?`).run(attempts, canonicalJid(jid));
    },

    /** Forget the ask time once it has been checked, so the sweep does not keep finding it. */
    clearAutoDraftAskTime(jid: string): void {
      db.prepare(`UPDATE auto_draft_marks SET asked_at = NULL WHERE jid = ?`).run(canonicalJid(jid));
    },

    /**
     * Put a chat back to unhandled after an ask that produced nothing, and only
     * while the mark is still the value that ask wrote.
     *
     * This exists because `setAutoDraftMark` cannot do it and must not learn
     * how. That setter refuses a rollback twice over: `at <= 0` returns before
     * any SQL, and the upsert takes `MAX(existing, new)` so even a lower
     * positive value is swallowed. Both are deliberate, because a mark that can
     * go backwards would re-ask for messages the owner has already dealt with.
     * So a rollback through that setter would compile, run and do nothing,
     * leaving the burst marked handled; tests of a rollback must hold the mark
     * in this store, not in a local object.
     */
    rollbackAutoDraftMark(jid: string, expected: number): void {
      clearAutoDraftMarkStmt.run({ jid: canonicalJid(jid), at: expected });
    },

    // ================= unified conversations =================

    /**
     * Take a Gmail draft for sending through Superhuman, before anything else
     * happens. One statement, so two clicks cannot both pass: the insert only
     * lands when no row for this draft is sending, uncertain or sent. Returns
     * the row id, or the row that is in the way.
     */
    claimSuperhumanSend(entry: {
      account: MailAccount;
      gmailDraftId: string;
      threadId: string | null;
      to: string | null;
      subject: string | null;
      actor: string;
    }): { id: number } | { blocked: SuperhumanSendRow } {
      const info = db
        .prepare(
          `INSERT INTO superhuman_sends (account, gmail_draft_id, sh_draft_id, thread_id, to_header, subject, actor, status, created_at)
           SELECT ?, ?, '', ?, ?, ?, ?, 'sending', ?
           WHERE NOT EXISTS (SELECT 1 FROM superhuman_sends WHERE account = ? AND gmail_draft_id = ? AND status IN ('sending', 'uncertain', 'sent'))`,
        )
        .run(entry.account, entry.gmailDraftId, entry.threadId, entry.to, entry.subject, entry.actor, Date.now(), entry.account, entry.gmailDraftId);
      if (Number(info.changes) === 1) return { id: Number(info.lastInsertRowid) };
      const blocked = db
        .prepare(`SELECT * FROM superhuman_sends WHERE account = ? AND gmail_draft_id = ? AND status IN ('sending', 'uncertain', 'sent') ORDER BY id DESC LIMIT 1`)
        .get(entry.account, entry.gmailDraftId) as SuperhumanSendRow;
      return { blocked };
    },

    /** Correct the claim row from the fresh draft; `threadId` null means "look it up after the send". */
    setSuperhumanSendDetails(id: number, details: { threadId: string | null; to: string | null; subject: string | null }): void {
      db.prepare(`UPDATE superhuman_sends SET thread_id = ?, to_header = ?, subject = ? WHERE id = ?`).run(
        details.threadId,
        details.to,
        details.subject,
        id,
      );
    },

    /** The row that means this Gmail draft must not be sent again, from any path. */
    superhumanBlockFor(account: MailAccount, gmailDraftId: string): SuperhumanSendRow | null {
      return (
        (db
          .prepare(
            `SELECT * FROM superhuman_sends WHERE account = ? AND gmail_draft_id = ? AND status IN ('sending', 'uncertain', 'sent') ORDER BY id DESC LIMIT 1`,
          )
          .get(account, gmailDraftId) as SuperhumanSendRow | undefined) ?? null
      );
    },

    setSuperhumanDraftId(id: number, shDraftId: string): void {
      db.prepare(`UPDATE superhuman_sends SET sh_draft_id = ? WHERE id = ?`).run(shDraftId, id);
    },

    /** Rows that never settled: a crash mid-send, or an answer we could not read. */
    unsettledSuperhumanSends(olderThan: number): SuperhumanSendRow[] {
      return db
        .prepare(`SELECT * FROM superhuman_sends WHERE status IN ('sending', 'uncertain') AND created_at < ? ORDER BY id ASC`)
        .all(olderThan) as SuperhumanSendRow[];
    },

    superhumanSendRow(id: number): SuperhumanSendRow | null {
      return (db.prepare(`SELECT * FROM superhuman_sends WHERE id = ?`).get(id) as SuperhumanSendRow | undefined) ?? null;
    },

    /** Settle a send row. A thread id is only ever filled in, never cleared. */
    finishSuperhumanSend(id: number, update: { status: "sent" | "uncertain" | "failed"; messageId?: string | null; threadId?: string | null; error?: string | null }): void {
      db.prepare(
        `UPDATE superhuman_sends SET status = ?, sh_message_id = COALESCE(?, sh_message_id), thread_id = COALESCE(thread_id, ?),
           error = ?, sent_at = CASE WHEN ? = 'failed' THEN sent_at ELSE COALESCE(sent_at, ?) END WHERE id = ?`,
      ).run(update.status, update.messageId ?? null, update.threadId ?? null, update.error ?? null, update.status, Date.now(), id);
    },

    /** Superhuman's undo handle for a send, and the copy a cancel writes back. */
    setSuperhumanUndo(id: number, undo: { token: string | null; until: number; copy: UndoCopy }): void {
      db.prepare(`UPDATE superhuman_sends SET undo_token = ?, undo_until = ?, undo_copy = ? WHERE id = ?`).run(
        undo.token,
        undo.until,
        JSON.stringify(undo.copy),
        id,
      );
    },

    /** Sends whose undo window is still open, newest first. */
    undoableSuperhumanSends(now: number): SuperhumanSendRow[] {
      return db
        .prepare(`SELECT * FROM superhuman_sends WHERE status = 'sent' AND undo_until IS NOT NULL AND undo_until > ? ORDER BY sent_at DESC`)
        .all(now) as SuperhumanSendRow[];
    },

    /** The window has closed for good (Superhuman said it went): Undo is not offered again. */
    clearSuperhumanUndo(id: number): void {
      db.prepare(`UPDATE superhuman_sends SET undo_until = NULL, undo_token = NULL WHERE id = ?`).run(id);
    },

    /**
     * A confirmed cancel. Only a row still `sent` moves, in one statement, so
     * two Undo clicks cannot both write the draft back. True when it moved.
     */
    markSuperhumanSendCancelled(id: number): boolean {
      const info = db
        .prepare(`UPDATE superhuman_sends SET status = 'cancelled', undo_until = NULL, undo_token = NULL WHERE id = ? AND status = 'sent'`)
        .run(id);
      return Number(info.changes) === 1;
    },

    markSuperhumanGmailDraftDeleted(id: number): void {
      db.prepare(`UPDATE superhuman_sends SET gmail_draft_deleted = 1 WHERE id = ?`).run(id);
    },

    setSuperhumanSendThread(id: number, threadId: string): void {
      db.prepare(`UPDATE superhuman_sends SET thread_id = ? WHERE id = ? AND thread_id IS NULL`).run(threadId, id);
    },

    /**
     * Store each open as its own row. Idempotent: the feed hands back the same
     * events on every read, and the primary key drops the repeats. Returns how
     * many were new.
     */
    recordSuperhumanOpens(sendId: number, opens: readonly { recipient: string | null; at: number; device: string | null }[]): number {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO superhuman_opens (send_id, recipient, opened_at, device) VALUES (?, ?, ?, ?)`,
      );
      let added = 0;
      for (const open of opens) {
        added += Number(insert.run(sendId, open.recipient ?? "", open.at, open.device).changes);
      }
      return added;
    },

    /** Every recorded open of one send, oldest first. */
    superhumanOpens(sendId: number): { recipient: string | null; openedAt: number; device: string | null }[] {
      const rows = db
        .prepare(`SELECT recipient, opened_at, device FROM superhuman_opens WHERE send_id = ? ORDER BY opened_at ASC`)
        .all(sendId) as { recipient: string; opened_at: number; device: string | null }[];
      return rows.map((row) => ({ recipient: row.recipient === "" ? null : row.recipient, openedAt: row.opened_at, device: row.device }));
    },

    /** Opens only ever grow: a feed page that misses an event must not lower a count already shown. */
    recordSuperhumanReads(id: number, tally: { opens: number; readers: string[]; firstAt: number | null; lastAt: number | null }): void {
      const row = db.prepare(`SELECT opens, readers FROM superhuman_sends WHERE id = ?`).get(id) as { opens: number; readers: string | null } | undefined;
      if (!row || tally.opens <= row.opens) return;
      const readers = [...new Set([...(row.readers ? (JSON.parse(row.readers) as string[]) : []), ...tally.readers])].sort();
      db.prepare(
        `UPDATE superhuman_sends SET opens = ?, readers = ?, first_read_at = COALESCE(MIN(first_read_at, ?), ?, first_read_at),
           last_read_at = MAX(COALESCE(last_read_at, 0), COALESCE(?, 0)) WHERE id = ?`,
      ).run(tally.opens, JSON.stringify(readers), tally.firstAt, tally.firstAt, tally.lastAt, id);
    },

    /** Sent rows still inside the read watch, oldest first. */
    superhumanSendsSince(since: number): SuperhumanSendRow[] {
      return db
        .prepare(`SELECT * FROM superhuman_sends WHERE status IN ('sent', 'uncertain') AND sent_at >= ? ORDER BY sent_at ASC`)
        .all(since) as SuperhumanSendRow[];
    },

    /** Sent rows whose Gmail draft could not be deleted yet. */
    superhumanUndeletedDrafts(): SuperhumanSendRow[] {
      return db
        .prepare(`SELECT * FROM superhuman_sends WHERE status = 'sent' AND gmail_draft_deleted = 0 ORDER BY id ASC`)
        .all() as SuperhumanSendRow[];
    },

    /** The newest Superhuman send in a thread, for the read status line. */
    latestSuperhumanSend(account: MailAccount, threadId: string): SuperhumanSendRow | null {
      const row = db
        .prepare(`SELECT * FROM superhuman_sends WHERE account = ? AND thread_id = ? AND status IN ('sent', 'uncertain') ORDER BY sent_at DESC LIMIT 1`)
        .get(account, threadId) as SuperhumanSendRow | undefined;
      return row ?? null;
    },

    superhumanSends(limit = 50): SuperhumanSendRow[] {
      return db.prepare(`SELECT * FROM superhuman_sends ORDER BY id DESC LIMIT ?`).all(limit) as SuperhumanSendRow[];
    },

    /** Every cached mail conversation: threads plus drafts with no cached thread. */
    mailConversations(): Conversation[] {
      const threadRows = db.prepare(`SELECT * FROM mail_threads`).all() as MailThreadRow[];
      const muted = store.mutedIds();
      const readCutoff = Date.now() - MAIL_NEEDS_REPLY_MAX_AGE_MS;
      const draftRows = store.mailDraftRows();
      const cachedThreads = new Set(threadRows.map((row) => `${row.account} ${row.thread_id}`));
      // Newest draft per cached thread; every other draft becomes its own row.
      const byThread = new Map<string, MailDraftRow>();
      const loose = new Map<string, MailDraftRow>();
      for (const row of draftRows) {
        const composite = `${row.account} ${row.thread_id}`;
        if (row.thread_id && cachedThreads.has(composite)) {
          const seen = byThread.get(composite);
          if (!seen || row.updated_at > seen.updated_at) byThread.set(composite, row);
          continue;
        }
        // A draft that carries a Gmail thread id keeps the thread key even when
        // the thread is not cached, so tools, CLI and the inbox agree on it.
        const account = accountOf(row.account);
        const key = row.thread_id ? mailThreadKey(account, row.thread_id) : mailDraftKey(account, row.draft_id);
        const seen = loose.get(key);
        if (!seen || row.updated_at > seen.updated_at) loose.set(key, row);
      }

      const out: Conversation[] = [];
      for (const row of threadRows) {
        const account = accountOf(row.account);
        const key = mailThreadKey(account, row.thread_id);
        const draftRow = byThread.get(`${row.account} ${row.thread_id}`) ?? null;
        const draft = draftRow ? mailDraftDto(draftRow) : null;
        const facts = threadFactsStmt.get({ account: row.account, thread_id: row.thread_id }) as {
          n: number;
          other_from: string | null;
          last_to: string | null;
        };
        // The other side is a person where there is one, so a Superhuman
        // reminder or a calendar robot writing into the thread does not make
        // the row read "Reminder" instead of the client it is about.
        const otherFroms = (otherFromsStmt.all({ account: row.account, thread_id: row.thread_id }) as { from_header: string | null }[])
          .map((r) => r.from_header)
          .filter((h): h is string => h !== null && h.trim() !== "");
        const human = otherFroms.find((h) => !isAutomatedMail(h, null) && !isSuperhumanReminder(h));
        if (human !== undefined) facts.other_from = human;
        else if (otherFroms.length > 0 && otherFroms.every((h) => isAutomatedMail(h, null) || isSuperhumanReminder(h))) {
          // Only robots wrote back, so the other side is whoever the owner wrote to.
          const mine = myLastToStmt.get({ account: row.account, thread_id: row.thread_id }) as { to_header: string | null } | undefined;
          if (mine?.to_header) facts.other_from = mine.to_header;
        }
        const lastFromMe = row.last_from_me === 1;
        const lastIncoming = (lastIncomingMailStmt.get({ account: row.account, thread_id: row.thread_id }) as { at: number | null }).at;
        const dismissed = isDismissed(store.attention(key)?.dismissed_at ?? null, lastIncoming);
        const unread = row.unread === 1;
        const newest = newestMessageStmt.get({ account: row.account, thread_id: row.thread_id }) as
          | { from_header: string | null; to_header: string | null; cc_header: string | null; subject: string | null; labels: string | null; bulk: number }
          | undefined;
        // A thread he answers elsewhere or never stays in the list and in
        // search, and only leaves the Needs reply count. Not on any send path.
        const quietRuleSet = lastFromMe ? null : (options.quietRules?.(account) ?? null);
        const quiet =
          quietRuleSet === null
            ? null
            : quietReason(
                { from: newest?.from_header ?? row.last_from, to: newest?.to_header ?? null, cc: newest?.cc_header ?? null, subject: newest?.subject ?? row.subject },
                quietRuleSet,
              );
        // Superhuman's AI writes its verdicts into Gmail as ordinary labels;
        // when present they beat the local heuristics.
        const roles = options.labelRoles?.(account) ?? null;
        // Superhuman puts its labels on whichever message it classified, not
        // necessarily the newest one, so match across the whole cached thread.
        const threadLabels =
          roles === null
            ? []
            : (threadLabelsStmt.all({ account: row.account, thread_id: row.thread_id }) as { labels: string | null }[]).flatMap(
                (r) => parseLabels(r.labels),
              );
        const hasRespond = roles !== null && !lastFromMe && threadLabels.some((label) => roles.respond.has(label));
        const waiting = lastFromMe && roles !== null && threadLabels.some((label) => roles.waiting.has(label));
        const shAutomated = roles !== null && threadLabels.some((label) => roles.automated.has(label));
        // A bulk mailing (List-Unsubscribe or a bulk Precedence) never needs a
        // reply, even when it comes from a person's own address.
        const automated =
          shAutomated ||
          newest?.bulk === 1 ||
          isAutomatedMail(newest?.from_header ?? row.last_from, newest?.labels ?? null);
        // Mute follows the other side of the thread, whoever wrote last.
        const senderId = mailSenderId(facts.other_from ?? (lastFromMe ? facts.last_to : row.last_from)) || null;
        const isMuted = senderId !== null && muted.has(senderId);
        const counterpart = lastFromMe
          ? displayNameOf(facts.last_to) || displayNameOf(facts.other_from)
          : displayNameOf(facts.other_from ?? row.last_from);
        const wouldNeedReply =
          !lastFromMe &&
          row.last_at !== null &&
          !dismissed &&
          !isMuted &&
          (hasRespond || (!automated && (unread || row.last_at > readCutoff)));
        out.push({
          key,
          channel: "mail",
          account,
          title: row.subject && row.subject.trim() !== "" ? row.subject : "(no subject)",
          counterpart,
          preview: shorten(row.preview),
          lastAt: row.last_at,
          lastFromMe,
          unread,
          waiting,
          // Superhuman's Respond verdict wins. Otherwise inbound mail that does
          // not look automated counts while it is unread, and for a week after
          // it was read: reading a mail is not answering it.
          needsReply: wouldNeedReply && quiet === null,
          // Only a thread that would otherwise need a reply is marked quiet.
          quiet: wouldNeedReply ? quiet : null,
          // The thread is cached, so this is a live conversation: a draft on it
          // is ready to send, whatever its age or dismissal. Unless the owner
          // has already sent a reply newer than the draft, from Gmail or
          // Superhuman: then it is a leftover, so a sent draft does not stay
          // listed as ready.
          readyToSend: draft !== null && !(draftRow !== null && overtakenStmt.get({ account: row.account, thread_id: row.thread_id, at: draftRow.updated_at }) !== undefined),
          stale: false,
          isGroup: false,
          dismissed,
          senderId,
          muted: isMuted,
          draft,
          links: mailLinks(emailOf(account), row.thread_id),
          messageCount: Math.max(facts.n, row.message_count),
          reminder: !lastFromMe && isSuperhumanReminder(newest?.from_header ?? row.last_from),
          opened: ((openedStmt.get(row.account, row.thread_id) as { opens: number } | undefined)?.opens ?? 0) > 0,
        });
      }

      const draftCutoff = Date.now() - MAIL_DRAFT_MAX_AGE_MS;
      for (const [key, row] of loose) {
        const account = accountOf(row.account);
        // No conversation behind it: recent drafts are still actionable, old
        // ones are leftovers that only clutter the counts.
        const fresh = row.updated_at > draftCutoff;
        out.push({
          key,
          channel: "mail",
          account,
          title: row.subject && row.subject.trim() !== "" ? row.subject : "(no subject)",
          counterpart: displayNameOf(row.to_header),
          preview: shorten(row.body),
          lastAt: row.updated_at,
          lastFromMe: true,
          unread: false,
          waiting: false,
          needsReply: false,
          readyToSend: fresh,
          stale: !fresh,
          isGroup: false,
          dismissed: isDismissed(store.attention(key)?.dismissed_at ?? null, null),
          senderId: mailSenderId(row.to_header) || null,
          muted: muted.has(mailSenderId(row.to_header)),
          draft: mailDraftDto(row),
          links: mailLinks(emailOf(account), row.thread_id, true),
          messageCount: 0,
        });
      }
      return out;
    },

    waConversations(): Conversation[] {
      const rows = db
        .prepare(
          `${CHAT_SELECT} WHERE c.last_message_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM wa_drafts d WHERE d.chat_jid = c.jid AND d.status = 'pending')`,
        )
        .all() as ChatRow[];
      const muted = store.mutedIds();
      return rows.map((row) => {
        const chat = toChat(row);
        const key = waKey(chat.jid);
        const draft = chat.pendingDrafts > 0 ? store.pendingDraftFor(chat.jid) : null;
        const attention = store.attention(key);
        const lastIncoming = (lastIncomingWaStmt.get(chat.jid) as { at: number | null }).at;
        const dismissed = isDismissed(attention?.dismissed_at ?? null, lastIncoming);
        const openedAt = attention?.opened_at ?? null;
        const unread =
          !chat.lastFromMe && chat.lastMessageAt !== null && (openedAt === null || openedAt < chat.lastMessageAt);
        // A chat nobody touched for a week is stale, not waiting: it stays under "All".
        const recent = chat.lastMessageAt !== null && chat.lastMessageAt > Date.now() - WA_NEEDS_REPLY_MAX_AGE_MS;
        const senderId = waSenderId(chat.jid);
        const isMuted = muted.has(senderId);
        const base = !chat.lastFromMe && recent && !dismissed && !isMuted;
        const messageCount = (waMessageCountStmt.get(chat.jid) as { n: number }).n;
        return {
          key,
          channel: "whatsapp" as const,
          account: null,
          title: chat.name,
          counterpart: chat.isGroup ? "group" : (chat.phone ?? (chat.jid.endsWith("@lid") ? "" : chat.jid)),
          preview: shorten(chat.lastMessageText),
          lastAt: chat.lastMessageAt,
          lastFromMe: chat.lastFromMe,
          unread,
          waiting: false,
          // Groups are noise unless the chief already prepared something.
          needsReply: chat.isGroup ? base && draft !== null : base,
          // A draft waiting for approval is always actionable: neither a
          // dismissal nor the seven-day age limit may hide it. Unless the owner
          // has written in the chat since it was saved, from any device or
          // anywhere else: then it was overtaken, as a mail draft is by a later
          // sent reply: otherwise a chat shows an older draft as ready to send
          // after his own later reply.
          readyToSend: draft !== null && !waDraftOvertaken(draft.updatedAt, (lastOutgoingWaStmt.get(chat.jid) as { at: number | null }).at),
          stale: false,
          isGroup: chat.isGroup,
          dismissed,
          senderId,
          muted: isMuted,
          draft: draft ? withRevision(waDraftDtoFor(draft)) : null,
          links: null,
          messageCount,
        };
      });
    },

    allConversations(): Conversation[] {
      return [...store.mailConversations(), ...store.waConversations()];
    },

    conversations(query: ConversationQuery = {}): Conversation[] {
      return store.conversationsPage(query).conversations;
    },

    /** Like conversations(), but also reports how many matched before the limit cut the list. */
    conversationsPage(query: ConversationQuery = {}): { conversations: Conversation[]; total: number } {
      const filter: InboxFilter = query.filter ?? "needs-reply";
      const channels = query.channels && query.channels.length > 0 ? new Set(query.channels) : null;
      const needle = query.query?.trim().toLowerCase() ?? "";
      const limit = query.limit ?? 300;
      const matches = store.allConversations().filter((c) => {
        if (channels && !channels.has(channelKeyOf(c.channel, c.account))) return false;
        // Quiet rows are listed under the needs-reply filter in their
        // own group, outside every count, so leaving the count hides nothing.
        if (filter === "needs-reply" && !c.needsReply && !c.quiet) return false;
        if (filter === "ready" && (!c.readyToSend || c.stale)) return false;
        if (filter === "waiting" && !isWaiting(c, Date.now())) return false;
        if (needle !== "") {
          const hay = `${c.title}\n${c.counterpart}\n${c.preview}`.toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        return true;
      });
      // Ready drafts read newest draft first; everywhere else leftovers sink.
      if (filter === "ready") matches.sort((a, b) => draftAt(b) - draftAt(a));
      else matches.sort((a, b) => Number(a.stale) - Number(b.stale) || sortAt(b) - sortAt(a));
      return { conversations: matches.slice(0, limit), total: matches.length };
    },

    conversation(key: string): Conversation | null {
      const canonical = canonicalKey(key);
      return store.allConversations().find((c) => c.key === canonical) ?? null;
    },

    counts(): {
      needsReply: number;
      needsReplyOnly: number;
      ready: number;
      staleDrafts: number;
      discarded: number;
      waiting: number;
      byChannel: Record<ChannelKey, { needsReply: number; ready: number; total: number }>;
    } {
      const byChannel: Record<ChannelKey, { needsReply: number; ready: number; total: number }> = {
        "mail:work": { needsReply: 0, ready: 0, total: 0 },
        "mail:personal": { needsReply: 0, ready: 0, total: 0 },
        whatsapp: { needsReply: 0, ready: 0, total: 0 },
      };
      let needsReply = 0;
      let needsReplyOnly = 0;
      let ready = 0;
      let staleDrafts = 0;
      let waiting = 0;
      const now = Date.now();
      for (const c of store.allConversations()) {
        if (isWaiting(c, now)) waiting += 1;
        const bucket = byChannel[channelKeyOf(c.channel, c.account)];
        bucket.total += 1;
        // Leftover Gmail drafts stay out of the actionable numbers.
        if (c.stale) {
          staleDrafts += 1;
          continue;
        }
        if (c.needsReply) {
          bucket.needsReply += 1;
          needsReply += 1;
          // The list shows a conversation with a draft ready under "Ready to
          // send" only, so the "to reply" count leaves those out too.
          if (!c.readyToSend) needsReplyOnly += 1;
        }
        if (c.readyToSend) {
          bucket.ready += 1;
          ready += 1;
        }
      }
      return { needsReply, needsReplyOnly, ready, staleDrafts, discarded: store.trashedMailDrafts().length, waiting, byChannel };
    },

    /** Messages of any conversation, oldest first. */
    messagesFor(key: string, limit = 60): Message[] {
      const parsed = parseConversationKey(key);
      if (!parsed) return [];
      if (parsed.channel === "whatsapp") {
        const chat = store.chat(parsed.jid);
        // In a direct chat the other side is the chat itself; LID jids carry no readable id.
        const fallback = chat && !chat.isGroup ? chat.name : null;
        return store.messages(parsed.jid, limit).map((m) => ({
          id: m.id,
          at: m.timestamp,
          fromMe: m.fromMe,
          sender: m.fromMe
            ? "You"
            : (m.senderName ?? (m.senderJid ? contactNameOf(m.senderJid) : null) ?? fallback ?? m.senderJid ?? "unknown"),
          text: m.text,
          kind: m.kind,
          to: null,
          cc: null,
          mediaPath: m.mediaPath ?? null,
          mediaMime: m.mediaMime ?? null,
          fileName: m.fileName ?? null,
        }));
      }
      if (!parsed.threadId) return [];
      // The unsent draft is shown in the reply dock, not as a message bubble.
      return store.mailMessageRowsSent(parsed.account, parsed.threadId).map((row) => ({
        id: row.id,
        at: row.date_ms ?? 0,
        fromMe: row.from_me === 1,
        sender: row.from_header ?? "",
        text: row.body ?? "",
        kind: "mail",
        to: row.to_header,
        cc: row.cc_header,
        mediaPath: null,
        mediaMime: null,
        fileName: null,
      }));
    },

    // ================= activity =================

    /**
     * True when the write happened, false when the database was already closed.
     *
     * The host closes this database when the plugin reloads or shuts down,
     * and a timer armed before that can still fire afterwards. Writing then
     * throws inside a bare timer callback with no caller to catch it, which
     * ends the host process and every other plugin in it. Losing an activity
     * row during shutdown costs nothing.
     */
    logActivity(kind: ActivityKind, text: string, ref: string | null = null, actor: string | null = null): boolean {
      if (!dbIsOpen()) return false;
      insertActivityStmt.run(Date.now(), kind, text.slice(0, 2000), ref, actor);
      // Keep the log bounded.
      db.prepare(`DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 2000)`).run();
      return true;
    },

    activity(limit = 100): Activity[] {
      const rows = db.prepare(`SELECT * FROM activity ORDER BY id DESC LIMIT ?`).all(limit) as ActivityRow[];
      return rows.map((row) => ({ id: row.id, at: row.at, kind: row.kind, text: row.text, ref: row.ref, actor: row.actor ?? null }));
    },

    /** Forget every WhatsApp row (used on logout). Drafts and activity are kept. */
    clearWhatsApp(): void {
      db.exec(
        `DELETE FROM wa_messages; DELETE FROM wa_chats; DELETE FROM wa_contacts; DELETE FROM wa_jid_alias; DELETE FROM attention WHERE key LIKE 'wa:%';`,
      );
    },
  };

  return store;
}

/** Did the owner write in the chat after this draft was last saved? */
export function waDraftOvertaken(draftUpdatedAt: number, lastOutgoingAt: number | null): boolean {
  return lastOutgoingAt !== null && lastOutgoingAt > draftUpdatedAt;
}

function waDraftDto(draft: WaDraft, origin: DraftOriginValue): Draft {
  return {
    id: draft.id,
    channel: "whatsapp",
    account: null,
    text: draft.text,
    /** WhatsApp replies never quote. */
    quoted: null,
    to: null,
    cc: null,
    subject: null,
    updatedAt: draft.updatedAt,
    links: null,
    // Drafts written by a thread carry that thread id; the panel and his own
    // terminal pass null because then it is the owner typing.
    origin,
    error: draft.error,
  };
}

function sortAt(conversation: Conversation): number {
  return conversation.lastAt ?? conversation.draft?.updatedAt ?? 0;
}

/** Sort key for the "ready" filter: when the draft was last written. */
function draftAt(conversation: Conversation): number {
  return conversation.draft?.updatedAt ?? conversation.lastAt ?? 0;
}

export type Store = ReturnType<typeof createStore>;
