// workflows.ts: one generic graph builder for every model in the registry, and
// graph inspection for hand-written or edited workflows. Pure; no bb API.
//
// The builder knows nothing about any particular model. It walks a registry
// entry's declared inputs in their catalog order, fills each one from the
// request's role values (clamping numbers to the schema and checking enum
// membership), and wires the node into SaveImage or SaveVideo. The Seedream and
// Seedance graphs come out of it byte identical to the golden fixtures in
// test/fixtures, which pin that.
import { randomInt } from "node:crypto";
import {
  QUALITY_INPUT_NAMES,
  isLink,
  parseSizePreset,
  type AssetKind,
  type GenerateImageInput,
  type GenerateVideoInput,
  type JsonValue,
  type Params,
  type Workflow,
} from "./contract";
import { MODEL_ENTRIES, capabilitiesOf, closestModels, getModel, referenceImageModels, type GeneratedInput, type RegistryEntry, type Role } from "./registry";

export const MAX_SEED = 2147483647;

export function randomSeed(): number {
  return randomInt(0, MAX_SEED + 1);
}

function clampSeed(seed: number | undefined): number {
  if (seed === undefined || !Number.isFinite(seed)) return randomSeed();
  return Math.min(MAX_SEED, Math.max(0, Math.floor(seed)));
}

interface Range {
  min: number;
  max: number;
  step: number;
}

/** The value Comfy Cloud accepts for a number: inside the range and on the step grid. */
export function clampToRange(value: number, range: Range): number {
  const clamped = Math.min(range.max, Math.max(range.min, Math.round(value)));
  const step = range.step > 0 ? range.step : 1;
  const stepped = range.min + Math.round((clamped - range.min) / step) * step;
  return Math.min(range.max, stepped);
}

function rangeOf(input: GeneratedInput): Range {
  return { min: input.min ?? 0, max: input.max ?? Number.MAX_SAFE_INTEGER, step: input.step ?? 1 };
}

function inputFor(entry: RegistryEntry, role: Role): GeneratedInput | null {
  const name = entry.roles[role];
  if (name === undefined) return null;
  return entry.inputs.find((i) => i.name === name) ?? null;
}

// ---------- resolving a request ----------

/**
 * One image already uploaded to Comfy Cloud, ready to be wired into a graph.
 *
 * `name` is what Comfy Cloud stored the bytes under and is the only thing the
 * graph carries; `from` is what the caller named (an asset id, or a path on the
 * bb server) and is kept only so the asset row can say where it came from.
 */
export interface ReferenceImage {
  name: string;
  from: string;
}

/** One fully resolved request: every role the model has, with a legal value. */
export interface ModelSpec {
  entry: RegistryEntry;
  kind: AssetKind;
  /** The key the caller named, so the asset row keeps the id it was asked for. */
  model: string;
  prompt: string;
  negativePrompt: string | null;
  sizePreset: string | null;
  aspect: string | null;
  resolution: string | null;
  /** Pixel size, from the preset when there is one. */
  width: number | null;
  height: number | null;
  duration: number | null;
  count: number | null;
  audio: boolean | null;
  seed: number;
  extras: Record<string, string | number | boolean>;
  /** Uploaded reference images, in slot order. Empty on every request that named none. */
  references: readonly ReferenceImage[];
  /** `aspect` under the name the video path uses. */
  aspectRatio: string | null;
  /** `audio` under the name the video path uses, never null. */
  generateAudio: boolean;
}

/** Everything a caller can ask for, whatever the model. */
export interface ModelRequest {
  prompt: string;
  model?: string;
  sizePreset?: string;
  aspect?: string;
  resolution?: string;
  width?: number;
  height?: number;
  duration?: number;
  count?: number;
  negativePrompt?: string;
  generateAudio?: boolean;
  seed?: number;
  extras?: Record<string, string | number | boolean>;
  /** Images already uploaded to Comfy Cloud, to wire into the model's reference slots. */
  references?: readonly ReferenceImage[];
}

