// Gmail access through the `gw` CLI (a Google CLI that holds one or two accounts).
//
// `gw` owns the OAuth tokens. `gw gmail draft` creates drafts; `sendDraft`
// below is the only path in this plugin that sends mail, and it only works
// with `--i-have-user-approval`, which `gw` requires. WhatsApp sends through
// whatsapp.ts, which is a separate wire. Both Gmail and
// Superhuman show the same mailbox, so a draft made here appears in both.
import { execFile } from "node:child_process";
import type { MailAccount } from "./contract";

/** The gw `--account` label used for each of the plugin's two mailboxes. */
export type GwAccountLabels = Record<MailAccount, string>;

/** Default labels; the `gwWorkAccount` and `gwPersonalAccount` settings override them. */
export const DEFAULT_GW_ACCOUNTS: GwAccountLabels = { work: "work", personal: "personal" };

/** Labels from the two settings; a blank setting falls back to its default. */
export function gwAccountLabels(work: string | undefined, personal: string | undefined): GwAccountLabels {
  return {
    work: work?.trim() || DEFAULT_GW_ACCOUNTS.work,
    personal: personal?.trim() || DEFAULT_GW_ACCOUNTS.personal,
  };
}

export function parseAccount(value: string | undefined | null): MailAccount | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "work") return "work";
  if (v === "personal" || v === "gmail" || v === "private" || v === "home") return "personal";
  return null;
}

