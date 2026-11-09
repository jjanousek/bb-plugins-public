// Who the other side of a mail thread is. Every address below is invented.
//
// Run with: npm test  (node --test, native TypeScript stripping, Node 22.18+)

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mailCounterparty } from "../counterparty.ts";

describe("mailCounterparty", () => {
  const mine = ["work@example.com", "personal@example.com"];

  // Taking the newest sender on a thread where the owner wrote last would
  // name the owner's own address.
  it("finds the other side on a thread where the user sent the last two messages", () => {
    const rows = [
      { fromHeader: "Example, Kim <kim.example@example.org>", toHeader: "Owner <work@example.com>", fromMe: false },
      { fromHeader: "Owner Name <work@example.com>", toHeader: "kim.example@example.org", fromMe: true },
      { fromHeader: "Owner Name <work@example.com>", toHeader: "kim.example@example.org", fromMe: true },
    ];
    const found = mailCounterparty(rows, mine);
    assert.equal(found, "kim.example@example.org");
    assert.notEqual(found, "work@example.com", "the owner's own address is never the counterparty");
  });

  it("takes the other side when the user wrote last", () => {
    const rows = [
      { fromHeader: "Kim <kim.example@example.org>", toHeader: "work@example.com", fromMe: false },
      { fromHeader: "Owner <work@example.com>", toHeader: "kim.example@example.org", fromMe: true },
    ];
    assert.equal(mailCounterparty(rows, mine), "kim.example@example.org");
  });

  it("takes the newest message they sent", () => {
    const rows = [
      { fromHeader: "old@example.com", toHeader: "work@example.com", fromMe: false },
      { fromHeader: "new@example.com", toHeader: "work@example.com", fromMe: false },
    ];
    assert.equal(mailCounterparty(rows, mine), "new@example.com");
  });

  it("falls back to who the owner's message went to, skipping the owner's addresses", () => {
    const rows = [{ fromHeader: "Owner <work@example.com>", toHeader: "work@example.com, contact@example.com", fromMe: true }];
    assert.equal(mailCounterparty(rows, mine), "contact@example.com");
  });

  it("returns nothing when only the owner's addresses appear", () => {
    const rows = [{ fromHeader: "work@example.com", toHeader: "personal@example.com", fromMe: true }];
    assert.equal(mailCounterparty(rows, mine), "");
  });

  it("does not trust from_me alone when the header is the owner's address", () => {
    const rows = [{ fromHeader: "Owner <work@example.com>", toHeader: "someone@example.com", fromMe: false }];
    assert.equal(mailCounterparty(rows, mine), "someone@example.com");
  });
});
