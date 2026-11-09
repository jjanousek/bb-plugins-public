#!/usr/bin/env node
// make-models.mjs: build models.generated.ts from the cached Comfy Cloud node
// catalog, and models.overrides.ts from the hand checked vendor documentation
// in qa/model-docs. Run by hand, like make-art.mjs, never at build time:
//
//   node scripts/make-models.mjs            write both files
//   node scripts/make-models.mjs --check    print the summary, write nothing
//
// The catalog is ~/.bb/plugins/comfy-cloud/object_info.json (override with
// COMFY_CATALOG). Runtime never reads it: models.generated.ts is checked in and
// is the source of truth, so tests are deterministic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CATALOG = process.env.COMFY_CATALOG ?? path.join(os.homedir(), ".bb", "plugins", "comfy-cloud", "object_info.json");
const DOCS_DIR = path.join(ROOT, "qa", "model-docs");
const CHECK = process.argv.includes("--check");

// ---------- the selection rule ----------

/** Input types we cannot produce from a text prompt. A required one disqualifies the node. */
const MEDIA_TYPES = new Set(["IMAGE", "VIDEO", "AUDIO", "MASK", "LATENT"]);

/**
 * Nodes that pass the mechanical rule but raise at execute time because they
 * need media, a prior generation id or a custom type we cannot construct. Each
 * name comes from the node's documentation and source, and is a node whose
 * media input sits in an optional or autogrow group, so the schema alone cannot
 * tell.
 */
const NOT_TEXT_TO_SOMETHING = {
  ByteDance2FirstLastFrameNode: "Needs a first and last frame image.",
  ByteDance2ReferenceNodeV2: "Needs at least one reference image.",
  ByteDance2ReferenceNode: "Needs at least one reference image.",
  Wan2ReferenceVideoApi: "Needs at least one reference image.",
  WanReferenceVideoApi: "Needs at least one reference image.",
  HappyHorseReferenceVideoApi: "Needs at least one reference image.",
  QwenImageEditApi: "Edits an image, so it needs one.",
  LumaImageToVideoNode: "Animates an image, so it needs one.",
  LumaRay32ImageToVideoNode: "Animates an image, so it needs one.",
  LumaRay32KeyframesToVideoNode: "Needs a LUMA_RAY32_KEYFRAME chain.",
  LumaRay32ExtendVideoNode: "Extends an earlier generation, so it needs its id.",
  GrokImageEditNodeV2: "Edits an image, so it needs one.",
  GrokVideoReferenceNode: "Needs at least one reference image.",
  Flux3ImageToVideoNode: "Raises 'Connect at least one keyframe image'.",
  MinimaxHailuo03ReferenceNode: "Needs at least one reference image.",
  PixverseV6FusionVideoNode: "Needs at least one reference image.",
  Vidu2ReferenceVideoApi: "Needs at least one reference image.",
  Vidu2ReferenceVideoNode: "Needs at least one reference image.",
  KlingVideoExtendNode: "Extends an earlier generation, so it needs its video id.",
  HeyGenAvatarVideoNode: "Drives an avatar, and has no prompt role.",
};

/**
 * The extra inputs the frozen Seedream and Seedance graphs carry, so the
 * generic builder reproduces them byte for byte; see the golden fixtures in
 * test/fixtures. Everything else the
 * builder derives from the schema.
 */
const COMPAT = {
  // 5.0 Pro declares neither input, but the frozen graph sends both and Comfy
  // Cloud accepts them.
  "ByteDanceSeedreamNodeV2/seedream 5.0 pro": { "model.max_images": 1, "model.fail_on_partial": false },
  // camera_fixed is optional and has no role; the frozen Seedance 1.x graph sends it.
  ByteDanceTextToVideoNode: { camera_fixed: false },
};

/**
 * Starting values the plugin uses where they differ from the node's own
 * default. Comfy's Seedance 2.x slider starts at 7 seconds; this plugin starts
 * at 5, because a longer clip costs proportionally more.
 *
 * The three Gemini Omni entries are the other case: they have no duration
 * input at all, because the length is written into the prompt, and Google
 * documents that the model returns 10 seconds when the prompt does not say.
 * Recording that here is what lets the estimate quote the length a click
 * actually buys instead of the 5 second fallback.
 */
const DEFAULTS = {
  "ByteDance2TextToVideoNode/Seedance 2.5": { duration: 5 },
  "ByteDance2TextToVideoNode/Seedance 2.0": { duration: 5 },
  "ByteDance2TextToVideoNode/Seedance 2.0 Fast": { duration: 5 },
  "ByteDance2TextToVideoNode/Seedance 2.0 Mini": { duration: 5 },
  "GeminiVideoOmniV2/Omni Flash 1.1": { duration: 10 },
  "GeminiVideoOmniV2/Omni Flash": { duration: 10 },
  "GeminiVideoOmni/Omni Flash": { duration: 10 },
  // The node defaults to "5", a string, because its list also holds "auto";
  // without this the form would read the first number and open at 1 second.
  "PrunaTextToVideoNode/p-video-2": { duration: 5 },
};

/** Legacy model ids that must keep resolving, mapped to the entry that built their graphs. */
const ALIASES = {
  "seedream 5.0 pro": "ByteDanceSeedreamNodeV2/seedream 5.0 pro",
  "seedream 5.0 lite": "ByteDanceSeedreamNodeV2/seedream 5.0 lite",
  "seedream-4-5-251128": "ByteDanceSeedreamNodeV2/seedream-4-5-251128",
  "seedream-4-0-250828": "ByteDanceSeedreamNodeV2/seedream-4-0-250828",
  "seedance-1-0-pro-fast-251015": "ByteDanceTextToVideoNode/seedance-1-0-pro-fast-251015",
  "seedance-1-5-pro-251215": "ByteDanceTextToVideoNode/seedance-1-5-pro-251215",
  "seedance-1-0-pro-250528": "ByteDanceTextToVideoNode/seedance-1-0-pro-250528",
  "Seedance 2.0 Fast": "ByteDance2TextToVideoNode/Seedance 2.0 Fast",
  "Seedance 2.0": "ByteDance2TextToVideoNode/Seedance 2.0",
  "Seedance 2.5": "ByteDance2TextToVideoNode/Seedance 2.5",
};