function listFew(options: readonly string[], max = 8): string {
  return options.length <= max ? options.join(", ") : `${options.slice(0, max).join(", ")} and ${options.length - max} more`;
}

/** Look a model up and explain the near misses when it is unknown. */
export function requireModel(id: string, kind?: AssetKind): RegistryEntry {
  const entry = getModel(id);
  if (entry === null) {
    const close = closestModels(id, kind);
    const hint = close.length > 0 ? ` Closest matches: ${close.join(", ")}.` : "";
    throw new Error(`Unknown model "${id}".${hint} Run: bb comfy models${kind ? ` --kind ${kind}` : ""}`);
  }
  if (!entry.supported) throw new Error(`${entry.label} cannot be generated from a prompt alone: ${entry.unsupportedReason ?? "unsupported"}`);
  if (kind !== undefined && entry.kind !== kind) throw new Error(`${entry.label} is ${entry.kind === "image" ? "an image" : "a video"} model, not ${kind === "image" ? "an image" : "a video"} model.`);
  return entry;
}

/** Match a requested option against the model's list, case insensitively. */
function chooseOption(requested: string | undefined, options: readonly string[], fallback: string | null, label: string, model: string): string | null {
  if (options.length === 0) return null;
  if (requested === undefined || requested.trim() === "") return fallback;
  const want = requested.trim();
  const hit = options.find((o) => o === want) ?? options.find((o) => o.toLowerCase() === want.toLowerCase());
  if (hit === undefined) throw new Error(`${label} "${want}" is not available for ${model}. Choose one of: ${listFew(options)}`);
  return hit;
}

/**
 * Validate and complete a request against a registry entry. Throws a plain
 * Error with a user-facing message.
 */