export interface GwRunner {
  /** Run `gw <args>` and return its parsed JSON payload; throws GwError on failure. */
  run(args: string[], options?: { stdin?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<Record<string, unknown>>;
}

export class GwError extends Error {
  // Written out rather than declared as constructor parameter properties:
  // node --test strips types without compiling, and it cannot parse those.
  readonly fix: string | null;
  readonly exitCode: number | null;

  constructor(message: string, fix: string | null = null, exitCode: number | null = null) {
    super(message);
    this.name = "GwError";
    this.fix = fix;
    this.exitCode = exitCode;
  }
}

/**
 * gw writes its `fix` strings as a bare `gw ...`,
 * but gw must run as the user that owns the Google credentials, which may be
 * reached through a configured command, so a fix copied as printed could run
 * as the wrong user. Rewrite the leading command word to the command the
 * plugin actually uses.
 */
export function fixWithCommand(fix: string, command: string): string {
  const trimmed = command.trim();
  if (trimmed === "" || trimmed === "gw") return fix;
  return fix.replace(/(^|\s)gw(?=\s)/, (_match, lead: string) => `${lead}${trimmed}`);
}

/**
 * Build a runner from a command line: the first word is the program and the
 * rest go before gw's own arguments, so a wrapper or prefix command works.
 */
/** How long one gw call may run before it is killed, unless the caller says otherwise. */
export const GW_TIMEOUT_MS = 60_000;

/**
 * The timeout for a listing that fetches one Gmail item per result. gw makes
 * one Gmail call per draft or message, so a big listing page can outrun a
 * flat minute, and a timeout fails the whole mail pass. A page of ten keeps
 * the minute; the sync's big pages get up to three.
 */
export function gwListTimeoutMs(max: number): number {
  return Math.min(180_000, Math.max(GW_TIMEOUT_MS, max * 900));
}

/** "gw gmail drafts timed out after 60s": the command and subcommand only, never the query. */
export function gwTimeoutText(args: readonly string[], timeoutMs: number): string {
  const words: string[] = [];
  for (let i = 0; i < args.length && words.length < 2; i += 1) {
    const arg = args[i] as string;
    if (arg.startsWith("--")) {
      i += 1;
      continue;
    }
    words.push(arg);
  }
  const after = timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`;
  return `gw ${words.join(" ")} timed out after ${after}`;
}

export function createGwRunner(commandLine: string): GwRunner {
  const parts = commandLine.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("gw command is empty");
  const [bin, ...prefix] = parts as [string, ...string[]];
  return {
    run(args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = execFile(
          bin,
          [...prefix, ...args],
          {
            timeout: options.timeoutMs ?? GW_TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            signal: options.signal,
            env: { ...process.env, LANG: "C.UTF-8" },
          },
          (error, stdout, stderr) => {
            const parsed = parseJsonLine(stdout) ?? parseJsonLine(stderr);
            // Killed by our own timeout, not by a reload. Node reports that as a
            // bare "Command failed: <command line>" with nothing after it, so the
            // reason is named here for the log and the activity row.
            if (error && (error as { killed?: boolean }).killed && !options.signal?.aborted) {
              reject(new GwError(gwTimeoutText(args, options.timeoutMs ?? GW_TIMEOUT_MS)));
              return;
            }
            if (error) {
              const code = typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null;
              const message =
                (parsed && typeof parsed.error === "string" && parsed.error) ||
                (stderr.trim() || error.message || "gw failed");
              const fix = parsed && typeof parsed.fix === "string" ? parsed.fix : null;
              reject(new GwError(message, fix, code));
              return;
            }
            if (!parsed) {
              reject(new GwError(`gw returned no JSON: ${stdout.slice(0, 300)}`));
              return;
            }
            if (parsed.ok === false) {
              reject(new GwError(String(parsed.error ?? "gw failed"), typeof parsed.fix === "string" ? parsed.fix : null));
              return;
            }
            resolve(parsed);
          },
        );
        // A child that exits before reading its input raises EPIPE on this
        // stream. With no listener that is an uncaught exception, which exits
        // the whole bb process server. The exit itself is reported through
        // the callback above, so the stream error only needs swallowing.
        child.stdin?.on("error", () => {});
        if (options.stdin !== undefined) {
          child.stdin?.end(options.stdin);
        } else {
          child.stdin?.end();
        }
      });
    },
  };
}

function parseJsonLine(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  // gw prints exactly one JSON document, but warnings may precede it.
  const start = trimmed.lastIndexOf("\n{");
  const candidate = start >= 0 ? trimmed.slice(start + 1) : trimmed;
  try {
    const value: unknown = JSON.parse(candidate);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------- header and address helpers ----------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  deg: "°",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  szlig: "ß",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
};

/** Decode the HTML entities that actually show up in mail bodies and snippets. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Cheap guess: does this body need to be run through htmlToText? */
export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 600).toLowerCase();
  if (text.trimStart().startsWith("<")) return true;
  return head.includes("<html") || head.includes("<div") || head.includes("<p>") || head.includes("<br") || head.includes("<table");
}

/** Strip an HTML mail body down to readable plain text. */
export function htmlToText(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, " ");
  out = out.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, " ");
  out = out.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|section|article)\s*>/gi, "\n");
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<[^>]*>/g, " ");
  out = decodeEntities(out);
  out = out.replace(/\r/g, "");
  out = out.replace(/[ \t ]+/g, " ");
  out = out.replace(/[ \t]*\n[ \t]*/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

/**
 * Invisible characters mail tools pad the inbox preview line with (zero-width
 * joiners, soft hyphens, combining grapheme joiners, BOMs). Superhuman's
 * reminder mail carries runs of them, which rendered as a tall blank block.
 */
const INVISIBLE_PADDING = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g;

/** Plain text for a body that may or may not be HTML. */
export function bodyToText(body: string): string {
  const text = looksLikeHtml(body) ? htmlToText(body) : decodeEntities(body).replace(/\r/g, "");
  return text
    .replace(INVISIBLE_PADDING, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** RFC 2822 date to epoch millis. Trailing comments such as "(UTC)" are dropped. */
export function parseMailDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/\s*\([^()]*\)\s*$/, "").trim();
  const first = Date.parse(cleaned);
  if (Number.isFinite(first)) return first;
  const second = Date.parse(value);
  return Number.isFinite(second) ? second : null;
}

/** Lowercase bare address of the first mailbox in a header ("A B <a@b.c>" -> "a@b.c"). */
export function addressOf(header: string | null | undefined): string {
  if (!header) return "";
  const angled = header.match(/<([^>]+)>/);
  const raw = angled?.[1] ?? header.split(",")[0] ?? "";
  return raw.trim().replace(/^"+|"+$/g, "").toLowerCase();
}

/** Human name of the first mailbox in a header, falling back to the address. */
export function displayNameOf(header: string | null | undefined): string {
  if (!header) return "";
  const trimmed = header.trim();
  const angled = trimmed.match(/^(.*?)<([^>]+)>\s*$/);
  if (angled) {
    const name = (angled[1] ?? "").trim().replace(/^"(.*)"$/s, "$1").trim();
    if (name) return name;
    return (angled[2] ?? "").trim();
  }
  const first = trimmed.split(",")[0] ?? trimmed;
  return first.trim().replace(/^"(.*)"$/s, "$1");
}

/** Is this From/Sender header one of the owner's own addresses? */
export function isFromMe(header: string | null | undefined, emails: readonly string[]): boolean {
  const address = addressOf(header);
  if (!address) return false;
  return emails.some((email) => email.trim().toLowerCase() === address);
}

// ---------- data shapes ----------

export interface MailHeader {
  id: string;
  threadId: string | null;
  date: string | null;
  /**
   * When Gmail received it, epoch ms. The Date header is when the sender's
   * client wrote it, which can be minutes earlier; a dismissal compared against
   * that would hide a reply that arrived after it. Null from an older gw
   * that does not report it.
   */
  receivedAt: number | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  snippet: string | null;
  /**
   * A bulk mailing: `gw` sets this when the message carries List-Unsubscribe
   * or a bulk Precedence. Marketing sent from a person's own address has no
   * other reliable tell.
   */
  bulk: boolean;
  labels: string[];
}

export interface MailMessage extends MailHeader {
  cc: string | null;
  body: string;
}

export interface MailDraftCreated {
  draftId: string;
  messageId: string | null;
  threadId: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
}

export interface MailDraftRef {
  draftId: string;
  messageId: string | null;
  threadId: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  internalDate: number | null;
}

export interface MailDraftFull extends MailDraftRef {
  inReplyTo: string | null;
  body: string;
  /** Null when an older gw does not report it. */
  bcc?: string | null;
  /** File names of attachments. Null when gw does not report them. */
  attachments?: string[] | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function headerOf(raw: Record<string, unknown>): MailHeader {
  return {
    id: String(raw.id),
    threadId: str(raw.thread_id),
    date: str(raw.date),
    receivedAt: num(raw.internal_date),
    from: str(raw.from),
    to: str(raw.to),
    subject: str(raw.subject),
    snippet: str(raw.snippet),
    bulk: raw.bulk === true,
    labels: Array.isArray(raw.labels) ? raw.labels.map(String) : [],
  };
}

function draftRefOf(raw: Record<string, unknown>): MailDraftRef {
  return {
    draftId: String(raw.draft_id),
    messageId: str(raw.message_id),
    threadId: str(raw.thread_id),
    to: str(raw.to),
    cc: str(raw.cc),
    subject: str(raw.subject),
    date: str(raw.date),
    internalDate: num(raw.internal_date),
  };
}

export function createMail(gw: GwRunner, labels: GwAccountLabels = DEFAULT_GW_ACCOUNTS) {
  const account = (a: MailAccount) => ["--account", labels[a]];
  return {
    async search(a: MailAccount, query: string, max = 10, signal?: AbortSignal): Promise<{ estimate: number | null; messages: MailHeader[] }> {
      const res = await gw.run([...account(a), "gmail", "search", query, "--max", String(max)], { signal, timeoutMs: gwListTimeoutMs(max) });
      const messages = Array.isArray(res.messages) ? (res.messages as Record<string, unknown>[]).map(headerOf) : [];
      return { estimate: typeof res.estimate === "number" ? res.estimate : null, messages };
    },

    /**
     * Message and thread ids only, from the list call (gw's --ids-only): no per-message get, so no headers and no labels. Used
     * to tell whether anything changed before paying for the full search.
     */
    async searchIds(a: MailAccount, query: string, max = 100, signal?: AbortSignal): Promise<{ id: string; threadId: string | null }[]> {
      const res = await gw.run([...account(a), "gmail", "search", query, "--max", String(max), "--ids-only"], { signal, timeoutMs: GW_TIMEOUT_MS });
      if (res.ids_only !== true) throw new Error("gw did not answer --ids-only; it is too old for this plugin");
      const messages = Array.isArray(res.messages) ? (res.messages as Record<string, unknown>[]) : [];
      return messages.map((m) => ({ id: String(m.id), threadId: str(m.thread_id) }));
    },

    /** Draft, message and thread ids only, from drafts.list. */
    async draftIds(a: MailAccount, max = 200, signal?: AbortSignal): Promise<{ draftId: string; messageId: string | null; threadId: string | null }[]> {
      const res = await gw.run([...account(a), "gmail", "drafts", "--max", String(max), "--ids-only"], { signal, timeoutMs: GW_TIMEOUT_MS });
      if (res.ids_only !== true) throw new Error("gw did not answer --ids-only; it is too old for this plugin");
      const drafts = Array.isArray(res.drafts) ? (res.drafts as Record<string, unknown>[]) : [];
      return drafts.map((d) => ({ draftId: String(d.draft_id), messageId: str(d.message_id), threadId: str(d.thread_id) }));
    },

    async read(a: MailAccount, messageId: string, maxChars = 20_000, signal?: AbortSignal): Promise<MailMessage> {
      const res = await gw.run([...account(a), "gmail", "read", messageId, "--max-chars", String(maxChars)], { signal });
      return { ...headerOf(res), cc: str(res.cc), body: typeof res.body === "string" ? res.body : "" };
    },

    async thread(a: MailAccount, threadId: string, maxChars = 8_000, signal?: AbortSignal): Promise<MailMessage[]> {
      const res = await gw.run([...account(a), "gmail", "thread", threadId, "--max-chars", String(maxChars)], { signal });
      const messages = Array.isArray(res.messages) ? (res.messages as Record<string, unknown>[]) : [];
      return messages.map((m) => ({
        ...headerOf({ ...m, thread_id: threadId }),
        cc: str(m.cc),
        body: typeof m.body === "string" ? m.body : "",
      }));
    },

    /** Create a draft. Never sends. `replyToMessageId` threads it into that conversation. */
    async draft(
      a: MailAccount,
      input: { to: string; subject: string; body: string; cc?: string | null; replyToMessageId?: string | null },
      signal?: AbortSignal,
    ): Promise<MailDraftCreated> {
      const args = [...account(a), "gmail", "draft", "--to", input.to, "--subject", input.subject, "--body", "-"];
      if (input.cc) args.push("--cc", input.cc);
      if (input.replyToMessageId) args.push("--reply-to", input.replyToMessageId);
      const res = await gw.run(args, { stdin: input.body, signal });
      return {
        draftId: String(res.draft_id),
        messageId: str(res.message_id),
        threadId: str(res.thread_id),
        to: input.to,
        cc: input.cc ?? null,
        subject: input.subject,
      };
    },

    async drafts(a: MailAccount, max = 20, signal?: AbortSignal): Promise<MailDraftRef[]> {
      const res = await gw.run([...account(a), "gmail", "drafts", "--max", String(max)], { signal, timeoutMs: gwListTimeoutMs(max) });
      const drafts = Array.isArray(res.drafts) ? (res.drafts as Record<string, unknown>[]) : [];
      return drafts.map(draftRefOf);
    },

    async draftGet(a: MailAccount, draftId: string, signal?: AbortSignal): Promise<MailDraftFull> {
      const res = await gw.run([...account(a), "gmail", "draft-get", draftId], { signal });
      return {
        ...draftRefOf({ ...res, draft_id: res.draft_id ?? draftId }),
        inReplyTo: str(res.in_reply_to),
        body: typeof res.body === "string" ? res.body : "",
        bcc: str(res.bcc),
        attachments: Array.isArray(res.attachments) ? res.attachments.map((name) => String(name)) : null,
      };
    },

    /** Replace a draft's body (and optionally its headers). Keeps thread and reply headers. */
    async draftUpdate(
      a: MailAccount,
      draftId: string,
      patch: { body: string; to?: string | null; subject?: string | null; cc?: string | null },
      signal?: AbortSignal,
    ): Promise<MailDraftCreated> {
      const args = [...account(a), "gmail", "draft-update", draftId, "--body", "-"];
      if (patch.to) args.push("--to", patch.to);
      if (patch.subject) args.push("--subject", patch.subject);
      if (patch.cc) args.push("--cc", patch.cc);
      const res = await gw.run(args, { stdin: patch.body, signal });
      return {
        draftId: String(res.draft_id ?? draftId),
        messageId: str(res.message_id),
        threadId: str(res.thread_id),
        to: str(res.to) ?? patch.to ?? null,
        cc: str(res.cc) ?? patch.cc ?? null,
        subject: str(res.subject) ?? patch.subject ?? null,
      };
    },

    async draftDelete(a: MailAccount, draftId: string, signal?: AbortSignal): Promise<boolean> {
      const res = await gw.run([...account(a), "gmail", "draft-delete", draftId], { signal });
      return res.deleted !== false;
    },

    /** All labels of the mailbox, so user-label ids like Label_16 can be resolved to names. */
    async labels(a: MailAccount, signal?: AbortSignal): Promise<{ id: string; name: string; type: string }[]> {
      const res = await gw.run([...account(a), "gmail", "labels"], { signal });
      const labels = Array.isArray(res.labels) ? (res.labels as Record<string, unknown>[]) : [];
      return labels
        .filter((l) => typeof l.id === "string" && typeof l.name === "string")
        .map((l) => ({ id: String(l.id), name: String(l.name), type: String(l.type ?? "user") }));
    },

    /**
     * Send an existing draft. gw refuses without the approval flag; this
     * function is only reachable from human-approval paths (the Send button in
     * the Comms panel, `bb comms approve`, or the chief acting on an explicit
     * instruction from the owner). Never call it on the plugin's own initiative.
     */
    async sendDraft(a: MailAccount, draftId: string, signal?: AbortSignal): Promise<{ messageId: string | null; threadId: string | null }> {
      const res = await gw.run([...account(a), "gmail", "send-draft", draftId, "--i-have-user-approval"], { signal });
      return { messageId: str(res.message_id), threadId: str(res.thread_id) };
    },
  };
}

export type Mail = ReturnType<typeof createMail>;

/**
 * Does this gw error mean the draft is not in Gmail? gw surfaces the Google
 * API status in its message, and a missing draft is a 404. Used to tell a send
 * that failed from one where Gmail took the draft and only the answer was lost.
 */
export function looksLikeMissingDraft(text: string): boolean {
  return /\(404\)|not found/i.test(text);
}

/**
 * What to say when a conversation is opened whose thread Gmail no longer has
 * and nothing of it is cached, instead of Gmail's raw 404. This happens when
 * a mail that started a new thread is sent through Superhuman: deleting the
 * Gmail draft removes the draft-only thread the panel had open. The sent
 * mail's own thread is not in the comms list, because the
 * sync only adds sent mail to threads it already holds, so the text points to
 * Gmail rather than to the list. Null means the error is something else and is
 * passed on as it is.
 */
export function goneThreadText(error: string): string | null {
  if (!looksLikeMissingDraft(error)) return null;
  return "This thread is not in Gmail any more. A new message sent from it through Superhuman is in Gmail under a thread of its own.";
}

/**
 * Web links for a Gmail thread in Gmail and Superhuman (both read the same mailbox).
 *
 * `email` and `threadId` must come from the SAME account. Gmail thread ids are
 * per mailbox: one conversation has one id in the work mailbox and a different
 * one in the other side's inbox, and both are sixteen hex characters differing
 * only in the middle, so the wrong one looks right. Pairing a thread id with
 * the other account's address produces a well-formed link to nothing. Every
 * caller today reads both out of the same row or the same API call; keep it
 * that way. Superhuman refuses a thread id read out of the recipient's mailbox.
 */
export function mailLinks(email: string, threadId: string | null, draft = false): { gmailUrl: string; superhumanUrl: string } {
  const user = encodeURIComponent(email);
  if (!threadId) {
    return {
      gmailUrl: `https://mail.google.com/mail/u/?authuser=${user}#${draft ? "drafts" : "inbox"}`,
      superhumanUrl: `https://mail.superhuman.com/${user}/${draft ? "drafts" : "inbox"}`,
    };
  }
  return {
    gmailUrl: `https://mail.google.com/mail/u/?authuser=${user}#all/${threadId}`,
    superhumanUrl: `https://mail.superhuman.com/${user}/thread/${threadId}`,
  };
}

