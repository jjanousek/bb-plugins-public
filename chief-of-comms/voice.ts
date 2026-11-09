// One voice file per contact: how the owner writes to this person.
//
// The chief needs guidance on tone and wording per person. A file per
// contact, refreshed on a schedule, is handed to the chief inside every draft
// request for that person, so it never has to remember to look it up. Design:
// - not bb skills: those are listed by name in every agent's every thread and
//   a plugin's skills/ folder may be published, so real messages would leave
//   the machine;
// - stored in the plugin's own data directory, 0700, never in git;
// - samples are his real sent messages, refreshed from the cache on every
//   mail sync and on new WhatsApp messages, with no model turn;
// - the chief reviews a contact's notes weekly, from the edits the owner made to
//   its drafts, and every line it adds says so and is dated, so he can remove
//   it on the About card;
// - one-to-one contacts with activity in the last 30 days; no group chats.
//
// The file is markdown with fixed headings so it reads like a skill and can be
// edited by hand or by the chief. Parsing is forgiving: an unknown heading is
// kept as notes rather than dropped. No imports beyond node, so tests load it.

/** A message he sent to this person, as stored in the file. */
export interface VoiceSample {
  at: number;
  channel: "mail" | "whatsapp";
  text: string;
}

export interface VoiceFile {
  /** `mail:<address>` or `wa:<jid>`, the same handle mute uses. */
  contactId: string;
  name: string;
  /** Who this person is to him; free text, written by him or the chief. */
  about: string;
  /** Tone and wording notes, one per line, newest last. */
  notes: string[];
  /** Words or habits to avoid with this person. */
  avoid: string[];
  samples: VoiceSample[];
  /** When the chief last reviewed the notes, epoch ms, or null. */
  reviewedAt: number | null;
}

/** How many of his sent messages a file keeps. */
export const MAX_SAMPLES = 5;
/** Longest sample kept, in characters; enough for tone, not a whole letter. */
export const SAMPLE_CHARS = 900;
/** Shortest message worth keeping as a sample: "ok" and "thanks!" teach nothing. */
export const MIN_SAMPLE_CHARS = 25;
/** A contact gets a file once there was a one-to-one exchange in this window. */
export const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** How often the chief reviews one contact's notes. */
export const REVIEW_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** The longest a file may be in a draft request, so one chatty contact cannot crowd out the rest. */
export const REQUEST_CHARS = 4000;

/** The prefix the chief puts on a line it adds, so the owner can tell it from his own. */
export function chiefLine(text: string, at: number): string {
  return `${text.trim()} (added by the chief, ${dayOf(at)})`;
}

/**
 * The chief's change to the "who they are" line. A wrong guess it wrote (a
 * pronoun, an age read off an email address) must be correctable without
 * editing the file by hand, so `replace` rewrites that one line and nothing
 * else: the notes, the
 * avoid list, the samples and the review time come back unchanged, which the
 * test pins. The old text is returned so the caller can log both.
 */
export function withAbout(
  file: VoiceFile,
  about: string | undefined,
  options: { replace: boolean; at: number },
): { file: VoiceFile; change: "none" | "added" | "replaced" | "kept" | "his"; before: string } {
  const before = file.about.trim();
  const next = (about ?? "").trim();
  if (next === "") return { file, change: "none", before };
  if (before === "") return { file: { ...file, about: chiefLine(next, options.at) }, change: "added", before };
  if (!options.replace) return { file, change: "kept", before };
  // His own line is his: the tool says it cannot change his lines, so only a
  // line the chief wrote, which carries its marker, can be replaced.
  if (!isChiefLine(before)) return { file, change: "his", before };
  if (before.replace(/\s*\(added by the chief, [^)]*\)\s*$/, "") === next) return { file, change: "none", before };
  return { file: { ...file, about: chiefLine(next, options.at) }, change: "replaced", before };
}

export function isChiefLine(line: string): boolean {
  return /\(added by the chief, \d{4}-\d{2}-\d{2}\)\s*$/.test(line);
}

function dayOf(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "UTC" });
}

/** A file name for a contact id that is safe on disk and stable. */
export function voiceFileName(contactId: string): string {
  return `${contactId.replace(/[^a-zA-Z0-9@._+-]/g, "_").slice(0, 120)}.md`;
}

/**
 * Strip a sent message down to what he wrote: no quoted history, no signature
 * block under "--", trimmed and cut. Returns "" for something too short to
 * teach anything.
 */
