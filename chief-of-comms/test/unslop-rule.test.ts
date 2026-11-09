// Every draft this plugin asks for is read by someone other than the owner,
// so the rule for the optional third-party unslop skill belongs on the draft
// path rather than in a document. These
// read the source, because the properties are structural: a rule that names a
// skill the chief was never granted reads as followed and is not, and a rule
// that sits only in the standing instructions is missed by a chief acting on a
// single request.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

describe("the unslop rule on the draft path", () => {
  it("names the skill and puts the user's rules after it", () => {
    const rule = source.slice(source.indexOf("const UNSLOP_RULE"), source.indexOf("function chiefInstructions"));
    assert.match(rule, /`unslop` skill/);
    assert.match(rule, /before you save it as a draft/);
    // The id the chief's Skill tool lists it under. Naming the skill without
    // how to call it would let a draft be saved with no Skill call at all and
    // the rule applied from memory.
    assert.match(rule, /`bb-global-skills:unslop`/);
    // Order matters: his rules win, so they are applied second and said so.
    assert.ok(
      rule.indexOf("unslop") < rule.indexOf("the user's voice rules"),
      "unslop runs first, then his voice rules",
    );
    assert.match(rule, /let his win on any conflict/);
    // The skill is optional and not shipped: the rule says so and what to do
    // without it.
    assert.match(rule, /If a drafting-style user skill named `unslop` is installed/);
    assert.match(rule, /If no such skill is installed, skip this step/);
  });

  it("is reachable without a plugin grant, and never granted as a plugin skill", () => {
    // CHIEF_SKILLS only accepts skills this plugin ships; unslop is an
    // optional user skill in ~/.bb/skills, which reaches every thread without
    // a grant when it is installed.
    // Listing it would make bb refuse the whole configuration and leave the
    // chief without its tools. test/skill-grant.test.ts pins the grant itself.
    const grant = readFileSync(new URL("../skill-grant.ts", import.meta.url), "utf8");
    const list = grant.slice(grant.indexOf("export const CHIEF_SKILLS"), grant.indexOf("export function shippedSkillIds"));
    assert.doesNotMatch(list, /"unslop"/);
    assert.match(source, /Unslop is a user skill/, "server.ts says why it is not granted");
  });

  it("reaches every draft request, not only the standing instructions", () => {
    // Four request builders: WhatsApp with and without a pending draft, mail
    // with and without an existing one. A chief acting on one request sees the
    // request, so the rule has to be in it.
    const uses = source.split("UNSLOP_RULE").length - 1;
    assert.ok(uses >= 6, `expected the definition, the instructions and four request paths, found ${uses}`);
    const instructions = source.slice(source.indexOf("function chiefInstructions"), source.indexOf("type ToolResult"));
    assert.match(instructions, /UNSLOP_RULE/);
  });
});

describe("bb comms ask asks for facts only", () => {
  it("says so in the usage and the help line", () => {
    const entry = source.slice(source.indexOf('name: "ask"'), source.indexOf('name: "ask"') + 500);
    assert.match(entry, /facts only/i);
    assert.match(entry, /never how to draft, address or send/);
    assert.match(source, /bb comms ask "<facts only>"/);
  });
});
