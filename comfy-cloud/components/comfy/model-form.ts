// The form behind a model, worked out from its registry summary. Pure: no
// React, no SDK, no catalog. `test/app.test.tsx` exercises it directly.
//
// Two ideas hold the whole file together.
//
// 1. A value is a *wish*, not a fact. The user asks for 16:9 at 2K; the model
//    decides what it can do with that. `formModel` resolves a wish against the
//    model's capabilities and its documented constraints and returns both the
//    effective value and why it moved, so a silent jump never happens. Changing
//    the model therefore keeps every wish the new model can also grant and
//    quietly drops the rest.
// 2. The vendor's own refusals are data. `ModelSummary.constraints` come from
//    the documentation the registry read, in `when` / `then` form, so the form
//    can grey an option out instead of letting the API reject the request.
import { DRAFT_INPUT_NAMES, DURATION_INPUT_NAMES, QUALITY_INPUT_NAMES, secondsInValue } from "../../contract";
import type { ModelCapabilities, ModelConstraint, ModelExtra, ModelSummary, Params } from "../../contract";
import { presetMeta } from "./format";
import type { PresetMeta } from "./format";

export type ExtraValue = string | number | boolean;

/** Everything the form holds for one model, beside the prompt and the seed. */
export interface FormValues {
  sizePreset: string | null;
  aspect: string | null;
  resolution: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  audio: boolean;
  count: number;
  negativePrompt: string;
  /** Keyed by the input's wire name, e.g. "model.creativity". */
  extras: Record<string, ExtraValue>;
}

export interface Option {
  value: string;
  label: string;
  disabled: boolean;
  /** The vendor's own words for why, for the title attribute. */
  reason: string | null;
}

/** Which size control a model wants. */
export type SizeMode = "tiers" | "presets" | "aspect" | "dimensions" | "none";

export interface DimensionRule {
  widthMin: number;
  widthMax: number;
  heightMin: number;
  heightMax: number;
  step: number;
  minArea: number | null;
  maxArea: number | null;
  maxEdge: number | null;
  maxRatio: number | null;
}

export interface FormShape {
  /** The values as the model will actually receive them. */
  values: FormValues;
  sizeMode: SizeMode;
  /** True when the size preset is "Custom", so the pixel fields matter. */
  customSize: boolean;
  presets: Option[];
  tiers: Option[];
  /** Aspect options of the chosen tier, when the presets carry tiers. */
  tierAspects: Option[];
  aspects: Option[];
  resolutions: Option[];
  durations: Option[] | null;
  durationRange: { min: number; max: number; step: number } | null;
  counts: number[];
  countMax: number;
  audioAllowed: boolean;
  /** True when the vendor generates sound whatever the toggle says. */
  audioLocked: boolean;
  audioReason: string | null;
  dimensions: DimensionRule | null;
  /** Roles the vendor ignores in this state, e.g. Ideogram's aspect once a size is named. */
  ignored: Record<string, string>;
  /**
   * Option lists for the extras a constraint narrows, keyed by wire name, with
   * the refused values already greyed out. Only the extras a rule touches
   * appear; everything else renders straight from its schema.
   */
  extraOptions: Record<string, Option[]>;
  /** The vendor's own sentence under a narrowed extra, keyed by wire name. */
  extraNotes: Record<string, string>;
  /** The rules biting right now, under the control each one restricts. */
  notes: { size: string[]; length: string[]; sound: string[] };
  /** Set when the pixel fields are outside the documented area. */
  dimensionError: string | null;
}

const MAX_COUNT_CHIPS = 8;
/** How many outputs the form offers when the model has no count input of its own. */
export const DEFAULT_COUNT_MAX = 4;

// ---------- values ----------

export function emptyValues(): FormValues {
  return { sizePreset: null, aspect: null, resolution: null, width: null, height: null, duration: null, audio: false, count: 1, negativePrompt: "", extras: {} };
}

/**
 * The wishes an existing asset carries, for the viewer's "Tweak". The keys are
 * the ones `specParams` in workflows.ts writes, and anything the next model
 * cannot grant is dropped by `carryOver`.
 */
/**
 * Param names a role already owns. Everything else an asset row carries is an
 * extra under its own wire name ("model.creativity", "rendering_speed"), which
 * is how a tweak brings a model's More options back with it. `carryOver` drops
 * the ones the chosen model does not declare or would refuse, which is what
 * takes care of the `quality` the server records for the price: it is a real
 * input on Ideogram and nothing on the models that spell it `model.quality`.
 */
const ROLE_PARAM_NAMES = new Set(["sizePreset", "aspect", "aspectRatio", "resolution", "width", "height", "duration", "generateAudio", "count", "negativePrompt", "seed"]);

export function valuesFromParams(params: Params): FormValues {
  const text = (name: string): string | null => (typeof params[name] === "string" && params[name] !== "" ? (params[name] as string) : null);
  const number = (name: string): number | null => (typeof params[name] === "number" && Number.isFinite(params[name]) ? (params[name] as number) : null);
  const extras: Record<string, ExtraValue> = {};
  for (const [name, value] of Object.entries(params)) {
    if (ROLE_PARAM_NAMES.has(name) || value === null) continue;
    extras[name] = value;
  }
  return {
    sizePreset: text("sizePreset"),
    aspect: text("aspectRatio") ?? text("aspect"),
    resolution: text("resolution"),
    width: number("width"),
    height: number("height"),
    duration: number("duration"),
    audio: params.generateAudio === true,
    // A tweak makes one of a thing; asking for four again is a decision, not a repeat.
    count: 1,
    negativePrompt: text("negativePrompt") ?? "",
    extras,
  };
}