/** Vendor display names, where the catalog category spells one oddly. */
const VENDOR_NAMES = {
  Bytedance: "ByteDance",
  Sora: "OpenAI",
  Veo: "Google",
  Gemini: "Google",
  Grok: "xAI",
};

// ---------- reading the catalog ----------

function typeOf(spec) {
  const t = spec[0];
  return Array.isArray(t) ? "COMBO" : String(t);
}

function optionsOf(spec) {
  const t = spec[0];
  if (Array.isArray(t)) return t;
  const meta = spec[1] ?? {};
  return Array.isArray(meta.options) ? meta.options : null;
}

/** Walk the declared inputs of a node or of one dynamic combo option, in order. */
function orderedInputs(inputBlock, order) {
  const out = [];
  const seen = new Set();
  for (const section of ["required", "optional"]) {
    const dict = inputBlock?.[section] ?? {};
    const names = Array.isArray(order?.[section]) ? order[section].filter((n) => n in dict) : [];
    for (const name of names) {
      seen.add(name);
      out.push({ name, spec: dict[name], required: section === "required" });
    }
    for (const [name, spec] of Object.entries(dict)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, spec, required: section === "required" });
    }
  }
  return out;
}

/** True when a declared input can never be filled from a text prompt. */
function isMediaInput(spec) {
  const type = typeOf(spec);
  if (MEDIA_TYPES.has(type)) return true;
  if (type !== "COMFY_AUTOGROW_V3") return false;
  return true; // an autogrow group is a list of media slots; the builder never fills one
}

/**
 * An optional autogrow group of IMAGE slots: the reference images a model takes
 * beside its prompt.
 *
 * Media autogrow groups are skipped everywhere else, because the builder cannot
 * invent a picture. This is the one exception, and it is narrow on purpose:
 * `min` must be 0 (a group that demands an image makes the node an edit node,
 * and `requiresMedia` has already dropped it), the template must hold exactly
 * one required IMAGE and nothing else, and the vendor must name the slots. The
 * slot names are what the graph is wired with, so a group that names none is no
 * use: Recraft's `style_references` is the case, and it stays skipped.
 */
function referenceGroup(spec) {
  if (typeOf(spec) !== "COMFY_AUTOGROW_V3") return null;
  const template = spec[1]?.template ?? {};
  if (Number(template.min ?? 0) >= 1) return null;
  const required = Object.entries(template.input?.required ?? {});
  const optional = Object.entries(template.input?.optional ?? {});
  if (required.length !== 1 || optional.length > 0) return null;
  if (typeOf(required[0][1]) !== "IMAGE") return null;
  const names = Array.isArray(template.names) ? template.names.filter((n) => typeof n === "string" && n !== "") : [];
  if (names.length === 0) return null;
  return { slots: names, min: 0, max: names.length };
}

/**
 * The sentence for one input that demands media, or null when it does not.
 *
 * `requiresMedia` only reads the node's own top level, and a node that keeps
 * everything under a `COMFY_DYNAMICCOMBO_V3` hides its media there: Meta Muse
 * Image Edit declares `model.images`, an autogrow of one to ten IMAGE slots
 * with `min` 1, which the node level check does not see. Skipped as media like
 * any other group, it would leave the entry supported with no image input at
 * all, a text to image model that cannot run. So every sub input is read the
 * same way the node's own are.
 */
function demandsMedia(spec, required) {
  if (!required) return null;
  const type = typeOf(spec);
  if (MEDIA_TYPES.has(type)) return mediaSentence(type);
  if (type !== "COMFY_AUTOGROW_V3") return null;
  const template = spec[1]?.template ?? {};
  if (Number(template.min ?? 0) < 1) return null;
  const inner = Object.values(template.input?.required ?? {}).map((s) => typeOf(s));
  const media = inner.find((t) => MEDIA_TYPES.has(t));
  return media === undefined ? null : mediaSentence(media);
}

/** Plain words for what the model wants, for `bb comfy models --all`. */
function mediaSentence(type) {
  const thing = type === "IMAGE" ? "an image" : type === "VIDEO" ? "a video" : type === "AUDIO" ? "a sound file" : "media";
  return `Needs ${thing} to work from, so a prompt on its own cannot drive it.`;
}

/** A required autogrow that demands at least one media item makes the node an edit node. */
function requiresMedia(node) {
  for (const [name, spec] of Object.entries(node.input?.required ?? {})) {
    const type = typeOf(spec);
    if (MEDIA_TYPES.has(type)) return `required ${type} input "${name}"`;
    if (type === "COMFY_AUTOGROW_V3") {
      const template = spec[1]?.template ?? {};
      const min = Number(template.min ?? 0);
      const inner = Object.values(template.input?.required ?? {}).map((s) => typeOf(s));
      if (min >= 1 && inner.some((t) => MEDIA_TYPES.has(t))) return `required "${name}" group needs at least ${min} ${inner[0] ?? "item"}`;
    }
  }
  return null;
}

// ---------- roles ----------

const ASPECT_RE = /^\d{1,2}\s*:\s*\d{1,2}$/;
// A K tier may carry a decimal: MAI offers 1.5K and FLUX.3 0.75K and 1.5K.
// Without it FLUX.3's five sizes read as three tiers out of five, below the
// all but one rule, and the model gets no Size control.
const TIER_RE = /^(\d{3,4}\s*[pP]|\d(\.\d{1,2})?\s*[kK]|SD|HD|FHD|UHD)$/;
const SIZE_RE = /(\d{3,5})\s*[x×]\s*(\d{3,5})/;

