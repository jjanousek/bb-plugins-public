// registry.ts: the model registry, merged from the two generated files.
//
// `models.generated.ts` is the frozen snapshot of the Comfy Cloud node catalog
// (what the plugin can send). `models.overrides.ts` is the frozen snapshot of
// the vendor documentation in qa/model-docs (what a model can actually do, and
// what it costs). Overrides win. Both are written by scripts/make-models.mjs.
//
// Pure: no bb API, no filesystem, no network. server.ts turns entries into the
// `ModelSummary` rows the panel's picker renders; workflows.ts turns one entry
// plus a request into a graph.
import {
  DURATION_INPUT_NAMES,
  costSignature,
  estimateCredits,
  estimateParamsOf,
  floorCredits,
  floorShape,
  formatCredits,
  formatUsd,
  parseSizePreset,
  secondsInValue,
  usdForCredits,
  type AssetKind,
  type CostConfidence,
  type ModelCapabilities,
  type ModelConstraint,
  type ModelDefaults,
  type ModelExtra,
  type ModelPrice,
  type ModelSummary,
  type Params,
} from "./contract";
import { CATALOG_DATE, GENERATED_AT, GENERATED_MODELS, SKIPPED_NODES } from "./models.generated";
import { MODEL_ALIASES, MODEL_OVERRIDES, UNMATCHED_DOC_RECORDS } from "./models.overrides";

export { CATALOG_DATE, GENERATED_AT, SKIPPED_NODES, UNMATCHED_DOC_RECORDS };



/** The roles the builder knows. Everything else a node declares is an extra. */
export const ROLES = ["prompt", "negativePrompt", "model", "sizePreset", "aspect", "resolution", "width", "height", "duration", "audio", "count", "seed", "watermark"] as const;
export type Role = (typeof ROLES)[number];

/** One declared input of a node, with the wire name the graph uses. */
export interface GeneratedInput {
  /** Wire name, dotted for a dynamic combo sub-input ("model.size_preset"). */
  name: string;
  /** STRING, INT, FLOAT, BOOLEAN, COMBO or COMFY_DYNAMICCOMBO_V3. */
  type: string;
  required: boolean;
  options?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
  default?: string | number | boolean;
  multiline?: boolean;
  tooltip?: string;
  /** True for the few inputs the frozen graphs send that the node does not declare. */
  compat?: boolean;
  /** A combo whose catalog options are numbers, so the value goes on the wire as one. */
  numeric?: boolean;
}

/** One node and one model id, as the catalog declares them. */
export interface GeneratedEntry {
  key: string;
  node: string;
  modelId: string | null;
  /** Input that carries the model id, or null when the node runs one model. */
  modelInput: string | null;
  kind: AssetKind;
  vendor: string;
  category: string;
  label: string;
  displayName: string;
  description: string;
  outputNodeKind: "SaveImage" | "SaveVideo";
  deprecated: boolean;
  experimental: boolean;
  supported: boolean;
  unsupportedReason: string | null;
  roles: Partial<Record<Role, string>>;
  inputs: readonly GeneratedInput[];
  /**
   * The optional autogrow group of IMAGE slots this model takes beside its
   * prompt, when it has one. `input` is the group's own wire name
   * ("model.images") and a slot is written `<input>.<slot>`
   * ("model.images.image_1"), carrying a link to a LoadImage node.
   *
   * It is deliberately not in `inputs`: the builder fills declared inputs in
   * catalog order and the frozen graphs depend on that order, so a group that
   * only ever carries links stays out of it and `buildWorkflow` wires the slots
   * itself. Absent on every model that takes no reference.
   */
  referenceImages?: { input: string; slots: readonly string[]; min: number; max: number };
  /** Literal values the frozen graphs carry, keyed by wire name. */
  compat?: Readonly<Record<string, string | number | boolean>>;
}

