// The "This thread" lines on the About card. Names and text are invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_STEPS, gist, threadSteps } from "../about.ts";

const H = 60 * 60 * 1000;
const T0 = Date.parse("2031-04-09T02:00:00Z");

describe("gist", () => {
  it("drops the greeting and keeps the first sentence", () => {
    assert.equal(gist("Hi Desma,\n\nThe hall is booked for the evening. Can you bring chairs?"), "The hall is booked for the evening.");
  });

  it("stops at quoted history", () => {
    assert.equal(gist("Sounds good.\n\nOn Thu 10 Apr Desma wrote:\n> old text"), "Sounds good.");
  });

  it("cuts a long sentence to one line", () => {
    const long = "This is a very long sentence that keeps going well past the width the card has room for";
    const out = gist(long, 40);
    assert.ok(out.length <= 40, out);
    assert.ok(out.endsWith("…"));
  });

  it("drops a greeting run into the first sentence", () => {
    assert.equal(gist("Ho Desma Kettle is fixed now. Thanks!"), "Kettle is fixed now.");
    assert.equal(gist("Hi Desma, the tickets are booked. See you."), "the tickets are booked.");
  });

  it("keeps a short message that starts with a greeting word", () => {
    assert.equal(gist("hey are you free tomorrow"), "hey are you free tomorrow");
    assert.equal(gist("Hi, can we move Thursday to 3pm"), "Hi, can we move Thursday to 3pm");
    assert.equal(gist("Hello can you send the invoice"), "Hello can you send the invoice");
  });

  it("returns nothing for a message that is only a greeting", () => {
    assert.equal(gist("Hi Desma,"), "");
  });
});

describe("threadSteps", () => {
  const messages = [
    { at: T0, fromMe: false, text: "Which trail should we take on Saturday?" },
    { at: T0 + 5 * H, fromMe: true, text: "Hi Desma,\n\nThe lake loop is shorter. We can start at nine." },
  ];

  it("names who spoke, oldest first", () => {
    const steps = threadSteps({ messages, firstName: "Desma", opens: [], draftReady: false, draftByChief: false });
    assert.deepEqual(steps.map((s) => s.text), ["Desma: Which trail should we take on Saturday?", "You: The lake loop is shorter."]);
  });

  it("adds each open with its time and says there is no reply yet", () => {
    const opens = [T0 + 20 * H, T0 + 29 * H];
    const steps = threadSteps({ messages, firstName: "Desma", opens, draftReady: false, draftByChief: false });
    const open = steps.find((s) => s.tone === "open");
    assert.ok(open);
    assert.match(open.text, /^Opened \w{3} \d\d:\d\d, \w{3} \d\d:\d\d, no reply yet$/);
  });

  it("ends with the draft waiting, and keeps only the newest lines", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ at: T0 + i * H, fromMe: i % 2 === 1, text: `Message number ${i}.` }));
    const steps = threadSteps({ messages: many, firstName: "Desma", opens: [], draftReady: true, draftByChief: true });
    assert.equal(steps.length, MAX_STEPS);
    assert.equal(steps.at(-1)?.tone, "now");
    assert.equal(steps.at(-1)?.text, "Reply drafted by the chief, waiting for you");
    assert.ok(Number.isFinite(new Date(steps.at(-1)!.at).getTime()), "the waiting line carries a real date, not a sort sentinel");
    assert.equal(steps[0]?.text, "Desma: Message number 5.".replace("Desma", "You"));
  });

  it("names Superhuman's reminder as a reminder, not as the other person", () => {
    const withReminder = [...messages, { at: T0 + 30 * H, fromMe: false, automated: true, text: "Hi Desma, just following up on the trail." }];
    const steps = threadSteps({ messages: withReminder, firstName: "Desma", opens: [], draftReady: false, draftByChief: false });
    assert.equal(steps.at(-1)?.text, "Superhuman reminder: still no reply");
  });

  it("does not say no reply once they have answered after the opens", () => {
    const answered = [...messages, { at: T0 + 26 * H, fromMe: false, text: "Sounds good, see you there." }];
    const steps = threadSteps({ messages: answered, firstName: "Desma", opens: [T0 + 20 * H], draftReady: false, draftByChief: false });
    assert.ok(!steps.some((s) => /no reply yet/.test(s.text)));
  });
});
