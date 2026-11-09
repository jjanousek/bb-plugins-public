// Mail sync reads the mailbox only when something changed. The full pass
// searches the inbox and the owner's own replies with a per-message get each,
// which on a busy mailbox is a very large number of gets to find a few new
// messages. Before it runs, three ids-only list calls (gw's --ids-only; no
// gets at all) take a fingerprint:
//
//   in:inbox            a new message, or one archived or deleted, changes it
//   in:inbox is:unread  a message read or marked unread changes it
//   from:me             a reply he sent from Gmail or Superhuman changes it
//
// The full pass runs when the fingerprint differs from the last full pass, or
// when that pass is older than FULL_PASS_EVERY_MS. The backstop is there for
// what ids cannot show: a label Superhuman's AI adds to a message already in
// the inbox, for example. The full search stays the fallback for anything
// else too: a failed probe, or a gw without --ids-only, runs the full pass.

export const FULL_PASS_EVERY_MS = 15 * 60_000;

export interface ProbeSearch {
  searchIds(account: "work" | "personal", query: string, max?: number, signal?: AbortSignal): Promise<{ id: string; threadId: string | null }[]>;
}

/** The queries the fingerprint is taken over, for a lookback in days. */
export function probeQueries(lookbackDays: number): string[] {
  return [`in:inbox newer_than:${lookbackDays}d`, `in:inbox is:unread newer_than:${lookbackDays}d`, `from:me newer_than:${lookbackDays}d`];
}

/** One string for the three id sets; equal strings mean nothing an id can show changed. */
export async function mailFingerprint(
  mail: ProbeSearch,
  account: "work" | "personal",
  lookbackDays: number,
  max: number,
  signal?: AbortSignal,
): Promise<string> {
  const parts: string[] = [];
  for (const query of probeQueries(lookbackDays)) {
    const ids = await mail.searchIds(account, query, max, signal);
    parts.push(`${query}=${ids.map((m) => m.id).sort().join(",")}`);
  }
  return parts.join("\n");
}

export interface PassMemory {
  /** The fingerprint the last full pass was taken with, or null. */
  fingerprint: string | null;
  /** When the last full pass finished, or null. */
  fullAt: number | null;
}

/** Whether to run the full pass. `fingerprint` null means the probe failed: run it. */
export function needsFullPass(memory: PassMemory, fingerprint: string | null, now: number, forced = false): { full: boolean; reason: string } {
  if (forced) return { full: true, reason: "asked for" };
  if (fingerprint === null) return { full: true, reason: "the ids-only probe failed" };
  if (memory.fingerprint === null || memory.fullAt === null) return { full: true, reason: "first pass" };
  if (fingerprint !== memory.fingerprint) return { full: true, reason: "the mailbox changed" };
  if (now - memory.fullAt >= FULL_PASS_EVERY_MS) return { full: true, reason: "the 15 minute backstop" };
  return { full: false, reason: "unchanged" };
}