/** What a vendor's own documentation adds to a generated entry. */
export interface ModelOverride {
  source: string;
  label?: string;
  vendor?: string;
  strengths?: string;
  notes?: string;
  billedModelId?: string;
  hidden?: boolean;
  deprecated?: boolean;
  recommended?: boolean;
  supported?: boolean;
  unsupportedReason?: string;
  capabilities?: {
    resolutions?: readonly string[];
    aspects?: readonly string[];
    sizePresets?: readonly string[];
    durations?: { min?: number; max?: number; allowed?: readonly number[] };
    audio?: boolean;
    /** False when the node declares a negative prompt but the model ignores it. */
    negativePrompt?: boolean;
    batch?: { min: number; max: number };
    promptMaxChars?: number;
  };
  constraints?: readonly ModelConstraint[];
  /** Starting values the plugin uses where they differ from the node's own default. */
  defaults?: { duration?: number; count?: number; sizePreset?: string; resolution?: string; aspect?: string };
  price?: ModelPrice;
  sources?: readonly string[];
}

/** A generated entry with its documentation folded in. */
export interface RegistryEntry extends GeneratedEntry {
  override: ModelOverride | null;
  documented: boolean;
  hidden: boolean;
  recommended: boolean;
  price: ModelPrice | null;
  constraints: readonly ModelConstraint[];
  strengths: string | null;
  notes: string | null;
  billedModelId: string | null;
  aliases: readonly string[];
}

function inputOf(entry: GeneratedEntry, role: Role): GeneratedInput | null {
  const name = entry.roles[role];
  if (name === undefined) return null;
  return entry.inputs.find((i) => i.name === name) ?? null;
}

/** Options a role's input offers, minus the escape hatches the builder cannot price. */
function roleOptions(entry: GeneratedEntry, role: Role): string[] {
  const input = inputOf(entry, role);
  if (input === null || input.options === undefined) return [];
  return input.options.filter((o) => o !== "Custom" && o !== "custom");
}

/** Keep the documented list where it narrows the schema, and say so when it does not overlap. */
function narrow(schema: readonly string[], documented: readonly string[] | undefined): string[] {
  if (documented === undefined || documented.length === 0) return [...schema];
  const kept = schema.filter((o) => documented.some((d) => d.toLowerCase() === o.toLowerCase()));
  return kept.length > 0 ? kept : [...schema];
}

/** Rough pixel height of a tier label, so "480p", "1K" and "4k" sort cheapest first. */
function tierWeight(tier: string): number {
  const t = tier.trim().toLowerCase();
  const p = /^(\d{3,4})\s*p$/.exec(t);
  if (p) return Number(p[1]);
  // A decimal K tier sorts by its value: 0.75K before 1K, 1.5K between 1K and 2K.
  const k = /^(\d(?:\.\d{1,2})?)\s*k$/.exec(t);
  if (k) return Number(k[1]) * 1000;
  const named: Record<string, number> = { sd: 480, hd: 720, fhd: 1080, uhd: 2160, auto: 0 };
  return named[t] ?? Number.MAX_SAFE_INTEGER;
}

/**
 * The combo that carries the clip length on a model with no duration input.
 *
 * `KlingTextToVideoNode` is the typical case: its `mode` input
 * spells both the model version and the length ("pro mode / 10s duration /
 * kling-v2-5-turbo"), and its own documentation says "a duration control must
 * write the mode string, not a number". Nothing here is hand written per
 * vendor: an input whose name is one the plugin already reads a length out of,
 * whose options each spell a different number of seconds, is a length control.
 */
function durationCombo(entry: GeneratedEntry): { input: GeneratedInput; seconds: number[] } | null {
  if (entry.roles.duration !== undefined) return null;
  for (const name of DURATION_INPUT_NAMES) {
    const input = entry.inputs.find((i) => i.name === name);
    if (input === undefined || input.type !== "COMBO" || input.options === undefined || input.options.length < 2) continue;
    const seconds = input.options.map((option) => secondsInValue(option));
    if (seconds.some((value) => value === null || value <= 0)) continue;
    const values = seconds as number[];
    if (new Set(values).size !== values.length) continue;
    return { input, seconds: values };
  }
  return null;
}

function numberOptions(input: GeneratedInput): number[] | null {
  if (input.options === undefined) return null;
  const parsed = input.options.map((o) => Number(String(o).replace(/s$/i, ""))).filter((n) => Number.isFinite(n));
  return parsed.length > 0 ? parsed : null;
}

// ---------- the merge ----------

