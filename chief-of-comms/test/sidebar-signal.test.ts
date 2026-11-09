// The sidebar nav badge says one thing. The host clips its box at 64px, or
// 54px once a dot is in, so every string here is width-bound and the character
// counts below are the proxy a unit test can assert.
//
// clamp99 is imported from sidebar-accessory-format.ts, the same file the
// badge component imports, so these assertions run against the code the badge
// renders with rather than against a local mirror of it.
//
// Run with: npm test  (node --test, native TypeScript stripping)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { clamp99 } from "../components/comms/sidebar-accessory-format.ts";
import { navBadge, topSignal } from "../components/comms/sidebar-signal.ts";

type Summary = Parameters<typeof topSignal>[0];

const summary = (over: Record<string, unknown> = {}): Summary =>
  ({
    chiefThreadId: null,
    chiefStatus: null,
    wa: { state: "connected", qrDataUrl: null, me: null, sinceMs: null, lastError: null },
    mail: [
      { account: "work", email: "work@example.com", lastSyncAt: 1, ok: true, error: null, syncing: false },
      { account: "personal", email: "personal@example.com", lastSyncAt: 1, ok: true, error: null, syncing: false },
    ],
    counts: { needsReply: 0, ready: 0, staleDrafts: 0, byChannel: {} },
    autoDraft: "off",
    ...over,
  }) as Summary;

const counts = (needsReply: number, ready: number) => summary({ counts: { needsReply, ready, staleDrafts: 0, byChannel: {} } });

describe("topSignal", () => {
  it("says nothing before the first summary arrives", () => {
    assert.equal(topSignal(null), null);
  });

  it("says nothing when there is nothing waiting", () => {
    assert.equal(topSignal(counts(0, 0)), null);
  });

  it("counts replies before drafts, because his turn outranks his send", () => {
    assert.deepEqual(topSignal(counts(3, 5)), { level: "attention", text: "3 replies" });
  });

  it("falls to ready drafts when nothing is waiting on a reply", () => {
    assert.deepEqual(topSignal(counts(0, 5)), { level: "attention", text: "5 ready" });
  });

  it("puts a broken feed above both counts, because a count read from a dead feed is a lie", () => {
    const mailDown = summary({
      counts: { needsReply: 3, ready: 5, staleDrafts: 0, byChannel: {} },
      mail: [{ account: "work", email: "work@example.com", lastSyncAt: 1, ok: false, error: "reauth needed", syncing: false }],
    });
    assert.deepEqual(topSignal(mailDown), { level: "urgent", text: "sync failed" });
    const waDown = summary({
      counts: { needsReply: 3, ready: 0, staleDrafts: 0, byChannel: {} },
      wa: { state: "logged-out", qrDataUrl: null, me: null, sinceMs: null, lastError: "logged out" },
    });
    assert.deepEqual(topSignal(waDown), { level: "urgent", text: "sync failed" });
  });

  it("does not call WhatsApp turned off, or mid-pairing, a failure", () => {
    for (const state of ["disabled", "connecting", "qr", "qr-expired"]) {
      const s = summary({
        counts: { needsReply: 2, ready: 0, staleDrafts: 0, byChannel: {} },
        wa: { state, qrDataUrl: null, me: null, sinceMs: null, lastError: null },
      });
      assert.deepEqual(topSignal(s), { level: "attention", text: "2 replies" }, state);
    }
  });

  it("clamps a runaway count to 99 and never renders 99+, which clips", () => {
    assert.deepEqual(topSignal(counts(1000, 0)), { level: "attention", text: "99 replies" });
    assert.deepEqual(topSignal(counts(0, 1000)), { level: "attention", text: "99 ready" });
    assert.equal(clamp99(1000), "99");
    assert.equal(clamp99(-4), "0");
    assert.equal(clamp99(7.9), "7");
  });

  it("keeps every branch inside its measured budget at a two-digit count", () => {
    const cases: Array<ReturnType<typeof topSignal>> = [
      topSignal(counts(12, 0)),
      topSignal(counts(0, 12)),
      topSignal(summary({ mail: [{ account: "work", email: "x", lastSyncAt: 1, ok: false, error: "x", syncing: false }] })),
    ];
    for (const signal of cases) {
      assert.ok(signal !== null);
      // 10 characters for a level that carries a 6px dot and its gap, 12 for
      // urgent, which has no dot, at an 11px font.
      const budget = signal.level === "urgent" ? 12 : 10;
      assert.ok(signal.text.length <= budget, `"${signal.text}" is ${signal.text.length} characters, over ${budget}`);
    }
  });
});

describe("the sidebar counts replies the way the list does", () => {
  it("leaves out conversations already counted as ready", () => {
    // 7 need a reply, 4 of them have a draft ready: the list shows 3 under
    // "Needs a reply", and the sidebar says 3, not 7.
    const signal = topSignal(summary({ counts: { needsReply: 7, needsReplyOnly: 3, ready: 4, staleDrafts: 0, byChannel: {} } }));
    assert.equal(signal?.text, "3 replies");
  });

  it("still reads an older server without the field", () => {
    assert.equal(topSignal(counts(3, 0))?.text, "3 replies");
  });
});

describe("navBadge for experimental_useBadge (bb 0.48.1)", () => {
  it("disappears before the first summary arrives and when nothing is waiting", () => {
    assert.equal(navBadge(null), null);
    assert.equal(navBadge(counts(0, 0)), null);
  });

  it("shows the reply count (needsReplyOnly first) with singular and plural labels", () => {
    assert.deepEqual(navBadge(counts(1, 0)), { count: 1, label: "1 reply" });
    assert.deepEqual(navBadge(counts(3, 5)), { count: 3, label: "3 replies" });
    assert.deepEqual(
      navBadge(summary({ counts: { needsReply: 7, needsReplyOnly: 3, ready: 4, staleDrafts: 0, byChannel: {} } })),
      { count: 3, label: "3 replies" },
    );
  });

  it("falls to ready drafts when nothing is waiting on a reply", () => {
    assert.deepEqual(navBadge(counts(0, 5)), { count: 5, label: "5 ready" });
  });

  it("returns a critical dot above both counts when mail or WhatsApp is broken", () => {
    const mailDown = summary({
      counts: { needsReply: 3, ready: 5, staleDrafts: 0, byChannel: {} },
      mail: [{ account: "work", email: "x", lastSyncAt: 1, ok: false, error: "x", syncing: false }],
    });
    assert.deepEqual(navBadge(mailDown), { tone: "critical", label: "sync failed" });
    const waDown = summary({
      counts: { needsReply: 3, ready: 0, staleDrafts: 0, byChannel: {} },
      wa: { state: "logged-out", qrDataUrl: null, me: null, sinceMs: null, lastError: "logged out" },
    });
    assert.deepEqual(navBadge(waDown), { tone: "critical", label: "sync failed" });
  });

  it("wires experimental_useBadge on navPanel and drops experimental_sidebarAccessory", () => {
    const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
    assert.match(appSource, /experimental_useBadge:\s*useCommsBadge/);
    assert.doesNotMatch(appSource, /experimental_sidebarAccessory/);
  });
});