/** A ratio combo may carry one or two escape hatches such as "auto" or "adaptive". */
function looksLikeAspect(options) {
  if (options === null || options.length === 0) return false;
  const ratios = options.filter((o) => typeof o === "string" && ASPECT_RE.test(o)).length;
  return ratios >= 2 && ratios >= options.length - 2;
}
function looksLikeTier(options) {
  return options !== null && options.length > 0 && options.filter((o) => typeof o === "string" && TIER_RE.test(o.trim())).length >= Math.max(1, options.length - 1);
}
/**
 * Escape hatches a size list carries beside its real sizes. They are not sizes
 * and must not count against the list: GPT Image 2 offers eight WxH options
 * plus "auto" and "Custom", and counting those two as failures would leave it
 * with no Size control while gpt-image-1 on the same node has one.
 */
const SIZE_SENTINELS = new Set(["auto", "custom", "default", "none", "original", "match_input"]);
function looksLikeSize(options) {
  if (options === null || options.length === 0) return false;
  const named = options.filter((o) => typeof o === "string" && !SIZE_SENTINELS.has(o.trim().toLowerCase()));
  return named.length > 0 && named.filter((o) => SIZE_RE.test(o)).length >= Math.max(1, named.length - 1);
}
function looksLikeSeconds(options) {
  return options !== null && options.length > 0 && options.every((o) => typeof o === "number" || (typeof o === "string" && /^\d+(\.\d+)?\s*s?$/i.test(o)) || o === "auto");
}

const PROMPT_NAMES = ["prompt", "prompt_text", "positive_prompt", "text"];
const NEGATIVE_NAMES = ["negative_prompt", "negativeprompt"];
const ASPECT_NAMES = ["aspect_ratio", "aspectratio", "ratio", "aspect"];
const RESOLUTION_NAMES = ["resolution", "quality", "video_quality"];
const SIZE_NAMES = ["size", "size_preset", "image_size", "output_size", "resolution", "ratio", "dimensions"];
const DURATION_NAMES = ["duration", "duration_seconds", "length", "video_length", "seconds"];
const AUDIO_NAMES = ["generate_audio", "background_music", "with_audio", "audio"];
const COUNT_NAMES = ["n", "num_images", "max_images", "series_amount", "batch_size", "image_count", "num_outputs"];

/** Map one declared input to a role, or null when it is an extra. */
function roleOf(bare, spec, taken) {
  const type = typeOf(spec);
  const options = optionsOf(spec);
  const name = bare.toLowerCase();
  if (!taken.has("prompt") && PROMPT_NAMES.includes(name) && type === "STRING") return "prompt";
  if (NEGATIVE_NAMES.includes(name) && type === "STRING") return "negativePrompt";
  if (name === "seed" && (type === "INT" || type === "FLOAT")) return "seed";
  if (name === "watermark" && type === "BOOLEAN") return "watermark";
  if (AUDIO_NAMES.includes(name) && type === "BOOLEAN") return "audio";
  if (COUNT_NAMES.includes(name) && (type === "INT" || (type === "COMBO" && looksLikeSeconds(options)))) return "count";
  if (DURATION_NAMES.includes(name) && (type === "INT" || type === "FLOAT" || (type === "COMBO" && looksLikeSeconds(options)))) return "duration";
  if (name === "width" && (type === "INT" || type === "FLOAT")) return "width";
  if (name === "height" && (type === "INT" || type === "FLOAT")) return "height";
  if (type === "COMBO" || Array.isArray(spec[0])) {
    // A combo whose options are pixel sizes is a preset list, whatever it is called.
    if (SIZE_NAMES.includes(name) && looksLikeSize(options)) return "sizePreset";
    if (ASPECT_NAMES.includes(name) && looksLikeAspect(options)) return "aspect";
    if (RESOLUTION_NAMES.includes(name) && looksLikeTier(options)) return "resolution";
    if (SIZE_NAMES.includes(name) && !taken.has("sizePreset") && looksLikeTier(options)) return "resolution";
    if (ASPECT_NAMES.includes(name) && looksLikeSize(options)) return "sizePreset";
  }
  return null;
}

// ---------- building one entry ----------

function vendorOf(category, node) {
  const parts = category.split("/");
  const raw = parts[2] ?? parts[1] ?? "Other";
  return VENDOR_NAMES[raw] ?? raw;
}

