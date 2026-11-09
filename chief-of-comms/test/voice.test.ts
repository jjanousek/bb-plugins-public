// The per-contact voice file. Names and messages are invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_SAMPLES,
  MIN_SAMPLE_CHARS,
  REQUEST_CHARS,
  REVIEW_EVERY_MS,
  chiefLine,
  emptyVoice,
  isChiefLine,
  parseVoice,
  pickSamples,
  renderVoice,
  reviewDue,
  sampleText,
  voiceBlock,
  voiceFileName,
  readVoiceFile,
  shouldSendReview,
  VOICE_REVIEW_MAX,
  withAbout,
  withSamples,
} from "../voice.ts";
import { readFileSync } from "node:fs";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2031-04-22T03:00:00Z");

describe("sampleText", () => {
  it("keeps what he wrote and drops quoted history and signatures", () => {
    const raw = "Hi Desma,\n\nThursday at 3pm works, see you then.\n\nBest,\nElske\n\nOn Fri, May 2 Desma wrote:\n> can we meet";
    assert.equal(sampleText(raw), "Hi Desma,\n\nThursday at 3pm works, see you then.\n\nBest,\nElske");
  });

  it("drops messages too short to show a tone", () => {
    assert.equal(sampleText("Thanks!"), "");
  });

  it("never uses a bare link or token as a sample", () => {
    // Invented values, each longer than MIN_SAMPLE_CHARS, so it is the
    // bare-token rule that drops them and not the length rule.
    const link = "https://example.com/artifact/00000000-0000-4000-8000-000000000000";
    const token = "exampletoken7.0123456789abcdef0123456789abcdef";
    for (const bare of [link, token]) {
      assert.ok(bare.length >= MIN_SAMPLE_CHARS, `${bare} is long enough to pass the length rule`);
      assert.equal(sampleText(bare), "");
    }
  });

  it("never uses a plugin test message as a sample", () => {
    assert.equal(sampleText("[bb test] does the panel show this line only once?"), "");
  });
});

describe("pickSamples", () => {
  it("takes the newest distinct messages, at most five", () => {
    const msgs = Array.from({ length: 8 }, (_, i) => ({ at: T0 + i * DAY, channel: "whatsapp" as const, text: `Message number ${i} with enough words to count.` }));
    msgs.push({ at: T0 + 20 * DAY, channel: "whatsapp", text: "Message number 7 with enough words to count." });
    const picked = pickSamples(msgs);
    assert.equal(picked.length, MAX_SAMPLES);
    assert.equal(picked[0]?.at, T0 + 20 * DAY);
    assert.equal(new Set(picked.map((p) => p.text)).size, picked.length, "no duplicates");
  });
});

describe("the file on disk", () => {
  it("round-trips everything through render and parse", () => {
    const file = {
      ...emptyVoice("mail:desma@example.com", "Desma Lee"),
      about: "Parent of Sam, pays per class.",
      notes: ["Short, four or five sentences.", chiefLine("No sign-off on WhatsApp", T0)],
      avoid: ["Exclamation marks"],
      samples: [{ at: T0, channel: "mail" as const, text: "Hi Desma,\n\nSam did well today.\n\nAll the best,\nElske" }],
      reviewedAt: T0,
    };
    assert.deepEqual(parseVoice(renderVoice(file), "x"), file);
  });

  it("keeps a hand-written line under an unknown heading as a note", () => {
    const parsed = parseVoice("## Something else\n- Prefers mornings", "wa:1@x");
    assert.deepEqual(parsed.notes, ["Prefers mornings"]);
  });

  it("refreshing samples never touches his notes", () => {
    const file = { ...emptyVoice("wa:1@x", "Lee"), notes: ["Keep it short."], about: "Friend." };
    const next = withSamples(file, [{ at: T0, channel: "whatsapp", text: "See you Friday at the usual place." }], "Lee");
    assert.deepEqual(next.notes, ["Keep it short."]);
    assert.equal(next.about, "Friend.");
    assert.equal(next.samples.length, 1);
  });

  it("names files safely", () => {
    assert.equal(voiceFileName("mail:desma@example.com"), "mail_desma@example.com.md");
    assert.ok(!voiceFileName("wa:../../etc").includes("/"));
  });
});

