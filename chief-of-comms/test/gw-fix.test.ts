// gw prints its fix strings as a bare `gw ...`, but the plugin may be set up
// to run gw through a configured command prefix, so the fix a reader sees in
// the Connections tab or in `bb comms status` must name the configured
// command.
//
// Run with: npm test  (node --test, native TypeScript stripping, Node 22.18+)

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fixWithCommand } from "../gmail.ts";

const GW = "env GW_PROFILE=example gw";

describe("fixWithCommand", () => {
  it("names the configured command in a reauth fix", () => {
    assert.equal(
      fixWithCommand("gw auth --account alpha", GW),
      "env GW_PROFILE=example gw auth --account alpha",
    );
  });

  it("rewrites a fix that mentions gw mid-sentence", () => {
    assert.equal(
      fixWithCommand("ask for access to the file, or run gw auth --account beta", GW),
      "ask for access to the file, or run env GW_PROFILE=example gw auth --account beta",
    );
  });

  it("leaves a fix without a gw command alone", () => {
    const fix = "check the id, and that this account has access to it";
    assert.equal(fixWithCommand(fix, GW), fix);
  });

  it("does not touch words that merely start with gw", () => {
    assert.equal(fixWithCommand("run gwork auth", GW), "run gwork auth");
  });

  it("rewrites only the first command word", () => {
    assert.equal(
      fixWithCommand("gw auth --account alpha, then gw whoami", GW),
      "env GW_PROFILE=example gw auth --account alpha, then gw whoami",
    );
  });

  it("is a no-op when the command is bare gw or empty", () => {
    assert.equal(fixWithCommand("gw auth --account alpha", "gw"), "gw auth --account alpha");
    assert.equal(fixWithCommand("gw auth --account alpha", "  "), "gw auth --account alpha");
  });
});

import { dedupeRecipients } from "../gmail.ts";

describe("dedupeRecipients", () => {
  // The same person can end up in both To and Cc.
  it("keeps an address in To and drops its Cc copy, whatever the case or name", () => {
    const out = dedupeRecipients('"Sample, Sam" <Sam@Client.invalid>, desma@example.com', "sam@client.invalid, Ops <ops@example.com>");
    assert.equal(out.to, '"Sample, Sam" <Sam@Client.invalid>, desma@example.com');
    assert.equal(out.cc, "Ops <ops@example.com>");
    assert.deepEqual(out.dropped, ["sam@client.invalid"]);
  });

  it("leaves distinct recipients alone and returns no Cc when none is left", () => {
    assert.deepEqual(dedupeRecipients("a@example.com", null), { to: "a@example.com", cc: null, dropped: [] });
    assert.deepEqual(dedupeRecipients("a@example.com", "A@example.com"), { to: "a@example.com", cc: null, dropped: ["a@example.com"] });
  });
});

import { goneThreadText } from "../gmail.ts";

describe("opening a thread Gmail no longer has", () => {
  it("says so in plain words instead of passing Gmail's 404 through", () => {
    const text = goneThreadText("api error (404): that thread is gone");
    assert.ok(text !== null && !/404|google api/i.test(text), String(text));
  });

  it("leaves any other failure as it is", () => {
    assert.equal(goneThreadText("connect failed: no route to the mail host"), null);
    assert.equal(goneThreadText("api error (500): the backend is busy, try later"), null);
  });
});

import { createGwRunner, gwTimeoutText } from "../gmail.ts";

describe("a gw call that runs past its timeout", () => {
  it("names the subcommand and the limit, not the account or the query", () => {
    assert.equal(gwTimeoutText(["--account", "alpha", "gmail", "drafts", "--max", "200"], 60_000), "gw gmail drafts timed out after 60s");
    assert.equal(gwTimeoutText(["--account", "beta", "gmail", "search", "from:desma@example.com", "--max", "5"], 60_000), "gw gmail search timed out after 60s");
  });

  it("says timed out instead of a bare Command failed", async () => {
    const runner = createGwRunner("sleep");
    await assert.rejects(runner.run(["5"], { timeoutMs: 200 }), /timed out after 200ms/);
  });

  it("is not reported as a timeout when the caller aborted it", async () => {
    const runner = createGwRunner("sleep");
    const controller = new AbortController();
    const run = runner.run(["5"], { timeoutMs: 10_000, signal: controller.signal });
    controller.abort();
    await assert.rejects(run, (error: Error) => !/timed out/.test(error.message));
  });
});

import { GW_TIMEOUT_MS, gwListTimeoutMs } from "../gmail.ts";

describe("how long a Gmail listing may take", () => {
  it("gives the sync's big pages longer than a minute, at roughly half a second per item", () => {
    assert.ok(gwListTimeoutMs(200) >= 150_000, "a listing of 200 items can take over two minutes");
    assert.ok(gwListTimeoutMs(100) > 60_000, "a search of 100 items can take over a minute");
  });

  it("keeps small reads at the default and never waits more than three minutes", () => {
    assert.equal(gwListTimeoutMs(10), GW_TIMEOUT_MS);
    assert.equal(gwListTimeoutMs(5000), 180_000);
  });
});
