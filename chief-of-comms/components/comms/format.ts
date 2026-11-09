// Presentation helpers shared by the inbox surfaces: time formatting, one-line
// previews, reply subjects, human WhatsApp labels, and the quoted-trailer split
// for mail bodies.
import type { Conversation, MailAccount, WaState } from "../../contract";

/** Mail bodies longer than this are collapsed behind "Show more". */
export const LONG_MAIL_CHARS = 1200;

/** Every date in this panel is read in UTC, never the browser's zone. */
const ZONE = "UTC";

/** Calendar year of a timestamp, in UTC. */
function yearOf(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: ZONE }).slice(0, 4);
}

/**
 * A date this year needs no year on it. One from an earlier year does: the
 * panel lists leftover Gmail drafts that are months or years old, and "18 Sept"
 * on its own is indistinguishable from a date two weeks away.
 */
function yearPart(ms: number): { year?: "numeric" } {
  return yearOf(ms) === yearOf(Date.now()) ? {} : { year: "numeric" };
}

/** Calendar date without a time: "18 Sept" this year, "18 Sept 2030" before it. */
function dateOnly(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", {
    timeZone: ZONE,
    day: "2-digit",
    month: "short",
    ...yearPart(ms),
  });
}

export function relativeTime(ms: number | null): string {
  if (ms === null) return "";
  const diff = Date.now() - ms;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return dateOnly(ms);
}

/** Short right-aligned age for list rows. */
export function shortTime(ms: number | null): string {
  if (ms === null) return "";
  const diff = Date.now() - ms;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return dateOnly(ms);
}

/** Absolute message time, always in UTC. */
export function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", {
    timeZone: ZONE,
    day: "2-digit",
    month: "short",
    ...yearPart(ms),
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Day bucket for grouping, in UTC. */
function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", {
    timeZone: ZONE,
    weekday: "short",
    day: "2-digit",
    month: "short",
    ...yearPart(ms),
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sortable calendar day in UTC; equal keys are the same day. */
export function dayKey(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: ZONE });
}

/** Separator text between days in a feed: Today, Yesterday, then the date. */
export function daySeparator(ms: number): string {
  const key = dayKey(ms);
  const now = Date.now();
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(now - DAY_MS)) return "Yesterday";
  return dayLabel(ms);
}

/**
 * The day column of a "This thread" line on the About card: "today", or the
 * short weekday and day of month ("Mon 22") in UTC.
 */
export function stepDay(ms: number, now: number = Date.now()): string {
  if (dayKey(ms) === dayKey(now)) return "today";
  const weekday = new Date(ms).toLocaleDateString("en-GB", { timeZone: ZONE, weekday: "short" });
  const day = new Date(ms).toLocaleDateString("en-GB", { timeZone: ZONE, day: "numeric" });
  return `${weekday} ${day}`;
}

/** Collapse a body to a single line for a preview row. */
export function previewLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function accountLabel(account: MailAccount | null): string {
  if (account === "work") return "Work";
  if (account === "personal") return "Personal";
  return "";
}

/** Human label for a WhatsApp connection state; never show the raw enum. */
export function waStateLabel(state: WaState): string {
  if (state === "connected") return "WhatsApp connected";
  if (state === "connecting") return "WhatsApp connecting";
  if (state === "qr") return "Scan the WhatsApp QR code";
  if (state === "qr-expired") return "WhatsApp QR code expired";
  if (state === "disabled") return "WhatsApp turned off";
  if (state === "logged-out") return "WhatsApp logged out";
  return "WhatsApp disconnected";
}

/**
 * The same state without the channel name, for surfaces that already say
 * WhatsApp. Written out rather than derived from waStateLabel: this is the
 * primary line of the Connections section, so each one is a sentence and not a
 * lowercase fragment left over from a string replace.
 */
export function waStateShort(state: WaState): string {
  if (state === "connected") return "Connected";
  if (state === "connecting") return "Connecting";
  if (state === "qr") return "Scan the QR code";
  if (state === "qr-expired") return "QR code expired";
  if (state === "disabled") return "Turned off";
  if (state === "logged-out") return "Logged out";
  return "Disconnected";
}

/**
 * Who the other side is, for a header meta line. A WhatsApp group carries the
 * literal word "group" as its counterpart, which is a kind and not a name, and
 * would otherwise dangle in front of the channel label.
 */
