import { generatedAt, providers } from "@opencode-ai/models/snapshot";
import type { ModelCost } from "@opencode-ai/models";

// cacheWrite is the 5-minute cache write, the rate models.dev lists as
// cache_write. cacheWrite1h is the 1-hour write, which models.dev does not
// list; Anthropic bills it at 2x the input rate against 1.25x for 5 minutes.
export type Price = { input: number; cached: number; cacheWrite: number; cacheWrite1h: number; output: number };
export type PricingStatus = "models-dev-exact" | "models-dev-alias" | "logged" | "unknown";
export type PricingResult = {
  modelProviderId: string;
  modelProviderName: string;
  price: Price | null;
  status: Exclude<PricingStatus, "logged">;
};

type CatalogModel = { id: string; cost?: ModelCost };
export type CatalogProvider = { id?: string; name?: string; models: Record<string, CatalogModel> };
const catalog = providers as unknown as Record<string, CatalogProvider>;

let activeCatalog: { revision: string; providers: Record<string, CatalogProvider> } | null = null;

export function setPricingCatalog(providers: Record<string, CatalogProvider>, revision: string) {
  activeCatalog = { revision, providers };
}

export function resetPricingCatalog() {
  activeCatalog = null;
}

function activeProviders() {
  return activeCatalog?.providers ?? catalog;
}

const providerAliases: Record<string, string> = {
  bedrock: "amazon-bedrock",
  vertex: "google-vertex",
  "x-ai": "xai",
  copilot: "github-copilot",
  // Example id for a locally proxied Claude subscription that answers as an
  // OpenAI-style endpoint and bills nothing per token. Its tokens are
  // Anthropic tokens, so they are priced at Anthropic list. Add your own
  // local provider ids here.
  "my-claude-proxy": "anthropic",
  // Google OAuth pools (Antigravity and Gemini CLI) in omp.
  "google-antigravity": "google",
  "google-gemini-cli": "google",
};

// The same model reaches the page under different names depending on the
// harness: some report short aliases (`fable`, `haiku`), while Claude Code
// reports the full id. Report every row under one canonical id so the Model
// breakdown aggregates a model into a single row no matter which agent
// produced it, and so pricing resolves the canonical id instead of the alias.
// Keyed by normalized provider id and lowercased model; each target is the
// full model id the alias stands for.
const canonicalModelIds: Record<string, string> = {
  "anthropic/fable": "claude-fable-5",
  "anthropic/haiku": "claude-haiku-4-5-20251001",
  "anthropic/sonnet": "claude-sonnet-4-6",
  "anthropic/opus": "claude-opus-4-8",
  "google/gemini-2.5-flash-thinking": "gemini-2.5-flash",
};
// Model ids that carry no list price of their own, priced at the tier the same
// tokens would bill at. Keyed by normalized provider id and lowercased model.
// Free and flat-plan tiers keep their $0 in the agent's own cost log; the page
// shows the standard-rate estimate, the same rule Claude Code Max rows follow.
// Unlike a canonical id this only redirects the price lookup: the row keeps its
// own model id, because the free tier is a distinct thing to see on the page.
// The opencode entry is an example; add your own free-tier ids beside it.
const modelPriceAliases: Record<string, string> = {
  "opencode/quill-3-free": "quill-3",
  // models.dev's google catalog lists these under their -preview ids.
  "google/gemini-3.1-pro": "gemini-3.1-pro-preview",
  "google/gemini-3-pro": "gemini-3-pro-preview",
  "google/gemini-3-flash": "gemini-3-flash-preview",
  "google/gemini-4-argon-contributor": "gemini-4-argon",
};

// List prices for models released after the bundled snapshot and before the
// daily models.dev refresh picks them up. The catalog wins once it has the
// model; this only stops a new model pricing as its older sibling meanwhile.
// USD per million tokens, from models.dev's anthropic and google entries.
const pendingCatalogPrices: Record<string, Price> = {
  "anthropic/claude-opus-5-5": { input: 4, cached: 0.2, cacheWrite: 5, cacheWrite1h: 8, output: 20 },
  "anthropic/claude-sonnet-5-5": { input: 2, cached: 0.1, cacheWrite: 2.5, cacheWrite1h: 4, output: 10 },
  "anthropic/claude-fable-5-1": { input: 10, cached: 0.25, cacheWrite: 12.5, cacheWrite1h: 20, output: 50 },
  "anthropic/claude-haiku-5-5": { input: 0.1, cached: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2, output: 0.5 },
  "google/gemini-4-argon": { input: 2, cached: 0.1, cacheWrite: 2, cacheWrite1h: 4, output: 10 },
  "google/gemini-3.8-flash": { input: 0.75, cached: 0.075, cacheWrite: 0.75, cacheWrite1h: 1.5, output: 3.75 },
  "google/gemini-3.7-flash": { input: 0.75, cached: 0.075, cacheWrite: 0.75, cacheWrite1h: 1.5, output: 3.75 },
  "google/gemini-3-pro-preview": { input: 2, cached: 0.2, cacheWrite: 2, cacheWrite1h: 4, output: 12 },
};

export function pricingRevision() {
  return activeCatalog?.revision ?? generatedAt;
}

export function pricingVersion() {
  const revision = pricingRevision();
  return (revision.includes("@") ? revision.slice(revision.indexOf("@") + 1) : revision).slice(0, 10);
}

export function normalizeProviderId(providerId: string) {
  const normalized = providerId.trim().toLowerCase().replace(/_/g, "-");
  return providerAliases[normalized] ?? (normalized || "unknown");
}

function bareModelId(providerId: string, model: string) {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith(`${providerId}/`) ? normalized.slice(providerId.length + 1) : normalized;
}