/** Where a model's form starts, from the defaults the registry computed. */
export function initialValues(summary: ModelSummary): FormValues {
  const d = summary.defaults;
  // A pixel size is only a wish on a model whose size *is* pixels. Seedream
  // declares width and height for its "Custom" escape hatch and defaults them
  // to 2048x2048, which a preset makes irrelevant; carried into the next model,
  // that pair would open it at a size and a price the user never picked. A
  // model reached from the pixel fields still carries them, because then the
  // user chose them.
  const pixels = sizeModeOf(summary) === "dimensions";
  return {
    sizePreset: d.sizePreset,
    aspect: d.aspect,
    resolution: d.resolution,
    width: pixels ? d.width : null,
    height: pixels ? d.height : null,
    duration: d.duration,
    audio: d.audio === true,
    count: d.count ?? 1,
    negativePrompt: "",
    extras: {},
  };
}

function snapNumber(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  if (step <= 0) return Math.round(clamped);
  const steps = Math.round((clamped - min) / step);
  return Math.min(max, Math.max(min, min + steps * step));
}

/** The allowed number nearest to a wish. */
function nearestNumber(values: readonly number[], wanted: number): number {
  let best = values[0] ?? wanted;
  let distance = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const d = Math.abs(value - wanted);
    if (d < distance) {
      best = value;
      distance = d;
    }
  }
  return best;
}

/** "16:9" as 1.777…, or NaN. */
function ratioOf(aspect: string): number {
  const match = /^(\d+)\s*[:x]\s*(\d+)$/.exec(aspect.trim());
  if (match === null) return Number.NaN;
  const height = Number(match[2]);
  return height === 0 ? Number.NaN : Number(match[1]) / height;
}

/** The option whose shape is closest to a wanted ratio, in log space. */
function closestRatio(options: readonly string[], wanted: string): string | null {
  if (options.length === 0) return null;
  if (options.includes(wanted)) return wanted;
  const want = ratioOf(wanted);
  if (!Number.isFinite(want) || want <= 0) return options[0]!;
  let best: string | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const value = ratioOf(option);
    if (!Number.isFinite(value) || value <= 0) continue;
    const d = Math.abs(Math.log(value / want));
    if (d < distance) {
      best = option;
      distance = d;
    }
  }
  return best ?? options[0]!;
}

/** The presets that carry a tier and an aspect, e.g. "(1K) 1312x736 (16:9)". */
function taggedPresets(caps: ModelCapabilities): PresetMeta[] {
  return caps.sizePresets.map(presetMeta).filter((meta): meta is PresetMeta => meta !== null);
}

/** True when the whole preset list is tier tagged, so tier and aspect chips can drive it. */
function presetsAreTiered(caps: ModelCapabilities): boolean {
  const named = caps.sizePresets.filter((preset) => preset !== "Custom" && preset !== "Auto");
  return named.length > 0 && taggedPresets(caps).length === named.length;
}

export function sizeModeOf(summary: ModelSummary): SizeMode {
  const caps = summary.capabilities;
  if (caps.sizePresets.length > 0) return presetsAreTiered(caps) ? "tiers" : "presets";
  if (caps.aspects.length > 0 || caps.resolutions.length > 0) return "aspect";
  if (caps.dimensions !== null) return "dimensions";
  return "none";
}

/**
 * Every wish the new model can also grant, kept. Anything it cannot is replaced
 * by that model's own default rather than left to fail at the API.
 */
