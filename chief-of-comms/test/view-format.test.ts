// The conversation view helpers. Names and addresses are invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  viewClock,
  viewDayLabel,
  viewFirstName,
  viewOpenedLine,
  viewRecipient,
  viewSendKeyHint,
  viewStamp,
} from "../components/comms/format.ts";

// Thursday 17 July 2031, 12:00 UTC.
const NOW = Date.parse("2031-07-17T12:00:00Z");
const UTC = (iso: string) => Date.parse(`${iso}Z`);

describe("viewFirstName", () => {
  it("reads display names, headers and bare addresses", () => {
    assert.equal(viewFirstName("Desma Sample"), "Desma");
    assert.equal(viewFirstName('"Desma Sample" <desma@example.com>'), "Desma");
    assert.equal(viewFirstName("desma.sample@example.com"), "Desma");
    assert.equal(viewFirstName(""), "");
  });
});

describe("viewDayLabel and viewClock", () => {
  it("writes the day out in UTC", () => {
    // 23:30 UTC on Friday the 11th stays Friday the 11th, whatever zone the browser is in.
    assert.equal(viewDayLabel(Date.parse("2031-07-11T23:30:00Z"), NOW), "Friday 11 July");
  });

  it("adds the year only for another year", () => {
    assert.equal(viewDayLabel(UTC("2032-01-01T10:00:00"), NOW), "Thursday 1 January 2032");
  });

  it("gives a 24 hour clock", () => {
    assert.equal(viewClock(UTC("2031-07-15T19:45:00")), "19:45");
  });
});

describe("viewOpenedLine", () => {
  it("lists up to three opens", () => {
    const opens = [{ at: UTC("2031-07-16T09:15:00") }, { at: UTC("2031-07-16T21:45:00") }];
    assert.equal(viewOpenedLine("Desma", opens, NOW), "Opened by Desma Wed 09:15 and Wed 21:45");
  });

  it("counts beyond three and names the last", () => {
    const opens = [1, 2, 3, 4].map((hour) => ({ at: UTC(`2031-07-17T0${hour}:00:00`) }));
    assert.equal(viewOpenedLine("Desma", opens, NOW), "Opened by Desma 4 times, last Thu 04:00");
  });

  it("uses a date for an open more than six days back", () => {
    assert.equal(viewStamp(UTC("2031-07-03T09:15:00"), NOW), "3 Jul 09:15");
  });

  it("drops the name when there is none", () => {
    assert.equal(viewOpenedLine("", [{ at: UTC("2031-07-17T08:00:00") }], NOW), "Opened Thu 08:00");
  });
});

describe("viewSendKeyHint", () => {
  it("shows the command key on Apple platforms and Ctrl elsewhere", () => {
    assert.equal(viewSendKeyHint("MacIntel"), "⌘↵");
    assert.equal(viewSendKeyHint("iPad"), "⌘↵");
    assert.equal(viewSendKeyHint("Linux x86_64"), "Ctrl ↵");
    assert.equal(viewSendKeyHint(""), "Ctrl ↵");
  });
});

describe("viewRecipient", () => {
  it("splits a named address", () => {
    assert.deepEqual(viewRecipient('"Sample, Desma" <desma@example.com>'), {
      name: "Sample, Desma",
      address: "desma@example.com",
      more: 0,
    });
  });

  it("counts further recipients", () => {
    assert.deepEqual(viewRecipient("Desma <desma@example.com>, lee@example.com"), {
      name: "Desma",
      address: "desma@example.com",
      more: 1,
    });
  });

  it("keeps a bare address or a bare name", () => {
    assert.deepEqual(viewRecipient("desma@example.com"), { name: "", address: "desma@example.com", more: 0 });
    assert.deepEqual(viewRecipient("Desma Sample"), { name: "Desma Sample", address: "", more: 0 });
  });
});

import { viewDockPlaceholder, viewRecipients } from "../components/comms/format.ts";

describe("viewRecipients, every recipient before Send", () => {
  it("lists all of them, names kept, commas inside quotes left alone", () => {
    assert.deepEqual(viewRecipients('"Lee, Desma" <desma@example.com>, sam@example.com, Ana <ana@example.com>'), [
      "Lee, Desma <desma@example.com>",
      "sam@example.com",
      "Ana <ana@example.com>",
    ]);
  });

  it("is empty for no header", () => {
    assert.deepEqual(viewRecipients(null), []);
    assert.deepEqual(viewRecipients("  "), []);
  });
});

describe("the reply box says who it writes to", () => {
  it("names the person and the channel", () => {
    assert.equal(viewDockPlaceholder("whatsapp", "Desma"), "Write a WhatsApp message to Desma");
    assert.equal(viewDockPlaceholder("mail", "Sol Lindahl"), "Write the email to Sol Lindahl");
  });

  it("still reads without a name", () => {
    assert.equal(viewDockPlaceholder("whatsapp", " "), "Write a WhatsApp message");
  });
});
