// Model summaries for the frontend tests, shaped like the ones the `models`
// RPC returns but written out here so a regenerated registry cannot silently
// rewrite what the picker and the form are being held to. The prices are test
// figures, several of them invented. The registry's own truth is
// test/models.test.ts; these are the shapes the UI has to render:
//
//   - tier tagged presets plus a Custom pixel size (Seedream)
//   - a long flat preset list, many ratios, and a rule that makes the ratio
//     moot (Ideogram)
//   - free width and height with an area rule (FLUX.2)
//   - no size control at all, everything in extras (GPT Image)
//   - resolution and ratio chips with a length span (Seedance)
//   - a length the vendor only allows at one resolution (Veo)
//   - reference images: Seedream covers the first and adds a fixed figure for each one
//     after, GPT Image bills a span from the first, and FLUX.2 takes them but
//     publishes no per image figure, so a quote with one has to refuse
import type { ModelCapabilities, ModelDefaults, ModelSummary, ModelsResult, ObservedShape } from "../contract";

const NO_CAPS: ModelCapabilities = {
  sizePresets: [],
  aspects: [],
  resolutions: [],
  dimensions: null,
  duration: null,
  audio: false,
  count: null,
  seed: true,
  negativePrompt: false,
  promptMaxChars: null,
  schemaDerived: false,
};

const NO_DEFAULTS: ModelDefaults = {
  sizePreset: null,
  aspect: null,
  resolution: null,
  width: null,
  height: null,
  duration: null,
  count: null,
  audio: null,
};

export function model(over: Partial<ModelSummary> & { key: string; label: string; vendor: string }): ModelSummary {
  return {
    kind: "image",
    node: over.key.split("/")[0]!,
    modelId: over.key.includes("/") ? over.key.slice(over.key.indexOf("/") + 1) : null,
    strengths: null,
    notes: null,
    capabilities: NO_CAPS,
    capabilityLine: "",
    price: null,
    priceLine: "price unknown",
    cheapestLine: "price unknown",
    defaults: NO_DEFAULTS,
    constraints: [],
    extras: [],
    roles: ["prompt", "seed"],
    supported: true,
    unsupportedReason: null,
    deprecated: false,
    hidden: false,
    recommended: false,
    documented: true,
    aliases: [],
    ...over,
  };
}

const SEEDREAM_1K = [
  "(1K) 1024x1024 (1:1)",
  "(1K) 864x1152 (3:4)",
  "(1K) 1152x864 (4:3)",
  "(1K) 1312x736 (16:9)",
  "(1K) 736x1312 (9:16)",
];
const SEEDREAM_2K = ["(2K) 2048x2048 (1:1)", "(2K) 1728x2304 (3:4)", "(2K) 2304x1728 (4:3)", "(2K) 2496x1664 (3:2)"];
const SEEDREAM_4K = ["(4K) 4096x4096 (1:1)", "(4K) 5504x3040 (16:9)"];

/**
 * The legacy V2 node: hidden in the picker, and the entry the bare id
 * "seedream 5.0 pro" in a saved setting resolves to, so the panel has to be
 * able to show a hidden model as the current one. The shipped default is the
 * V3 entry; test/server.test.ts holds that.
 */