export function carryOver(previous: FormValues, next: ModelSummary): FormValues {
  const caps = next.capabilities;
  const start = initialValues(next);
  const values: FormValues = { ...start, negativePrompt: previous.negativePrompt };

  if (caps.sizePresets.length > 0 && previous.sizePreset !== null) {
    if (caps.sizePresets.includes(previous.sizePreset)) values.sizePreset = previous.sizePreset;
    else {
      // Both families tag their presets, so a 16:9 at 2K wish survives a move
      // from Seedream 5.0 Pro to 4.0 even though the strings differ.
      const wanted = presetMeta(previous.sizePreset);
      const options = taggedPresets(caps);
      if (wanted !== null && options.length > 0) {
        const sameTier = options.filter((meta) => meta.tier === wanted.tier);
        const pool = sameTier.length > 0 ? sameTier : options;
        const aspect = closestRatio(pool.map((meta) => meta.aspect), wanted.aspect);
        values.sizePreset = pool.find((meta) => meta.aspect === aspect)?.preset ?? start.sizePreset;
      }
    }
  }
  if (previous.aspect !== null && caps.aspects.includes(previous.aspect)) values.aspect = previous.aspect;
  if (previous.resolution !== null && caps.resolutions.includes(previous.resolution)) values.resolution = previous.resolution;
  if (caps.dimensions !== null && previous.width !== null && previous.height !== null) {
    const d = caps.dimensions;
    values.width = snapNumber(previous.width, d.widthMin, d.widthMax, d.step);
    values.height = snapNumber(previous.height, d.heightMin, d.heightMax, d.step);
  }
  if (caps.duration !== null && previous.duration !== null) {
    const d = caps.duration;
    values.duration = d.allowed === null ? snapNumber(previous.duration, d.min, d.max, d.step) : nearestNumber(d.allowed, previous.duration);
  }
  values.audio = caps.audio ? previous.audio : false;
  const countMax = caps.count?.max ?? DEFAULT_COUNT_MAX;
  values.count = Math.min(Math.max(1, previous.count), countMax);

  // An extra survives only when the new model declares the same input and would
  // accept the value; otherwise the builder's own default is the right answer.
  for (const extra of next.extras) {
    const value = previous.extras[extra.name];
    if (value === undefined) continue;
    if (extra.options !== undefined && (typeof value !== "string" || !extra.options.includes(value))) continue;
    if (extra.type === "INT" || extra.type === "FLOAT") {
      if (typeof value !== "number") continue;
      if (extra.min !== undefined && value < extra.min) continue;
      if (extra.max !== undefined && value > extra.max) continue;
    }
    values.extras[extra.name] = value;
  }
  return values;
}

// ---------- constraints ----------

type Selection = Record<string, unknown>;

function selectionOf(summary: ModelSummary, values: FormValues): Selection {
  const extras: Selection = {};
  // An extra is part of the selection under its own wire name, so a rule can
  // both read one ("when rendering_speed is TURBO") and narrow one. An untouched
  // extra counts as its default, because that is what the request will carry.
  for (const extra of summary.extras) extras[extra.name] = extraValue(extra, values);
  return {
    ...extras,
    model: summary.modelId ?? summary.key,
    sizePreset: values.sizePreset,
    aspect: values.aspect,
    resolution: values.resolution,
    duration: values.duration,
    count: values.count,
    audio: values.audio,
    width: values.width,
    height: values.height,
    dimensions: values.width !== null && values.height !== null ? `${values.width}x${values.height}` : null,
  };
}

