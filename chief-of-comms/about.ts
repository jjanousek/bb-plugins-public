// The "This thread" lines on the About card in the chief drawer.
//
// Built from the messages themselves, not written by a model: the chief's
// thread is one long conversation that is never started fresh, and asking it
// for a summary every time a conversation is opened would put a turn into
// that thread for each click. A line here is who spoke and the start of what
// they said, which is enough to remember where a thread stands.
//
// Pure, so the rules are tested without a database.

export interface AboutMessage {
  at: number;
  fromMe: boolean;
  text: string;
  /** Superhuman's "no reply yet" reminder, or another machine: not the other side speaking. */
  automated?: boolean;
}

export interface AboutStep {
  text: string;
  at: number;
  /** "open" is drawn green; "now" is the current state, drawn solid. */
  tone: "plain" | "open" | "now";
}

/** How many lines the card shows. More than this and it stops being a glance. */
export const MAX_STEPS = 4;

const QUOTE_START = /^\s*(>|On .{0,200} wrote:|Am .{0,200} schrieb)/im;

/**
 * The first sentence of a message, without greeting or quoted history, cut to
 * a line. "Hi Desma,\n\nShould I bring the spare chairs on Friday?" becomes
 * "Should I bring the spare chairs on Friday?".
 */
export function gist(text: string, max = 64): string {
  const cut = text.search(QUOTE_START);
  const own = (cut >= 0 ? text.slice(0, cut) : text).replace(/\r/g, "");
  const lines = own
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    // A greeting on its own line ("Hi Desma,") says nothing about the thread.
    // Only a line that is JUST a greeting and a name: "hey are you free
    // tomorrow" is a whole message and must survive.
    .filter((line) => !/^(hi|ho|hello|hey|dear|hallo|liebe|lieber|guten tag|good (morning|afternoon|evening))(\s+[\p{L}'-]+){0,2}\s*[,!.]?$/iu.test(line));
  // A greeting run into the first sentence: "Hi Desma, the chairs are here." keeps "The chairs are here."
  // "Hi Desma The chairs…" with no comma is caught by the capital that follows the name.
  if (lines[0] !== undefined) {
    lines[0] = lines[0].replace(/^(?:[Hh]i|[Hh]o|[Hh]ello|[Hh]ey|[Dd]ear|[Hh]allo)\s+[\p{L}'-]{1,30}(?:[,!]\s+|\s+(?=\p{Lu}))/u, "");
  }
  const flat = lines.join(" ").replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  const sentence = flat.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? flat;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).trimEnd()}…`;
}

/** "Mon 09:12" in UTC, the form the card uses for an open. */
export function shortWhen(ms: number): string {
  const day = new Date(ms).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short" });
  const time = new Date(ms).toLocaleTimeString("en-GB", { timeZone: "UTC", hour12: false, hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}

/**
 * The thread in at most four lines, oldest first, ending with where it stands.
 *
 * `firstName` names the other side ("Desma asked…"); `opens` are the recorded
 * opens of the owner's last message, which become one green line; `draftReady`
 * adds the closing "waiting for you" line. When the thread is longer than fits,
 * the newest lines win, because the card answers "where are we now".
 */
export function threadSteps(input: {
  messages: readonly AboutMessage[];
  firstName: string;
  opens: readonly number[];
  draftReady: boolean;
  draftByChief: boolean;
  /** The time to date the waiting line with; tests pass a fixed one. */
  now?: number;
}): AboutStep[] {
  const steps: AboutStep[] = [];
  const sorted = [...input.messages].sort((a, b) => a.at - b.at);
  for (const message of sorted) {
    if (message.automated) {
      // Superhuman's reminder is a fact about the thread, not something they said.
      steps.push({ text: "Superhuman reminder: still no reply", at: message.at, tone: "plain" });
      continue;
    }
    const said = gist(message.text);
    if (said === "") continue;
    steps.push({ text: `${message.fromMe ? "You" : input.firstName}: ${said}`, at: message.at, tone: "plain" });
  }
  const human = sorted.filter((m) => !m.automated);
  const lastMine = [...human].reverse().find((m) => m.fromMe);
  const lastTheirs = [...human].reverse().find((m) => !m.fromMe);
  if (lastMine && input.opens.length > 0) {
    const times = [...input.opens].sort((a, b) => a - b);
    const listed = times.length <= 3 ? times.map(shortWhen).join(", ") : `${times.length} times, last ${shortWhen(times[times.length - 1] as number)}`;
    const answered = lastTheirs !== undefined && lastTheirs.at > lastMine.at;
    steps.push({ text: `Opened ${listed}${answered ? "" : ", no reply yet"}`, at: times[0] as number, tone: "open" });
  }
  if (input.draftReady) {
    // Dated now, which is when it is waiting. A sentinel such as
    // MAX_SAFE_INTEGER would print as "Invalid Date" on the card.
    steps.push({ text: input.draftByChief ? "Reply drafted by the chief, waiting for you" : "Reply drafted, waiting for you", at: input.now ?? Date.now(), tone: "now" });
  }
  // Oldest first, and the waiting line always last whatever its time.
  steps.sort((a, b) => (a.tone === "now" ? 1 : 0) - (b.tone === "now" ? 1 : 0) || a.at - b.at);
  return steps.slice(-MAX_STEPS);
}
