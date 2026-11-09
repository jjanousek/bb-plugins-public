// The chief's skill grant, run through the SDK's own configure() check.
//
// CHIEF_SKILLS may only name skills this plugin ships: bb refuses the whole
// configuration over an unknown id, which would leave the chief with no comms
// tools. These tests use the fake host's resolveAgentConfiguration, which
// applies the same known-id rule as the real host, fed with the skill ids this
// plugin actually ships.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

import { CHIEF_SKILLS, grantableSkills, shippedSkillIds } from "../skill-grant.ts";

const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));
const SHIPPED = [...shippedSkillIds(SKILLS_DIR)];
const TOOL = "comms_inbox";

/** What the chief is given for a turn when configure() returns this skill list. */
async function chiefGets(skills: string[]) {
  const host = createFakePluginHost({ pluginId: "chief-of-comms", agentSkillIds: SHIPPED });
  host.bb.agents.registerTool({ name: TOOL, description: "x", parameters: { type: "object", properties: {} } as never, execute: () => "ok" });
  host.bb.agents.configure(() => ({ tools: [TOOL], skills }));
  const result = await host.harness.resolveAgentConfiguration({
    thread: { id: "t1", projectId: "p1", environmentId: null, providerId: "claude-code", title: null },
    origin: { kind: "user", pluginId: null },
  } as never);
  await host.harness.dispose();
  return { tools: result.tools.map((t: { name: string }) => t.name), skills: result.skills };
}

describe("the chief's skill grant", () => {
  it("ships the chief-of-comms skill and not unslop, which is an optional user skill", () => {
    assert.ok(SHIPPED.includes("chief-of-comms"));
    assert.ok(!SHIPPED.includes("unslop"));
  });

  it("a list naming an unshipped skill costs the chief every tool", async () => {
    const bad = await chiefGets(["chief-of-comms", "unslop"]);
    assert.deepEqual(bad.tools, [], "bb drops the tools with the skills when one id is unknown");
    assert.deepEqual(bad.skills, []);
  });

  it("the shipped list keeps the tools and the skill", async () => {
    const now = await chiefGets(grantableSkills(CHIEF_SKILLS, new Set(SHIPPED)).granted);
    assert.deepEqual(now.tools, [TOOL]);
    assert.deepEqual(now.skills, ["chief-of-comms"]);
  });

  it("CHIEF_SKILLS names nothing the plugin does not ship", () => {
    assert.deepEqual(grantableSkills(CHIEF_SKILLS, new Set(SHIPPED)).unknown, []);
  });

  it("an unknown id is filtered out rather than passed to bb", async () => {
    const grant = grantableSkills(["chief-of-comms", "unslop"], new Set(SHIPPED));
    assert.deepEqual(grant.unknown, ["unslop"]);
    const now = await chiefGets(grant.granted);
    assert.deepEqual(now.tools, [TOOL]);
  });
});
