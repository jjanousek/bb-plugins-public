// Only the owner's own click or command sends. Agent sends through the comms
// CLI and tools are blocked.
//
// How an agent is told apart from him:
// - A chief tool (comms_mail_send_draft, comms_wa_send, comms_wa_send_draft)
//   is only ever called by an agent thread, so it is always refused, even when
//   the send guard reads the owner's own turn as having asked.
// - A `bb comms` CLI call carries the calling thread's id when it runs inside a
//   bb thread: the bb CLI sends `threadId` from BB_THREAD_ID, which bb sets in
//   every thread's environment, and the plugin CLI endpoint passes it on as
//   `ctx.threadId`. The owner in his own terminal has no BB_THREAD_ID, so the
//   field is absent and the command runs.
// - The panel's Send button reaches the plugin over RPC, which carries no
//   caller at all, and stays allowed: that is his click.
//
// Drafting is not sending: comms_wa_draft, comms_mail_draft, draft_save and
// every request-draft path are untouched.

/** The refusal an agent sees, in plain words. */
export const AGENT_SEND_REFUSAL =
  "Not sent. Only the user sends messages, from the Comms panel. The draft is saved and waiting for him there; tell him it is ready.";

/** Is this CLI call from an agent's thread rather than his own terminal? */
export function cliCallerIsAgent(ctx: { threadId?: string | null } | null | undefined): boolean {
  return typeof ctx?.threadId === "string" && ctx.threadId.trim() !== "";
}

// The panel's Send button, told apart from an agent.
// An RPC handler is given the input and nothing else, so `bb plugin rpc call
// chief-of-comms draft_send` or a plain curl from any agent on the machine reached
// the same handler as his click. A plugin HTTP route does see the request, and
// the panel's Send first asks `/send-intent` for a one-time code; that route
// refuses a request with no Origin header, which bb's CLI and curl do not send
// and a browser always does on a POST. `draft_send` and `send_now` refuse
// without a live code for that conversation. Codes live in this process only,
// never in a log or the database, and die on reload. Limit, said plainly: a
// process that forges an Origin header on purpose gets through.

export const SEND_INTENT_MS = 10 * 60_000;

export const NOT_HIS_CLICK =
  "Not sent. Only the user sends, with the Send button in the Comms panel. This request did not come from that button, so nothing was sent.";

/** True when a request to the send-code route carries a browser Origin. */
export function hasBrowserOrigin(origin: string | null | undefined): boolean {
  return typeof origin === "string" && origin.trim() !== "";
}

/** One-time send codes, each tied to one conversation key. */
export class SendIntents {
  private readonly codes = new Map<string, { key: string; expiresAt: number }>();
  private readonly newCode: () => string;
  private readonly now: () => number;

  constructor(newCode: () => string, now: () => number = Date.now) {
    this.newCode = newCode;
    this.now = now;
  }

  issue(key: string): { intent: string; expiresAt: number } {
    const at = this.now();
    for (const [code, entry] of this.codes) if (entry.expiresAt <= at) this.codes.delete(code);
    const intent = this.newCode();
    const expiresAt = at + SEND_INTENT_MS;
    this.codes.set(intent, { key, expiresAt });
    return { intent, expiresAt };
  }

  valid(intent: string | undefined, key: string): boolean {
    if (intent === undefined || intent === "") return false;
    const entry = this.codes.get(intent);
    return entry !== undefined && entry.key === key && entry.expiresAt > this.now();
  }

  /** Spent on a send that went out, so the same code cannot send twice. */
  spend(intent: string | undefined): void {
    if (intent !== undefined) this.codes.delete(intent);
  }
}