export const SEEDREAM_5_PRO = model({
  key: "ByteDanceSeedreamNodeV2/seedream 5.0 pro",
  label: "Seedream 5.0 Pro (legacy node)",
  vendor: "ByteDance",
  strengths: "Keeps close to the prompt and to its references, at 1K and 2K",
  notes: "The node the plugin's frozen image graph uses.",
  capabilityLine: "1K to 2K",
  capabilities: {
    ...NO_CAPS,
    sizePresets: [...SEEDREAM_1K, ...SEEDREAM_2K, "Custom"],
    dimensions: { widthMin: 1024, widthMax: 3136, heightMin: 1024, heightMax: 2496, step: 2, widthDefault: 2048, heightDefault: 2048 },
    referenceImages: { min: 0, max: 10 },
  },
  defaults: { ...NO_DEFAULTS, sizePreset: "(1K) 1024x1024 (1:1)", width: 2048, height: 2048 },
  price: {
    unit: "per-image",
    credits: null,
    tiers: [
      { when: { resolution: "1K", maxPixels: 2_610_000 }, credits: 8 },
      { when: { resolution: "2K", minPixels: 2_610_001 }, credits: 16 },
    ],
    confidence: "published",
    note: "One figure up to 2.61 MP and a higher one above it.",
    reference: { credits: 0.5, included: 1 },
  },
  priceLine: "from 8 credits, about $0.04",
  constraints: [
    {
      when: { sizePreset: "Custom" },
      then: { dimensions: { minArea: 921_600, maxArea: 4_194_304, widthMin: 1024, widthMax: 3136, heightMin: 1024, heightMax: 2496, step: 2 } },
      note: "Custom sizes are checked by pixel area, not by edge.",
    },
  ],
  extras: [{ name: "thinking", type: "BOOLEAN", required: false, default: true, tooltip: "Prompt-optimization reasoning. Slower." }],
  roles: ["prompt", "model", "sizePreset", "width", "height", "seed", "watermark"],
  deprecated: true,
  hidden: true,
  aliases: ["seedream 5.0 pro"],
});

export const SEEDREAM_4 = model({
  key: "ByteDanceSeedreamNodeV3/seedream-4-0-250828",
  label: "Seedream 4.0",
  vendor: "ByteDance",
  strengths: "A low price per image, and sizes up to 4K",
  capabilityLine: "1K to 4K, up to 10 at once",
  capabilities: {
    ...NO_CAPS,
    sizePresets: [...SEEDREAM_1K, ...SEEDREAM_2K, ...SEEDREAM_4K],
    count: { min: 1, max: 10 },
    referenceImages: { min: 0, max: 10 },
  },
  defaults: { ...NO_DEFAULTS, sizePreset: "(2K) 2048x2048 (1:1)", count: 1 },
  price: { unit: "per-image", credits: 6.33, confidence: "published", note: "Comfy's published figure.", reference: { credits: 0.63, included: 1 } },
  priceLine: "about 6.33 credits, $0.03",
  extras: [
    { name: "model.fail_on_partial", type: "BOOLEAN", required: false, default: false },
    { name: "model.thinking", type: "BOOLEAN", required: false, default: true },
  ],
  roles: ["prompt", "model", "sizePreset", "count", "seed", "watermark"],
  recommended: true,
});

export const IDEOGRAM_3 = model({
  key: "IdeogramV3",
  label: "Ideogram 3.0",
  vendor: "Ideogram",
  strengths: "Several images in one run, and a negative prompt",
  capabilityLine: "512x1536 to 1024x1024, 15 ratios, up to 8 at once",
  capabilities: {
    ...NO_CAPS,
    sizePresets: ["Auto", "512x1536", "832x1248", "1024x1024", "1152x864", "1248x832", "1312x736", "1536x512"],
    aspects: ["1:3", "3:1", "9:16", "16:9", "2:3", "3:2", "3:4", "4:3", "1:1"],
    count: { min: 1, max: 8 },
    negativePrompt: true,
  },
  defaults: { ...NO_DEFAULTS, sizePreset: "Auto", aspect: "1:1", count: 1 },
  price: {
    unit: "per-image",
    credits: 18.1,
    tiers: [
      { when: { quality: "turbo" }, credits: 9.05 },
      { when: { quality: "default" }, credits: 18.1 },
      { when: { quality: "quality" }, credits: 27.16 },
    ],
    confidence: "published",
    note: "rendering_speed DEFAULT, multiplied by num_images",
  },
  priceLine: "from 9.05 credits, about $0.04",
  constraints: [
    {
      when: { sizePreset: "not Auto" },
      then: { aspect: "ignored" },
      note: "The ratio is ignored unless the size is Auto.",
    },
  ],
  extras: [
    { name: "magic_prompt_option", type: "COMBO", required: false, options: ["AUTO", "ON", "OFF"], default: "AUTO", tooltip: "Whether MagicPrompt rewrites the prompt" },
    { name: "rendering_speed", type: "COMBO", required: false, options: ["DEFAULT", "TURBO", "QUALITY"], default: "DEFAULT", tooltip: "Speed against quality" },
  ],
  roles: ["prompt", "aspect", "sizePreset", "negativePrompt", "seed", "count"],
});

