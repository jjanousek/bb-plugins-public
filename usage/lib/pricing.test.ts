import { describe, expect, it } from "vitest";
import { canonicalModelId, normalizeProviderId, priceFor, resetPricingCatalog, resolvePricing, setPricingCatalog, pricingVersion } from "./pricing";

describe("models.dev pricing", () => {
  it("uses provider/model rates from the bundled snapshot", () => {
    expect(priceFor("openai", "gpt-5.6-terra")).toEqual({ input: 2, cached: 0.2, cacheWrite: 2.5, cacheWrite1h: 4, output: 12 });
    expect(priceFor("anthropic", "claude-fable-5")).toEqual({ input: 10, cached: 1, cacheWrite: 12.5, cacheWrite1h: 20, output: 50 });
    expect(priceFor("xai", "grok-4.5")).toEqual({ input: 2, cached: 0.3, cacheWrite: 2, cacheWrite1h: 4, output: 6 });
  });

  it("normalizes provider aliases and dated model suffixes", () => {
    expect(normalizeProviderId("x-ai")).toBe("xai");
    expect(priceFor("anthropic", "claude-sonnet-5-20990101")).toEqual(priceFor("anthropic", "claude-sonnet-5"));
  });

  it("prices a local Claude proxy and free-tier model ids at the tier the same tokens would bill at", () => {
    const cost = (input: number, output: number) => ({ input, output, cache_read: input / 10, cache_write: input * 1.25 });
    setPricingCatalog({
      anthropic: { name: "Anthropic", models: {
        "claude-fable-5-1": { id: "claude-fable-5-1", cost: cost(10, 50) },
        "claude-fable-5": { id: "claude-fable-5", cost: cost(10, 50) },
        "claude-haiku-4-5": { id: "claude-haiku-4-5", cost: cost(1, 5) },
      } },
      opencode: { name: "OpenCode Zen", models: {
        "quill-3": { id: "quill-3", cost: cost(2, 8) },
        "quill-3-free": { id: "quill-3-free", cost: cost(0, 0) },
      } },
    }, "models.dev@2031-05-27T08:00:00.000Z");
    try {
      expect(normalizeProviderId("my-claude-proxy")).toBe("anthropic");
      expect(resolvePricing("my-claude-proxy", "claude-fable-5-1")).toMatchObject({ modelProviderId: "anthropic", status: "models-dev-exact", price: { input: 10, output: 50 } });
      // Pricing follows the canonical id, so an alias is never priced separately.
      expect(priceFor("my-claude-proxy", "sonnet")).toEqual(priceFor("anthropic", "claude-sonnet-4-6"));
      expect(priceFor("my-claude-proxy", "fable")).toEqual(priceFor("anthropic", "claude-fable-5"));
      expect(priceFor("my-claude-proxy", "haiku")).toEqual(priceFor("anthropic", "claude-haiku-4-5-20251001"));
      expect(priceFor("opencode", "quill-3-free")).toMatchObject({ input: 2, output: 8 });
      expect(resolvePricing("opencode", "quill-3-free").status).toBe("models-dev-exact");
    } finally {
      resetPricingCatalog();
    }
  });

  it("reports each model under one canonical id whichever harness saw it", () => {
    // Some harnesses report short aliases; Claude Code reports the full id.
    expect(canonicalModelId("my-claude-proxy", "opus")).toBe("claude-opus-4-8");
    expect(canonicalModelId("my-claude-proxy", "sonnet")).toBe("claude-sonnet-4-6");
    expect(canonicalModelId("my-claude-proxy", "haiku")).toBe("claude-haiku-4-5-20251001");
    expect(canonicalModelId("my-claude-proxy", "fable")).toBe("claude-fable-5");
    // Already-canonical ids and ids only one agent knows are left alone.
    expect(canonicalModelId("my-claude-proxy", "claude-opus-5")).toBe("claude-opus-5");
    expect(canonicalModelId("my-claude-proxy", "claude-fable-5-1")).toBe("claude-fable-5-1");
    expect(canonicalModelId("anthropic", "claude-fable-5")).toBe("claude-fable-5");
    expect(canonicalModelId("opencode", "quill-3-free")).toBe("quill-3-free");
    // An alias reported by either harness lands on the same id as the other.
    expect(canonicalModelId("my-claude-proxy", "fable")).toBe(canonicalModelId("anthropic", "claude-fable-5"));
  });

  it("does not assign an unrelated fallback price to unknown models", () => {
    expect(priceFor("custom-local", "unreleased-model")).toBeNull();
    expect(resolvePricing("custom-local", "unreleased-model")).toMatchObject({ status: "unknown", price: null });
  });

  it("derives the displayed version from the bundled snapshot", () => {
    expect(pricingVersion()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("prefers an activated live catalog over the bundled snapshot", () => {
    setPricingCatalog({
      openai: {
        name: "OpenAI",
        models: { "gpt-test-model": { id: "gpt-test-model", cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 1.5 } } },
      },
    }, "models.dev@2031-05-20T08:00:00.000Z");
    expect(priceFor("openai", "gpt-test-model")).toEqual({ input: 1, cached: 0.5, cacheWrite: 1.5, cacheWrite1h: 2, output: 2 });
    expect(pricingVersion()).toBe("2031-05-20");
    resetPricingCatalog();
    expect(priceFor("openai", "gpt-test-model")).toBeNull();
    expect(pricingVersion()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("prices Opus 5.5, Sonnet 5.5, Fable 5.1, Haiku 5.5, Gemini 4 Argon, and Gemini 3.8 Flash before the catalog lists them", () => {
    expect(resolvePricing("anthropic", "claude-opus-5-5")).toMatchObject({
      status: "models-dev-exact", price: { input: 4, cached: 0.2, cacheWrite: 5, cacheWrite1h: 8, output: 20 },
    });
    expect(resolvePricing("anthropic", "claude-sonnet-5-5")).toMatchObject({
      status: "models-dev-exact", price: { input: 2, cached: 0.1, cacheWrite: 2.5, cacheWrite1h: 4, output: 10 },
    });
    expect(resolvePricing("anthropic", "claude-fable-5-1")).toMatchObject({
      status: "models-dev-exact", price: { input: 10, cached: 0.25, cacheWrite: 12.5, cacheWrite1h: 20, output: 50 },
    });
    expect(resolvePricing("anthropic", "claude-haiku-5-5")).toMatchObject({
      status: "models-dev-exact", price: { input: 0.1, cached: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2, output: 0.5 },
    });
    expect(resolvePricing("google", "gemini-4-argon")).toMatchObject({
      modelProviderId: "google", modelProviderName: "Google", status: "models-dev-exact",
      price: { input: 2, cached: 0.1, cacheWrite: 2, cacheWrite1h: 4, output: 10 },
    });
    expect(resolvePricing("google", "gemini-3.8-flash")).toMatchObject({
      modelProviderId: "google", modelProviderName: "Google", status: "models-dev-exact",
      price: { input: 0.75, cached: 0.075, cacheWrite: 0.75, cacheWrite1h: 1.5, output: 3.75 },
    });
    expect(resolvePricing("google", "gemini-3.7-flash")).toMatchObject({
      modelProviderId: "google", modelProviderName: "Google", status: "models-dev-exact",
      price: { input: 0.75, cached: 0.075, cacheWrite: 0.75, cacheWrite1h: 1.5, output: 3.75 },
    });
    expect(resolvePricing("google", "gemini-3.1-pro")).toMatchObject({
      modelProviderId: "google", status: "models-dev-exact",
      price: { input: 2, cached: 0.2, cacheWrite: 2, cacheWrite1h: 4, output: 12 },
    });
    expect(resolvePricing("google", "gemini-3-flash")).toMatchObject({
      modelProviderId: "google", status: "models-dev-exact",
      price: { input: 0.5, cached: 0.05, cacheWrite: 0.5, cacheWrite1h: 1, output: 3 },
    });
    expect(resolvePricing("anthropic", "claude-opus-5").price).toMatchObject({ input: 5, output: 25 });
  });

  it("resolves google-antigravity and a local Claude proxy provider and strips effort suffixes", () => {
    expect(normalizeProviderId("google-antigravity")).toBe("google");
    expect(normalizeProviderId("my-claude-proxy")).toBe("anthropic");
    expect(canonicalModelId("google-antigravity", "gemini-4-argon-high")).toBe("gemini-4-argon");
    expect(canonicalModelId("google-antigravity", "gemini-3.8-flash-medium")).toBe("gemini-3.8-flash");
    expect(canonicalModelId("google-antigravity", "claude-opus-5-5-high")).toBe("claude-opus-5-5");
    expect(canonicalModelId("my-claude-proxy", "claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(resolvePricing("google-antigravity", "gemini-4-argon")).toMatchObject({
      modelProviderId: "google", modelProviderName: "Google", status: "models-dev-exact",
      price: { input: 2, cached: 0.1, cacheWrite: 2, cacheWrite1h: 4, output: 10 },
    });
    expect(resolvePricing("google-antigravity", "claude-opus-5-5")).toMatchObject({
      modelProviderId: "anthropic", modelProviderName: "Anthropic", status: "models-dev-exact",
      price: { input: 4, cached: 0.2, cacheWrite: 5, cacheWrite1h: 8, output: 20 },
    });
    expect(resolvePricing("my-claude-proxy", "claude-opus-5-5")).toMatchObject({
      modelProviderId: "anthropic", modelProviderName: "Anthropic", status: "models-dev-exact",
      price: { input: 4, cached: 0.2, cacheWrite: 5, cacheWrite1h: 8, output: 20 },
    });
  });
});
