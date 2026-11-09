// The execution bar offers what bb reports for a thread's provider and nothing
// else: catalog models in catalog order, the current model even when the catalog
// dropped it, the levels the model supports, and permission modes capped at the
// machine ceiling. These tests mirror the "execution options" block in
// chief-of-staff/core.test.ts; the mapping file is vendored from there.
//
// Run with: npm test  (node --test, native TypeScript stripping, Node 22.18+)

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  modelChoices,
  modelLabel,
  permissionChoices,
  reasoningChoices,
  reasoningForModel,
  type CatalogModel,
  type CatalogProvider,
} from "../components/comms/execution-options.ts";

describe("execution options: what the bar offers for a thread", () => {
  const efforts = (...levels: CatalogModel["defaultReasoningEffort"][]) => levels.map((reasoningEffort) => ({ reasoningEffort }));
  const catalog: CatalogModel[] = [
    { model: "claude-fable-5-1", displayName: "Fable 5.1", defaultReasoningEffort: "high", supportedReasoningEfforts: efforts("low", "medium", "high", "xhigh", "ultracode", "max") },
    { model: "opencode/glm-5-free", displayName: "GLM-5 Free", defaultReasoningEffort: "high", supportedReasoningEfforts: efforts("low", "medium", "high", "xhigh") },
  ];
  const provider: CatalogProvider = {
    reasoningLevels: [{ id: "xhigh", label: "Extra High" }, { id: "low", label: "Quick" }],
    capabilities: { permissionModes: ["accept-edits", "auto", "full"] },
  };

  it("modelLabel uses the catalog name and falls back to the id without its vendor", () => {
    assert.equal(modelLabel("claude-fable-5-1", catalog), "Fable 5.1");
    assert.equal(modelLabel("opencode/muse-spark-1.3-contributor-free", catalog), "muse-spark-1.3-contributor-free");
  });

  it("modelChoices keeps catalog order and lists an uncatalogued current model first", () => {
    assert.deepEqual(modelChoices("opencode/glm-5-free", catalog).map((c) => c.value), ["claude-fable-5-1", "opencode/glm-5-free"]);
    const withStray = modelChoices("other-bridge/fable", catalog);
    assert.equal(withStray[0]?.value, "other-bridge/fable");
    assert.equal(withStray[0]?.short, "fable");
    assert.equal(withStray.length, 3);
  });

  it("reasoningChoices follows the model's list with the provider's labels, host wording otherwise", () => {
    const choices = reasoningChoices("high", "opencode/glm-5-free", catalog, provider);
    assert.deepEqual(choices.map((c) => c.value), ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(choices.map((c) => c.short), ["Quick", "Medium", "High", "Extra High"]);
  });

  it("reasoningChoices always offers the current level, and falls back to the provider then to every level", () => {
    assert.equal(reasoningChoices("ultracode", "opencode/glm-5-free", catalog, provider)[0]?.value, "ultracode");
    assert.deepEqual(reasoningChoices("low", "unknown", catalog, provider).map((c) => c.value), ["xhigh", "low"]);
    assert.equal(reasoningChoices("medium", "unknown", catalog, null).length, 8);
  });

  it("reasoningForModel keeps a level the new model supports and otherwise picks its default", () => {
    assert.equal(reasoningForModel("high", "opencode/glm-5-free", catalog), null);
    assert.equal(reasoningForModel("ultracode", "opencode/glm-5-free", catalog), "high");
    assert.equal(reasoningForModel("ultracode", "unknown", catalog), null);
  });

  it("permissionChoices caps at the ceiling, drops auto for omp, and keeps the current mode", () => {
    assert.deepEqual(permissionChoices("full", provider, "full").map((c) => c.value), ["accept-edits", "auto", "full"]);
    assert.deepEqual(permissionChoices("accept-edits", provider, "auto").map((c) => c.value), ["accept-edits", "auto"]);
    assert.deepEqual(permissionChoices("full", provider, "auto").map((c) => c.value), ["accept-edits", "auto", "full"]);
    assert.deepEqual(permissionChoices("full", provider, "full", true).map((c) => c.value), ["accept-edits", "full"]);
    assert.deepEqual(permissionChoices("full", null, "full").map((c) => c.short), ["Edits", "Auto", "Full"]);
  });
});