export const FLUX_2 = model({
  key: "Flux2ImageNode/Flux.2 [pro]",
  label: "Flux.2 [pro]",
  vendor: "BFL",
  strengths: "Free width and height, priced per megapixel",
  capabilityLine: "256x256 to 2048x2048",
  capabilities: {
    ...NO_CAPS,
    dimensions: { widthMin: 256, widthMax: 2048, heightMin: 256, heightMax: 2048, step: 16, widthDefault: 1024, heightDefault: 1024 },
    referenceImages: { min: 0, max: 8 },
  },
  defaults: { ...NO_DEFAULTS, width: 1024, height: 1024 },
  price: { unit: "per-image", credits: 6.33, perExtraMegapixelCredits: 1.27, confidence: "published", note: "6.33 credits for the first megapixel." },
  // A megapixel surcharge makes the published figure a floor, so the row says
  // "from" exactly the way a tier list does.
  priceLine: "from 6.33 credits, about $0.03",
  constraints: [
    { when: { dimensions: "any" }, then: { dimensions: { minArea: 262_144, maxArea: 4_194_304 } }, note: "Between 0.26 and 4.2 megapixels." },
  ],
  roles: ["prompt", "model", "width", "height", "seed"],
  recommended: true,
});

export const GPT_IMAGE_2 = model({
  key: "OpenAIGPTImageNodeV2/gpt-image-2",
  label: "GPT Image 2",
  vendor: "OpenAI",
  strengths: "Good at text inside the picture",
  capabilityLine: "up to 8 at once",
  capabilities: { ...NO_CAPS, count: { min: 1, max: 8 }, referenceImages: { min: 0, max: 16 } },
  defaults: { ...NO_DEFAULTS, count: 1 },
  price: {
    unit: "per-image",
    credits: 10.38,
    tiers: [
      { when: { quality: "low" }, credits: 1.22 },
      { when: { quality: "medium" }, credits: 10.38 },
      { when: { quality: "high" }, credits: 42.54 },
    ],
    confidence: "published",
    note: "OpenAI bills by output tokens; the tiers are the published per image figures.",
    reference: { credits: 2.26, creditsMax: 3.1 },
  },
  priceLine: "from 1.22 credits, about $0.01",
  extras: [
    { name: "model.size", type: "COMBO", required: false, options: ["auto", "1024x1024", "1536x1024", "1024x1536"], default: "auto" },
    { name: "model.quality", type: "COMBO", required: false, options: ["low", "medium", "high"], default: "medium" },
    { name: "model.background", type: "COMBO", required: false, options: ["auto", "transparent", "opaque"], default: "auto" },
    // custom_width and custom_height are not here on purpose: the node declares
    // them, and `extrasOf` drops them with the "Custom" size they serve.
  ],
  roles: ["prompt", "model", "count", "seed"],
});

export const REVE_CREATE = model({
  key: "ReveImageCreateNode/reve-create@20250915",
  label: "Reve Image Create",
  vendor: "Reve",
  strengths: "Quick drafts at a low flat price",
  capabilityLine: "7 ratios",
  capabilities: { ...NO_CAPS, aspects: ["1:1", "3:4", "4:3", "9:16", "16:9", "9:21", "21:9"] },
  defaults: { ...NO_DEFAULTS, aspect: "16:9" },
  price: { unit: "per-image", credits: 2, confidence: "published", note: "One flat figure per image." },
  priceLine: "2 credits, about $0.01",
  extras: [{ name: "model.style_weight", type: "FLOAT", required: false, min: 0, max: 1, step: 0.1, default: 0.8, tooltip: "How strongly the style is applied" }],
  roles: ["prompt", "model", "aspect", "seed"],
});

export const IMAGE_MODELS_FIXTURE: ModelSummary[] = [IDEOGRAM_3, SEEDREAM_4, REVE_CREATE, GPT_IMAGE_2, FLUX_2, SEEDREAM_5_PRO];

