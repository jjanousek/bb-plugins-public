// Sending a comms draft through Superhuman, so the message carries Superhuman's
// read status. Pure helpers only; the send itself is `sendMailDraft` in
// server.ts, and this file never talks to the network.
//
// The shape: the draft is written, reviewed, discarded and restored in Gmail
// exactly as before. Only at the moment the owner presses Send is its text
// handed to Superhuman, which writes its own draft and sends that. The Gmail
// draft is deleted after the send succeeds.
//
// Against this API an empty answer is the dangerous one, because for every
// question asked of it (who opened it, which thread is it) empty is also a
// legitimate answer. So the reducers below throw on a field they do not
// recognise rather than returning nothing.

import { asArray, pickOptional, toIsoString, valueToString } from "./superhuman.ts";

/** Every bare address in a header, lowercased. "A <a@x.y>, b@x.y" -> ["a@x.y", "b@x.y"]. */
export function addressesIn(header: string | readonly string[] | null | undefined): string[] {
  const text = Array.isArray(header) ? header.join(", ") : ((header as string | null | undefined) ?? "");
  return text.match(/[^\s<>,;"']+@[^\s<>,;"']+/g)?.map((m) => m.toLowerCase()) ?? [];
}

/**
 * Compare who the Gmail draft was addressed to with who the Superhuman draft
 * ended up addressed to, field by field.
 *
 * On a reply, Superhuman merges the `to`
 * we pass with the thread's existing participants, so its draft can carry an
 * address the owner never saw in the one he approved. Pooling To, Cc and Bcc
 * into one set would let an approved Cc that Superhuman ALSO put in To look
 * identical and pass. So each field is
 * compared on its own, and an address listed twice across fields is a
 * difference too. The owner's own addresses are ignored, because the merge
 * adds his own alias and that reaches nobody new. Case never matters.
 */
export interface RecipientFields {
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
}

export function recipientMismatch(
  approved: RecipientFields,
  actual: RecipientFields,
  own: readonly string[],
): { problems: string[] } {
  const mine = new Set(own.map((address) => address.toLowerCase()));
  const clean = (list: readonly string[]) => [...new Set(list.map((a) => a.toLowerCase()).filter((a) => !mine.has(a)))].sort();
  const problems: string[] = [];
  for (const field of ["to", "cc", "bcc"] as const) {
    const want = clean(approved[field]);
    const have = clean(actual[field]);
    const extra = have.filter((a) => !want.includes(a));
    const missing = want.filter((a) => !have.includes(a));
    const label = field === "to" ? "To" : field === "cc" ? "Cc" : "Bcc";
    if (extra.length > 0) problems.push(`${label} would also have ${extra.join(", ")}`);
    if (missing.length > 0) problems.push(`${label} would be missing ${missing.join(", ")}`);
  }
  const seen = new Map<string, string[]>();
  for (const field of ["to", "cc", "bcc"] as const) {
    for (const address of clean(actual[field])) seen.set(address, [...(seen.get(address) ?? []), field]);
  }
  for (const [address, fields] of seen) {
    if (fields.length > 1) problems.push(`${address} would be in ${fields.join(" and ")} at once`);
  }
  return { problems };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The body Superhuman is given. Superhuman takes HTML only and comms drafts
 * are plain text, so this is one paragraph per blank-line block with line
 * breaks kept, and nothing else.
 */
export function htmlFromText(text: string): string {
  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter((block) => block !== "");
  if (blocks.length === 0) return "<p></p>";
  return blocks.map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`).join("\n");
}

/**
 * A thread id we can key on, or null.
 *
 * `send_draft` hands back a `draft...` id for a message that starts a new
 * thread, and every thread-keyed call then matches
 * nothing without erroring. So that id is treated as no id at all, and the
 * real one is looked up later.
 */
export function resolvedThreadId(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return value.startsWith("draft") ? null : value;
}

/** One read event as the live feed returns it. */
export interface ReadEvent {
  threadId: string;
  messageId: string | null;
  recipient: string | null;
  at: number;
  /** The client the event came from, kept as the server says it. */
  device: string | null;
}

/**
 * Read one feed event. The real shape is
 * `thread_id, message_id, subject, recipient { email }, occurred_at, device`.
 * A missing thread or time throws: an event we cannot place or date would
 * otherwise count as nothing, which looks exactly like an unread message.
 */
export function readEvent(entry: unknown): ReadEvent {
  const thread = pickOptional(entry, "thread_id", "threadId");
  const at = pickOptional(entry, "occurred_at", "occurredAt");
  if (thread === null || at === null) {
    const keys = entry !== null && typeof entry === "object" ? Object.keys(entry as object).join(", ") : typeof entry;
    throw new Error(`Superhuman returned a read event without thread_id or occurred_at. Fields present: ${keys}.`);
  }
  const recipient = pickOptional(entry, "recipient");
  const email = recipient === null ? null : pickOptional(recipient, "email");
  const message = pickOptional(entry, "message_id", "messageId");
  const device = pickOptional(entry, "device");
  return {
    device: device === null ? null : valueToString(device),
    threadId: valueToString(thread),
    messageId: message === null ? null : valueToString(message),
    recipient: email === null ? (recipient === null ? null : valueToString(recipient).toLowerCase()) : valueToString(email).toLowerCase(),
    at: Date.parse(toIsoString(at, "a read time")),
  };
}

/** The feed page: events plus the cursor for the next one. */
export function readFeedPage(json: unknown): { events: ReadEvent[]; nextCursor: string | null } {
  const list = Array.isArray(json) ? json : pickOptional(json, "events", "reads", "items", "results");
  if (list === null) {
    const keys = json !== null && typeof json === "object" ? Object.keys(json as object).join(", ") : typeof json;
    throw new Error(`Superhuman's read feed came back without an event list. Fields present: ${keys}.`);
  }
  const cursor = Array.isArray(json) ? null : pickOptional(json, "next_cursor", "nextCursor");
  return { events: asArray(list).map(readEvent), nextCursor: cursor === null ? null : valueToString(cursor) };
}

/** What we know about who opened one sent message. */
export interface ReadTally {
  /** The matched events themselves, so each open can be stored with its time. */
  events: ReadEvent[];
  opens: number;
  readers: string[];
  firstAt: number | null;
  lastAt: number | null;
}

/**
 * The opens that belong to one message we sent.
 *
 * Events are per recipient and a repeat open is its own event, so `opens`
 * counts opens and `readers` counts people; the panel shows people. When an
 * event carries our message id, only those count. Otherwise every open in the
 * thread since we sent it counts, which over-counts only if the owner also
 * sent a later message in the same thread from the Superhuman app.
 */
export function tallyFor(
  events: readonly ReadEvent[],
  sent: { threadId: string; messageId: string | null; sentAt: number },
): ReadTally {
  const inThread = events.filter((event) => event.threadId === sent.threadId);
  const byMessage = sent.messageId === null ? [] : inThread.filter((event) => event.messageId === sent.messageId);
  const mine = byMessage.length > 0 ? byMessage : inThread.filter((event) => event.at >= sent.sentAt);
  const times = mine.map((event) => event.at).sort((a, b) => a - b);
  const readers = [...new Set(mine.map((event) => event.recipient).filter((r): r is string => r !== null))].sort();
  return {
    events: [...mine].sort((a, b) => a.at - b.at),
    opens: mine.length,
    readers,
    firstAt: times.length === 0 ? null : (times[0] as number),
    lastAt: times.length === 0 ? null : (times[times.length - 1] as number),
  };
}

/** How long a sent message is watched for opens. The feed itself scans 14 days of sent mail. */
export const READ_WATCH_MS = 14 * 24 * 60 * 60 * 1000;

/** The feed counts as current for this long after its last good read. */
export const FEED_FRESH_MS = 30 * 60 * 1000;

export type ReadState = "opened" | "not-opened" | "unknown" | "pending";

/**
 * The read status line for one sent message.
 *
 * "Not opened" and "we could not check" must never render alike: a status
 * that quietly stopped updating on a thread would read as "they have not seen
 * it", and the next thing done about that is writing to somebody who already
 * answered. So "not opened" is
 * only said while the feed has been read successfully since the send and
 * recently, and every other case says what is missing.
 */
export function readStatusText(
  sent: { sentAt: number; threadId: string | null; opens: number; readers: string[]; firstReadAt: number | null; lastReadAt: number | null },
  feed: { lastOkAt: number | null; lastError: string | null },
  now: number,
): { state: ReadState; text: string } {
  if (sent.opens > 0) {
    const who = sent.readers.length === 0 ? "" : ` by ${sent.readers.join(", ")}`;
    const times = sent.opens === 1 ? "once" : `${sent.opens} times`;
    return { state: "opened", text: `Opened ${times}${who}, first ${fmt(sent.firstReadAt)}, last ${fmt(sent.lastReadAt)}.` };
  }
  if (sent.threadId === null) {
    return { state: "pending", text: "Sent through Superhuman. Read status starts once Superhuman has indexed the message, usually within a few minutes." };
  }
  const fresh = feed.lastOkAt !== null && feed.lastOkAt >= sent.sentAt && now - feed.lastOkAt <= FEED_FRESH_MS;
  if (!fresh) {
    const why = feed.lastError === null ? "it has not been read since this was sent" : `the last read failed: ${feed.lastError}`;
    return { state: "unknown", text: `Read status unknown: ${why}.` };
  }
  if (now - sent.sentAt > READ_WATCH_MS) {
    return { state: "unknown", text: "Not opened in the 14 days it was watched. Superhuman's feed does not look further back." };
  }
  return { state: "not-opened", text: `No open recorded as of ${fmt(feed.lastOkAt)}. Apple Mail and image blocking both make this unreliable either way.` };
}

/**
 * Each open on its own, oldest first: "4 Mar, 14:15 UTC (desma@example.com)".
 * The recipient is named only when the message went to more than one person,
 * because for a single recipient it is always the same name.
 */
export function openTimes(opens: readonly { recipient: string | null; openedAt: number }[], manyRecipients: boolean): string[] {
  return opens.map((open) => (manyRecipients && open.recipient ? `${fmt(open.openedAt)} (${open.recipient})` : fmt(open.openedAt)));
}

function fmt(ms: number | null): string {
  if (ms === null) return "unknown";
  return new Date(ms).toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " UTC";
}