export function sampleText(raw: string): string {
  // Plugin and QA test messages carry this marker; they are not his voice.
  if (/^\s*\[bb test\]/i.test(raw)) return "";
  // A bare link or token is a note to himself, not a sentence in his voice.
  if (!/\s/.test(raw.trim()) || !/[a-zA-Z]{2,}\s+[a-zA-Z]{2,}/.test(raw)) return "";
  const lines = raw.replace(/\r/g, "").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^On .{0,200} wrote:\s*$/.test(line.trim()) || /^Am .{0,200} schrieb/.test(line.trim())) break;
    if (/^-{2,}\s*$/.test(line.trim())) break;
    if (/^_{5,}/.test(line.trim()) || /^From: /.test(line.trim())) break;
    kept.push(line);
  }
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < MIN_SAMPLE_CHARS) return "";
  return text.length <= SAMPLE_CHARS ? text : `${text.slice(0, SAMPLE_CHARS - 1).trimEnd()}…`;
}

/** The newest distinct samples, newest first, at most MAX_SAMPLES. */
export function pickSamples(messages: readonly VoiceSample[]): VoiceSample[] {
  const seen = new Set<string>();
  const out: VoiceSample[] = [];
  for (const message of [...messages].sort((a, b) => b.at - a.at)) {
    const text = sampleText(message.text);
    if (text === "") continue;
    const key = text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...message, text });
    if (out.length >= MAX_SAMPLES) break;
  }
  return out;
}

export function emptyVoice(contactId: string, name: string): VoiceFile {
  return { contactId, name, about: "", notes: [], avoid: [], samples: [], reviewedAt: null };
}

const H = {
  about: "## Who they are",
  notes: "## How the user writes to them",
  avoid: "## Avoid",
  samples: "## Messages he sent them",
};

/**
 * A sample is his own words and can hold a line that looks like a heading
 * ("# Packing list"). Written as is, parseVoice would read it as structure: a "# "
 * line would be dropped, so every sync would see a change and rewrite the
 * file, and a "## " line could become a tone rule.
 * A backslash in front of any line starting with "#" or a backslash marks it
 * as text; parseVoice takes it off again.
 */