const ALIASES_BY_KEY = new Map<string, string[]>();
for (const [alias, key] of Object.entries(MODEL_ALIASES)) {
  const list = ALIASES_BY_KEY.get(key) ?? [];
  list.push(alias);
  ALIASES_BY_KEY.set(key, list);
}

function merge(entry: GeneratedEntry): RegistryEntry {
  const override = (MODEL_OVERRIDES as Record<string, ModelOverride | undefined>)[entry.key] ?? null;
  const aliases = ALIASES_BY_KEY.get(entry.key) ?? [];
  // A deprecated duplicate is hidden even when a legacy id still points at it:
  // the id keeps resolving, and `visibleModels` in server.ts puts the current
  // default back so the picker can always show the model the user is on.
  const hidden = override?.hidden === true;
  const supported = override?.supported === false ? false : entry.supported;
  return {
    ...entry,
    vendor: override?.vendor ?? entry.vendor,
    label: override?.label ?? entry.label,
    supported,
    unsupportedReason: supported ? null : (override?.unsupportedReason ?? entry.unsupportedReason),
    deprecated: entry.deprecated || override?.deprecated === true,
    override,
    documented: override !== null && override.source !== "catalog",
    hidden,
    recommended: override?.recommended === true,
    price: override?.price ?? null,
    constraints: override?.constraints ?? [],
    strengths: override?.strengths ?? null,
    notes: override?.notes ?? null,
    billedModelId: override?.billedModelId ?? null,
    aliases,
  };
}

/** Every entry, keyed by its registry key. */
export const MODEL_REGISTRY: ReadonlyMap<string, RegistryEntry> = new Map(GENERATED_MODELS.map((e) => [e.key, merge(e)]));

/** Every entry in key order. */
export const MODEL_ENTRIES: readonly RegistryEntry[] = [...MODEL_REGISTRY.values()];

// ---------- resolving a model key ----------

const BY_MODEL_ID = new Map<string, RegistryEntry[]>();
for (const entry of MODEL_ENTRIES) {
  if (entry.modelId === null) continue;
  const list = BY_MODEL_ID.get(entry.modelId.toLowerCase()) ?? [];
  list.push(entry);
  BY_MODEL_ID.set(entry.modelId.toLowerCase(), list);
}

/** Best entry among several offering the same bare model id: usable, current, documented. */
function preferred(entries: readonly RegistryEntry[]): RegistryEntry {
  const score = (e: RegistryEntry) => (e.supported ? 8 : 0) + (e.deprecated ? 0 : 4) + (e.documented ? 2 : 0) + (e.recommended ? 1 : 0);
  return [...entries].sort((a, b) => score(b) - score(a) || a.key.localeCompare(b.key))[0]!;
}

/**
 * Turn anything a caller might pass into a registry key: a key, one of the
 * legacy ids, or a bare model id offered by one or more nodes. Null when
 * nothing matches.
 */
export function resolveModelKey(id: string): string | null {
  const raw = id.trim();
  if (raw === "") return null;
  if (MODEL_REGISTRY.has(raw)) return raw;
  const alias = (MODEL_ALIASES as Record<string, string | undefined>)[raw];
  if (alias !== undefined && MODEL_REGISTRY.has(alias)) return alias;
  const byId = BY_MODEL_ID.get(raw.toLowerCase());
  if (byId !== undefined && byId.length > 0) return preferred(byId).key;
  const lower = raw.toLowerCase();
  const byKey = MODEL_ENTRIES.find((e) => e.key.toLowerCase() === lower);
  if (byKey) return byKey.key;
  const byLabel = MODEL_ENTRIES.filter((e) => e.label.toLowerCase() === lower);
  return byLabel.length > 0 ? preferred(byLabel).key : null;
}

/** The entry a caller named, or null. */
export function getModel(id: string): RegistryEntry | null {
  const key = resolveModelKey(id);
  return key === null ? null : (MODEL_REGISTRY.get(key) ?? null);
}

