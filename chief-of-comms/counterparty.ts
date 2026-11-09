// Who is on the other side of a mail thread. Pure, so it is tested without a
// database.

export interface MailSide {
  /** Oldest first, as the store returns them. */
  fromHeader: string | null;
  toHeader: string | null;
  fromMe: boolean;
}

/**
 * The address of the person on the other side of a mail thread.
 *
 * Taking the newest message's sender names the owner whenever he wrote last,
 * which silently picks his own address. Prefer the newest message they sent;
 * fall back to who his own newest message went to, skipping his own addresses.
 */
export function mailCounterparty(rows: readonly MailSide[], ownEmails: readonly string[]): string {
  const mine = ownEmails.map((email) => email.trim().toLowerCase()).filter((email) => email !== "");
  const isMine = (address: string) => mine.includes(address);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i] as MailSide;
    if (row.fromMe) continue;
    const address = emailsIn(row.fromHeader)[0] ?? "";
    if (address !== "" && !isMine(address)) return address;
  }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i] as MailSide;
    const address = emailsIn(row.toHeader).find((candidate) => !isMine(candidate)) ?? "";
    if (address !== "") return address;
  }
  return "";
}

function emailsIn(header: string | null | undefined): string[] {
  return (header ?? "").match(/[^\s<>,;"]+@[^\s<>,;"]+/g)?.map((m) => m.toLowerCase()) ?? [];
}