/** Compact one-line rendering of a header list for agents and the CLI. */
export function formatHeaders(a: MailAccount, headers: MailHeader[]): string {
  if (headers.length === 0) return `(${a}) no messages`;
  return headers
    .map((h) => {
      const unread = h.labels.includes("UNREAD") ? "*" : " ";
      const snippet = h.snippet ? `  ${decodeEntities(h.snippet).replace(/\s+/g, " ").slice(0, 100)}` : "";
      return `${unread} [${a}] id=${h.id} thread=${h.threadId ?? "-"}  ${h.date ?? ""}  ${h.from ?? ""}  |  ${h.subject ?? "(no subject)"}${snippet}`;
    })
    .join("\n");
}

export function formatMessage(a: MailAccount, m: MailMessage): string {
  return [
    `[${a}] id=${m.id} thread=${m.threadId ?? "-"}`,
    `From: ${m.from ?? ""}`,
    `To: ${m.to ?? ""}`,
    m.cc ? `Cc: ${m.cc}` : null,
    `Date: ${m.date ?? ""}`,
    `Subject: ${m.subject ?? ""}`,
    `Labels: ${m.labels.join(", ")}`,
    "",
    bodyToText(m.body),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function formatDraftRef(a: MailAccount, d: MailDraftRef): string {
  return `[${a}] draft ${d.draftId}  to ${d.to ?? "?"}  thread=${d.threadId ?? "-"}  |  ${d.subject ?? "(no subject)"}`;
}

/**
 * Split a To and a Cc header so no address sits in both, comparing
 * case-insensitively. An address listed in To stays in To and its Cc copy is
 * dropped, since To is where the caller put it first. Display names are kept.
 * A reply could otherwise go out with one person in To and Cc at once
 * (Superhuman's reply merge can cause it, which the send path now refuses, but
 * a draft should not carry duplicates either).
 */
export function dedupeRecipients(to: string, cc: string | null): { to: string; cc: string | null; dropped: string[] } {
  const split = (header: string | null) =>
    (header ?? "")
      .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
  const addressIn = (part: string) => (part.match(/<([^>]+)>/)?.[1] ?? part).trim().replace(/^"+|"+$/g, "").toLowerCase();
  const keptTo: string[] = [];
  const seen = new Set<string>();
  for (const part of split(to)) {
    const address = addressIn(part);
    if (seen.has(address)) continue;
    seen.add(address);
    keptTo.push(part);
  }
  const keptCc: string[] = [];
  const dropped: string[] = [];
  for (const part of split(cc)) {
    const address = addressIn(part);
    if (seen.has(address)) {
      dropped.push(address);
      continue;
    }
    seen.add(address);
    keptCc.push(part);
  }
  return { to: keptTo.join(", "), cc: keptCc.length > 0 ? keptCc.join(", ") : null, dropped };
}