/**
 * The one name a price is keyed by: the model id Comfy bills under, or the node
 * class for a node that runs a single model.
 *
 * The panel sends registry keys, the CLI and the agent tools take bare ids, and
 * the price tables and `cost_samples` predate both. Everything that prices or
 * learns goes through here, so "photon-flash-1" and
 * "LumaImageNode/photon-flash-1" are one shape rather than two half-learned
 * ones. An id no entry claims is returned unchanged.
 */
export function priceKeyOf(model: string): string {
  const entry = getModel(model);
  if (entry === null) return model;
  return entry.modelId ?? entry.key;
}

/** Cheap edit distance, for "did you mean" lists. */
function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const row = [i];
    for (let j = 1; j <= n; j += 1) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[n]!;
}

/** The closest model keys to something that did not resolve, for an error message. */
export function closestModels(id: string, kind?: AssetKind, limit = 3): string[] {
  const needle = id.trim().toLowerCase();
  const pool = MODEL_ENTRIES.filter((e) => e.supported && !e.hidden && (kind === undefined || e.kind === kind));
  const scored = pool.map((e) => {
    const candidates = [e.key, e.modelId ?? "", e.label, ...e.aliases].filter((c) => c !== "");
    const best = Math.min(...candidates.map((c) => (c.toLowerCase().includes(needle) ? 0 : distance(needle, c.toLowerCase()))));
    return { key: e.key, best };
  });
  return scored
    .sort((a, b) => a.best - b.best || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((s) => s.key);
}

// ---------- capabilities ----------

export function capabilitiesOf(entry: RegistryEntry): ModelCapabilities {
  const doc = entry.override?.capabilities;
  const width = inputOf(entry, "width");
  const height = inputOf(entry, "height");
  const duration = inputOf(entry, "duration");
  const count = inputOf(entry, "count");

  let durations: ModelCapabilities["duration"] = null;
  let durationVia: string | null = null;
  const combo = duration === null ? durationCombo(entry) : null;
  if (combo !== null) {
    const list = [...combo.seconds].sort((a, b) => a - b);
    const declared = secondsInValue(combo.input.default);
    durationVia = combo.input.name;
    durations = {
      min: list[0]!,
      max: list[list.length - 1]!,
      step: 1,
      allowed: list,
      default: declared !== null && list.includes(declared) ? declared : list[0]!,
    };
  }
  if (duration !== null) {
    const allowed = numberOptions(duration);
    const min = doc?.durations?.min ?? duration.min ?? (allowed ? Math.min(...allowed) : 1);
    const max = doc?.durations?.max ?? duration.max ?? (allowed ? Math.max(...allowed) : min);
    const list = doc?.durations?.allowed ? [...doc.durations.allowed] : allowed;
    const fallback = entry.override?.defaults?.duration ?? (typeof duration.default === "number" ? duration.default : (list?.[0] ?? min));
    durations = {
      min,
      max: Math.max(min, max),
      step: duration.step ?? 1,
      allowed: list === null ? null : list.filter((n) => n >= min && n <= max).sort((a, b) => a - b),
      default: Math.min(Math.max(fallback, min), Math.max(min, max)),
    };
  }

  return {
    sizePresets: narrow(roleOptions(entry, "sizePreset"), doc?.sizePresets),
    aspects: narrow(roleOptions(entry, "aspect"), doc?.aspects),
    // Cheapest tier first, whatever order the node happens to declare them in.
    resolutions: narrow(roleOptions(entry, "resolution"), doc?.resolutions).sort((a, b) => tierWeight(a) - tierWeight(b)),
    dimensions:
      width === null || height === null
        ? null
        : {
            widthMin: width.min ?? 1,
            widthMax: width.max ?? 4096,
            heightMin: height.min ?? 1,
            heightMax: height.max ?? 4096,
            step: width.step ?? 1,
            widthDefault: typeof width.default === "number" ? width.default : (width.min ?? 1024),
            heightDefault: typeof height.default === "number" ? height.default : (height.min ?? 1024),
          },
    duration: durations,
    durationVia,
    // Only for a model with no length control at all: the documented length one
    // click buys, so a per second price is quoted for the clip it will return.
    promptDurationDefault: durations === null ? (entry.override?.defaults?.duration ?? null) : null,
    audio: entry.roles.audio !== undefined && doc?.audio !== false,
    count: count === null ? null : { min: doc?.batch?.min ?? count.min ?? 1, max: doc?.batch?.max ?? count.max ?? 1 },
    seed: entry.roles.seed !== undefined,
    // Six Recraft entries declare a negative prompt whose own tooltip says
    // "This input is ignored". Documentation may take a role away, the same
    // way it takes `audio` away from Seedance 1.0 Pro; it may never add one.
    negativePrompt: entry.roles.negativePrompt !== undefined && doc?.negativePrompt !== false,
    promptMaxChars: doc?.promptMaxChars ?? null,
    // How many reference images the model takes beside the prompt. The wire
    // names stay on the entry; a caller only needs the count.
    referenceImages: entry.referenceImages === undefined ? null : { min: entry.referenceImages.min, max: entry.referenceImages.max },
    // True when nothing in qa/model-docs covers this entry at all, so the whole
    // capability list is the node schema and no vendor confirmed it.
    schemaDerived: !entry.documented,
  };
}

/** Where the form starts for a model. */
export function defaultsOf(entry: RegistryEntry, caps = capabilitiesOf(entry)): ModelDefaults {
  const sizeInput = inputOf(entry, "sizePreset");
  const aspectInput = inputOf(entry, "aspect");
  const resolutionInput = inputOf(entry, "resolution");
  const pick = (input: GeneratedInput | null, options: string[]): string | null => {
    if (options.length === 0) return null;
    const declared = typeof input?.default === "string" ? input.default : null;
    return declared !== null && options.includes(declared) ? declared : options[0]!;
  };
  const wanted = entry.override?.defaults ?? {};
  const preferOption = (value: string | undefined, input: GeneratedInput | null, options: string[]) =>
    value !== undefined && options.includes(value) ? value : pick(input, options);
  return {
    sizePreset: preferOption(wanted.sizePreset, sizeInput, caps.sizePresets),
    aspect: preferOption(wanted.aspect, aspectInput, caps.aspects),
    resolution: preferOption(wanted.resolution, resolutionInput, caps.resolutions),
    width: caps.dimensions?.widthDefault ?? null,
    height: caps.dimensions?.heightDefault ?? null,
    duration: caps.duration?.default ?? null,
    count: caps.count === null ? null : (wanted.count ?? caps.count.min),
    audio: caps.audio ? false : null,
  };
}

/** The five input types the generic "More options" form can render. */
const RENDERABLE = new Set(["COMBO", "BOOLEAN", "INT", "FLOAT", "STRING"]);

/**
 * Inputs whose only job is to serve a size preset the plugin does not offer.
 *
 * `roleOptions` drops "Custom" from every preset list, because the builder
 * cannot price a size the user has not chosen yet and every one of these nodes
 * validates the pixel fields anyway. A node such as GPT Image 2 also declares
 * `custom_width` and `custom_height`, whose own tooltip says they are read
 * "only when `size` is 'Custom'", so without Custom they are controls that
 * cannot do anything. They come out with Custom.
 */
function deadCustomInputs(entry: GeneratedEntry): Set<string> {
  const dead = new Set<string>();
  const preset = inputOf(entry, "sizePreset");
  if (preset === null || preset.options === undefined) return dead;
  if (!preset.options.some((option) => option.toLowerCase() === "custom")) return dead;
  const prefix = preset.name.includes(".") ? `${preset.name.slice(0, preset.name.lastIndexOf(".") + 1)}` : "";
  for (const name of ["custom_width", "custom_height"]) dead.add(`${prefix}${name}`);
  return dead;
}

/**
 * Inputs the form renders generically under "More options". A custom type such
 * as Krea's KREA_STYLE_REF is left out: it is always optional (a required one
 * makes the whole entry unsupported) and no generic control can produce one.
 */
export function extrasOf(entry: RegistryEntry): ModelExtra[] {
  const roleNames = new Set(Object.values(entry.roles));
  const dead = deadCustomInputs(entry);
  return entry.inputs
    .filter((i) => !roleNames.has(i.name) && !dead.has(i.name) && i.compat !== true && RENDERABLE.has(i.type))
    .map((i) => ({
      name: i.name,
      type: i.type,
      required: i.required,
      ...(i.options ? { options: [...i.options] } : {}),
      ...(i.min !== undefined ? { min: i.min } : {}),
      ...(i.max !== undefined ? { max: i.max } : {}),
      ...(i.step !== undefined ? { step: i.step } : {}),
      ...(i.default !== undefined ? { default: i.default } : {}),
      ...(i.multiline ? { multiline: true } : {}),
      ...(i.tooltip ? { tooltip: i.tooltip } : {}),
    }));
}

// ---------- the two lines the picker renders ----------

function range(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0]!;
  return `${values[0]} to ${values[values.length - 1]}`;
}