export function resolveSpec(input: ModelRequest, defaultModel: string, kind?: AssetKind): ModelSpec {
  const prompt = input.prompt.trim();
  if (prompt === "") throw new Error("The prompt is empty.");
  const named = (input.model ?? "").trim() || defaultModel;
  const entry = requireModel(named, kind);
  const caps = capabilitiesOf(entry);

  const sizeInput = inputFor(entry, "sizePreset");
  const defaultSize = typeof sizeInput?.default === "string" && caps.sizePresets.includes(sizeInput.default) ? sizeInput.default : (caps.sizePresets[0] ?? null);
  const sizePreset = chooseOption(input.sizePreset, caps.sizePresets, defaultSize, "Size preset", entry.label);

  const aspectInput = inputFor(entry, "aspect");
  const defaultAspect = typeof aspectInput?.default === "string" && caps.aspects.includes(aspectInput.default) ? aspectInput.default : (caps.aspects[0] ?? null);
  const aspect = chooseOption(input.aspect, caps.aspects, defaultAspect, "Aspect ratio", entry.label);

  const resolutionInput = inputFor(entry, "resolution");
  const defaultResolution =
    typeof resolutionInput?.default === "string" && caps.resolutions.includes(resolutionInput.default) ? resolutionInput.default : (caps.resolutions[0] ?? null);
  let resolution: string | null;
  try {
    resolution = chooseOption(input.resolution, caps.resolutions, defaultResolution, "Resolution", entry.label);
  } catch {
    // A refused resolution gets a sentence that lists the legal ones.
    throw new Error(`${entry.label} supports resolutions ${caps.resolutions.join(", ")}, not "${input.resolution}".`);
  }

  // The preset carries the real pixel size; free width and height are only used
  // when the model has no preset list.
  const fromPreset = sizePreset === null ? null : parseSizePreset(sizePreset);
  // A model that sizes by ratio and resolution and keeps width and height only
  // for a "custom" option this plugin does not offer (HY Image 3.5) is not
  // asked for pixels. The builder still sends the node's own default, because
  // the inputs are required, but the row does not record a size the node
  // ignored: `costSignature` would otherwise key every such bill on 2048x2048
  // and learn the 4K price into the 1K shape.
  const sizedByTier = caps.sizePresets.length === 0 && (caps.aspects.length > 0 || caps.resolutions.length > 0);
  const widthInput = sizedByTier ? null : inputFor(entry, "width");
  const heightInput = sizedByTier ? null : inputFor(entry, "height");
  const width = fromPreset?.width ?? (widthInput === null ? null : (input.width ?? caps.dimensions?.widthDefault ?? widthInput.min ?? null));
  const height = fromPreset?.height ?? (heightInput === null ? null : (input.height ?? caps.dimensions?.heightDefault ?? heightInput.min ?? null));

  let duration: number | null = null;
  if (caps.duration !== null) {
    const want = typeof input.duration === "number" && Number.isFinite(input.duration) ? Math.round(input.duration) : caps.duration.default;
    if (caps.duration.allowed !== null && caps.duration.allowed.length > 0) {
      duration = caps.duration.allowed.reduce((best, n) => (Math.abs(n - want) < Math.abs(best - want) ? n : best), caps.duration.allowed[0]!);
    } else {
      duration = Math.min(caps.duration.max, Math.max(caps.duration.min, want));
    }
  }

  const references = [...(input.references ?? [])];
  if (references.length > 0) {
    const group = entry.referenceImages;
    if (group === undefined) {
      // A model that cannot take one has to say which model can, or the caller
      // is left guessing through the whole picker. Same vendor first, because
      // someone who asked for Seedance wants the ByteDance answer, not the Google one.
      const candidates = referenceImageModels(entry.kind);
      const sameVendor = candidates.filter((other) => other.vendor === entry.vendor);
      const others = (sameVendor.length > 0 ? sameVendor : candidates).slice(0, 2);
      const hint = others.length === 0 ? "" : ` Models that do: ${others.map((o) => `${o.label} (${o.key})`).join(", ")}.`;
      throw new Error(`${entry.label} does not take a reference image.${hint}`);
    }
    if (references.length > group.max) {
      throw new Error(`${entry.label} takes at most ${group.max} reference image${group.max === 1 ? "" : "s"}, not ${references.length}.`);
    }
  }

  const count = caps.count === null ? null : Math.min(caps.count.max, Math.max(caps.count.min, Math.floor(input.count ?? caps.count.min)));
  const audio = caps.audio ? (input.generateAudio ?? false) : entry.roles.audio === undefined ? null : false;

  const extras: Record<string, string | number | boolean> = {};
  const roleNames = new Set(Object.values(entry.roles));
  for (const [name, value] of Object.entries(input.extras ?? {})) {
    const declared = entry.inputs.find((i) => i.name === name);
    if (declared === undefined) throw new Error(`${entry.label} has no input called "${name}".`);
    if (roleNames.has(name)) continue; // the role already carries it
    // Fitted here rather than only at build time, so the params the asset row
    // keeps hold the typed value the node got: a CLI "--extra count=3" comes in
    // as a string and has to come back out of Tweak as a number.
    extras[name] = fit(declared, value, entry) as string | number | boolean;
  }

  return {
    entry,
    kind: entry.kind,
    model: named,
    prompt,
    negativePrompt: entry.roles.negativePrompt === undefined ? null : (input.negativePrompt ?? ""),
    sizePreset,
    aspect,
    resolution,
    width,
    height,
    duration,
    count,
    audio,
    seed: clampSeed(input.seed),
    extras,
    references,
    aspectRatio: aspect,
    generateAudio: audio === true,
  };
}

// ---------- building the graph ----------