describe("chief lines", () => {
  it("are marked and dated so the user can tell them from his own", () => {
    const line = chiefLine("Uses first names only", T0);
    assert.equal(isChiefLine(line), true);
    assert.equal(isChiefLine("Uses first names only"), false);
  });
});

describe("the block in a draft request", () => {
  it("puts the rules before the samples and says the samples are for tone only", () => {
    const file = { ...emptyVoice("wa:1@x", "Lee"), notes: ["Short."], samples: [{ at: T0, channel: "whatsapp" as const, text: "See you Friday at the usual place." }] };
    const block = voiceBlock(file);
    assert.ok(block.indexOf("Short.") < block.indexOf("See you Friday"));
    assert.match(block, /Never reuse their content/);
  });

  it("says so when there is no file, and stays within its size", () => {
    assert.match(voiceBlock(null), /no voice file yet/);
    const huge = { ...emptyVoice("wa:1@x", "Lee"), notes: Array.from({ length: 400 }, (_, i) => `Note ${i} that is fairly long.`) };
    assert.ok(voiceBlock(huge).length <= REQUEST_CHARS);
  });
});

describe("reviewDue", () => {
  const file = { ...emptyVoice("wa:1@x", "Lee"), samples: [{ at: T0, channel: "whatsapp" as const, text: "x".repeat(40) }] };
  it("reviews a new file with samples once, then weekly when there was activity since", () => {
    assert.equal(reviewDue(file, T0, T0), true);
    const reviewed = { ...file, reviewedAt: T0 };
    assert.equal(reviewDue(reviewed, T0 + DAY, T0 + 2 * DAY), false, "not before a week");
    assert.equal(reviewDue(reviewed, T0 + DAY, T0 + REVIEW_EVERY_MS), true);
    assert.equal(reviewDue(reviewed, T0 - DAY, T0 + REVIEW_EVERY_MS), false, "nothing new since the last review");
  });
});

describe("a sample that contains heading-like lines", () => {
  // A sample line that looks like a heading stays sample text: the parser
  // keeps it, so a render and parse give back the same file and a sync sees
  // no change.
  const tricky = {
    ...emptyVoice("wa:7@x", "Jessamy"),
    notes: ["Short."],
    samples: [
      {
        at: Date.parse("2031-09-17T10:15:00Z"),
        channel: "whatsapp" as const,
        text: "# Packing list\nTent, stove, two maps.\n## Also bring\n### 2031-02-03T00:00:00.000Z whatsapp\nThis is still the message.",
      },
    ],
  };

  it("round-trips the sample exactly", () => {
    assert.deepEqual(parseVoice(renderVoice(tricky), "x").samples, tricky.samples);
  });

  it("never turns a sample line into a tone rule", () => {
    assert.deepEqual(parseVoice(renderVoice(tricky), "x").notes, ["Short."]);
  });

  it("renders the same text twice in a row, so a sync writes nothing", () => {
    const once = renderVoice(parseVoice(renderVoice(tricky), "x"));
    assert.equal(renderVoice(parseVoice(once, "x")), once);
  });
});