/** "480p to 1080p, 3 to 12 s, audio" or "1K to 4K, up to 6 images". */
export function capabilityLine(entry: RegistryEntry, caps = capabilitiesOf(entry)): string {
  const parts: string[] = [];
  const size = sizeSummary(caps);
  if (size !== null) parts.push(size);
  if (caps.aspects.length > 1) parts.push(`${caps.aspects.length} ratios`);
  if (caps.duration !== null) parts.push(caps.duration.min === caps.duration.max ? `${caps.duration.min} s` : `${caps.duration.min} to ${caps.duration.max} s`);
  if (caps.audio) parts.push("audio");
  if (caps.count !== null && caps.count.max > 1) parts.push(`up to ${caps.count.max} at once`);
  if (parts.length === 0) parts.push(entry.kind === "image" ? "one fixed size" : "one fixed length");
  return parts.join(", ");
}

/** The size half of a capability line: tiers where the model has them, pixels otherwise. */
function sizeSummary(caps: ModelCapabilities): string | null {
  const tiers = range(caps.resolutions);
  if (tiers !== null) return tiers;
  // "(1K) 1024x1024 (1:1)" carries its own tier; use it rather than a pixel range.
  const tagged = [...new Set(caps.sizePresets.map((p) => /\(([1-9])K\)/.exec(p)?.[1]).filter((t): t is string => t !== undefined))].sort();
  if (tagged.length > 0) return tagged.length === 1 ? `${tagged[0]}K` : `${tagged[0]}K to ${tagged[tagged.length - 1]}K`;
  const sizes = caps.sizePresets.map((p) => parseSizePreset(p)).filter((s): s is { width: number; height: number } => s !== null);
  if (sizes.length > 0) {
    const area = (s: { width: number; height: number }) => s.width * s.height;
    const smallest = sizes.reduce((a, b) => (area(a) <= area(b) ? a : b));
    const largest = sizes.reduce((a, b) => (area(a) >= area(b) ? a : b));
    return area(smallest) === area(largest) ? `${largest.width}x${largest.height}` : `${smallest.width}x${smallest.height} to ${largest.width}x${largest.height}`;
  }
  if (caps.sizePresets.length > 0) return `${caps.sizePresets.length} sizes`;
  if (caps.dimensions !== null) {
    const d = caps.dimensions;
    return `${d.widthMin}x${d.heightMin} to ${d.widthMax}x${d.heightMax}`;
  }
  return null;
}