/** Coerce and clamp one value onto one declared input, or throw when it cannot be. */
function fit(input: GeneratedInput, value: string | number | boolean, entry: RegistryEntry): JsonValue {
  switch (input.type) {
    case "INT":
    case "FLOAT": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) throw new Error(`${entry.label}: "${input.name}" needs a number.`);
      const fitted = clampToRange(n, rangeOf(input));
      return input.type === "INT" ? Math.round(fitted) : fitted;
    }
    case "BOOLEAN":
      return value === true || value === "true";
    case "COMBO":
    case "COMFY_DYNAMICCOMBO_V3": {
      const text = String(value);
      if (input.options === undefined || input.options.length === 0) return text;
      // A duration combo spells its options "5s" and "10s", so a numeric role
      // value has to be matched by number, not by string.
      const sameNumber = typeof value === "number" ? input.options.find((o) => Number(o.replace(/s$/i, "")) === value) : undefined;
      const hit = input.options.find((o) => o === text) ?? input.options.find((o) => o.toLowerCase() === text.toLowerCase()) ?? sameNumber;
      if (hit === undefined) throw new Error(`${entry.label}: "${text}" is not one of ${input.name}'s options (${listFew(input.options)}).`);
      // A combo the catalog declares as numbers is sent as a number, and one it
      // declares as digit strings is sent as a string. ComfyUI validates with a
      // plain `in` and no coercion, so 24 is not in ["24", "48"]: Pruna's fps
      // and LTX-2.5's duration and fps are spelled that way.
      return input.numeric === true ? Number(hit) : hit;
    }
    default:
      return typeof value === "string" ? value : String(value);
  }
}

/** The role value for one declared input, or undefined when no role fills it. */
function roleValue(entry: RegistryEntry, spec: ModelSpec, name: string): string | number | boolean | undefined {
  const roles = entry.roles;
  if (roles.prompt === name) return spec.prompt;
  if (roles.negativePrompt === name) return spec.negativePrompt ?? "";
  if (roles.model === name) return entry.modelId ?? undefined;
  if (roles.sizePreset === name) return spec.sizePreset ?? undefined;
  if (roles.aspect === name) return spec.aspect ?? undefined;
  if (roles.resolution === name) return spec.resolution ?? undefined;
  if (roles.width === name) return spec.width ?? undefined;
  if (roles.height === name) return spec.height ?? undefined;
  if (roles.duration === name) return spec.duration ?? undefined;
  if (roles.count === name) return spec.count ?? undefined;
  if (roles.audio === name) return spec.audio ?? undefined;
  if (roles.seed === name) return spec.seed;
  // The plugin never asks for a watermark.
  if (roles.watermark === name) return false;
  return undefined;
}

/** The node class that names an already uploaded file so a model can read it. */
export const LOAD_IMAGE_NODE = "LoadImage";
/** Node ids 1 and 2 are the model and the save node, so references start at 3. */
const FIRST_REFERENCE_NODE = 3;

/**
 * The graph for one resolved request: the model node in slot 1, the save node
 * in slot 2, plus one LoadImage node per reference image from slot 3 on.
 *
 * The reference slots are written after every declared input, so a request that
 * names no reference produces the same bytes as a graph with no reference
 * support at all. That is what the golden fixtures pin.
 *
 * The wire name is `<group>.<slot>` ("model.images.image_1") and the value is a
 * link. The node reads references only under this spelling; another spelling
 * fails at execute time or is ignored. Keep this shape.
 */
export function buildWorkflow(spec: ModelSpec): Workflow {
  const entry = spec.entry;
  const inputs: Record<string, JsonValue> = {};
  for (const declared of entry.inputs) {
    const fromRole = roleValue(entry, spec, declared.name);
    const fromExtras = spec.extras[declared.name];
    const fromCompat = entry.compat?.[declared.name];
    const value = fromRole ?? fromExtras ?? fromCompat ?? (declared.required ? defaultOf(declared) : undefined);
    if (value === undefined) continue;
    inputs[declared.name] = fit(declared, value, entry);
  }
  const save: Record<string, JsonValue> =
    entry.outputNodeKind === "SaveVideo"
      ? { video: ["1", 0], filename_prefix: "video/bb", format: "mp4", "format.codec": "h264" }
      : { images: ["1", 0], filename_prefix: "bb" };
  const workflow: Workflow = {
    "1": { class_type: entry.node, inputs },
    "2": { class_type: entry.outputNodeKind, inputs: save },
  };
  const group = entry.referenceImages;
  if (group !== undefined) {
    spec.references.forEach((reference, index) => {
      const slot = group.slots[index];
      if (slot === undefined) return;
      const nodeId = String(FIRST_REFERENCE_NODE + index);
      workflow[nodeId] = { class_type: LOAD_IMAGE_NODE, inputs: { image: reference.name } };
      inputs[`${group.input}.${slot}`] = [nodeId, 0];
    });
  }
  return workflow;
}

