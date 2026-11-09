// Avatar letters on the About card in the chief drawer, and the day column of
// its "This thread" lines. Names and addresses are invented.
//
// Run with: npm test  (node --test, native TypeScript stripping)
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { initials, stepDay } from "../components/comms/format.ts";

describe("initials", () => {
  // One helper for every avatar: the list, the conversation header and the
  // About card all use it, so a person gets the same letters everywhere.
  it("takes the first and last word", () => {
    assert.equal(initials("Desma Sample"), "DS");
    assert.equal(initials("Marja van der Ostrander"), "MO");
  });

  it("reads an address by its local part, and a name before an address", () => {
    assert.equal(initials("desma.sample@example.com"), "DS");
    assert.equal(initials("billing@example.com"), "B");
    assert.equal(initials("Lotte Brink <lena@example.com>"), "LB");
  });

  it("ignores quotes and brackets and keeps accented letters", () => {
    assert.equal(initials('  "Desma"  (Sample) '), "DS");
    assert.equal(initials("Øyvind Åsen"), "ØÅ");
  });

  it("gives a mark rather than digits for a phone number or nothing", () => {
    assert.equal(initials("+1 555 0100"), "#");
    assert.equal(initials(""), "#");
  });
});
describe("stepDay", () => {
  // 2031-08-20 12:00 UTC.
  const now = Date.parse("2031-08-20T12:00:00Z");

  it("says today for the same UTC day", () => {
    assert.equal(stepDay(Date.parse("2031-08-20T00:30:00Z"), now), "today");
  });

  it("gives weekday and day of month otherwise, read in UTC", () => {
    // 23:30 UTC stays on Monday 18 August, whatever zone the browser is in.
    assert.equal(stepDay(Date.parse("2031-08-18T23:30:00Z"), now), "Mon 18");
    assert.equal(stepDay(Date.parse("2031-08-16T02:00:00Z"), now), "Sat 16");
  });
});