/**
 * The hedge, in one place, so a picker row and the Generate button never quote
 * the same published price with different confidence. `estimateCreditsText`
 * writes "about" for anything the account has not been billed for, and this is
 * the same rule, so the same price never reads "N credits" on the row and
 * "about N credits" in the button.
 *
 * A line that already opens with "from" carries its own hedge, so it does not
 * take a second one, and the dollar half only says "about" when the credits
 * have not said it first. One hedge per sentence.
 */
function hedged(credits: string, confidence: CostConfidence, floor: boolean): string {
  return confidence === "measured" || floor ? credits : `about ${credits}`;
}

/** "9.5 credits, about $0.045" for an image, "from 42.2 credits per second" for video. */
export function priceLine(entry: RegistryEntry, rate: number | null): string {
  const price = entry.price;
  if (price === null) return "price unknown";
  const base = price.tiers && price.tiers.length > 0 ? Math.min(...price.tiers.map((t) => t.credits)) : price.credits;
  const money = (credits: number, hedge = true) => {
    const usd = usdForCredits(credits, rate);
    return usd === null ? "" : `, ${hedge ? "about " : ""}${formatUsd(usd)}`;
  };
  if (price.unit === "per-1m-tokens" || price.unit === "per-1k-tokens") {
    // A rate per token means nothing on a row, so quote the cheapest real clip
    // this model can produce. The token formula lives in contract.ts.
    const caps = capabilitiesOf(entry);
    const resolution = caps.resolutions[0] ?? "480p";
    const seconds = caps.duration?.min ?? 5;
    const estimate = estimateCredits(entry.kind, entry.modelId ?? entry.key, { resolution, duration: seconds }, undefined, price);
    if (estimate.credits !== null) return `about ${formatCredits(estimate.credits)} credits for ${seconds} s at ${resolution}${money(estimate.credits, false)}`;
    return base === null ? "price unknown" : `${formatCredits(base)} credits per million tokens`;
  }
  if (base === null) return "price unknown";
  // A megapixel surcharge makes the published figure a floor exactly the way a
  // tier list does, so the line says "from" and the row never quotes less than
  // the form opens at.
  const varies = (price.tiers !== undefined && price.tiers.length > 1) || price.perExtraMegapixelCredits !== undefined;
  const from = varies ? "from " : "";
  const say = (credits: number, tail = "") => {
    const hedge = hedged(`${formatCredits(credits)} credits`, price.confidence, varies);
    return `${from}${hedge}${tail}${money(credits, !hedge.startsWith("about"))}`;
  };
  switch (price.unit) {
    case "per-second":
      // A rate is not a bill, so it takes no hedge: it is exactly what the
      // vendor publishes per second, whatever a whole clip ends up costing.
      return `${from}${formatCredits(base)} credits per second${lengthIsUnpredictable(entry) ? ", and the prompt sets the length" : ""}`;
    case "per-run":
    case "per-video":
      // "per clip" is a video word. Wan 2.5 Image is billed per run and is the
      // one image model that lands here.
      return say(base, ` per ${entry.kind === "video" ? "clip" : "run"}`);
    default: {
      if (price.creditsRange) return `${formatCredits(price.creditsRange[0])} to ${formatCredits(price.creditsRange[1])} credits`;
      return say(base);
    }
  }
}