function defaultOf(input: GeneratedInput): string | number | boolean | undefined {
  if (input.default !== undefined) return input.default;
  if (input.type === "INT" || input.type === "FLOAT") return input.min ?? 0;
  if (input.type === "BOOLEAN") return false;
  if (input.options !== undefined && input.options.length > 0) return input.options[0];
  if (input.type === "STRING") return "";
  return undefined;
}

/**
 * The quality tier a request runs at, where an extra sets one. The value the
 * caller chose wins; otherwise it is the tier the node itself defaults to,
 * because that is what the graph will carry.
 */
export function specQuality(spec: ModelSpec): string | null {
  for (const name of QUALITY_INPUT_NAMES) {
    const chosen = spec.extras[name];
    // The wire value, not a normalised one: on Ideogram the input is called
    // `quality` outright, so the two would overwrite each other and Tweak would
    // come back with a value the node does not offer. `costSignature` and
    // `tierMatches` both lowercase what they are given.
    if (typeof chosen === "string" && chosen !== "") return chosen;
    const declared = spec.entry.inputs.find((input) => input.name === name);
    if (declared !== undefined && typeof declared.default === "string" && declared.default !== "") return declared.default;
  }
  return null;
}

/**
 * The params the asset row keeps: one field per role the model has, every extra
 * the caller set under its own wire name, and the quality tier when the model
 * prices by one. The extras are what lets Tweak restore a request exactly, and
 * the quality is what lets the stored estimate agree with the form's.
 */
export function specParams(spec: ModelSpec): Params {
  const params: Params = {};
  const roles = spec.entry.roles;
  if (roles.sizePreset !== undefined && spec.sizePreset !== null) params.sizePreset = spec.sizePreset;
  if (spec.width !== null) params.width = spec.width;
  if (spec.height !== null) params.height = spec.height;
  if (roles.resolution !== undefined && spec.resolution !== null) params.resolution = spec.resolution;
  if (roles.aspect !== undefined && spec.aspect !== null) params.aspectRatio = spec.aspect;
  if (roles.duration !== undefined && spec.duration !== null) params.duration = spec.duration;
  if (roles.audio !== undefined && spec.audio !== null) params.generateAudio = spec.audio;
  if (roles.count !== undefined && spec.count !== null && spec.count > 1) params.count = spec.count;
  if (roles.negativePrompt !== undefined && spec.negativePrompt !== null && spec.negativePrompt !== "") params.negativePrompt = spec.negativePrompt;
  for (const [name, value] of Object.entries(spec.extras)) {
    // A role already has a param name of its own; an extra keeps its wire name.
    if (Object.values(roles).includes(name)) continue;
    params[name] = value;
  }
  const quality = specQuality(spec);
  if (quality !== null) params.quality = quality;
  // Where the references came from, not what Comfy called them: an asset id or
  // a path means something to a person, a sha256 does not. The graph carries
  // the uploaded names, so Retry and Tweak still work from the stored file.
  if (spec.references.length > 0) {
    params.references = spec.references.map((reference) => reference.from).join(", ");
    // The count as a number beside the origins, because the price shape is keyed
    // by it and an origin can hold a comma.
    params.referenceCount = spec.references.length;
  }
  params.seed = spec.seed;
  return params;
}

// ---------- the two named entry points the rest of the plugin uses ----------

export function resolveImageSpec(input: GenerateImageInput, defaultModel: string, references?: readonly ReferenceImage[]): ModelSpec {
  return resolveSpec(
    {
      references,
      prompt: input.prompt,
      model: input.model,
      sizePreset: input.sizePreset,
      aspect: input.aspect,
      resolution: input.resolution,
      width: input.width,
      height: input.height,
      count: input.count,
      negativePrompt: input.negativePrompt,
      seed: input.seed,
      extras: input.extras,
    },
    defaultModel,
    "image",
  );
}