describe("the chief corrects its own 'who they are' line", () => {
  // Invented contact, written for this test.
  const base = {
    ...emptyVoice("wa:1@x", "Toma"),
    about: chiefLine("Neighbour; teenage; lends him tools", T0),
    notes: ["Short replies.", chiefLine("No sign-off", T0)],
    avoid: ["Exclamation marks"],
    samples: [{ at: T0, channel: "whatsapp" as const, text: "Thanks for the ladder, back on Sunday." }],
    reviewedAt: T0,
  };
  const later = T0 + 3 * DAY;

  it("replaces that one line when asked, and leaves every other field alone", () => {
    const result = withAbout(base, "Neighbour; lends them tools", { replace: true, at: later });
    assert.equal(result.change, "replaced");
    assert.equal(result.before, base.about);
    assert.equal(result.file.about, chiefLine("Neighbour; lends them tools", later));
    const { about: _a, ...rest } = result.file;
    const { about: _b, ...restBefore } = base;
    assert.deepEqual(rest, restBefore, "notes, avoid, samples and review time unchanged");
  });

  it("without the flag, an existing line is kept, as before", () => {
    const result = withAbout(base, "Something else", { replace: false, at: later });
    assert.equal(result.change, "kept");
    assert.equal(result.file.about, base.about);
  });

  it("an empty line is filled without the flag, and an empty value changes nothing", () => {
    const empty = { ...base, about: "" };
    assert.equal(withAbout(empty, "Neighbour", { replace: false, at: later }).change, "added");
    assert.equal(withAbout(base, "  ", { replace: true, at: later }).file, base);
  });

  it("the tool passes the flag through and logs the old and the new text", () => {
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const start = server.indexOf('name: "comms_voice_note"');
    const body = server.slice(start, server.indexOf("\n  });\n", start));
    assert.match(body, /replaceAbout: z/);
    assert.match(body, /withAbout\(file, about, \{ replace: replaceAbout, at: now \}\)/);
    assert.match(body, /Was: "\$\{aboutChange\.before\}"\. Now: "\$\{next\.about\}"/);
    assert.doesNotMatch(body, /samples:/, "the tool never writes samples");
  });

  it("the chief is told not to guess pronouns, age or role, in its instructions and in the review", () => {
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    assert.match(server, /never guess a person\\'s pronouns, age or role from a name or an email address; use "they"/);
    assert.equal([...server.matchAll(/^\s*VOICE_FACTS_RULE,$/gm)].length, 2);
  });
});

describe("the owner's own 'who they are' line is never replaced", () => {
  it("a hand-written line with replaceAbout true stays unchanged", () => {
    const file = { ...emptyVoice("wa:2@x", "Pell"), about: "Old school friend, lives abroad." };
    const result = withAbout(file, "Colleague", { replace: true, at: T0 });
    assert.equal(result.change, "his");
    assert.equal(result.file.about, "Old school friend, lives abroad.");
    assert.equal(result.file, file, "nothing in the file changed");
  });

  it("the tool tells the chief to ask him", () => {
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    assert.match(server, /aboutChange\.change === "his"[\s\S]{0,200}ask him/);
  });
});

describe("a voice file that cannot be read is never treated as missing", () => {
  const errno = (code: string) => Object.assign(new Error(`${code}: test`), { code });

  it("a missing file is null", () => {
    assert.equal(readVoiceFile(() => { throw errno("ENOENT"); }, "wa:3@x"), null);
  });

  it("any other read error throws, so no writer starts from an empty file", () => {
    assert.throws(() => readVoiceFile(() => { throw errno("EACCES"); }, "wa:3@x"), /could not be read .*left alone/);
    assert.throws(() => readVoiceFile(() => { throw errno("EIO"); }, "wa:3@x"));
  });

  it("the three writers stop on a read error instead of writing", () => {
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    assert.doesNotMatch(server, /readVoice\(contact\.contactId\) \?\? emptyVoice/, "no writer folds a read error into an empty file");
    assert.match(server, /voice refresh skipped/);
    assert.match(server, /Nothing was written; tell the user\./);
    assert.match(server, /Nothing was saved\./);
  });
});

describe("the voice review sends weekly, not daily", () => {
  // 2031-05-15 is a Thursday; 2031-05-13 a Tuesday. Both at 00:30 UTC.
  const thursday = Date.parse("2031-05-15T00:30:00Z");
  const tuesday = Date.parse("2031-05-13T00:30:00Z");
  const recentlyDue = tuesday - 2 * DAY;

  it("two due on a non-review weekday wait", () => {
    assert.equal(shouldSendReview(2, recentlyDue, tuesday), false);
  });
  it("a full batch sends on any day", () => {
    assert.equal(shouldSendReview(VOICE_REVIEW_MAX, recentlyDue, tuesday), true);
  });
  it("one contact a whole week overdue sends", () => {
    assert.equal(shouldSendReview(1, tuesday - 7 * DAY, tuesday), true);
  });
  it("two due on the review weekday send", () => {
    assert.equal(shouldSendReview(2, thursday - 2 * DAY, thursday), true);
  });
  it("the daily run uses the gate, and --review still asks now", () => {
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    assert.match(server, /if \(!options\.now && !shouldSendReview\(/);
    assert.match(server, /runVoiceReview\(\{ now: true \}\)/);
  });
});