/**
 * What the cheapest complete generation costs, which is the figure the Cheapest
 * sort orders by. A video model's usual line is a rate ("from 10.55 credits per
 * second") and the sort key is a whole clip, so under that sort the two have to
 * be the same number or the column reads as broken.
 */
export function cheapestLine(entry: RegistryEntry, rate: number | null): string {
  const price = entry.price;
  if (price === null) return "price unknown";
  const caps = capabilitiesOf(entry);
  const floor = floorCredits(price, entry.kind, floorShape(caps, defaultsOf(entry, caps)));
  if (floor === null) return priceLine(entry, rate);
  const usd = usdForCredits(floor, rate);
  if (entry.kind === "image") {
    const hedge = hedged(`${formatCredits(floor)} credits`, price.confidence, false);
    const money = usd === null ? "" : `, ${hedge.startsWith("about") ? "" : "about "}${formatUsd(usd)}`;
    return `${hedge} an image${money}`;
  }
  const money = usd === null ? "" : `, about ${formatUsd(usd)}`;
  const seconds = caps.duration?.min ?? caps.promptDurationDefault ?? null;
  // "about" when the length is the one the prompt happens to produce.
  const vague = caps.duration === null && seconds !== null;
  const length = seconds === null ? "" : ` for ${vague ? "about " : ""}${formatCredits(seconds)} s`;
  return `from ${formatCredits(floor)} credits${length}${money}`;
}

// ---------- the picker DTO ----------

/** A deprecated entry says so in the picker, unless its documented label already does. */
function legacyLabel(entry: RegistryEntry): string {
  if (!entry.deprecated || /legacy|superseded|deprecated/i.test(entry.label)) return entry.label;
  return `${entry.label} (legacy node)`;
}