export function resolveVideoSpec(input: GenerateVideoInput, defaultModel: string, references?: readonly ReferenceImage[]): ModelSpec {
  return resolveSpec(
    {
      references,
      prompt: input.prompt,
      model: input.model,
      sizePreset: input.sizePreset,
      aspect: input.aspect ?? input.aspectRatio,
      resolution: input.resolution,
      width: input.width,
      height: input.height,
      duration: input.duration,
      count: input.count,
      negativePrompt: input.negativePrompt,
      generateAudio: input.generateAudio,
      seed: input.seed,
      extras: input.extras,
    },
    defaultModel,
    "video",
  );
}

// ---------- inspection of arbitrary graphs ----------

const VIDEO_SAVE_NODES = /SaveVideo|VideoCombine|SaveAnimated|SaveWEBM|CreateVideo/i;
const PROMPT_INPUTS = ["prompt", "model.prompt", "text", "positive", "positive_prompt", "string"];
const MODEL_INPUTS = ["model", "model.name", "model_name", "ckpt_name", "unet_name"];
/** Raw input names mapped to the param names the generate form uses, so "Tweak" round-trips. */
const PARAM_NAMES: Record<string, string> = {
  "model.size_preset": "sizePreset",
  "model.width": "width",
  "model.height": "height",
  size_preset: "sizePreset",
  size: "sizePreset",
  width: "width",
  height: "height",
  resolution: "resolution",
  "model.resolution": "resolution",
  aspect_ratio: "aspectRatio",
  ratio: "aspectRatio",
  "model.ratio": "aspectRatio",
  duration: "duration",
  "model.duration": "duration",
  generate_audio: "generateAudio",
  "model.generate_audio": "generateAudio",
  seed: "seed",
  "model.seed": "seed",
};
const SKIPPED_PARAMS = new Set(["model.max_images", "model.fail_on_partial", "watermark", "camera_fixed", "model.output_format"]);

/** Longest prompt kept in the asset row. Longer prompts are cut with a marker. */
export const MAX_STORED_PROMPT = 2000;
/** Longest string kept as a param value, and the longest fallback prompt candidate. */
export const MAX_PARAM_STRING = 500;

/** Cut a prompt to the stored length; a cut prompt says so. */
export function capPrompt(text: string): string {
  return text.length <= MAX_STORED_PROMPT ? text : `${text.slice(0, MAX_STORED_PROMPT)} [cut, ${text.length} chars]`;
}

export interface WorkflowInfo {
  kind: AssetKind;
  prompt: string | null;
  model: string | null;
  seed: number | null;
  params: Params;
}

function isScalar(value: JsonValue): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Kind (from the save node), prompt, model, seed and flat params of a graph. */
export function inspectWorkflow(workflow: Workflow): WorkflowInfo {
  const nodeIds = Object.keys(workflow).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const kind: AssetKind = nodeIds.some((id) => VIDEO_SAVE_NODES.test(workflow[id]?.class_type ?? "")) ? "video" : "image";

  let promptNode: string | null = null;
  let prompt: string | null = null;
  for (const id of nodeIds) {
    const inputs = workflow[id]?.inputs ?? {};
    for (const name of PROMPT_INPUTS) {
      const value = inputs[name];
      if (typeof value === "string" && value.trim() !== "") {
        promptNode = id;
        prompt = value;
        break;
      }
    }
    if (promptNode !== null) break;
  }
  if (promptNode === null) {
    let best = "";
    for (const id of nodeIds) {
      for (const value of Object.values(workflow[id]?.inputs ?? {})) {
        if (typeof value === "string" && value.length > best.length && value.length >= 12 && value.length <= MAX_PARAM_STRING && !/^[\w./-]+$/.test(value)) {
          best = value;
          promptNode = id;
        }
      }
    }
    prompt = best === "" ? null : best;
  }

  let model: string | null = null;
  let seed: number | null = null;
  const params: Params = {};
  const candidates = promptNode !== null ? [promptNode, ...nodeIds.filter((id) => id !== promptNode)] : nodeIds;
  for (const id of candidates) {
    const inputs = workflow[id]?.inputs ?? {};
    if (model === null) {
      for (const name of MODEL_INPUTS) {
        const value = inputs[name];
        if (typeof value === "string" && value !== "") {
          model = value;
          break;
        }
      }
    }
    if (seed === null) {
      const found = seedInput(inputs);
      if (found !== null) seed = inputs[found] as number;
    }
  }
  if (promptNode !== null) {
    for (const [name, value] of Object.entries(workflow[promptNode]?.inputs ?? {})) {
      if (PROMPT_INPUTS.includes(name) || MODEL_INPUTS.includes(name) || SKIPPED_PARAMS.has(name)) continue;
      if (!isScalar(value) || isLink(value)) continue;
      // A long string here is prompt-like free text, not a setting. Keep the
      // shape without copying the text into the row.
      params[PARAM_NAMES[name] ?? name] = typeof value === "string" && value.length > MAX_PARAM_STRING ? `[${value.length} chars]` : value;
    }
  }
  if (seed !== null) params.seed = seed;
  // The preset decides the output size; model.width and model.height are only
  // the (clamped) custom values, so the preset wins when both are present.
  const preset = typeof params.sizePreset === "string" ? parseSizePreset(params.sizePreset) : null;
  if (preset !== null) {
    params.width = preset.width;
    params.height = preset.height;
  }
  return { kind, prompt: prompt === null ? null : capPrompt(prompt), model, seed, params };
}