export const SEEDANCE_1_FAST = model({
  key: "ByteDanceTextToVideoNode/seedance-1-0-pro-fast-251015",
  kind: "video",
  label: "Seedance 1.0 Pro Fast",
  vendor: "ByteDance",
  strengths: "The cheapest clip that still looks like film",
  capabilityLine: "480p to 1080p, 6 ratios, 3 to 12 s",
  capabilities: {
    ...NO_CAPS,
    resolutions: ["480p", "720p", "1080p"],
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
    duration: { min: 3, max: 12, step: 1, allowed: null, default: 5 },
  },
  defaults: { ...NO_DEFAULTS, resolution: "480p", aspect: "16:9", duration: 5 },
  price: { unit: "per-1m-tokens", credits: 370, confidence: "published", note: "Billed by the token formula." },
  priceLine: "about 10.9 credits for 3 s at 480p, about $0.05",
  extras: [{ name: "camera_fixed", type: "BOOLEAN", required: false, default: false, tooltip: "Hold the camera still" }],
  roles: ["prompt", "model", "resolution", "aspect", "duration", "seed", "watermark"],
  recommended: true,
});

export const SEEDANCE_25 = model({
  key: "ByteDance2TextToVideoNode/Seedance 2.5",
  kind: "video",
  label: "Seedance 2.5",
  vendor: "ByteDance",
  strengths: "Longest clips and a soundtrack",
  capabilityLine: "480p to 1080p, 5 ratios, 4 to 30 s, audio",
  capabilities: {
    ...NO_CAPS,
    resolutions: ["480p", "720p", "1080p"],
    aspects: ["16:9", "4:3", "1:1", "9:16", "adaptive"],
    duration: { min: 4, max: 30, step: 1, allowed: null, default: 5 },
    audio: true,
  },
  defaults: { ...NO_DEFAULTS, resolution: "480p", aspect: "16:9", duration: 5, audio: false },
  price: { unit: "per-1m-tokens", credits: 1266.0, confidence: "published", note: "Comfy's published rate per million tokens." },
  priceLine: "about 42.7 credits for 4 s at 480p, about $0.20",
  roles: ["prompt", "model", "resolution", "aspect", "duration", "audio", "seed", "watermark"],
});

export const VEO_3 = model({
  key: "Veo3VideoGenerationNode",
  kind: "video",
  label: "Veo 3.1",
  vendor: "Google",
  strengths: "Cinematic motion with native audio",
  capabilityLine: "720p to 1080p, 2 ratios, 4 to 8 s, audio",
  capabilities: {
    ...NO_CAPS,
    resolutions: ["720p", "1080p"],
    aspects: ["16:9", "9:16"],
    duration: { min: 4, max: 8, step: 2, allowed: [4, 6, 8], default: 8 },
    audio: true,
  },
  defaults: { ...NO_DEFAULTS, resolution: "720p", aspect: "16:9", duration: 8, audio: true },
  price: { unit: "per-second", credits: 72, confidence: "published", note: "One rate per second of output." },
  priceLine: "72 credits per second",
  constraints: [
    { when: { resolution: "1080p" }, then: { duration: [8] }, note: "1080p is only offered as an 8 second clip." },
    { when: { resolution: "1080p" }, then: { aspect: ["16:9"] }, note: "1080p is landscape only." },
  ],
  extras: [{ name: "person_generation", type: "COMBO", required: false, options: ["allow_all", "allow_adult", "dont_allow"], default: "allow_all" }],
  roles: ["prompt", "resolution", "aspect", "duration", "audio", "seed"],
});

export const VIDEO_MODELS_FIXTURE: ModelSummary[] = [SEEDANCE_1_FAST, SEEDANCE_25, VEO_3];

/**
 * The `models` RPC reply for one kind, with the plugin's shipped defaults.
 * `observed` is what this account has already been billed; pass rows to check
 * that the form quotes them over the published price.
 */
export function modelsResult(kind: "image" | "video", creditRate: number | null, observed: ObservedShape[] = []): ModelsResult {
  const models = kind === "image" ? IMAGE_MODELS_FIXTURE : VIDEO_MODELS_FIXTURE;
  return {
    models,
    defaults: { image: SEEDREAM_5_PRO.key, video: SEEDANCE_1_FAST.key },
    counts: { total: models.length, supported: models.length, unsupported: 0, hidden: models.filter((entry) => entry.hidden).length },
    creditRate,
    observed,
  };
}
