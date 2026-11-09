// A replaced draft says so, and the CLI help
// stops offering sends to agents. Names and texts are invented.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { replacedBy, replacedLine } from "../draft-replace.ts";

const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
const usage = source.slice(source.indexOf("  const usage = ["), source.indexOf('].join("\\n");', source.indexOf("  const usage = [")));

describe("the CLI help stops offering sends to agents", () => {
  it("has no 'Send now' and says the send commands are refused from any thread", () => {
    assert.ok(usage.length > 200, "found the usage text");
    assert.doesNotMatch(usage, /Send now/);
    assert.doesNotMatch(usage, /say-so|no further confirmation/);
    for (const command of ["bb comms approve <key>", "bb comms wa approve <draftId>", "bb comms wa send <chat> <text>"]) {
      const line = usage.split("\n").find((l) => l.includes(command)) ?? "";
      assert.match(line, /refused from any thread/, command);
    }
  });
});

describe("a second draft into one chat says it replaced the first", () => {
  const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const first = { text: "Friday at 4 works for us.", updatedAt: Date.parse("2031-09-12T06:30:00Z") };

  it("a different text is a replacement that names the first text and its author", () => {
    const replaced = replacedBy(first, "Saturday at 10 is better.", "the chief");
    assert.ok(replaced);
    const line = replacedLine(replaced, fmt);
    assert.match(line, /^Replaced the pending draft written 06:30 by the chief; previous text: Friday at 4 works for us\.$/);
  });

  it("no pending draft, or the same text, is not a replacement", () => {
    assert.equal(replacedBy(null, "x", "The user"), null);
    assert.equal(replacedBy(first, "  Friday at 4 works for us. ", "The user"), null);
  });

  it("a long previous text is cut at 200 characters", () => {
    const line = replacedLine({ text: "word ".repeat(80), by: "The user", updatedAt: 0 }, fmt);
    assert.ok(line.length < 300);
    assert.match(line, /…$/);
  });

  it("wa draft, the tool and bb comms draft all reply with it", () => {
    assert.match(source, /name: "comms_wa_draft"[\s\S]{0,900}result\.replaced[\s\S]{0,80}replacedText\(result\.replaced\)/);
    assert.match(source, /case "draft": \{[\s\S]{0,600}createWaDraft\(chat, text, ctx\.threadId \?\? null\)[\s\S]{0,300}replacedText\(result\.replaced\)/);
    assert.match(source, /saveDraftReporting\(key, text, ctx\.signal, ctx\.threadId \?\? null\)[\s\S]{0,200}replacedText\(replaced\)/);
  });
});