export function counterpartLabel(conversation: Conversation): string {
  if (conversation.channel === "whatsapp" && conversation.isGroup) return "Group";
  return conversation.counterpart.trim();
}

/**
 * Who a reply goes to, in words a human recognises. Mail answers the draft's
 * To header, then the sender. WhatsApp answers the chat title, because the
 * counterpart of a chat is only a phone number or the word "group" - never the
 * name the chat is filed under. Returns "" when there is no recipient at all,
 * which happens on a leftover Gmail draft that was never addressed.
 */
export function replyTarget(conversation: Conversation, draftTo: string | null): string {
  const title = conversation.title.trim();
  const counterpart = conversation.counterpart.trim();
  if (conversation.channel === "whatsapp") {
    if (title !== "") return title;
    return counterpart === "group" ? "" : counterpart;
  }
  const to = (draftTo ?? "").trim();
  return to !== "" ? to : counterpart;
}

const REPLY_PREFIX = /^\s*(re|aw|antw|sv|vs|fwd?|wg)\s*:/i;

/** Subject line for a reply, without stacking a second "Re:". "" stays "". */
export function replySubject(title: string): string {
  const trimmed = title.trim();
  if (trimmed === "") return "";
  return REPLY_PREFIX.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

// The split itself lives at the plugin root: the server needs it too, to keep
// the trailer out of the editable draft and put it back on save.
// With the extension, so node --test can load this file (test/initials.test.ts).
export { splitQuoted, type SplitBody } from "../../quoted.ts";

export interface TextSegment {
  kind: "text" | "link";
  /** What to display. */
  text: string;
  /** Where a link points; "" for plain text. */
  href: string;
}

// Bare URLs, mailto: and the "label<https://...>" shape that HTML-to-text
// conversion leaves behind. The label is kept as its own text segment.
const LINK_RE = /<?\b((?:https?:\/\/|www\.|mailto:)[^\s<>()[\]"']+)>?/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/;

function hrefFor(raw: string): string {
  if (/^www\./i.test(raw)) return `https://${raw}`;
  return raw;
}

function labelFor(raw: string): string {
  if (/^mailto:/i.test(raw)) return raw.slice(7);
  return raw.replace(/^https?:\/\//i, "");
}

/**
 * Split text into plain and link segments. Angle brackets around a URL are
 * dropped, and a URL glued to the preceding word is separated from it so the
 * line can wrap.
 */
export function tokenizeLinks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  LINK_RE.lastIndex = 0;
  let match = LINK_RE.exec(text);
  while (match !== null) {
    const raw = match[1] ?? "";
    const trailing = TRAILING_PUNCTUATION.exec(raw)?.[0] ?? "";
    const url = trailing === "" ? raw : raw.slice(0, raw.length - trailing.length);
    if (url !== "") {
      const label = labelFor(url);
      let before = text.slice(cursor, match.index);
      // "name@host<mailto:name@host>" and "https://x <https://x>" repeat the
      // target twice; keep the link and drop the bare copy in front of it.
      if (before.toLowerCase().endsWith(label.toLowerCase())) before = before.slice(0, before.length - label.length);
      if (before !== "") segments.push({ kind: "text", text: before, href: "" });
      segments.push({ kind: "link", text: label, href: hrefFor(url) });
      if (trailing !== "") segments.push({ kind: "text", text: trailing, href: "" });
      cursor = match.index + match[0].length;
    }
    match = LINK_RE.exec(text);
  }
  const rest = text.slice(cursor);
  if (rest !== "") segments.push({ kind: "text", text: rest, href: "" });
  if (segments.length === 0) segments.push({ kind: "text", text, href: "" });
  return segments;
}

/**
 * Up to two letters for an avatar: the first letter of the first and the last
 * word. An address is read by its local part, so "desma.sample@x.invalid" gives
 * "DS", and "Name <address>" uses the name. A name with no letter in it, such
 * as a bare phone number, gives "#". The one helper for every avatar (list,
 * conversation header, About card), so a person looks the same in all three.
 */
export function initials(name: string): string {
  let text = name.replace(/<[^>]*>/g, " ").trim() || name.replace(/[<>]/g, "").trim();
  const at = text.indexOf("@");
  if (at > 0 && !/\s/.test(text)) text = text.slice(0, at).replace(/[._+-]+/g, " ");
  const words = text
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+/u, ""))
    .filter((word) => /^\p{L}/u.test(word));
  if (words.length === 0) return "#";
  const first = Array.from(words[0] ?? "")[0] ?? "";
  if (words.length === 1) return first.toUpperCase();
  const last = Array.from(words[words.length - 1] ?? "")[0] ?? "";
  return `${first}${last}`.toUpperCase();
}

/**
 * Six soft avatar colours, background and text. Literal class strings so
 * Tailwind emits them. A solid pastel with dark text reads on both themes.
 */
const AVATAR_TONES: readonly string[] = [
  "bg-[#e8e1f5] text-[#5b3aa5]",
  "bg-[#dcecf5] text-[#25628a]",
  "bg-[#f5e6d8] text-[#8a4f1c]",
  "bg-[#dff0e4] text-[#2d6b44]",
  "bg-[#f3dfe3] text-[#93304a]",
  "bg-[#e6e6e1] text-[#55534d]",
];

/**
 * The avatar colour for a name. The same name always gets the same colour,
 * whatever else is on the list, and case or surrounding space does not move it.
 */
export function avatarTone(name: string): string {
  const key = name.trim().toLowerCase();
  let hash = 5381;
  for (let i = 0; i < key.length; i += 1) hash = ((hash * 33) ^ key.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? AVATAR_TONES[0]!;
}

/**
 * How many rows "To do" holds: everything that needs a reply plus every draft
 * ready to send, each conversation once. The summary counts the two sets
 * separately and a conversation can be in both, so the ones in both are taken
 * off, read from the pinned ready rows. Null while those rows are not loaded,
 * so the control shows no number rather than a wrong one.
 */
export function todoCount(
  needsReply: number,
  ready: number,
  readyRows: readonly Pick<Conversation, "needsReply" | "readyToSend" | "stale">[] | null,
): number | null {
  if (readyRows === null) return null;
  const both = readyRows.filter((row) => row.readyToSend && !row.stale && row.needsReply).length;
  return Math.max(needsReply + ready - both, 0);
}

// ---------- conversation view ----------
//
// Helpers for the open conversation: the header avatar, the day labels in the
// thread, the foot under each message and the To line of the dock. Named with
// a `view` prefix so they cannot collide with the list's helpers.

const BARE_ADDRESS = /^[^\s@<>]+@[^\s@<>]+$/;

/**
 * First name for a message foot: the first word of a display name, or the
 * local part of a bare address, capitalised. "" stays "".
 */
export function viewFirstName(name: string): string {
  const trimmed = name.trim().replace(/^"(.*)"$/s, "$1").trim();
  if (trimmed === "") return "";
  const angled = trimmed.match(/^(.*?)<([^>]+)>\s*$/);
  if (angled) return viewFirstName((angled[1] ?? "").trim() || (angled[2] ?? ""));
  if (BARE_ADDRESS.test(trimmed)) {
    const local = (trimmed.split("@")[0] ?? "").split(/[._+-]/)[0] ?? "";
    return local.charAt(0).toLocaleUpperCase() + local.slice(1);
  }
  return trimmed.split(/\s+/)[0] ?? "";
}

/** Day label over a group of messages: "Thursday 17 July", with the year when it is not this year. */
export function viewDayLabel(ms: number, now: number = Date.now()): string {
  const sameYear = yearOf(ms) === yearOf(now);
  return new Date(ms)
    .toLocaleDateString("en-GB", {
      timeZone: ZONE,
      weekday: "long",
      day: "numeric",
      month: "long",
      ...(sameYear ? {} : { year: "numeric" as const }),
    })
    .replace(",", "");
}

/** Clock time in UTC, 24 hour: "18:05". */
export function viewClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * A short stamp for an open: "Wed 09:15" inside the last six days, where a
 * weekday cannot be mistaken for another week, and "3 Jul 09:15" before that.
 */
export function viewStamp(ms: number, now: number = Date.now()): string {
  const recent = ms <= now && now - ms < 6 * DAY_MS;
  const day = recent
    ? new Date(ms).toLocaleDateString("en-GB", { timeZone: ZONE, weekday: "short" })
    : new Date(ms).toLocaleDateString("en-GB", { timeZone: ZONE, day: "numeric", month: "short" });
  return `${day} ${viewClock(ms)}`;
}

/**
 * The foot under a sent mail that was opened: "Opened by Desma Wed 09:15 and
 * Wed 21:45". Up to three opens are listed; more than that give the count and
 * the last one. `opens` is oldest first, as the server sends it.
 */
export function viewOpenedLine(name: string, opens: readonly { at: number }[], now: number = Date.now()): string {
  const who = name.trim() === "" ? "Opened" : `Opened by ${name.trim()}`;
  if (opens.length === 0) return who;
  if (opens.length > 3) {
    const last = opens[opens.length - 1];
    return `${who} ${opens.length} times, last ${last === undefined ? "" : viewStamp(last.at, now)}`;
  }
  const stamps = opens.map((open) => viewStamp(open.at, now));
  const listed = stamps.length === 1 ? stamps[0] : `${stamps.slice(0, -1).join(", ")} and ${stamps[stamps.length - 1]}`;
  return `${who} ${listed}`;
}

/**
 * The Send key hint for a platform string (navigator.platform or the owner
 * agent): the command key on Apple machines, Ctrl everywhere else, since the
 * dock accepts either.
 */
export function viewSendKeyHint(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘↵" : "Ctrl ↵";
}

/**
 * A To header split for the dock's To line: the first recipient's name and
 * address, and how many more there are. A bare address has no name, and a
 * bare name has no address.
 */
export function viewRecipient(header: string): { name: string; address: string; more: number } {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const char of header) {
    if (char === '"') quoted = !quoted;
    else if (char === "<") angled = true;
    else if (char === ">") angled = false;
    if (char === "," && !quoted && !angled) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  const recipients = parts.map((part) => part.trim()).filter((part) => part !== "");
  const first = recipients[0] ?? "";
  const more = Math.max(0, recipients.length - 1);
  const match = first.match(/^(.*?)<([^>]+)>\s*$/);
  if (match) {
    const name = (match[1] ?? "").trim().replace(/^"(.*)"$/s, "$1").trim();
    return { name, address: (match[2] ?? "").trim(), more };
  }
  if (BARE_ADDRESS.test(first)) return { name: "", address: first, more };
  return { name: first.replace(/^"(.*)"$/s, "$1"), address: "", more };
}

/**
 * The reply box's placeholder. It names who the text goes to, because the
 * chief's composer sits right beside it, and a note meant for the chief typed
 * here would go to the person.
 */
export function viewDockPlaceholder(channel: "mail" | "whatsapp", recipient: string): string {
  const who = recipient.trim();
  if (channel === "mail") return who === "" ? "Write the email" : `Write the email to ${who}`;
  return who === "" ? "Write a WhatsApp message" : `Write a WhatsApp message to ${who}`;
}

/**
 * Every recipient in a header, as "Name <address>" or the bare address, in
 * order. The dock lists all of them, Cc included, before Send, so a reply
 * going to several people never looks like one going to one person.
 */
export function viewRecipients(header: string | null): string[] {
  if (header === null || header.trim() === "") return [];
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const char of header) {
    if (char === '"') quoted = !quoted;
    else if (char === "<") angled = true;
    else if (char === ">") angled = false;
    if (char === "," && !quoted && !angled) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const match = part.match(/^(.*?)<([^>]+)>\s*$/);
      if (!match) return part.replace(/^"(.*)"$/s, "$1");
      const name = (match[1] ?? "").trim().replace(/^"(.*)"$/s, "$1").trim();
      const address = (match[2] ?? "").trim();
      return name === "" ? address : `${name} <${address}>`;
    });
}

/**
 * The first line "Ask chief…" puts in the chief's composer: which conversation
 * this is about, by name and key, so the chief can find it without the owner
 * pasting anything. The user writes the actual question after it; nothing is
 * sent until they press Enter.
 */
export function askLine(conversation: Pick<Conversation, "key" | "title" | "counterpart" | "channel">, hasDraft: boolean): string {
  const who = conversation.channel === "whatsapp" ? conversation.title : conversation.counterpart || conversation.title;
  const about = conversation.channel === "mail" && conversation.title && conversation.title !== who ? ` (${conversation.title})` : "";
  return `About ${who}${about}, ${conversation.key}${hasDraft ? ", the draft in the dock" : ""}:`;
}