function sameText(a: unknown, b: unknown): boolean {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/** One `when` term. Understands the shapes the documentation files actually use. */
function termMatches(want: unknown, have: unknown): boolean {
  if (have === null || have === undefined) return false;
  if (Array.isArray(want)) return want.some((option) => termMatches(option, have));
  if (typeof want === "boolean") return have === want;
  if (typeof want === "number") return typeof have === "number" ? have === want : sameText(have, want);
  if (typeof want !== "string") return false;
  const text = want.trim();
  if (text === "any") return true;
  if (text.toLowerCase().startsWith("not ")) return !termMatches(text.slice(4).trim(), have);
  const comparison = /^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(text);
  if (comparison !== null) {
    const number = typeof have === "number" ? have : Number(have);
    if (!Number.isFinite(number)) return false;
    const limit = Number(comparison[2]);
    switch (comparison[1]) {
      case ">":
        return number > limit;
      case "<":
        return number < limit;
      case ">=":
        return number >= limit;
      default:
        return number <= limit;
    }
  }
  return sameText(have, text);
}

/** True when every term of a `when` clause holds for a selection. `skip` ignores one role. */
function whenMatches(constraint: ModelConstraint, selection: Selection, skip?: string): boolean {
  for (const [role, want] of Object.entries(constraint.when)) {
    if (role === skip) continue;
    if (!termMatches(want, selection[role])) return false;
  }
  return true;
}

/** The values a `then` clause allows for one role, or null when it says nothing about it. */
function allowedBy(then: Record<string, unknown>, role: string): string[] | null {
  const rule = then[role];
  if (rule === undefined || rule === null) return null;
  if (Array.isArray(rule)) return rule.map((value) => String(value));
  if (typeof rule === "string" || typeof rule === "number" || typeof rule === "boolean") {
    // "ignored" is handled separately; it narrows nothing.
    return rule === "ignored" ? null : [String(rule)];
  }
  return null;
}

function numberRule(then: Record<string, unknown>, role: string): { min?: number; max?: number } | null {
  const rule = then[role];
  if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return null;
  const record = rule as Record<string, unknown>;
  const min = typeof record.min === "number" ? record.min : undefined;
  const max = typeof record.max === "number" ? record.max : undefined;
  return min === undefined && max === undefined ? null : { min, max };
}

function dimensionRuleOf(caps: ModelCapabilities, constraints: readonly ModelConstraint[], selection: Selection): DimensionRule | null {
  const base = caps.dimensions;
  if (base === null) return null;
  const rule: DimensionRule = {
    widthMin: base.widthMin,
    widthMax: base.widthMax,
    heightMin: base.heightMin,
    heightMax: base.heightMax,
    step: base.step,
    minArea: null,
    maxArea: null,
    maxEdge: null,
    maxRatio: null,
  };
  for (const constraint of constraints) {
    const then = constraint.then as Record<string, unknown>;
    const box = then.dimensions;
    if (box === null || typeof box !== "object" || Array.isArray(box)) continue;
    if (!whenMatches(constraint, selection)) continue;
    const record = box as Record<string, unknown>;
    const number = (name: string): number | null => (typeof record[name] === "number" ? (record[name] as number) : null);
    rule.minArea = number("minArea") ?? number("minTotalPixels") ?? rule.minArea;
    rule.maxArea = number("maxArea") ?? number("maxTotalPixels") ?? rule.maxArea;
    rule.maxEdge = number("maxEdge") ?? rule.maxEdge;
    rule.maxRatio = number("maxRatio") ?? rule.maxRatio;
    rule.widthMin = number("widthMin") ?? rule.widthMin;
    rule.widthMax = number("widthMax") ?? rule.widthMax;
    rule.heightMin = number("heightMin") ?? rule.heightMin;
    rule.heightMax = number("heightMax") ?? rule.heightMax;
    rule.step = number("step") ?? rule.step;
  }
  return rule;
}

/** What a pixel size breaks, in the vendor's own terms, or null when it is legal. */
export function dimensionError(rule: DimensionRule | null, width: number | null, height: number | null): string | null {
  if (rule === null || width === null || height === null) return null;
  if (width < rule.widthMin || width > rule.widthMax) return `Width must be between ${rule.widthMin} and ${rule.widthMax}.`;
  if (height < rule.heightMin || height > rule.heightMax) return `Height must be between ${rule.heightMin} and ${rule.heightMax}.`;
  if (rule.step > 1 && ((width - rule.widthMin) % rule.step !== 0 || (height - rule.heightMin) % rule.step !== 0)) {
    return `Width and height move in steps of ${rule.step}.`;
  }
  const area = width * height;
  if (rule.minArea !== null && area < rule.minArea) return `That is under the smallest area this model takes (${rule.minArea.toLocaleString("en-US")} pixels).`;
  if (rule.maxArea !== null && area > rule.maxArea) return `That is over the largest area this model takes (${rule.maxArea.toLocaleString("en-US")} pixels).`;
  if (rule.maxEdge !== null && Math.max(width, height) > rule.maxEdge) return `No edge may be longer than ${rule.maxEdge} pixels.`;
  if (rule.maxRatio !== null) {
    const ratio = Math.max(width / height, height / width);
    if (ratio > rule.maxRatio + 1e-9) return `The shape may not be more lopsided than ${rule.maxRatio} to 1.`;
  }
  return null;
}

interface RoleRules {
  /** Values the vendor still allows, or null when nothing narrows this role. */
  allowed: string[] | null;
  /** Values refused outright, with the reason. */
  refused: Map<string, string>;
  note: string | null;
}

/**
 * What the constraints say about one role, given everything else the form holds.
 * `when` is matched with this role skipped, so a rule keyed on the role itself
 * ("480P is refused") still bites while the role's own value is being chosen.
 */
function rulesFor(summary: ModelSummary, values: FormValues, role: string): RoleRules {
  const selection = selectionOf(summary, values);
  const out: RoleRules = { allowed: null, refused: new Map(), note: null };
  for (const constraint of summary.constraints) {
    const then = constraint.then as Record<string, unknown>;
    if (then.allowed === false) {
      // A refusal keyed on this role names the values to grey out; one keyed on
      // another role is that role's business, not this one's.
      if (!(role in constraint.when)) continue;
      if (!whenMatches(constraint, selection, role)) continue;
      const want = constraint.when[role];
      out.refused.set(refusalKey(want), constraint.note);
      out.note = constraint.note;
      continue;
    }
    if (role in constraint.when) continue;
    if (!whenMatches(constraint, selection)) continue;
    const allowed = allowedBy(then, role);
    if (allowed === null) continue;
    out.allowed = out.allowed === null ? allowed : out.allowed.filter((value) => allowed.includes(value));
    out.note = constraint.note;
  }
  return out;
}

/** A refusal's `when` value, as the key the option list is matched against. */
function refusalKey(want: unknown): string {
  return typeof want === "string" || typeof want === "number" || typeof want === "boolean" ? String(want) : JSON.stringify(want);
}

function optionsWithRules(values: readonly string[], rules: RoleRules): Option[] {
  return values.map((value) => {
    for (const [want, note] of rules.refused) {
      if (termMatches(want, value) || (Number.isFinite(Number(value)) && termMatches(want, Number(value)))) {
        return { value, label: value, disabled: true, reason: note };
      }
    }
    if (rules.allowed !== null && !rules.allowed.some((allowed) => sameText(allowed, value))) {
      return { value, label: value, disabled: true, reason: rules.note };
    }
    return { value, label: value, disabled: false, reason: null };
  });
}

/** The first option that is not greyed out, so an effective value is always legal. */
function firstEnabled(options: readonly Option[], wanted: string | null): string | null {
  const exact = options.find((option) => option.value === wanted);
  if (exact !== undefined && !exact.disabled) return exact.value;
  const usable = options.filter((option) => !option.disabled);
  if (usable.length === 0) return wanted;
  if (wanted !== null) {
    // Ratios and tiers both read better by nearness than by list order.
    const near = closestRatio(usable.map((option) => option.value), wanted);
    if (near !== null && Number.isFinite(ratioOf(wanted))) return near;
  }
  return usable[0]!.value;
}

/** Roles the vendor accepts but ignores in this state, with its own words. */
function ignoredRoles(summary: ModelSummary, values: FormValues): Record<string, string> {
  const selection = selectionOf(summary, values);
  const out: Record<string, string> = {};
  for (const constraint of summary.constraints) {
    if (!whenMatches(constraint, selection)) continue;
    for (const [role, rule] of Object.entries(constraint.then as Record<string, unknown>)) {
      if (rule === "ignored") out[role] = constraint.note;
    }
  }
  return out;
}

/**
 * The whole form for one model and one set of wishes: which controls to draw,
 * which of their options the vendor refuses, and the values that will actually
 * be sent.
 */
export function formModel(summary: ModelSummary, wish: FormValues): FormShape {
  const caps = summary.capabilities;
  const values: FormValues = { ...wish, extras: { ...wish.extras } };
  // A note belongs under the control it restricts, not in one bag at the top.
  const sizeNotes = new Set<string>();
  const lengthNotes = new Set<string>();
  const soundNotes = new Set<string>();
  const sizeMode = sizeModeOf(summary);

  // Size, in whichever of the three shapes this model speaks.
  const presetRules = rulesFor(summary, values, "sizePreset");
  const presetOptions = optionsWithRules(caps.sizePresets, presetRules);
  let tiers: Option[] = [];
  let tierAspects: Option[] = [];
  if (sizeMode === "tiers") {
    const tagged = taggedPresets(caps);
    const names = [...new Set(tagged.map((meta) => meta.tier))];
    // A tagged list can still carry one untagged entry, and on Seedream that is
    // "Custom": it joins the tier row and swaps the ratio chips for the pixel
    // fields, which is the only way to reach a size the presets do not name.
    const untagged = caps.sizePresets.filter((preset) => presetMeta(preset) === null);
    tiers = [...names, ...untagged].map((name) => ({ value: name, label: name, disabled: false, reason: null }));
    if (values.sizePreset !== null && untagged.includes(values.sizePreset)) {
      tierAspects = [];
    } else {
      const wanted = values.sizePreset === null ? null : presetMeta(values.sizePreset);
      let tier = wanted?.tier ?? names[0] ?? "";
      if (!names.includes(tier)) tier = names[0] ?? "";
      const inTier = tagged.filter((meta) => meta.tier === tier);
      tierAspects = inTier.map((meta) => {
        const option = presetOptions.find((candidate) => candidate.value === meta.preset);
        return { value: meta.aspect, label: meta.aspect, disabled: option?.disabled ?? false, reason: option?.reason ?? null };
      });
      const aspect = firstEnabled(tierAspects, wanted?.aspect ?? null);
      values.sizePreset = inTier.find((meta) => meta.aspect === aspect)?.preset ?? inTier[0]?.preset ?? values.sizePreset;
    }
  } else if (sizeMode === "presets") {
    values.sizePreset = firstEnabled(presetOptions, values.sizePreset);
  }

  const resolutionRules = rulesFor(summary, values, "resolution");
  const resolutions = optionsWithRules(caps.resolutions, resolutionRules);
  if (caps.resolutions.length > 0) values.resolution = firstEnabled(resolutions, values.resolution);
  if (resolutionRules.note !== null && resolutions.some((option) => option.disabled)) sizeNotes.add(resolutionRules.note);

  const aspectRules = rulesFor(summary, { ...values }, "aspect");
  const aspects = optionsWithRules(caps.aspects, aspectRules);
  if (caps.aspects.length > 0) values.aspect = firstEnabled(aspects, values.aspect);
  if (aspectRules.note !== null && aspects.some((option) => option.disabled)) sizeNotes.add(aspectRules.note);

  // Length: a fixed list when the node offers one, otherwise a range.
  //
  // A model with no duration input can still have a length: Kling keeps both
  // the version and the length in one `mode` string, so `durationVia` names the
  // combo that carries it. The number is read out of that string here and
  // written back into it below, and the raw string never reaches the form.
  const durationVia = caps.durationVia ?? null;
  if (durationVia !== null && values.duration === null) {
    const carried = secondsInValue(values.extras[durationVia]);
    if (carried !== null) values.duration = carried;
  }
  let durations: Option[] | null = null;
  let durationRange: { min: number; max: number; step: number } | null = null;
  if (caps.duration !== null) {
    const rules = rulesFor(summary, values, "duration");
    const span = caps.duration;
    const list = span.allowed ?? spanList(span.min, span.max, span.step, rules);
    if (list !== null) {
      durations = optionsWithRules(list.map(String), rules);
      const usable = durations.filter((option) => !option.disabled).map((option) => Number(option.value));
      const wanted = values.duration ?? span.default;
      values.duration = usable.length === 0 ? wanted : usable.includes(wanted) ? wanted : nearestNumber(usable, wanted);
      if (rules.note !== null && durations.some((option) => option.disabled)) lengthNotes.add(rules.note);
    } else {
      const bounds = narrowSpan(span, rules);
      durationRange = bounds;
      values.duration = snapNumber(values.duration ?? span.default, bounds.min, bounds.max, bounds.step);
      if (rules.note !== null && (bounds.min !== span.min || bounds.max !== span.max)) lengthNotes.add(rules.note);
    }
  } else {
    values.duration = null;
  }

  // Sound. A vendor can refuse audio outright, and one (Kling 3.0 Turbo) always
  // produces it and ignores the toggle, so the chips say so rather than offering
  // a choice that is not one.
  const audioRules = rulesFor(summary, values, "audio");
  let audioAllowed = caps.audio;
  let audioLocked = false;
  let audioReason: string | null = null;
  if (caps.audio) {
    const [on, off] = optionsWithRules(["true", "false"], audioRules);
    if (on?.disabled === true) {
      audioAllowed = false;
      audioReason = on.reason;
      if (on.reason !== null) soundNotes.add(on.reason);
    } else if (off?.disabled === true) {
      audioLocked = true;
      audioReason = off.reason;
    }
  }
  values.audio = audioAllowed && (audioLocked || values.audio);

  // Count. A model with no count input still generates more than one, by
  // submitting the request that many times.
  const countRules = rulesFor(summary, values, "count");
  let countNote: string | null = null;
  let countMax = caps.count?.max ?? DEFAULT_COUNT_MAX;
  for (const constraint of summary.constraints) {
    // Matched with count skipped, so "asking for more than one caps you at ten"
    // is read as a ceiling rather than as a rule about the current value.
    if (!whenMatches(constraint, selectionOf(summary, values), "count")) continue;
    const rule = numberRule(constraint.then as Record<string, unknown>, "count");
    if (rule?.max !== undefined) countMax = Math.min(countMax, rule.max);
    const fixed = allowedBy(constraint.then as Record<string, unknown>, "count");
    if (fixed !== null && fixed.length > 0) countMax = Math.min(countMax, Math.max(...fixed.map(Number).filter(Number.isFinite)));
  }
  for (const [want, note] of countRules.refused) {
    for (let candidate = 2; candidate <= countMax; candidate += 1) {
      if (termMatches(want, candidate)) {
        countMax = Math.min(countMax, candidate - 1);
        countNote = note;
      }
    }
  }
  countMax = Math.max(1, Math.min(countMax, caps.count?.max ?? DEFAULT_COUNT_MAX));
  const counts = countList(caps.count?.min ?? 1, countMax);
  values.count = Math.min(Math.max(counts[0] ?? 1, values.count), countMax);

  // Free pixel size.
  const dimensions = dimensionRuleOf(caps, summary.constraints, selectionOf(summary, values));
  // "Custom" (or any preset the tier grammar does not name) is what turns the
  // pixel fields on.
  const customSize = values.sizePreset !== null && caps.sizePresets.includes(values.sizePreset) && presetMeta(values.sizePreset) === null && caps.dimensions !== null;
  if (caps.dimensions !== null) {
    if (values.width === null) values.width = caps.dimensions.widthDefault;
    if (values.height === null) values.height = caps.dimensions.heightDefault;
  }

  // Extras the vendor restricts. A `then` keyed by an input's wire name narrows
  // that input exactly the way a role is narrowed, which is how Kling's
  // `series_amount` is held at "disabled" on the one model that ignores it.
  // This keeps the form from offering a series on a model whose own tooltip
  // says it cannot make one.
  const extraOptions: Record<string, Option[]> = {};
  const extraNotes: Record<string, string> = {};
  for (const extra of summary.extras) {
    if (extra.options === undefined || extra.options.length === 0) continue;
    const rules = rulesFor(summary, values, extra.name);
    if (rules.allowed === null && rules.refused.size === 0) continue;
    const options = optionsWithRules(extra.options, rules);
    if (!options.some((option) => option.disabled)) continue;
    extraOptions[extra.name] = options;
    if (rules.note !== null) extraNotes[extra.name] = rules.note;
    const wanted = String(extraValue(extra, values));
    const effective = firstEnabled(options, wanted);
    if (effective !== null && effective !== wanted) values.extras[extra.name] = effective;
  }

  // The length wins over whatever the combo happened to hold, and it is written
  // last so the constraint pass above cannot leave a 5 s string on a 10 s clip.
  if (durationVia !== null && values.duration !== null) {
    const option = durationOptionFor(summary, values.duration);
    if (option !== null) values.extras[durationVia] = option;
  }

  const ignored = ignoredRoles(summary, values);
  for (const [role, note] of Object.entries(ignored)) {
    if (role === "duration") lengthNotes.add(note);
    else if (role === "audio") soundNotes.add(note);
    else sizeNotes.add(note);
  }
  if (countNote !== null) sizeNotes.add(countNote);

  return {
    values,
    sizeMode,
    customSize,
    presets: presetOptions,
    tiers,
    tierAspects,
    aspects,
    resolutions,
    durations,
    durationRange,
    counts,
    countMax,
    audioAllowed,
    audioLocked,
    audioReason,
    dimensions,
    ignored,
    extraOptions,
    extraNotes,
    notes: { size: [...sizeNotes], length: [...lengthNotes], sound: [...soundNotes] },
    dimensionError: sizeMode === "dimensions" || customSize ? dimensionError(dimensions, values.width, values.height) : null,
  };
}

/** A span short enough to draw as chips rather than a slider. */
function spanList(min: number, max: number, step: number, rules: RoleRules): number[] | null {
  if (rules.allowed !== null) {
    const numbers = rules.allowed.map(Number).filter((value) => Number.isFinite(value) && value >= min && value <= max);
    if (numbers.length > 0) return numbers.sort((a, b) => a - b);
  }
  const count = Math.floor((max - min) / Math.max(1, step)) + 1;
  if (count > 6) return null;
  const out: number[] = [];
  for (let value = min; value <= max; value += Math.max(1, step)) out.push(value);
  return out;
}

function narrowSpan(span: { min: number; max: number; step: number }, rules: RoleRules): { min: number; max: number; step: number } {
  let { min, max } = span;
  for (const [want] of rules.refused) {
    const comparison = /^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(String(want).trim());
    if (comparison === null) continue;
    const limit = Number(comparison[2]);
    if (comparison[1] === ">" ) max = Math.min(max, limit);
    else if (comparison[1] === ">=") max = Math.min(max, limit - span.step);
    else if (comparison[1] === "<") min = Math.max(min, limit);
    else min = Math.max(min, limit + span.step);
  }
  return { min, max: Math.max(min, max), step: span.step };
}

function countList(min: number, max: number): number[] {
  const out: number[] = [];
  for (let value = Math.max(1, min); value <= max && out.length < MAX_COUNT_CHIPS - 1; value += 1) out.push(value);
  if (max > (out[out.length - 1] ?? 0)) out.push(max);
  return out.length === 0 ? [1] : out;
}

/**
 * The option string of the length-carrying combo that means this many seconds,
 * e.g. 10 becomes "pro mode / 10s duration / kling-v2-5-turbo".
 */
export function durationOptionFor(summary: ModelSummary, seconds: number): string | null {
  const name = summary.capabilities.durationVia ?? null;
  if (name === null) return null;
  const extra = summary.extras.find((candidate) => candidate.name === name);
  return extra?.options?.find((option) => secondsInValue(option) === seconds) ?? null;
}

/**
 * Extras "More options" must not draw: the combo the Length control already
 * writes. Showing it as well would offer the same decision twice, once as
 * seconds and once as a raw vendor string.
 */
export function visibleExtras(summary: ModelSummary): ModelExtra[] {
  const hidden = summary.capabilities.durationVia ?? null;
  return hidden === null ? [...summary.extras] : summary.extras.filter((extra) => extra.name !== hidden);
}

/** The tier half of a tagged preset, e.g. "1K" from "(1K) 1312x736 (16:9)". */
export function tierOf(preset: string | null): string | null {
  return preset === null ? null : (presetMeta(preset)?.tier ?? null);
}

/** The aspect half of a tagged preset, e.g. "16:9". */
export function presetAspect(preset: string | null): string | null {
  return preset === null ? null : (presetMeta(preset)?.aspect ?? null);
}

/** The preset of one tier whose aspect is, or is nearest to, the wanted one. */
export function presetForTier(summary: ModelSummary, tier: string, aspect: string | null): string | null {
  const options = taggedPresets(summary.capabilities).filter((meta) => meta.tier === tier);
  if (options.length === 0) return null;
  const wanted = aspect === null ? null : closestRatio(options.map((meta) => meta.aspect), aspect);
  return options.find((meta) => meta.aspect === wanted)?.preset ?? options[0]!.preset;
}

// ---------- what gets sent ----------

/** The pixel size a request resolves to, for the label hint and the estimate. */
export function pixelsOf(summary: ModelSummary, values: FormValues): { width: number; height: number } | null {
  const mode = sizeModeOf(summary);
  if ((mode === "dimensions" || values.sizePreset === "Custom") && values.width !== null && values.height !== null) {
    return { width: values.width, height: values.height };
  }
  if (values.sizePreset !== null) {
    const meta = presetMeta(values.sizePreset);
    if (meta !== null) return { width: meta.width, height: meta.height };
    const plain = /^(\d+)\s*x\s*(\d+)$/.exec(values.sizePreset);
    if (plain !== null) return { width: Number(plain[1]), height: Number(plain[2]) };
  }
  return null;
}

/** The size line beside the Size label: pixels when we know them, else the words. */
export function sizeHint(summary: ModelSummary, values: FormValues): string | null {
  const pixels = pixelsOf(summary, values);
  if (pixels !== null) return `${pixels.width}x${pixels.height}`;
  const parts = [values.resolution, values.aspect].filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? null : parts.join(" ");
}

/** The quality tier a request asks for, where an extra sets one (Ideogram, GPT Image). */
export function qualityOf(values: FormValues, summary: ModelSummary): string | null {
  for (const name of QUALITY_INPUT_NAMES) {
    const chosen = values.extras[name];
    if (typeof chosen === "string" && chosen !== "") return chosen.toLowerCase();
    const extra = summary.extras.find((candidate) => candidate.name === name);
    if (extra !== undefined && typeof extra.default === "string" && extra.default !== "") return extra.default.toLowerCase();
  }
  return null;
}

/** Whether a request asks for a draft render, where the model sells one (Pruna P-Video-2). */
export function draftOf(values: FormValues, summary: ModelSummary): boolean | null {
  for (const name of DRAFT_INPUT_NAMES) {
    const chosen = values.extras[name];
    if (typeof chosen === "boolean") return chosen;
    const extra = summary.extras.find((candidate) => candidate.name === name);
    if (extra !== undefined && typeof extra.default === "boolean") return extra.default;
  }
  return null;
}

/**
 * The clip length a request asks for. The duration role when the model has one,
 * otherwise the seconds spelled inside an extra: Kling keeps both the length
 * and the model version in its `mode` combo ("pro mode / 10s duration /
 * kling-v2-5-turbo"), and its price doubles between the two options, so the
 * estimate has to read it.
 */
export function durationOf(values: FormValues, summary: ModelSummary): number | null {
  if (values.duration !== null) return values.duration;
  for (const name of DURATION_INPUT_NAMES) {
    const chosen = secondsInValue(values.extras[name]);
    if (chosen !== null) return chosen;
    const extra = summary.extras.find((candidate) => candidate.name === name);
    const fallback = extra === undefined ? null : secondsInValue(extra.default);
    if (fallback !== null) return fallback;
  }
  return null;
}

/** Only the extras the user actually moved; the builder fills the rest from the schema. */
export function changedExtras(values: FormValues, summary: ModelSummary): Record<string, ExtraValue> {
  const out: Record<string, ExtraValue> = {};
  for (const extra of summary.extras) {
    const value = values.extras[extra.name];
    if (value === undefined) continue;
    if (extra.default !== undefined && value === extra.default) continue;
    out[extra.name] = value;
  }
  return out;
}

export interface GenerateFields {
  sizePreset?: string;
  aspect?: string;
  resolution?: string;
  width?: number;
  height?: number;
  duration?: number;
  generateAudio?: boolean;
  count?: number;
  negativePrompt?: string;
  extras?: Record<string, ExtraValue>;
}

/**
 * The request fields for one model, from its resolved form. A model with no
 * such role sends nothing for it, so one request shape covers the catalog.
 */
export function generateFields(summary: ModelSummary, shape: FormShape): GenerateFields {
  const values = shape.values;
  const roles = new Set(summary.roles);
  const out: GenerateFields = {};
  if (roles.has("sizePreset") && values.sizePreset !== null) out.sizePreset = values.sizePreset;
  if (roles.has("aspect") && values.aspect !== null && shape.ignored.aspect === undefined) out.aspect = values.aspect;
  if (roles.has("resolution") && values.resolution !== null) out.resolution = values.resolution;
  const wantsPixels = shape.sizeMode === "dimensions" || shape.customSize;
  if (wantsPixels && roles.has("width") && values.width !== null) out.width = values.width;
  if (wantsPixels && roles.has("height") && values.height !== null) out.height = values.height;
  if (roles.has("duration") && values.duration !== null) out.duration = values.duration;
  if (roles.has("audio")) out.generateAudio = values.audio;
  if (roles.has("count") && values.count > 1) out.count = values.count;
  if (roles.has("negativePrompt") && values.negativePrompt.trim() !== "") out.negativePrompt = values.negativePrompt.trim();
  const extras = changedExtras(values, summary);
  if (Object.keys(extras).length > 0) out.extras = extras;
  return out;
}

/** True when one request already asks for every output, so the tab submits once. */
export function batchesInOneRun(summary: ModelSummary): boolean {
  return summary.roles.includes("count");
}

// ---------- extras ----------

/** "model.prompt_optimization" as "prompt optimization"; the wire name lives in the title. */
export function extraLabel(name: string): string {
  const bare = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return bare.replace(/_/g, " ");
}

/**
 * A vendor's own option value, as a person reads it.
 *
 * `extraLabel` handles the label side of an extra; this handles the value
 * side, so a select such as Ideogram's quality reads very low / low / medium /
 * high like every other value on the form rather than shouting VERY_LOW /
 * LOW. Only a shouted slug is touched: "4K", "1080P", "16:9",
 * "auto" and Kling's "pro mode / 5s duration / kling-v2-5-turbo" are already
 * words and are left exactly as the vendor wrote them, because the value is
 * what goes on the wire and a user comparing the two must see the same string.
 */
export function extraOptionLabel(value: string): string {
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(value)) return value.toLowerCase().replace(/_/g, " ");
  // Two letters, because Ideogram's prompt upsampling spells its three values
  // "AUTO", "OFF" and "ON" and a select reading "auto / off / ON" is worse than
  // one that shouts consistently. A tier keeps its case: "4K" and "1K" carry a
  // digit, so neither pattern matches them.
  if (/^[A-Z]{2,}$/.test(value)) return value.toLowerCase();
  return value;
}

/** The value an extra control starts from. */
export function extraValue(extra: ModelExtra, values: FormValues): ExtraValue {
  const current = values.extras[extra.name];
  if (current !== undefined) return current;
  if (extra.default !== undefined) return extra.default;
  if (extra.options !== undefined) return extra.options[0] ?? "";
  if (extra.type === "BOOLEAN") return false;
  if (extra.type === "INT" || extra.type === "FLOAT") return extra.min ?? 0;
  return "";
}