function prettyLabel(modelId, node) {
  if (modelId === null) return node.display_name ?? node.name;
  if (/[A-Z]/.test(modelId) || modelId.includes(" ")) return modelId;
  return modelId
    .replace(/-\d{6,}$/, "")
    .split("-")
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function inputRecord(wireName, bare, spec, required) {
  const meta = spec[1] ?? {};
  const type = typeOf(spec);
  const options = optionsOf(spec);
  const record = { name: wireName, type, required };
  if (options !== null) record.options = options.map((o) => String(o));
  // Options are stored as strings, so remember when the catalog's own are
  // numbers. ComfyUI checks a combo value with a plain `in`, no coercion: Kling
  // declares [5, 10] and must get 5, Pruna declares ["24", "48"] and must get
  // "24". Sending every all-digit list as a number would fail the second kind.
  if (options !== null && options.length > 0 && options.every((o) => typeof o === "number")) record.numeric = true;
  if (typeof meta.min === "number") record.min = meta.min;
  if (typeof meta.max === "number") record.max = meta.max;
  if (typeof meta.step === "number") record.step = meta.step;
  if (meta.default !== undefined && (typeof meta.default === "string" || typeof meta.default === "number" || typeof meta.default === "boolean")) record.default = meta.default;
  if (meta.multiline === true) record.multiline = true;
  if (typeof meta.tooltip === "string" && meta.tooltip !== "") record.tooltip = meta.tooltip.slice(0, 240);
  if (record.default === undefined && record.options && record.options.length > 0 && type === "COMBO") record.default = record.options[0];
  return record;
}

/**
 * One registry entry: the node, one model id, the ordered wire inputs, and the
 * role map. The order is what makes the frozen graphs come out byte identical.
 */
function buildEntry(node, catalog, modelInput, modelId, dynamicChoices, compat) {
  const inputs = [];
  const roles = {};
  const references = [];
  const taken = new Set();
  let mediaBlock = null;
  const order = node.input_order ?? {};
  const addCompat = () => {
    for (const [name, value] of Object.entries(compat ?? {})) {
      if (inputs.some((i) => i.name === name)) continue;
      inputs.push({ name, type: typeof value === "boolean" ? "BOOLEAN" : typeof value === "number" ? "INT" : "STRING", required: false, default: value, compat: true });
    }
  };

  const push = (wireName, bare, spec, required) => {
    const group = referenceGroup(spec);
    if (group !== null) {
      references.push({ input: wireName, ...group });
      return;
    }
    if (isMediaInput(spec)) return;
    const role = roleOf(bare, spec, taken);
    if (role !== null && roles[role] === undefined) {
      roles[role] = wireName;
      taken.add(role);
    }
    inputs.push(inputRecord(wireName, bare, spec, required));
  };

  for (const { name, spec, required } of orderedInputs(node.input, order)) {
    const type = typeOf(spec);
    if (type === "COMFY_DYNAMICCOMBO_V3") {
      const options = spec[1]?.options ?? [];
      const chosen = name === modelInput ? options.find((o) => o.key === modelId) : options.find((o) => o.key === dynamicChoices[name]) ?? options[0];
      const key = chosen?.key ?? null;
      if (key === null) continue;
      inputs.push({ name, type: "COMFY_DYNAMICCOMBO_V3", required, options: options.map((o) => String(o.key)), default: key });
      if (name === modelInput) roles.model = name;
      for (const sub of orderedInputs(chosen.inputs, chosen.inputs?.input_order)) {
        // push() reads the reference group out of the spec, so a media input
        // that is not one is skipped here.
        if (isMediaInput(sub.spec) && referenceGroup(sub.spec) === null) {
          mediaBlock = mediaBlock ?? demandsMedia(sub.spec, sub.required);
          continue;
        }
        push(`${name}.${sub.name}`, sub.name, sub.spec, sub.required);
      }
      // The frozen graphs send a couple of inputs this model does not declare.
      // They belong right here, at the end of the model's own block.
      addCompat();
      continue;
    }
    if (name === modelInput && modelId !== null) {
      inputs.push(inputRecord(name, name, spec, required));
      roles.model = name;
      continue;
    }
    push(name, name, spec, required);
  }
  addCompat();
  // One group or none. PixVerse V6 Fusion declares two ("subjects" and
  // "backgrounds") and nothing in the schema says which one a plain reference
  // belongs in, so it is left out rather than guessed at.
  return { inputs, roles, mediaBlock, referenceImages: references.length === 1 ? references[0] : null };
}

// ---------- generate ----------

function loadCatalog() {
  if (!fs.existsSync(CATALOG)) {
    console.error(`No node catalog at ${CATALOG}. Start the plugin once, or set COMFY_CATALOG.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CATALOG, "utf8"));
}

function generate(catalog) {
  const entries = [];
  const skipped = [];
  for (const [name, node] of Object.entries(catalog)) {
    const category = node.category ?? "";
    if (!category.startsWith("partner/")) continue;
    const outputs = node.output ?? [];
    const first = Array.isArray(outputs) ? outputs[0] : null;
    if (first !== "IMAGE" && first !== "VIDEO") continue;

    const kind = first === "IMAGE" ? "image" : "video";
    const media = requiresMedia(node);
    if (media !== null) {
      skipped.push({ node: name, reason: media });
      continue;
    }

    // Which input carries the model id, and which dynamic combos we pin.
    const all = orderedInputs(node.input, node.input_order ?? {});
    const modelEntry = all.find((i) => ["model", "model_name", "model_version"].includes(i.name));
    const dynamicChoices = {};
    for (const { name: iname, spec } of all) {
      if (typeOf(spec) === "COMFY_DYNAMICCOMBO_V3" && iname !== modelEntry?.name) {
        dynamicChoices[iname] = (spec[1]?.options ?? [])[0]?.key ?? null;
      }
    }

    let modelIds = [null];
    let modelInput = null;
    if (modelEntry) {
      modelInput = modelEntry.name;
      const type = typeOf(modelEntry.spec);
      if (type === "COMFY_DYNAMICCOMBO_V3") modelIds = (modelEntry.spec[1]?.options ?? []).map((o) => String(o.key));
      else if (type === "COMBO") modelIds = (optionsOf(modelEntry.spec) ?? []).map((o) => String(o));
      else modelInput = null;
      if (modelIds.length === 0) {
        modelIds = [null];
        modelInput = null;
      }
    }

    for (const modelId of modelIds) {
      const key = modelId === null ? name : `${name}/${modelId}`;
      const compat = COMPAT[key] ?? COMPAT[name] ?? null;
      const { inputs, roles, mediaBlock, referenceImages } = buildEntry(node, catalog, modelInput, modelId, dynamicChoices, compat);
      const missing = inputs.filter((i) => i.required && i.default === undefined && !Object.values(roles).includes(i.name) && i.type !== "COMFY_DYNAMICCOMBO_V3");
      let supported = true;
      let reason = null;
      if (NOT_TEXT_TO_SOMETHING[name]) {
        supported = false;
        reason = NOT_TEXT_TO_SOMETHING[name];
      } else if (roles.prompt === undefined) {
        supported = false;
        reason = "The node has no text prompt input.";
      } else if (mediaBlock !== null) {
        supported = false;
        reason = mediaBlock;
      } else if (missing.length > 0) {
        supported = false;
        reason = `Required input${missing.length > 1 ? "s" : ""} with no role and no default: ${missing.map((i) => i.name).join(", ")}.`;
      }
      entries.push({
        key,
        node: name,
        modelId,
        modelInput,
        kind,
        vendor: vendorOf(category, node),
        category,
        label: prettyLabel(modelId, node),
        displayName: node.display_name ?? name,
        description: typeof node.description === "string" ? node.description.slice(0, 300) : "",
        outputNodeKind: kind === "image" ? "SaveImage" : "SaveVideo",
        deprecated: node.deprecated === true,
        experimental: node.experimental === true,
        supported,
        unsupportedReason: reason,
        roles,
        inputs,
        ...(referenceImages ? { referenceImages } : {}),
        ...(compat ? { compat } : {}),
      });
    }
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return { entries, skipped };
}

// ---------- the documentation files ----------

function loadDocs() {
  const records = [];
  if (!fs.existsSync(DOCS_DIR)) return records;
  for (const file of fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const data = JSON.parse(fs.readFileSync(path.join(DOCS_DIR, file), "utf8"));
    for (const [docKey, record] of Object.entries(data)) records.push({ file, docKey, record });
  }
  return records;
}

/** Every registry key a documentation record could belong to, best first. */
function candidateKeys({ docKey, record }) {
  const out = [];
  const add = (k) => {
    if (typeof k === "string" && k !== "" && !out.includes(k)) out.push(k);
  };
  add(record.registryKey);
  const nodes = [record.node, ...(Array.isArray(record.nodes) ? record.nodes : [])].filter((n) => typeof n === "string");
  for (const node of nodes) {
    if (typeof record.modelId === "string") add(`${node}/${record.modelId}`);
    add(`${node}/${docKey}`);
    if (record.modelIdSelectable === false || record.modelId === null || record.modelId === undefined) add(node);
  }
  add(docKey);
  return out;
}

// ---------- normalising a documented price ----------

const CREDITS_PER_USD = 211;
/** A documented price is published or inferred; `measured` belongs to a user's own bills, never to a doc. */
const DOC_CONFIDENCES = ["published", "inferred", "unknown"];

function creditsOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value.credits === "number" && Number.isFinite(value.credits)) return round2(value.credits);
  if (typeof value.usd === "number" && Number.isFinite(value.usd)) return round2(value.usd * CREDITS_PER_USD);
  // Token billed models publish a low and a high instead of one figure.
  const range = rangeOf(value);
  return range === null ? null : range[0];
}

/** [low, high] credits when a documented figure is a range rather than a number. */
function rangeOf(value) {
  if (!value || typeof value !== "object") return null;
  const pick = (v, factor) => (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number") ? [round2(v[0] * factor), round2(v[1] * factor)] : null);
  return pick(value.credits, 1) ?? pick(value.creditsRange, 1) ?? pick(value.usd, CREDITS_PER_USD) ?? pick(value.usdRange, CREDITS_PER_USD);
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

const UNITS = new Set(["per-image", "per-second", "per-run", "per-video", "per-1m-tokens", "per-1k-tokens"]);
/** Vidu Q2 charges a base for the first second and a rate for the rest. */
const BASE_PLUS_SECOND = "per-run-plus-per-second";

/** "720P" -> resolution 720p; "1K, area <= 2610000 px" -> tier 1K plus maxPixels. */
function whenFromTierLabel(label) {
  const clauses = [];
  const base = {};
  const resolutions = [];
  for (const raw of String(label).split(",")) {
    const part = raw.trim();
    if (part === "") continue;
    let m = /^(\d{3,4})\s*[pP]$/.exec(part);
    if (m) {
      resolutions.push(`${m[1]}p`);
      continue;
    }
    m = /^([1-9])\s*[kK]$/.exec(part);
    if (m) {
      resolutions.push(`${m[1]}K`);
      continue;
    }
    m = /area\s*<=\s*([\d_]+)/.exec(part);
    if (m) {
      base.maxPixels = Number(m[1].replace(/_/g, ""));
      continue;
    }
    m = /area\s*>\s*([\d_]+)/.exec(part);
    if (m) {
      base.minPixels = Number(m[1].replace(/_/g, "")) + 1;
      continue;
    }
    m = /^generate_audio\s+(true|false)$/.exec(part);
    if (m) {
      base.audio = m[1] === "true";
      continue;
    }
    m = SIZE_RE.exec(part);
    if (m) {
      base.size = `${m[1]}x${m[2]}`;
      continue;
    }
    if (/^(low|medium|high|standard|hd|turbo|quality|pro|fast)$/i.test(part)) {
      base.quality = part.toLowerCase();
      continue;
    }
  }
  if (resolutions.length === 0) return Object.keys(base).length > 0 ? [base] : [];
  for (const r of resolutions) clauses.push({ ...base, resolution: r.toLowerCase() === "4k" ? "4k" : r });
  return clauses;
}

/** Level keys of the google file's nested `by` table. */
function whenFromByKey(key) {
  const k = String(key).trim();
  if (/^(silent)$/i.test(k)) return { audio: false };
  if (/^(audio)$/i.test(k)) return { audio: true };
  let m = /^(\d+)\s*s$/i.exec(k);
  if (m) return { duration: Number(m[1]) };
  m = /^(\d{3,5})\s*[x×]\s*(\d{3,5})$/.exec(k);
  if (m) return { size: `${m[1]}x${m[2]}` };
  // "1.5K" is a real resolution option (OpenRouter's MAI models), so the tier
  // key has to allow one decimal place.
  if (/^(\d{3,4}p|\d(\.\d{1,2})?k)$/i.test(k)) return { resolution: k.toLowerCase() === "4k" ? "4k" : k };
  // xhigh and max arrived with GPT Image 2.5, above high.
  if (/^(low|medium|high|xhigh|max|standard|hd|auto|turbo|quality)$/i.test(k)) return { quality: k.toLowerCase() };
  return null;
}

function flattenBy(by, prefix, tiers) {
  for (const [key, value] of Object.entries(by ?? {})) {
    const when = whenFromByKey(key);
    if (when === null) continue;
    const merged = { ...prefix, ...when };
    const credits = creditsOf(value);
    if (credits !== null) {
      const range = rangeOf(value);
      tiers.push(range === null ? { when: merged, credits } : { when: merged, credits, creditsRange: range });
      continue;
    }
    if (value && typeof value === "object") flattenBy(value, merged, tiers);
  }
}

function normalisePrice(record) {
  const p = record.price;
  if (!p || typeof p !== "object") return null;
  const unit = UNITS.has(p.unit) ? p.unit : p.unit === BASE_PLUS_SECOND ? "per-second" : null;
  if (unit === null) return null;
  const tiers = [];

  if (p.unit === BASE_PLUS_SECOND && Array.isArray(p.table)) {
    for (const row of p.table) {
      const base = creditsOf({ credits: row.baseCredits, usd: row.baseUsd });
      const rate = creditsOf({ credits: row.perSecondCredits, usd: row.perSecondUsd });
      if (base === null || rate === null || !row.when) continue;
      const when = {};
      if (row.when.resolution) when.resolution = String(row.when.resolution).toLowerCase() === "4k" ? "4k" : String(row.when.resolution);
      tiers.push({ when, credits: rate, baseCredits: base });
    }
    if (tiers.length > 0) {
      return {
        unit: "per-second",
        credits: tiers[0].credits,
        baseCredits: tiers[0].baseCredits,
        tiers,
        confidence: DOC_CONFIDENCES.includes(p.confidence) ? p.confidence : "published",
        note: [p.note, p.basis].filter((n) => typeof n === "string" && n.trim() !== "")[0]?.slice(0, 420) ?? "",
      };
    }
  }

  if (p.byTier && typeof p.byTier === "object") {
    for (const [label, value] of Object.entries(p.byTier)) {
      const credits = creditsOf(value);
      if (credits === null) continue;
      for (const when of whenFromTierLabel(label)) tiers.push({ when, credits });
    }
  }
  if (p.by && typeof p.by === "object") flattenBy(p.by, {}, tiers);
  if (Array.isArray(p.table)) {
    for (const row of p.table) {
      const credits = creditsOf(row);
      if (credits === null || !row.when || typeof row.when !== "object") continue;
      const when = {};
      for (const [k, v] of Object.entries(row.when)) {
        if (k === "resolution" || k === "tier") when.resolution = String(v).toLowerCase() === "4k" ? "4k" : String(v);
        else if (k === "audio") when.audio = v === true;
        else if (k === "duration") when.duration = Number(v);
        else if (k === "quality" || k === "rendering_speed") when.quality = String(v).toLowerCase();
        else if (k === "size") when.size = String(v);
        else if (k === "draft") when.draft = v === true;
      }
      if (Object.keys(when).length > 0) tiers.push({ when, credits });
    }
  }

  const base = creditsOf(p);
  const price = { unit, credits: base, confidence: DOC_CONFIDENCES.includes(p.confidence) ? p.confidence : "published", note: "" };
  if (tiers.length > 0) {
    // Drop tiers that repeat an identical clause; the first one wins.
    const seen = new Set();
    price.tiers = tiers.filter((t) => {
      const sig = JSON.stringify(Object.entries(t.when).sort());
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  }
  if (typeof p.extraImageCredits === "number") price.extraCredits = round2(p.extraImageCredits);
  // What a reference image adds, from the node's own price badge. A record that
  // says nothing leaves `price.reference` undefined, and `priceCredits` then
  // refuses to quote a request that carries one rather than quoting it at the
  // text only figure.
  const refRange = rangeOf({ credits: p.perReferenceImageCredits, usd: p.perReferenceImageUsd });
  const refFlat = typeof p.perReferenceImageCredits === "number" ? round2(p.perReferenceImageCredits) : typeof p.perReferenceImageUsd === "number" ? round2(p.perReferenceImageUsd * CREDITS_PER_USD) : null;
  const refCredits = refFlat ?? (refRange === null ? null : refRange[0]);
  if (refCredits !== null) {
    price.reference = { credits: refCredits };
    if (refRange !== null && refRange[1] > refCredits) price.reference.creditsMax = refRange[1];
    if (typeof p.referencesIncluded === "number" && p.referencesIncluded > 0) price.reference.included = Math.floor(p.referencesIncluded);
  }
  const formula = typeof p.formula === "string" ? p.formula : "";
  const perMp = /\+\s*([\d.]+)\s*\*\s*\(max\(1,\s*floor/.exec(formula);
  if (perMp) price.perExtraMegapixelCredits = round2(Number(perMp[1]));
  const range = rangeOf({ creditsRange: p.creditsRange, usdRange: p.usdRange });
  if (range !== null) price.creditsRange = range;
  const note = [p.note, p.basis, p.formula].filter((n) => typeof n === "string" && n.trim() !== "")[0] ?? "";
  price.note = note.slice(0, 420);
  if (price.credits === null && (price.tiers ?? []).length === 0) return null;
  return price;
}

// ---------- normalising documented capabilities and constraints ----------

function stringList(value) {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v) => typeof v === "string" && v.trim() !== "");
  return out.length > 0 ? out : null;
}

function normaliseCapabilities(record) {
  const c = record.capabilities;
  if (!c || typeof c !== "object") return null;
  const out = {};
  const resolutions = stringList(c.resolutions);
  if (resolutions) out.resolutions = resolutions;
  const aspects = stringList(c.aspects);
  if (aspects) out.aspects = aspects;
  const presets = stringList(c.sizePresets) ?? stringList(c.sizes);
  if (presets) out.sizePresets = presets.filter((p) => p !== "Custom");
  if (c.durations && typeof c.durations === "object") {
    const d = {};
    if (typeof c.durations.min === "number") d.min = c.durations.min;
    if (typeof c.durations.max === "number") d.max = c.durations.max;
    if (Array.isArray(c.durations.allowed)) {
      const allowed = c.durations.allowed.filter((n) => typeof n === "number");
      if (allowed.length > 0) d.allowed = allowed;
    }
    if (Object.keys(d).length > 0) out.durations = d;
  }
  if (typeof c.audio === "boolean") out.audio = c.audio;
  // Only ever taken away. The catalog decides whether a node has the input at
  // all; documentation decides whether the model reads it. Recraft V4 and V4.1
  // declare `negative_prompt` and their own tooltip says it is ignored.
  if (c.negativePrompt === false) out.negativePrompt = false;
  if (c.batch && typeof c.batch === "object" && typeof c.batch.max === "number") out.batch = { min: typeof c.batch.min === "number" ? c.batch.min : 1, max: c.batch.max };
  if (typeof c.promptMaxChars === "number") out.promptMaxChars = c.promptMaxChars;
  return Object.keys(out).length > 0 ? out : null;
}

const CONSTRAINT_ROLES = new Set(["resolution", "aspect", "duration", "sizePreset", "dimensions", "audio", "count", "quality", "model", "seed", "allowed", "width", "height"]);

/**
 * A constraint may name a role, or any input the entry actually declares, so a
 * documented rule can narrow an extra ("series_amount") the same way it narrows
 * a role. The key is rewritten to the wire name, which is what the form looks
 * up. Anything the entry does not have is dropped: a rule about an input that
 * is not there can only mislead.
 */
function constraintKey(name, inputs) {
  if (CONSTRAINT_ROLES.has(name)) return name;
  if (inputs.has(name)) return name;
  return [...inputs].find((wire) => wire.endsWith(`.${name}`)) ?? null;
}

function normaliseConstraints(record, inputs = new Set()) {
  if (!Array.isArray(record.constraints)) return null;
  const out = [];
  for (const c of record.constraints) {
    if (!c || typeof c !== "object" || !c.when || !c.then) continue;
    const when = {};
    for (const [k, v] of Object.entries(c.when)) {
      const key = constraintKey(k, inputs);
      if (key !== null) when[key] = v;
    }
    const then = {};
    for (const [k, v] of Object.entries(c.then)) {
      const key = constraintKey(k, inputs);
      if (key !== null) then[key] = v;
    }
    if (Object.keys(when).length === 0 || Object.keys(then).length === 0) continue;
    out.push({ when, then, note: typeof c.note === "string" ? c.note.slice(0, 300) : "" });
  }
  return out.length > 0 ? out : null;
}

// ---------- writing ----------

function ts(value) {
  return JSON.stringify(value);
}

function writeGenerated(entries, skipped, stats) {
  const lines = [];
  lines.push("// GENERATED by scripts/make-models.mjs. Do not edit by hand.");
  lines.push("//");
  lines.push(`// Built on ${stats.generatedAt} from the Comfy Cloud node catalog cached on ${stats.catalogDate}.`);
  lines.push(`// ${stats.nodes} partner text-to-image and text-to-video nodes expand to`);
  lines.push(`// ${entries.length} entries, ${stats.supported} of them supported.`);
  lines.push("//");
  lines.push("// Runtime never reads object_info.json: this file is the frozen snapshot the");
  lines.push("// builder fills, the validator checks and the picker lists. Regenerate with");
  lines.push("// `node scripts/make-models.mjs` when Comfy Cloud changes its catalog.");
  lines.push('import type { GeneratedEntry } from "./registry";');
  lines.push("");
  lines.push(`/** The date the catalog this file was built from was fetched. */`);
  lines.push(`export const CATALOG_DATE = ${ts(stats.catalogDate)};`);
  lines.push("");
  lines.push("/** The day this file was last generated, so a stale registry can say so. */");
  lines.push(`export const GENERATED_AT = ${ts(stats.generatedAt)};`);
  lines.push("");
  lines.push("/** Nodes that were left out because they need media we cannot produce from a prompt. */");
  lines.push(`export const SKIPPED_NODES: ReadonlyArray<{ node: string; reason: string }> = ${JSON.stringify(skipped, null, 2)};`);
  lines.push("");
  lines.push("export const GENERATED_MODELS: readonly GeneratedEntry[] = [");
  for (const e of entries) lines.push(`  ${JSON.stringify(e)},`);
  lines.push("];");
  lines.push("");
  fs.writeFileSync(path.join(ROOT, "models.generated.ts"), lines.join("\n"));
}

function writeOverrides(overrides, meta) {
  const lines = [];
  lines.push("// GENERATED by scripts/make-models.mjs from qa/model-docs/*.json.");
  lines.push("//");
  lines.push("// One record per model key, holding what a vendor's own documentation says:");
  lines.push("// the friendly label, the capabilities the node schema cannot express, the");
  lines.push("// combinations the vendor refuses, and the price. Overrides win over the");
  lines.push("// generated data. Edit the documentation files and run the script again;");
  lines.push("// nothing here is typed twice.");
  lines.push("//");
  lines.push(`// ${meta.matched} of ${meta.records} documentation records matched a registry entry`);
  lines.push(`// on ${meta.builtAt}. ${meta.unmatched.length} did not; they are listed at the bottom.`);
  lines.push('import type { ModelOverride } from "./registry";');
  lines.push("");
  lines.push("export const MODEL_OVERRIDES: Readonly<Record<string, ModelOverride>> = {");
  for (const key of Object.keys(overrides).sort()) lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(overrides[key])},`);
  lines.push("};");
  lines.push("");
  lines.push("/** Legacy model ids that still resolve, mapped to the entry whose graph they built. */");
  lines.push(`export const MODEL_ALIASES: Readonly<Record<string, string>> = ${JSON.stringify(ALIASES, null, 2)};`);
  lines.push("");
  lines.push("/** Documentation records that matched no entry in the catalog snapshot. */");
  lines.push(`export const UNMATCHED_DOC_RECORDS: readonly string[] = ${JSON.stringify(meta.unmatched, null, 2)};`);
  lines.push("");
  fs.writeFileSync(path.join(ROOT, "models.overrides.ts"), lines.join("\n"));
}

// ---------- main ----------

const catalog = loadCatalog();
const { entries, skipped } = generate(catalog);
const byKey = new Map(entries.map((e) => [e.key, e]));

const docs = loadDocs();
const overrides = {};
const unmatched = [];
let matched = 0;
for (const doc of docs) {
  const keys = candidateKeys(doc).filter((k) => byKey.has(k));
  if (keys.length === 0) {
    unmatched.push(`${doc.file}: ${doc.docKey}`);
    continue;
  }
  matched += 1;
  const r = doc.record;
  for (const key of keys) {
    const entry = byKey.get(key);
    const o = overrides[key] ?? { source: doc.file };
    if (typeof r.label === "string" && r.label.trim() !== "") o.label = r.label.trim();
    if (typeof r.vendor === "string" && r.vendor.trim() !== "") o.vendor = r.vendor.trim();
    if (typeof r.strengths === "string" && r.strengths.trim() !== "") o.strengths = r.strengths.trim().slice(0, 120);
    if (typeof r.notes === "string" && r.notes.trim() !== "") o.notes = r.notes.trim().slice(0, 900);
    if (typeof r.billedModelId === "string") o.billedModelId = r.billedModelId;
    if (r.hidden === true) o.hidden = true;
    if (r.recommended === true) o.recommended = true;
    if (r.supported === false) {
      const why = typeof r.excludeReason === "string" ? r.excludeReason : typeof r.notes === "string" ? r.notes : "The documentation marks this entry unusable.";
      // `bb comfy models --all` exists to explain an exclusion in words, so a
      // machine slug ("needs-image-input") never becomes the reason on screen:
      // the hand list in NOT_TEXT_TO_SOMETHING already holds a sentence for
      // every one of these nodes and stays in place instead.
      const sentence = /^[a-z0-9]+(-[a-z0-9]+)+$/.test(why.trim()) ? null : why.trim();
      // A duplicate that still builds is hidden, not unsupported: the picker
      // leaves it out but `bb comfy models --all` and the schema test keep it.
      if (/deprecat|duplicate|supersed|deactivat|legacy/i.test(why)) {
        o.hidden = true;
        o.deprecated = true;
        o.notes = o.notes ?? why.slice(0, 900);
      } else {
        o.supported = false;
        if (sentence !== null) o.unsupportedReason = sentence.slice(0, 200);
      }
    }
    const caps = normaliseCapabilities(r);
    if (caps) o.capabilities = caps;
    const constraints = normaliseConstraints(r, new Set((entry?.inputs ?? []).map((i) => i.name)));
    if (constraints) o.constraints = constraints;
    const price = normalisePrice(r);
    if (price) o.price = price;
    if (Array.isArray(r.sources)) o.sources = r.sources.filter((s) => typeof s === "string").slice(0, 6);
    overrides[key] = o;
  }
}

// A node the catalog marks deprecated, whose model another live node also
// offers, is a duplicate. Hide it rather than showing the same model twice.
const liveModelIds = new Set(entries.filter((e) => !e.deprecated && e.modelId !== null).map((e) => `${e.kind}|${e.modelId}`));
for (const e of entries) {
  if (!e.deprecated || e.modelId === null) continue;
  if (!liveModelIds.has(`${e.kind}|${e.modelId}`)) continue;
  const o = overrides[e.key] ?? (overrides[e.key] = { source: "catalog" });
  o.hidden = true;
  o.deprecated = true;
}

for (const [key, defaults] of Object.entries(DEFAULTS)) {
  if (!byKey.has(key)) continue;
  const o = overrides[key] ?? (overrides[key] = { source: "plugin" });
  o.defaults = defaults;
}

const supported = entries.filter((e) => e.supported && overrides[e.key]?.supported !== false).length;
const hidden = entries.filter((e) => overrides[e.key]?.hidden === true).length;
const stat = fs.statSync(CATALOG);
const catalogDate = new Date(stat.mtimeMs).toLocaleDateString("en-CA");
// The day this run wrote the files. Two same-day runs from one snapshot are
// still byte identical; a run on the next day differs by this line alone,
// which is the price of being able to say how old the registry is.
const generatedAt = new Date().toLocaleDateString("en-CA");
const nodes = new Set(entries.map((e) => e.node)).size;

const reasons = new Map();
for (const e of entries) {
  if (e.supported && overrides[e.key]?.supported !== false) continue;
  const reason = (e.unsupportedReason ?? overrides[e.key]?.unsupportedReason ?? "unknown").replace(/\s*\(.*$/, "").replace(/[.:].*$/, "").trim();
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
}

console.log(`catalog: ${CATALOG} (fetched ${catalogDate})`);
console.log(`nodes: ${nodes} qualifying, ${skipped.length} skipped as edit or reference nodes`);
console.log(`entries: ${entries.length} total, ${supported} supported, ${entries.length - supported} unsupported, ${hidden} hidden`);
console.log(`documented: ${matched} of ${docs.length} records matched, ${Object.keys(overrides).length} entries carry documentation`);
console.log(`priced: ${Object.values(overrides).filter((o) => o.price).length} entries have a documented price`);
for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  unsupported: ${count}  ${reason}`);
if (unmatched.length > 0) console.log(`unmatched documentation records (${unmatched.length}):\n  ${unmatched.join("\n  ")}`);

if (!CHECK) {
  writeGenerated(entries, skipped, { catalogDate, generatedAt, nodes, supported });
  writeOverrides(overrides, { records: docs.length, matched, unmatched, builtAt: catalogDate });
  console.log("wrote models.generated.ts and models.overrides.ts");
}
