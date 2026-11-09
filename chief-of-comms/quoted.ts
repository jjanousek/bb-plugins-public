// Splitting a mail body from its quoted trailer. It lives at the plugin root
// because both sides need it: the panel hides the trailer when it shows a
// message, and the server keeps it out of the editable draft text and appends
// it again when the draft is saved back to Gmail.

export interface SplitBody {
  /** The part worth reading. */
  body: string;
  /** The quoted trailer, "" when there is none. */
  quoted: string;
}

const QUOTED_LINE = /^\s*>/;
// "On ... wrote:", "Am ... schrieb:", "Le ... a ecrit :", "El ... escribio:".
// The verb is not always last: German puts the name after it ("Am ... schrieb X:").
const ATTRIBUTION =
  /^\s*(On|Am|Le|El|Il)\s.{0,300}\b(wrote|schrieb|a\s+écrit|a\s+ecrit|escribió|escribio|ha\s+scritto)\b.{0,160}:\s*$/i;
const ATTRIBUTION_START = /^\s*(On|Am|Le|El|Il)\s.{0,300}$/i;
// Apple/Superhuman style: "Mon Mar 3, 2031, at 2:30 PM Name <addr>:" and the
// same line ending in "wrote:". Anchored on a clock time plus an address.
const ATTRIBUTION_TIME_ADDRESS =
  /^\s*.{0,200}\bat\s+\d{1,2}:\d{2}\s?(?:[AP]\.?M\.?)?\b.{0,240}[\w.+-]+@[\w.-]+\.\w+[\s>]*(?:wrote\s*)?:\s*$/i;
// The same shape without an address, but starting with a weekday or a month.
const ATTRIBUTION_TIME_DATED =
  /^\s*(Mon|Tue|Tues|Wed|Wednes|Thu|Thur|Thurs|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[.,]?\s.{0,240}\bat\s+\d{1,2}:\d{2}\b.{0,240}:\s*$/i;
const SEPARATOR =
  /^\s*-{2,}\s*(Original Message|Forwarded message|Ursprüngliche Nachricht|Message d'origine)\s*-{2,}\s*$/i;
// Outlook and some webmail clients rule off the trailer with underscores.
const UNDERSCORE_RULE = /^\s*_{8,}\s*$/;
const HEADER_BLOCK = /^\s*(From|Von|De|Da):\s.+$/;
const HEADER_NEXT = /^\s*(Sent|Date|To|Cc|Gesendet|An|Envoyé|Envoye|Enviado|Para|Data|Datum):\s/;

function startsTrailer(line: string, next: string): boolean {
  if (QUOTED_LINE.test(line)) return true;
  if (ATTRIBUTION.test(line)) return true;
  // The attribution may wrap over two lines.
  if (ATTRIBUTION_START.test(line) && ATTRIBUTION.test(`${line.trimEnd()} ${next.trim()}`)) return true;
  if (ATTRIBUTION_TIME_ADDRESS.test(line)) return true;
  if (ATTRIBUTION_TIME_DATED.test(line)) return true;
  if (SEPARATOR.test(line)) return true;
  if (UNDERSCORE_RULE.test(line)) return true;
  if (HEADER_BLOCK.test(line) && HEADER_NEXT.test(next)) return true;
  return false;
}

/**
 * Split a mail body from its quoted trailer. The trailer starts at the first
 * ">" line, at an attribution in any of the supported languages and formats,
 * at an original-message separator or underscore rule, or at a forwarded
 * header block.
 */
export function splitQuoted(text: string): SplitBody {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    if (!startsTrailer(line, next)) continue;
    const body = lines.slice(0, index).join("\n").trimEnd();
    const quoted = lines.slice(index).join("\n").trim();
    // A body that is quoted from its very first line has nothing to hide.
    if (body === "") return { body: text.trim(), quoted: "" };
    return { body, quoted };
  }
  return { body: text.trimEnd(), quoted: "" };
}
