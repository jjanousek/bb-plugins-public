// A conversation key names a thread, and a thread can hold more than one Gmail
// draft. The discard must not guess the newest, and must not delete a draft it
// holds no copy of. Both rules are pinned here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { chooseThreadDraft, mayDelete } from "../mail-discard.ts";

describe("which draft a thread-keyed discard may delete", () => {
  it("takes the only draft in the thread", () => {
    const chosen = chooseThreadDraft([{ draft_id: "r1", subject: "Re: hello", updated_at: 10 }], "t1");
    assert.deepEqual(chosen, { ok: true, draftId: "r1" });
  });

  it("refuses when the thread holds two, rather than picking the newest", () => {
    // The newest is the one the person just wrote, which is exactly the draft
    // that must not be destroyed by a command that did not name it.
    const chosen = chooseThreadDraft(
      [
        { draft_id: "old", subject: "stale check-in", updated_at: 10 },
        { draft_id: "new", subject: "Re: Zoom link", updated_at: 20 },
      ],
      "1a0000000000aaa1",
    );
    assert.equal(chosen.ok, false);
    if (chosen.ok) return;
    assert.match(chosen.reason, /has 2 Gmail drafts/);
    assert.match(chosen.reason, /Nothing was deleted/);
    // Both have to be named, or the caller cannot pick.
    assert.match(chosen.reason, /old/);
    assert.match(chosen.reason, /new/);
  });

  it("says there is nothing rather than refusing ambiguously", () => {
    const chosen = chooseThreadDraft([], "t1");
    assert.equal(chosen.ok, false);
    if (chosen.ok) return;
    assert.match(chosen.reason, /no Gmail draft/);
  });
});

describe("a discard that cannot be undone is refused", () => {
  it("allows the delete when bb has the draft cached", () => {
    assert.deepEqual(mayDelete({ cached: true, live: false }, "r1"), { ok: true, draftId: "r1" });
  });

  it("allows it when Gmail still answers for the id, even if bb never cached it", () => {
    assert.deepEqual(mayDelete({ cached: false, live: true }, "r1"), { ok: true, draftId: "r1" });
  });

  it("refuses when there is no source for the copy, instead of destroying it", () => {
    // A draft written through another tool and never synced has no copy to
    // take, so deleting it at Gmail would leave a restore that cannot work.
    const chosen = mayDelete({ cached: false, live: false }, "r-1000000000000001");
    assert.equal(chosen.ok, false);
    if (chosen.ok) return;
    assert.match(chosen.reason, /Nothing was deleted/);
    assert.match(chosen.reason, /cannot take the copy/);
  });
});

// The audit has to be unskippable, not merely present. These read the source,
// because the property is structural: the write must come before the delete
// and must not sit in a try/catch that would let the delete proceed unlogged.
describe("the discard audit cannot be skipped", () => {
  const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function keepThenDeleteMailDraft"));
  const fn = body.slice(0, body.indexOf("\n  }\n"));

  it("writes the audit row before Gmail is asked to delete", () => {
    const audit = fn.indexOf("recordMailDiscardAttempt");
    const del = fn.indexOf("mail.draftDelete");
    assert.ok(audit > 0, "the audit write is in keepThenDeleteMailDraft");
    assert.ok(del > 0, "the delete is in keepThenDeleteMailDraft");
    assert.ok(audit < del, "the audit row is written before the delete, not after it");
  });

  it("does not swallow an audit failure, which would delete unlogged", () => {
    // The guard: if recordMailDiscardAttempt ever throws, the throw has to
    // reach the caller so nothing is destroyed. A try wrapping it would undo
    // the whole point of the row.
    const upToAudit = fn.slice(0, fn.indexOf("recordMailDiscardAttempt"));
    const opens = (upToAudit.match(/\btry\s*\{/g) ?? []).length;
    const closes = (upToAudit.match(/\}\s*catch\b/g) ?? []).length;
    assert.equal(opens, closes, "the audit write is not inside an open try block");
  });
});