function normalizeVendorModelId(model: string) {
  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("gemini-")) {
    const stripped = lower.replace(/-(?:minimal|low|medium|high|xhigh|max)$/, "");
    return stripped !== lower ? stripped : trimmed;
  }
  if (lower.startsWith("claude-")) {
    const normalized = lower
      .replace(/\[1m\]$/, "")
      .replace(/-(?:minimal|low|medium|high|xhigh|max)$/, "")
      .replace(/(\d)\.(\d)/g, "$1-$2");
    return normalized !== lower ? normalized : trimmed;
  }
  return trimmed;
}

function effectiveProviderId(rawProviderId: string, model: string) {
  const providerId = normalizeProviderId(rawProviderId);
  const bare = bareModelId(providerId, model);
  // Google Antigravity can also serve Claude models; their rate card is Anthropic's.
  if (providerId === "google" && bare.startsWith("claude-")) return "anthropic";
  return providerId;
}

/**
 * The id a model is reported and aggregated under, whichever harness saw it.
 * Returns the model unchanged when it is already canonical, so ids that are
 * only known to one agent (a free-tier id) keep their own name.
 */
export function canonicalModelId(rawProviderId: string, model: string) {
  const providerId = effectiveProviderId(rawProviderId, model);
  const bare = normalizeVendorModelId(bareModelId(providerId, model));
  return canonicalModelIds[`${providerId}/${bare.toLowerCase()}`] ?? normalizeVendorModelId(model);
}

function normalizedModelIds(providerId: string, model: string) {
  const canonical = canonicalModelId(providerId, model).trim().toLowerCase();
  const withoutProvider = bareModelId(providerId, canonical);
  // The alias goes first: free tiers have a $0 catalog entry that would win an exact match.
  const aliased = modelPriceAliases[`${providerId}/${withoutProvider}`];
  return [...new Set([...(aliased ? [aliased] : []), canonical, withoutProvider])];
}

function toPrice(cost: ModelCost): Price | null {
  const input = Number(cost.input);
  const output = Number(cost.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const cached = Number(cost.cache_read ?? input);
  const cacheWrite = Number(cost.cache_write ?? input);
  return {
    input: Math.max(0, input),
    cached: Number.isFinite(cached) ? Math.max(0, cached) : Math.max(0, input),
    cacheWrite: Number.isFinite(cacheWrite) ? Math.max(0, cacheWrite) : Math.max(0, input),
    cacheWrite1h: Math.max(0, input) * 2,
    output: Math.max(0, output),
  };
}

function providerName(providerId: string, provider?: CatalogProvider) {
  return provider?.name?.trim() || providerId.split("-").map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function matchWithinProvider(providerId: string, provider: CatalogProvider, model: string): PricingResult | null {
  const modelIds = normalizedModelIds(providerId, model);
  for (const modelId of modelIds) {
    const exact = provider.models[modelId];
    const price = exact?.cost ? toPrice(exact.cost) : null;
    if (price) return { modelProviderId: providerId, modelProviderName: providerName(providerId, provider), price, status: "models-dev-exact" };
  }

  const alias = Object.values(provider.models)
    .filter((candidate) => candidate.cost && modelIds.some((modelId) =>
      modelId.startsWith(`${candidate.id.toLowerCase()}-`) || modelId.startsWith(`${candidate.id.toLowerCase()}:`)))
    .sort((a, b) => b.id.length - a.id.length)[0];
  const price = alias?.cost ? toPrice(alias.cost) : null;
  return price ? { modelProviderId: providerId, modelProviderName: providerName(providerId, provider), price, status: "models-dev-alias" } : null;
}

export function resolvePricing(rawProviderId: string, model: string): PricingResult {
  const modelProviderId = effectiveProviderId(rawProviderId, model);
  const provider = activeProviders()[modelProviderId];
  if (provider) {
    const match = matchWithinProvider(modelProviderId, provider, model);
    if (match?.status === "models-dev-exact") return match;
    const modelIds = normalizedModelIds(modelProviderId, model);
    const pending = modelIds.map((modelId) => pendingCatalogPrices[`${modelProviderId}/${modelId}`]).find(Boolean);
    if (pending) return { modelProviderId, modelProviderName: providerName(modelProviderId, provider), price: pending, status: "models-dev-exact" };
    if (match) return match;
    const pendingAlias = Object.entries(pendingCatalogPrices)
      .filter(([key]) => key.startsWith(`${modelProviderId}/`))
      .map(([key, price]) => ({ id: key.slice(modelProviderId.length + 1), price }))
      .filter((candidate) => modelIds.some((modelId) => modelId.startsWith(`${candidate.id}-`) || modelId.startsWith(`${candidate.id}:`)))
      .sort((a, b) => b.id.length - a.id.length)[0];
    if (pendingAlias) return { modelProviderId, modelProviderName: providerName(modelProviderId, provider), price: pendingAlias.price, status: "models-dev-alias" };
  }

  const exactMatches = Object.entries(activeProviders()).flatMap(([candidateId, candidate]) => {
    const exact = normalizedModelIds(modelProviderId, model).map((modelId) => candidate.models[modelId]).find((item) => item?.cost);
    const price = exact?.cost ? toPrice(exact.cost) : null;
    return price ? [{ modelProviderId: normalizeProviderId(candidateId), modelProviderName: providerName(candidateId, candidate), price }] : [];
  });
  if (exactMatches.length === 1) return { ...exactMatches[0]!, status: "models-dev-exact" };

  return { modelProviderId, modelProviderName: providerName(modelProviderId, provider), price: null, status: "unknown" };
}

export function priceFor(providerId: string, model: string): Price | null {
  return resolvePricing(providerId, model).price;
}