function escapeSampleText(text: string): string {
  return text.replace(/^(\\*#)/gm, "\\$1");
}

function unescapeSampleLine(line: string): string {
  return /^\\+#/.test(line) ? line.slice(1) : line;
}

export function renderVoice(file: VoiceFile): string {
  const bullets = (lines: readonly string[]) => (lines.length === 0 ? "(none yet)" : lines.map((line) => `- ${line}`).join("\n"));
  const samples =
    file.samples.length === 0
      ? "(none yet)"
      : file.samples
          .map((s) => `### ${new Date(s.at).toISOString()} ${s.channel}\n${escapeSampleText(s.text)}`)
          .join("\n\n");
  return [
    `---`,
    `contact: ${file.contactId}`,
    `name: ${file.name.replace(/\n/g, " ")}`,
    `reviewed: ${file.reviewedAt === null ? "never" : new Date(file.reviewedAt).toISOString()}`,
    `---`,
    ``,
    `# Voice: ${file.name}`,
    ``,
    H.about,
    file.about.trim() === "" ? "(not written yet)" : file.about.trim(),
    ``,
    H.notes,
    bullets(file.notes),
    ``,
    H.avoid,
    bullets(file.avoid),
    ``,
    H.samples,
    samples,
    ``,
  ].join("\n");
}

/** Read a file back. Anything it does not recognise lands in notes, never dropped. */
export function parseVoice(text: string, fallbackId: string): VoiceFile {
  const file = emptyVoice(fallbackId, fallbackId);
  const front = text.match(/^---\n([\s\S]*?)\n---\n?/);
  let body = text;
  if (front) {
    body = text.slice(front[0].length);
    for (const line of (front[1] as string).split("\n")) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (!m) continue;
      const [, k, v] = m as unknown as [string, string, string];
      if (k === "contact" && v.trim() !== "") file.contactId = v.trim();
      if (k === "name" && v.trim() !== "") file.name = v.trim();
      if (k === "reviewed") file.reviewedAt = v.trim() === "never" ? null : Date.parse(v.trim()) || null;
    }
  }
  let section: "about" | "notes" | "avoid" | "samples" | "other" = "other";
  const about: string[] = [];
  let sample: VoiceSample | null = null;
  const flushSample = () => {
    if (sample && sample.text.trim() !== "") file.samples.push({ ...sample, text: sample.text.trim() });
    sample = null;
  };
  for (const line of body.split("\n")) {
    if (section === "samples" && sample !== null && /^\\+#/.test(line)) {
      sample.text += `${unescapeSampleLine(line)}\n`;
      continue;
    }
    if (line.startsWith("# ")) continue;
    if (line.startsWith("## ")) {
      flushSample();
      const head = line.trim();
      section = head === H.about ? "about" : head === H.notes ? "notes" : head === H.avoid ? "avoid" : head === H.samples ? "samples" : "other";
      continue;
    }
    if (section === "samples") {
      const m = line.match(/^### (\S+) (mail|whatsapp)\s*$/);
      if (m) {
        flushSample();
        sample = { at: Date.parse(m[1] as string) || 0, channel: m[2] as "mail" | "whatsapp", text: "" };
        continue;
      }
      if (sample) sample.text += `${line}\n`;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || /^\((none yet|not written yet)\)$/.test(trimmed)) continue;
    const bullet = trimmed.replace(/^[-*]\s+/, "");
    if (section === "about") about.push(trimmed);
    else if (section === "avoid") file.avoid.push(bullet);
    else file.notes.push(bullet);
  }
  flushSample();
  file.about = about.join("\n");
  return file;
}

/** Keep his notes, about and review time; replace only the samples. */
export function withSamples(file: VoiceFile, samples: readonly VoiceSample[], name: string): VoiceFile {
  return { ...file, name: name.trim() === "" ? file.name : name, samples: [...samples] };
}

/**
 * The block that goes into a draft request. Notes and avoid
 * lines first, because they are the rules; then the samples as examples of
 * tone only, so the chief does not lift their content into a new reply.
 */
export function voiceBlock(file: VoiceFile | null): string {
  if (file === null) {
    return "Voice for this person: no voice file yet. Write in the user's general voice and keep it short.";
  }
  const lines = [`Voice for ${file.name} (from the contact's voice file; follow it over your general habits):`];
  if (file.about.trim() !== "") lines.push(`Who they are: ${file.about.trim()}`);
  if (file.notes.length > 0) lines.push("How he writes to them:", ...file.notes.map((n) => `- ${n}`));
  if (file.avoid.length > 0) lines.push("Avoid with them:", ...file.avoid.map((n) => `- ${n}`));
  if (file.samples.length > 0) {
    lines.push(
      "Messages he sent them, newest first. Copy the length, register, greeting and sign-off. Never reuse their content, facts or promises:",
    );
    for (const s of file.samples) lines.push(`--- ${dayOf(s.at)}`, s.text);
  }
  if (lines.length === 1) lines.push("(The file has no notes or samples yet. Write in his general voice.)");
  let text = lines.join("\n");
  if (text.length > REQUEST_CHARS) text = `${text.slice(0, REQUEST_CHARS - 1).trimEnd()}…`;
  return text;
}

/** Is this contact due for the chief's review? */
export function reviewDue(file: VoiceFile, lastActivityAt: number | null, now: number): boolean {
  if (lastActivityAt === null) return false;
  if (file.reviewedAt === null) return file.samples.length > 0;
  return now - file.reviewedAt >= REVIEW_EVERY_MS && lastActivityAt > file.reviewedAt;
}

/** The most contacts one review request carries. */
export const VOICE_REVIEW_MAX = 8;
/** The weekday the review runs on, in UTC: 4 is Thursday. */
export const REVIEW_WEEKDAY = 4;

/** When this contact fell due: a week after its last review, or null for a file never reviewed. */
export function reviewDueSince(file: VoiceFile): number | null {
  return file.reviewedAt === null ? null : file.reviewedAt + REVIEW_EVERY_MS;
}

/**
 * Whether today's scheduled run asks the chief at all. Contacts fall due a few
 * at a time, so sending whenever one was due would start a cold chief turn on
 * most days for only a few of them.
 * It sends on the review weekday, or when a full batch is waiting, or when the
 * longest-waiting contact has been due for another whole week.
 */
export function shouldSendReview(dueCount: number, oldestDueSince: number | null, now: number): boolean {
  if (dueCount === 0) return false;
  if (dueCount >= VOICE_REVIEW_MAX) return true;
  if (oldestDueSince !== null && now - oldestDueSince >= REVIEW_EVERY_MS) return true;
  const weekday = new Date(now).getUTCDay();
  return weekday === REVIEW_WEEKDAY;
}

/** The part of the file the owner edits on the card: who they are, notes, avoid. */
export function editablePart(file: VoiceFile): string {
  const bullets = (lines: readonly string[]) => lines.map((line) => `- ${line}`).join("\n");
  return [
    "## Who they are",
    file.about.trim(),
    "",
    "## How the user writes to them",
    bullets(file.notes),
    "",
    "## Avoid",
    bullets(file.avoid),
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Put an edited editable part back into a file, keeping its samples and review date. */
export function withEditable(file: VoiceFile, editable: string): VoiceFile {
  const parsed = parseVoice(editable, file.contactId);
  return { ...file, about: parsed.about, notes: parsed.notes, avoid: parsed.avoid };
}

/**
 * Read a voice file, or null when there is none.
 * Only a missing file is "none". Any other read error is thrown, because the
 * writers (the sample refresh, comms_voice_note and the panel save) would
 * otherwise write a fresh file over his notes.
 * `read` is the file read, passed in so a test can make it fail.
 */
export function readVoiceFile(read: () => string, contactId: string): VoiceFile | null {
  let text: string;
  try {
    text = read();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw new Error(`The voice file for ${contactId} could not be read (${(cause as Error).message}), so it was left alone.`);
  }
  return parseVoice(text, contactId);
}