export function modelSummary(entry: RegistryEntry, rate: number | null): ModelSummary {
  const caps = capabilitiesOf(entry);
  return {
    key: entry.key,
    kind: entry.kind,
    vendor: entry.vendor,
    node: entry.node,
    modelId: entry.modelId,
    label: legacyLabel(entry),
    strengths: entry.strengths,
    notes: entry.notes,
    capabilities: caps,
    capabilityLine: capabilityLine(entry, caps),
    price: entry.price,
    priceLine: priceLine(entry, rate),
    cheapestLine: cheapestLine(entry, rate),
    defaults: defaultsOf(entry, caps),
    constraints: [...entry.constraints],
    extras: extrasOf(entry),
    roles: Object.keys(entry.roles),
    supported: entry.supported,
    unsupportedReason: entry.unsupportedReason,
    deprecated: entry.deprecated,
    hidden: entry.hidden,
    recommended: entry.recommended,
    documented: entry.documented,
    aliases: [...entry.aliases],
  };
}

/**
 * True when a model is billed per second but has no length control, so the
 * clip's length comes out of the prompt. Gemini's Omni Flash is the case that
 * matters: it defaults to 10 seconds, which is about 300 credits at 720p, with
 * nothing on the form to warn anyone. Quoting the one second rate would be
 * worse than saying nothing, so the estimate stays unknown.
 */
export function lengthIsUnpredictable(entry: RegistryEntry): boolean {
  return entry.price?.unit === "per-second" && entry.roles.duration === undefined;
}

/** The registry price an estimate may use, or null when the shape cannot be priced. */
export function priceForEstimate(entry: RegistryEntry | null, duration?: number | null): ModelPrice | null {
  if (entry === null) return null;
  if (lengthIsUnpredictable(entry) && (duration === null || duration === undefined)) return null;
  return entry.price;
}

/**
 * The `cost_samples` signature for one asset row. One function, so the runner
 * writing a sample and the server reading one can never key it differently.
 *
 * It is built from what the request asked for, because that is all the next
 * estimate has. The row's own width and height (the file's pixels) are used
 * only for a model whose size really is pixels, or one the registry does not
 * know (a run_workflow graph), where they are the best word on the size. A
 * model sized by a tier or a ratio returns a file the request never named, so
 * keying its samples by the file's pixels would file the bill under a shape no
 * later estimate asks for. `resignCostSamples` re-keys stored samples to this
 * signature at start.
 */
export function assetCostSignature(asset: { kind: AssetKind; model: string; params?: Params | null; width?: number | null; height?: number | null }): string {
  const entry = getModel(asset.model);
  const pixelSized = entry === null || entry.roles.width !== undefined;
  const shape = estimateParamsOf(pixelSized ? asset : { kind: asset.kind, params: asset.params });
  return costSignature(asset.kind, priceKeyOf(asset.model), shape);
}

/**
 * Models that take a reference image, best first, for the sentence a refusal
 * ends with. Recommended and documented entries lead, so the name a user is
 * pointed at is one they can actually reach in the picker.
 */
export function referenceImageModels(kind?: AssetKind): RegistryEntry[] {
  const score = (e: RegistryEntry) => (e.recommended ? 4 : 0) + (e.documented ? 2 : 0) + (e.deprecated ? 0 : 1);
  return MODEL_ENTRIES.filter((e) => e.referenceImages !== undefined && e.supported && !e.hidden && (kind === undefined || e.kind === kind)).sort(
    (a, b) => score(b) - score(a) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
  );
}

export interface ModelFilter {
  kind?: AssetKind;
  vendor?: string;
  query?: string;
  /** Include unsupported and hidden entries. */
  all?: boolean;
}

/** The picker's list: supported and visible entries, vendor then label. */
export function listModels(filter: ModelFilter = {}): RegistryEntry[] {
  const query = (filter.query ?? "").trim().toLowerCase();
  return MODEL_ENTRIES.filter((e) => {
    if (filter.kind !== undefined && e.kind !== filter.kind) return false;
    if (filter.vendor !== undefined && e.vendor.toLowerCase() !== filter.vendor.toLowerCase()) return false;
    if (filter.all !== true && (!e.supported || e.hidden)) return false;
    if (query !== "" && ![e.key, e.label, e.vendor, e.modelId ?? "", ...e.aliases].some((f) => f.toLowerCase().includes(query))) return false;
    return true;
  }).sort((a, b) => a.vendor.localeCompare(b.vendor) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}