/**
 * The name a node spells its seed under: `seed`, or the dotted sub-input of a
 * dynamic combo (`model.seed`). Half the catalog uses the dotted form,
 * including the shipped default, so both are read; reading only the bare name
 * would make "retry with a new seed" produce the same picture again.
 */
function seedInput(inputs: Record<string, unknown>): string | null {
  for (const [name, value] of Object.entries(inputs)) {
    if (typeof value !== "number") continue;
    if (name === "seed" || name.endsWith(".seed")) return name;
  }
  return null;
}

/** Deep copy with every seed input replaced, dotted or not. */
export function withSeed(workflow: Workflow, seed: number): Workflow {
  const copy = JSON.parse(JSON.stringify(workflow)) as Workflow;
  for (const node of Object.values(copy)) {
    if (!node) continue;
    const name = seedInput(node.inputs);
    if (name !== null) node.inputs[name] = seed;
  }
  return copy;
}

export function seedOf(workflow: Workflow): number | null {
  for (const node of Object.values(workflow)) {
    if (!node) continue;
    const name = seedInput(node.inputs);
    if (name !== null) return node.inputs[name] as number;
  }
  return null;
}

/** The registry entries a node class can run, for clamping a hand edited graph. */
const BY_NODE = new Map<string, RegistryEntry[]>();
for (const entry of MODEL_ENTRIES) {
  const list = BY_NODE.get(entry.node) ?? [];
  list.push(entry);
  BY_NODE.set(entry.node, list);
}

/**
 * Pull every number in a hand edited graph into the range its node declares, so
 * a graph does not fail on a value that is only used for a "Custom" preset,
 * such as the 736 pixel height a 1K 16:9 Seedream preset names. It covers every
 * model in the registry.
 */
export function clampImageNodes(workflow: Workflow): Workflow {
  const copy = JSON.parse(JSON.stringify(workflow)) as Workflow;
  for (const node of Object.values(copy)) {
    if (!node) continue;
    const candidates = BY_NODE.get(node.class_type);
    if (candidates === undefined || candidates.length === 0) continue;
    const modelValue = typeof node.inputs.model === "string" ? node.inputs.model : null;
    const entry = candidates.find((e) => e.modelId === modelValue) ?? (candidates.length === 1 ? candidates[0]! : null);
    if (entry === null) continue;
    for (const declared of entry.inputs) {
      if (declared.type !== "INT" && declared.type !== "FLOAT") continue;
      if (declared.min === undefined && declared.max === undefined) continue;
      const value = node.inputs[declared.name];
      if (typeof value !== "number") continue;
      node.inputs[declared.name] = clampToRange(value, rangeOf(declared));
    }
  }
  return copy;
}
