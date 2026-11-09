// Needs reply counts only mail the owner can answer from Comms. Some threads
// look unanswered but are answered
// somewhere else or never: for example a shared mailbox someone else
// answers, mailing lists, the owner's own forwards from
// another address, calendar replies, and app notices that never need
// a reply. A rule here only moves a thread that WOULD need a reply
// into a quiet group: it stays in the list, in search and in the conversation
// view, and it leaves the Needs reply count.
//
// The addresses are settings, never code (ownAddresses, answerElsewhereTo,
// noReplyFrom), because they belong to the user, not to the plugin.
// Nothing here is on a send path: the recipient check before a send keeps
// using myEmails() in server.ts.

/** Why a thread is left out of Needs reply, or null when it is not. */
export type QuietReason = "elsewhere" | "own" | "calendar" | "no-reply";

export interface QuietRules {
  /** His other addresses: mail from one of them is his own forward. */
  ownAddresses: readonly string[];
  /** Addresses or "@domain" entries answered outside Comms (a shared mailbox, a mailing list). */
  answerElsewhereTo: readonly string[];
  /** Senders, addresses or "@domain", whose mail never needs a reply. */
  noReplyFrom: readonly string[];
  /** This account's own address: mail addressed to it is answered here even if a quiet address is also on it. */
  accountAddress: string;
}

export interface NewestMessage {
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
}

/** Calendar robots' replies: never a conversation. */
const CALENDAR_SUBJECT = /^\s*(accepted|declined|tentative(ly accepted)?|canceled|cancelled|updated invitation|invitation|new event|event canceled)\b[^:]{0,40}:/i;
/** App senders such as teams-app@ or calendar-app@. */
const APP_LOCAL_PART = /-app$/i;

/** "a, b; c" into lower-case entries; blanks dropped. */
export function parseAddressList(setting: string | null | undefined): string[] {
  return (setting ?? "")
    .split(/[,;\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "" && entry.includes("@"));
}

/** Every address in a header, lower case. */
export function addressesOfHeader(header: string | null | undefined): string[] {
  if (!header) return [];
  return [...header.matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase());
}

function matches(address: string, entries: readonly string[]): boolean {
  return entries.some((entry) => (entry.startsWith("@") ? address.endsWith(entry) : address === entry));
}

/** Why this thread's newest incoming message needs no reply from Comms, or null. */
export function quietReason(newest: NewestMessage, rules: QuietRules): QuietReason | null {
  const from = addressesOfHeader(newest.from)[0] ?? "";
  const recipients = [...addressesOfHeader(newest.to), ...addressesOfHeader(newest.cc)];
  if (from !== "" && matches(from, rules.noReplyFrom)) return "no-reply";
  if (from !== "" && matches(from, rules.ownAddresses)) return "own";
  if (newest.subject && CALENDAR_SUBJECT.test(newest.subject)) return "calendar";
  if (from !== "" && APP_LOCAL_PART.test(from.slice(0, from.indexOf("@")))) return "no-reply";
  const account = rules.accountAddress.toLowerCase();
  if (recipients.some((r) => matches(r, rules.answerElsewhereTo)) && !recipients.includes(account)) return "elsewhere";
  return null;
}
