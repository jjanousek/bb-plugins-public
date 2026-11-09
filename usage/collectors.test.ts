import { describe, expect, it } from "vitest";
import { parseCursor, parseHostUsageAggregates, parseOpenCode } from "./collectors";

const machine = { machineId: "machine-a", machineName: "Machine A" };

describe("usage collectors", () => {
  it("parses OpenCode metadata aggregates and rejects malformed output", () => {
    const content = JSON.stringify([{ day: "2031-04-22", modelProviderId: "anthropic", model: "claude-sonnet-5", loggedCostUsd: 0.02, inputTokens: 100, cachedInputTokens: 60, cacheWriteTokens: 5, outputTokens: 15, reasoningTokens: 5 }]);
    expect(parseOpenCode(content, machine)[0]).toMatchObject({
      eventKey: "opencode:machine-a:2031-04-22:anthropic:claude-sonnet-5", agentId: "opencode",
      modelProviderId: "anthropic", processedTokens: 185, cachedInputTokens: 60, uncachedInputTokens: 100,
      outputTokens: 20, costUsd: 0.02, loggedCostUsd: 0.02, pricingStatus: "logged", cacheSavingsUsd: 0.000108,
    });
    expect(() => parseOpenCode("not-json", machine)).toThrow("malformed JSON");
    expect(() => parseOpenCode(JSON.stringify([{}]), machine)).toThrow("invalid aggregate row at index 0");
    expect(() => parseOpenCode(JSON.stringify([{ day: "2031-04-22" }]), machine)).toThrow("invalid aggregate row at index 0");
    expect(parseOpenCode("[]", machine)).toEqual([]);
  });

  it("carries Cursor's own tokens and cost, and merges repeated day/model rows", () => {
    const content = JSON.stringify([
      { day: "2031-08-06", model: "cursor-model-b", events: 5, inputTokens: 310000, outputTokens: 21000, cacheReadTokens: 930000, cents: 470 },
      { day: "2031-08-05", model: "cursor-model-a", events: 8, inputTokens: 520000, outputTokens: 33000, cacheReadTokens: 2100000, cents: 830 },
      { day: "2031-08-07", model: "cursor-model-c", events: 2, inputTokens: 47000, outputTokens: 4700, cacheReadTokens: 0, cents: 130 },
      { day: "2031-08-05", model: "cursor-model-a", events: 6, inputTokens: 270000, outputTokens: 18000, cacheReadTokens: 1030000, cents: 640 },
    ]);
    const records = parseCursor(content, machine);
    expect(records).toHaveLength(3);
    expect(records[1]).toMatchObject({
      eventKey: "cursor:machine-a:2031-08-05:cursor-model-a",
      agentId: "cursor", agentName: "Cursor", modelProviderId: "xai",
      // Cursor's own model id, not bb's shorthand, and no project: its billing
      // record does not say which directory the work was done in.
      model: "cursor-model-a", project: "Unknown",
      turns: 14, uncachedInputTokens: 790000, outputTokens: 51000, cachedInputTokens: 3130000,
      // Cursor's own charge, never an API rate estimate.
      costUsd: 14.7, loggedCostUsd: 14.7, pricingStatus: "logged",
    });
    // Every model on the account is priced the same way.
    expect(records[0]).toMatchObject({ model: "cursor-model-b", turns: 5, costUsd: 4.7, pricingStatus: "logged" });
    expect(records[2]).toMatchObject({ model: "cursor-model-c", turns: 2, costUsd: 1.3, pricingStatus: "logged" });
  });

  it("keeps a Cursor call that was not charged at zero rather than estimating it", () => {
    const content = JSON.stringify([
      { day: "2031-05-14", model: "cursor-model-a", events: 3, inputTokens: 640, outputTokens: 20, cacheReadTokens: 0, cents: 0 },
    ]);
    expect(parseCursor(content, machine)[0]).toMatchObject({
      costUsd: 0, loggedCostUsd: 0, pricingStatus: "logged", turns: 3, uncachedInputTokens: 640,
    });
  });

  it("rejects malformed Cursor aggregates", () => {
    expect(() => parseCursor("not-json", machine)).toThrow("malformed JSON");
    expect(() => parseCursor(JSON.stringify({}), machine)).toThrow("unexpected result shape");
    expect(() => parseCursor(JSON.stringify([{}]), machine)).toThrow("invalid aggregate row at index 0");
    expect(() => parseCursor(JSON.stringify([{ day: "2031-05-14", model: "m" }]), machine))
      .toThrow("invalid aggregate row at index 0");
    expect(() => parseCursor(JSON.stringify([{ day: "14/05/2031", model: "m", events: 1, cents: 0 }]), machine))
      .toThrow("invalid aggregate row at index 0");
    expect(() => parseCursor(JSON.stringify([{ day: "2031-05-14", model: "m", events: 1.5, cents: 0 }]), machine))
      .toThrow("invalid aggregate row at index 0");
    expect(parseCursor("[]", machine)).toEqual([]);
  });

  it("leaves OpenCode cost unknown when the agent did not record a positive cost", () => {
    const content = JSON.stringify([{
      day: "2031-04-22", modelProviderId: "openai", model: "gpt-5.6-sol", loggedCostUsd: 0,
      inputTokens: 100, cachedInputTokens: 60, cacheWriteTokens: 5, outputTokens: 15, reasoningTokens: 5,
    }]);
    expect(parseOpenCode(content, machine)[0]).toMatchObject({
      modelProviderId: "openai", costUsd: 0, loggedCostUsd: null, pricingStatus: "unknown", cacheSavingsUsd: 0.00027,
    });
    expect(parseOpenCode(content.replace('"loggedCostUsd":0', '"loggedCostUsd":-0.01'), machine)[0]).toMatchObject({
      costUsd: 0, loggedCostUsd: null, pricingStatus: "unknown",
    });
  });

  it("prices 1-hour cache writes at twice the input rate and 5-minute ones at the listed rate", () => {
    const row = (cacheWrite1hTokens: number) => JSON.stringify([{
      day: "2031-04-22", modelProviderId: "anthropic", model: "claude-fable-5", loggedCostUsd: null, project: "p",
      uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 1_000_000, cacheWrite1hTokens, outputTokens: 0,
    }]);
    // Claude Fable 5 lists $10 input and $12.50 cache write per million tokens.
    expect(parseHostUsageAggregates(row(0), "claude", machine)[0]!.costUsd).toBe(12.5);
    expect(parseHostUsageAggregates(row(1_000_000), "claude", machine)[0]!.costUsd).toBe(20);
    expect(parseHostUsageAggregates(row(400_000), "claude", machine)[0]!.costUsd).toBe(15.5);
    // A row without the split, from any other harness, prices exactly as before.
    const unsplit = JSON.parse(row(0)); delete unsplit[0].cacheWrite1hTokens;
    expect(parseHostUsageAggregates(JSON.stringify(unsplit), "claude", machine)[0]!.costUsd).toBe(12.5);
  });

  it("keeps unknown models visible without inventing a price", () => {
    const content = JSON.stringify([{
      day: "2031-04-22", modelProviderId: "custom-local", model: "my-model", loggedCostUsd: null,
      uncachedInputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5,
    }]);
    expect(parseHostUsageAggregates(content, "pi", machine)[0]).toMatchObject({ costUsd: 0, pricingStatus: "unknown", processedTokens: 15 });
  });

  it("estimates cache savings for logged-cost-only records", () => {
    const content = JSON.stringify([{
      day: "2031-04-22",
      modelProviderId: "opencode-go",
      model: "hy3",
      loggedCostUsd: 0.01,
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheWriteTokens: 1,
      outputTokens: 200,
    }]);
    const record = parseHostUsageAggregates(content, "prime", machine)[0]!;
    expect(record).toMatchObject({ pricingStatus: "logged", loggedCostUsd: 0.01 });
    expect(record.cacheSavingsUsd).toBeGreaterThan(0);
  });

  it("prices host-side aggregates without exposing file metadata", () => {
    const content = JSON.stringify([{
      day: "2031-04-22",
      modelProviderId: "openai",
      model: "gpt-5.6-sol",
      loggedCostUsd: null,
      uncachedInputTokens: 40,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 20,
    }]);
    expect(parseHostUsageAggregates(content, "codex", machine)[0]).toMatchObject({
      eventKey: "codex:machine-a:2031-04-22:openai:gpt-5.6-sol:Unknown",
      day: "2031-04-22",
      agentId: "codex",
      modelProviderId: "openai",
      processedTokens: 125,
    });
    expect(parseHostUsageAggregates(content, "prime", machine)[0]).toMatchObject({
      eventKey: "prime:machine-a:2031-04-22:openai:gpt-5.6-sol:Unknown",
      agentId: "prime",
      agentName: "Prime Agent",
    });
  });

  it("uses FX-recorded spend without replacing it with API-rate estimates", () => {
    const aggregate = (loggedCostUsd: number | null) => JSON.stringify([{
      day: "2031-04-22",
      modelProviderId: "zai",
      model: "zai/glm-5.2",
      loggedCostUsd,
      uncachedInputTokens: 35,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 15,
    }]);
    expect(parseHostUsageAggregates(aggregate(0.015), "fx", machine)[0]).toMatchObject({
      eventKey: "fx:machine-a:2031-04-22:zai:zai%2Fglm-5.2:Unknown",
      agentId: "fx",
      agentName: "FX",
      modelProviderId: "zai",
      model: "zai/glm-5.2",
      processedTokens: 115,
      costUsd: 0.015,
      loggedCostUsd: 0.015,
      pricingStatus: "logged",
      cacheSavingsUsd: 0.000068,
    });
    expect(parseHostUsageAggregates(aggregate(0), "fx", machine)[0]).toMatchObject({
      costUsd: 0,
      loggedCostUsd: 0,
      pricingStatus: "logged",
    });
    expect(parseHostUsageAggregates(aggregate(null), "fx", machine)[0]).toMatchObject({
      costUsd: 0,
      loggedCostUsd: null,
      pricingStatus: "unknown",
    });
  });

  it("parses Antigravity host aggregates with the Antigravity agent name", () => {
    const content = JSON.stringify([{
      day: "2031-04-22",
      modelProviderId: "google",
      model: "gemini-4-ultra-preview",
      project: "Unknown",
      loggedCostUsd: null,
      uncachedInputTokens: 2000,
      cachedInputTokens: 8000,
      cacheWriteTokens: 0,
      outputTokens: 500,
    }]);
    expect(parseHostUsageAggregates(content, "antigravity", machine)[0]).toMatchObject({
      eventKey: "antigravity:machine-a:2031-04-22:google:gemini-4-ultra-preview:Unknown",
      agentId: "antigravity",
      agentName: "Antigravity",
      modelProviderId: "google",
      processedTokens: 10500,
    });
  });

  it("estimates omp host aggregates from a local Claude proxy provider at Anthropic list rates", () => {
    const content = JSON.stringify([{
      day: "2031-09-02",
      modelProviderId: "my-claude-proxy",
      model: "claude-opus-5-5",
      project: "demo-api",
      loggedCostUsd: 0,
      uncachedInputTokens: 2_500_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    }]);
    const record = parseHostUsageAggregates(content, "omp", machine)[0]!;
    expect(record).toMatchObject({
      eventKey: "omp:machine-a:2031-09-02:anthropic:claude-opus-5-5:demo-api",
      agentId: "omp",
      agentName: "omp",
      modelProviderId: "anthropic",
      costUsd: 10,
      loggedCostUsd: 0,
    });
    expect(record.pricingStatus).toMatch(/^models-dev-/);
  });

  it("stores short model aliases under the canonical model id and folds the duplicate rows", () => {
    const row = (model: string, uncachedInputTokens: number) => ({
      day: "2031-09-03", modelProviderId: "my-claude-proxy", model, project: "notes-app",
      loggedCostUsd: 0, uncachedInputTokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    });
    const records = parseHostUsageAggregates(JSON.stringify([
      row("haiku", 2_000_000), row("claude-fable-5", 250_000), row("fable", 750_000),
    ]), "omp", machine);

    // `fable` and `claude-fable-5` are the same model, so they are one row.
    expect(records).toHaveLength(2);
    const fable = records.find((record) => record.model === "claude-fable-5")!;
    expect(fable.eventKey).toBe("omp:machine-a:2031-09-03:anthropic:claude-fable-5:notes-app");
    expect(fable.uncachedInputTokens).toBe(1_000_000);
    expect(fable.costUsd).toBe(10);
    expect(records.find((record) => record.model === "haiku")).toBeUndefined();
    expect(records.find((record) => record.model === "claude-haiku-4-5-20251001")?.costUsd).toBe(2);
  });

  it("leaves a model id that only one agent reports alone", () => {
    const record = parseHostUsageAggregates(JSON.stringify([{
      day: "2031-09-04", modelProviderId: "opencode", model: "quill-3-free",
      project: "sample-site", loggedCostUsd: 0, uncachedInputTokens: 1_000_000, cachedInputTokens: 0,
      cacheWriteTokens: 0, outputTokens: 0,
    }]), "omp", machine)[0]!;
    // A free tier keeps its own id; its standard-rate price is covered in
    // lib/pricing.test.ts, which installs a catalog carrying the paid tier.
    expect(record.model).toBe("quill-3-free");
    expect(record.loggedCostUsd).toBe(0);
  });

  it("prices omp rows from google-antigravity and a local Claude proxy at standard API rates with cache savings", () => {
    const records = parseHostUsageAggregates(JSON.stringify([
      {
        day: "2031-10-08", modelProviderId: "my-claude-proxy", model: "claude-opus-5-5",
        project: "example-cli", loggedCostUsd: 0, uncachedInputTokens: 450_000, cachedInputTokens: 1_900_000,
        cacheWriteTokens: 0, outputTokens: 55_000,
      },
      {
        day: "2031-10-08", modelProviderId: "google-antigravity", model: "gemini-4-argon",
        project: "example-cli", loggedCostUsd: 1.5, uncachedInputTokens: 1_100_000, cachedInputTokens: 350_000,
        cacheWriteTokens: 0, outputTokens: 70_000,
      },
      {
        day: "2031-10-08", modelProviderId: "google-antigravity", model: "gemini-4-argon-high",
        project: "example-cli", loggedCostUsd: 0, uncachedInputTokens: 500_000, cachedInputTokens: 650_000,
        cacheWriteTokens: 0, outputTokens: 40_000,
      },
    ]), "omp", machine);

    expect(records).toHaveLength(2);
    const argon = records.find((record) => record.model === "gemini-4-argon")!;
    expect(argon).toMatchObject({
      eventKey: "omp:machine-a:2031-10-08:google:gemini-4-argon:example-cli",
      modelProviderId: "google",
      modelProviderName: "Google",
      pricingStatus: "models-dev-exact",
      uncachedInputTokens: 1_600_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 110_000,
      costUsd: 4.4,
      cacheSavingsUsd: 1.9,
    });
    const opus = records.find((record) => record.model === "claude-opus-5-5")!;
    expect(opus).toMatchObject({
      eventKey: "omp:machine-a:2031-10-08:anthropic:claude-opus-5-5:example-cli",
      modelProviderId: "anthropic",
      modelProviderName: "Anthropic",
      pricingStatus: "models-dev-exact",
      costUsd: 3.28,
      cacheSavingsUsd: 7.22,
    });
  });
});
