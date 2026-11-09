// Shared RPC contract, DTO schemas and model tables for bb-plugin-comfy-cloud.
//
// server.ts registers handlers against this contract; app.tsx and the
// components import only types and the plain constants, so nothing here may
// pull in server-only modules. This file is the frozen boundary between the
// backend and the frontend: change it deliberately, and keep it additive.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ---------- JSON ----------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

/**
 * A ComfyUI "API format" workflow: node id -> { class_type, inputs }. An input
 * value is either a literal or a link `[fromNodeId, outputSlot]`.
 */
export const workflowNodeSchema = z.object({
  class_type: z.string(),
  inputs: z.record(z.string(), jsonValueSchema),
  _meta: z.object({ title: z.string() }).optional(),
});
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export const workflowSchema = z.record(z.string(), workflowNodeSchema);
export type Workflow = z.infer<typeof workflowSchema>;

/** True when an input value is a link to another node's output. */
export function isLink(value: JsonValue): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
}

// ---------- models and presets (from Comfy Cloud /api/object_info) ----------

/**
 * Four bare Seedream ids that are accepted as model keys. They build the
 * byte identical graph; the registry in models.generated.ts is what validates
 * a model, so the type is a string.
 */
export const IMAGE_MODELS = ["seedream 5.0 pro", "seedream 5.0 lite", "seedream-4-5-251128", "seedream-4-0-250828"] as const;
export type LegacyImageModel = (typeof IMAGE_MODELS)[number];
/**
 * A model key. Either a registry key (`<nodeClass>/<modelId>`, or `<nodeClass>`
 * when the node has no model input) or one of the legacy ids above, which
 * `resolveModelKey` in registry.ts maps onto its registry entry.
 */
export type ModelKey = string;
export const modelKeySchema = z.string().min(1);
export type ImageModel = ModelKey;
export const imageModelSchema = modelKeySchema;
/**
 * The model a request with no model of its own runs on.
 *
 * This is the **V3** node, not the V2 one the legacy id `seedream 5.0 pro`
 * still resolves to. Comfy marks V2 deprecated and V3 offers the same four
 * models with the same size presets, so V2 is hidden in the picker, and a
 * default on a hidden row would put it back in the list beside its V3 twin.
 * The alias table is untouched: every asset, setting and CLI call that names
 * `seedream 5.0 pro` still builds the byte identical V2 graph the golden
 * fixtures pin.
 */
export const DEFAULT_IMAGE_MODEL: ImageModel = "ByteDanceSeedreamNodeV3/seedream 5.0 pro";

export interface ImageModelInfo {
  label: string;
  /** Section heading for grouped selects. */
  group: string;
}

/** Friendly labels for the Seedream image models. The raw id stays the wire value. */
export const IMAGE_MODEL_INFO: Record<string, ImageModelInfo> = {
  "seedream 5.0 pro": { label: "Seedream 5.0 Pro", group: "Seedream 5.x" },
  "seedream 5.0 lite": { label: "Seedream 5.0 Lite", group: "Seedream 5.x" },
  "seedream-4-5-251128": { label: "Seedream 4.5", group: "Seedream 4.x" },
  "seedream-4-0-250828": { label: "Seedream 4.0", group: "Seedream 4.x" },
};

/** Parse "(1K) 1312x736 (16:9)" into its pixel size. */
export function parseSizePreset(preset: string): { width: number; height: number } | null {
  const match = /(\d+)x(\d+)/.exec(preset);
  if (match === null) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

export const VIDEO_MODELS = [
  "seedance-1-0-pro-fast-251015",
  "seedance-1-5-pro-251215",
  "seedance-1-0-pro-250528",
  "Seedance 2.0 Fast",
  "Seedance 2.0",
  "Seedance 2.5",
] as const;
export type LegacyVideoModel = (typeof VIDEO_MODELS)[number];
export type VideoModel = ModelKey;
export const videoModelSchema = modelKeySchema;
export const DEFAULT_VIDEO_MODEL: VideoModel = "seedance-1-0-pro-fast-251015";

export const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];
export const VIDEO_ASPECTS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"] as const;
export type VideoAspect = (typeof VIDEO_ASPECTS)[number];

export interface VideoModelInfo {
  /** Which Comfy node runs this model. */
  node: "ByteDanceTextToVideoNode" | "ByteDance2TextToVideoNode";
  resolutions: readonly VideoResolution[];
  durationMin: number;
  durationMax: number;
  defaultDuration: number;
  /** Whether the model can generate an audio track. */
  audio: boolean;
  label: string;
}

/** Checked against /api/object_info. */
export const VIDEO_MODEL_INFO: Record<string, VideoModelInfo> = {
  "seedance-1-0-pro-fast-251015": { node: "ByteDanceTextToVideoNode", resolutions: ["480p", "720p", "1080p"], durationMin: 3, durationMax: 12, defaultDuration: 5, audio: false, label: "Seedance 1.0 Pro Fast" },
  "seedance-1-5-pro-251215": { node: "ByteDanceTextToVideoNode", resolutions: ["480p", "720p", "1080p"], durationMin: 3, durationMax: 12, defaultDuration: 5, audio: true, label: "Seedance 1.5 Pro" },
  "seedance-1-0-pro-250528": { node: "ByteDanceTextToVideoNode", resolutions: ["480p", "720p", "1080p"], durationMin: 3, durationMax: 12, defaultDuration: 5, audio: false, label: "Seedance 1.0 Pro" },
  "Seedance 2.0 Fast": { node: "ByteDance2TextToVideoNode", resolutions: ["480p", "720p"], durationMin: 4, durationMax: 15, defaultDuration: 5, audio: true, label: "Seedance 2.0 Fast" },
  "Seedance 2.0": { node: "ByteDance2TextToVideoNode", resolutions: ["480p", "720p", "1080p", "4k"], durationMin: 4, durationMax: 15, defaultDuration: 5, audio: true, label: "Seedance 2.0" },
  "Seedance 2.5": { node: "ByteDance2TextToVideoNode", resolutions: ["480p", "720p", "1080p"], durationMin: 4, durationMax: 30, defaultDuration: 5, audio: true, label: "Seedance 2.5" },
};

// ---------- assets ----------

export const assetKindSchema = z.enum(["image", "video"]);
export type AssetKind = z.infer<typeof assetKindSchema>;
/**
 * `unknown` is a submitted row whose outcome the plugin cannot tell yet: Comfy
 * Cloud was out of reach, refused the key, or is still running the job after
 * 20 minutes. It is never "failed", because the job may finish and be billed;
 * the runner asks again every minute.
 */
export const assetStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled", "unknown"]);
export type AssetStatus = z.infer<typeof assetStatusSchema>;
export const assetSourceSchema = z.enum(["panel", "cli", "tool", "unknown"]);
export type AssetSource = z.infer<typeof assetSourceSchema>;

/** Generation parameters as shown in the UI and used for "regenerate". Plain JSON, one level deep. */
export const paramsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
export type Params = z.infer<typeof paramsSchema>;

export const assetSchema = z.object({
  /** `img_` or `vid_` followed by 8 lowercase alphanumerics. */
  id: z.string(),
  kind: assetKindSchema,
  status: assetStatusSchema,
  prompt: z.string(),
  model: z.string(),
  params: paramsSchema,
  /** Path relative to the asset directory, for preview URLs. Null until the file is downloaded. */
  file: z.string().nullable(),
  /** Absolute path on the bb server's disk. Null until the file is downloaded. */
  path: z.string().nullable(),
  /** Absolute path of the workflow JSON that produced (or will produce) this asset. */
  workflowPath: z.string(),
  /**
   * Small copies beside the asset: 512 px long edge for the grid, 2048 px for
   * the viewer, which settles on it (see thumbs.ts). Null on every row that
   * predates them and on any whose ffmpeg run failed, so every surface falls
   * back to the original.
   */
  thumbPath: z.string().nullable().optional(),
  mediumPath: z.string().nullable().optional(),
  /**
   * Version tokens for the media route (media.ts), one per file: the file's
   * size and mtime in base 36, so each changes exactly when that file's bytes
   * do. Computed by the server as a row leaves through the RPC and never
   * stored, because the backfill can rewrite a small copy in place. A URL that
   * carries one may be cached for a year; a row without one (an old server,
   * or a file missing from disk) makes the panel fall back to the preview base.
   *
   * Three optional strings on the row rather than one map beside the list:
   * about 40 bytes a row, nothing to join on the client, and a client built
   * before them simply ignores the fields.
   */
  fileVersion: z.string().nullable().optional(),
  thumbVersion: z.string().nullable().optional(),
  mediumVersion: z.string().nullable().optional(),
  mime: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  durationS: z.number().nullable(),
  sizeBytes: z.number().nullable(),
  comfyPromptId: z.string().nullable(),
  /** The asset this one was regenerated or tweaked from. */
  parentId: z.string().nullable(),
  threadId: z.string().nullable(),
  source: assetSourceSchema,
  starred: z.boolean(),
  error: z.string().nullable(),
  // The four cost fields are `.optional()` so a caller that leaves them out
  // still validates; the server always sends them, null when unknown.
  /** Credits the price table expected at submit time. Null when the shape has no price. */
  estimatedCredits: z.number().nullable().optional(),
  /** Credits Comfy Cloud actually billed, from the billing event whose job_id is comfyPromptId. */
  actualCredits: z.number().nullable().optional(),
  /** Model id Comfy billed under, e.g. "seedream-5-0-pro-260628" for "seedream 5.0 pro". */
  billedModel: z.string().nullable().optional(),
  /** Billing tier of the output, e.g. "standard" or "large". */
  outputTier: z.string().nullable().optional(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
});
export type Asset = z.infer<typeof assetSchema>;

export const nodeInfoSchema = z.object({
  classType: z.string(),
  displayName: z.string(),
  category: z.string(),
  /** Output slot type names in slot order, e.g. ["IMAGE"] or ["VIDEO"]. */
  outputs: z.array(z.string()),
  /** Declared inputs (required then optional) with their type names. */
  inputs: z.array(z.object({ name: z.string(), type: z.string(), required: z.boolean() })),
  /** True when object_info marks the class as an output node (Save/Preview style). */
  outputNode: z.boolean().optional(),
});
export type NodeInfo = z.infer<typeof nodeInfoSchema>;

export const keySourceSchema = z.enum(["setting", "plugin-env", "key-file"]).nullable();
export type KeySource = z.infer<typeof keySourceSchema>;

export const statusSchema = z.object({
  configured: z.boolean(),
  keySource: keySourceSchema,
  /** Human hint when not configured. */
  configureHint: z.string().nullable(),
  assetDir: z.string(),
  imageModel: imageModelSchema,
  videoModel: videoModelSchema,
  counts: z.object({
    total: z.number(),
    images: z.number(),
    videos: z.number(),
    /** Queued, running, and submitted with the outcome not known yet: everything still in play. */
    running: z.number(),
    /** Every failed row still in the library, for all time. The panel's own figure. */
    failed: z.number(),
    /** Failed inside `FAILED_WINDOW_MS`. The sidebar badge's figure: see the constant. */
    failedRecent: z.number(),
  }),
  /** True once the node catalog (object_info) has been fetched and cached. */
  catalogLoaded: z.boolean(),
  /**
   * How current the shipped model registry is. The catalog on disk refreshes
   * itself daily; `models.generated.ts` is regenerated by hand, so the two can
   * drift. A registry a few days behind the catalog can still offer rows
   * Comfy Cloud has retired, which is the kind of gap this is here to show
   * before someone hits it.
   */
  registry: z.object({
    /** The day scripts/make-models.mjs last wrote the registry. */
    generatedAt: z.string(),
    /** The day the catalog snapshot it was built from was fetched. */
    catalogDate: z.string(),
    /** The day the catalog now on disk was fetched, or null when there is none. */
    catalogFetched: z.string().nullable(),
  }),
  /** Why the asset directory could not be prepared, or null when it is fine. */
  assetDirError: z.string().nullable().optional(),
  /** Credits left on the account, from /api/billing/balance. Null until it is known. */
  balanceCredits: z.number().nullable().optional(),
  /** The same balance in US dollars. Null when the balance or the rate is unknown. */
  balanceUsd: z.number().nullable().optional(),
  /** US dollars per credit, from the creditRate setting (default 211 credits per dollar). Null means show credits only. */
  creditRate: z.number().nullable().optional(),
});
/**
 * How long a failed generation stays loud on the sidebar badge.
 *
 * A signal has to be able to go away. `counts.failed` is a lifetime figure, so
 * a badge fed by it is permanently red, and a permanently red badge teaches you
 * to stop seeing red: the one failure that matters then arrives on a surface
 * you have learned to ignore. So the badge counts the window and the panel
 * keeps the lifetime total, which is where a lifetime total is useful.
 *
 * A day, not an hour, because generations made through the tool or the CLI
 * finish whether or not anyone is watching, so a failure has to survive until
 * the next time somebody looks. It is not a record: the Library and the Jobs
 * tab still hold the failure afterwards, and the Status settings section still
 * counts it.
 */
export const FAILED_WINDOW_MS = 24 * 3600_000;

export type Status = z.infer<typeof statusSchema>;

// ---------- how current this registry is ----------

/** Whole days from one YYYY-MM-DD to another, negative when b is earlier. */
function daysBetween(a: string, b: string): number | null {
  const parse = (d: string): number | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    return m === null ? null : Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  };
  const from = parse(a);
  const to = parse(b);
  if (from === null || to === null) return null;
  return Math.round((to - from) / 86_400_000);
}

export type RegistryAge = {
  generatedAt: string;
  catalogDate: string;
  catalogFetched: string | null;
  /** Days since the registry was generated, or null when a date is unreadable. */
  ageDays: number | null;
  /** Days the catalog on disk is newer than the snapshot the registry was built from. */
  behindDays: number | null;
  /** True when a newer catalog is sitting on disk than the one this registry was built from. */
  stale: boolean;
};

/**
 * The registry is a frozen snapshot regenerated by hand, and the catalog it is
 * built from refreshes itself every day, so the two drift silently. This is the
 * comparison, and `registryAgeLine` is the sentence every surface prints.
 */
export function registryAge(info: { generatedAt: string; catalogDate: string; catalogFetched: string | null }, today: string): RegistryAge {
  const behindDays = info.catalogFetched === null ? null : daysBetween(info.catalogDate, info.catalogFetched);
  return {
    generatedAt: info.generatedAt,
    catalogDate: info.catalogDate,
    catalogFetched: info.catalogFetched,
    ageDays: daysBetween(info.generatedAt, today),
    behindDays,
    stale: behindDays !== null && behindDays > 0,
  };
}

/** "N days ago", in the words a person would use. */
function agoWords(days: number | null): string | null {
  if (days === null || days < 0) return null;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** "built 2031-05-11 (today) from the catalog fetched 2031-05-10" */
function agePhrase(age: RegistryAge): string {
  const ago = agoWords(age.ageDays);
  return `built ${age.generatedAt}${ago === null ? "" : ` (${ago})`} from the catalog fetched ${age.catalogDate}`;
}

/** What to add when a newer catalog is already on disk, or "" when there is not. */
function staleClause(age: RegistryAge): string {
  if (!age.stale || age.behindDays === null) return "";
  const days = age.behindDays === 1 ? "1 day" : `${age.behindDays} days`;
  return ` The catalog on disk is ${days} newer, so a model Comfy Cloud has added or retired since is not in this list. Regenerate with node scripts/make-models.mjs.`;
}

/** Just the warning, for a surface that has its own sentence to append it to. Empty when current. */
export function registryStaleNote(age: RegistryAge): string {
  return staleClause(age).trim();
}

/** For `bb comfy status` and the comfy_status tool, which print whole sentences. */
export function registryAgeLine(age: RegistryAge): string {
  return `The model list was ${agePhrase(age)}.${staleClause(age)}`;
}

/** For a labelled row in the Status settings section, which supplies "Model list" itself. */
export function registryAgeText(age: RegistryAge): string {
  const phrase = agePhrase(age);
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.${staleClause(age)}`;
}


// ---------- cost DTOs ----------
// The price tables and the pure `estimateCredits` live at the bottom of this
// file; only the wire schemas are here, because `rpcContract` needs them.

/** See the doc comment on CostConfidence at the bottom of this file. */
export const costConfidenceSchema = z.enum(["measured", "published", "inferred", "unknown"]);
export type CostConfidence = z.infer<typeof costConfidenceSchema>;

/** One shape this account has been billed for, and the median it paid. */
export const observedShapeSchema = z.object({ signature: z.string(), kind: assetKindSchema, model: z.string(), credits: z.number(), samples: z.number() });
export type ObservedShape = z.infer<typeof observedShapeSchema>;

export const costsSchema = z.object({
  /** Credits left on the account, or null when the balance could not be read. */
  balanceCredits: z.number().nullable(),
  /** The same balance in US dollars. */
  balanceUsd: z.number().nullable(),
  /** US dollars per credit, from the creditRate setting. Null means show credits only. */
  creditRate: z.number().nullable(),
  /** What this plugin's own generations were billed, in credits. */
  spend: z.object({ today: z.number(), week: z.number(), total: z.number() }),
  /** One row per model over the window, most expensive first. */
  byModel: z.array(z.object({ model: z.string(), kind: assetKindSchema, credits: z.number(), count: z.number() })),
  /** Newest generations that carry a cost, for the settings table. */
  recent: z.array(
    z.object({
      id: z.string(),
      kind: assetKindSchema,
      model: z.string(),
      credits: z.number().nullable(),
      estimatedCredits: z.number().nullable(),
      createdAt: z.number(),
    }),
  ),
  /** What the plugin has learned: one row per shape it has been billed for. */
  observed: z.array(observedShapeSchema),
  /** Days covered by `byModel` and `recent`. */
  days: z.number(),
});
export type Costs = z.infer<typeof costsSchema>;

// ---------- the model registry, as the frontend sees it ----------
//
// The full registry lives in models.generated.ts (built from the cached Comfy
// Cloud node catalog by scripts/make-models.mjs) and models.overrides.ts (built
// from the hand checked vendor documentation in qa/model-docs). Neither is
// imported here: the panel gets the summaries below from the `models` RPC so
// the 150 entry table is never bundled into the app.

/** What a model can be asked for, in the plugin's own words. */
export const modelCapabilitiesSchema = z.object({
  /** Named size presets, e.g. "(1K) 1024x1024 (1:1)" or "2048x2048 (1:1)". */
  sizePresets: z.array(z.string()),
  /** Aspect ratio strings the model offers, e.g. "16:9". */
  aspects: z.array(z.string()),
  /** Resolution tiers, e.g. "720p" or "2K". */
  resolutions: z.array(z.string()),
  /** Free width and height, when the model takes them. */
  dimensions: z
    .object({ widthMin: z.number(), widthMax: z.number(), heightMin: z.number(), heightMax: z.number(), step: z.number(), widthDefault: z.number(), heightDefault: z.number() })
    .nullable(),
  /** Clip length in seconds. `allowed` is set when the node offers a fixed list. */
  duration: z.object({ min: z.number(), max: z.number(), step: z.number(), allowed: z.array(z.number()).nullable(), default: z.number() }).nullable(),
  /**
   * The wire name of the combo that carries the clip length, for a model with
   * no duration input of its own. Kling packs the version and the length into
   * one `mode` string ("pro mode / 10s duration / kling-v2-5-turbo"), so the
   * Length control writes that string rather than a number. Null (or absent)
   * means `duration` above is a real input.
   */
  durationVia: z.string().nullable().optional(),
  /**
   * The length a click actually buys on a model whose length comes out of the
   * prompt, from the vendor's own documentation. Gemini Omni Flash 1.1 returns
   * 10 seconds when the prompt does not say, and it is billed per second, so an
   * estimate that assumed the usual 5 would be half the truth.
   */
  promptDurationDefault: z.number().nullable().optional(),
  /** True when the model can add an audio track. */
  audio: z.boolean(),
  /** How many outputs one call can return. */
  count: z.object({ min: z.number(), max: z.number() }).nullable(),
  seed: z.boolean(),
  negativePrompt: z.boolean(),
  /** Longest prompt the vendor documents, or null when it publishes none. */
  promptMaxChars: z.number().nullable(),
  /**
   * How many reference images the model takes beside its prompt, or null when
   * it takes none. Optional on the wire so a caller that leaves it out
   * still validates.
   */
  referenceImages: z.object({ min: z.number(), max: z.number() }).nullable().optional(),
  /**
   * True when nothing in qa/model-docs covers this entry, so every field above
   * came from the node schema alone. The picker says so rather than implying a
   * vendor confirmed it.
   */
  schemaDerived: z.boolean(),
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

/**
 * A combination the vendor refuses, in machine usable form: when every entry of
 * `when` holds, `then` narrows what is legal. `then.allowed === false` means the
 * combination is refused outright.
 */
export const modelConstraintSchema = z.object({
  when: z.record(z.string(), jsonValueSchema),
  then: z.record(z.string(), jsonValueSchema),
  note: z.string(),
});
export type ModelConstraint = z.infer<typeof modelConstraintSchema>;

/** How a model is billed. `per-1m-tokens` and `per-1k-tokens` need the token formula. */
export const priceUnitSchema = z.enum(["per-image", "per-second", "per-run", "per-video", "per-1m-tokens", "per-1k-tokens"]);
export type PriceUnit = z.infer<typeof priceUnitSchema>;

/**
 * A price that applies only to some requests. `when` names roles and their
 * values (`resolution`, `tier`, `audio`, `duration`, `quality`, `size`) plus the
 * two pixel bounds `minPixels` and `maxPixels`. The most specific match wins.
 */
export const priceTierSchema = z.object({
  when: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  credits: z.number(),
  /** Low and high, for a tier the vendor publishes as a span rather than a figure. */
  creditsRange: z.tuple([z.number(), z.number()]).optional(),
  /** Credits for the first second, where a model charges a base plus a rate (Vidu Q2). */
  baseCredits: z.number().optional(),
});
export type PriceTier = z.infer<typeof priceTierSchema>;

export const modelPriceSchema = z.object({
  unit: priceUnitSchema,
  /** Credits for one unit when the price does not vary, or the base rate. Null when only tiers are known. */
  credits: z.number().nullable(),
  /** Credits for the first second, where a model charges a base plus a per second rate. */
  baseCredits: z.number().optional(),
  /** Prices for specific shapes, most specific match first. */
  tiers: z.array(priceTierSchema).optional(),
  /** Credits each output past the first adds (Seedream's max_images, Ideogram's n). */
  extraCredits: z.number().optional(),
  /** Credits each whole megapixel past the first adds (FLUX.2). */
  perExtraMegapixelCredits: z.number().optional(),
  /** Low and high credits when the model is billed by tokens the request cannot predict. */
  creditsRange: z.tuple([z.number(), z.number()]).optional(),
  /**
   * What a reference image adds. Absent means the model's price does not cover
   * references at all, and a request that carries one is refused a quote rather
   * than quoted at the text only figure: see `priceCredits`.
   */
  reference: z
    .object({
      /** Credits each billed reference adds. */
      credits: z.number(),
      /** The top of the vendor's span, where it publishes one. */
      creditsMax: z.number().optional(),
      /** References the base price already covers. Seedream includes the first; GPT Image includes none. */
      included: z.number().optional(),
    })
    .optional(),
  confidence: costConfidenceSchema,
  note: z.string(),
});
export type ModelPrice = z.infer<typeof modelPriceSchema>;

/** One input the form renders generically under "More options". */
export const modelExtraSchema = z.object({
  name: z.string(),
  /** COMBO, BOOLEAN, INT, FLOAT or STRING. */
  type: z.string(),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  multiline: z.boolean().optional(),
  tooltip: z.string().optional(),
});
export type ModelExtra = z.infer<typeof modelExtraSchema>;

/** Where the form starts for a model: the values the builder uses when the request says nothing. */
export const modelDefaultsSchema = z.object({
  sizePreset: z.string().nullable(),
  aspect: z.string().nullable(),
  resolution: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  duration: z.number().nullable(),
  count: z.number().nullable(),
  audio: z.boolean().nullable(),
});
export type ModelDefaults = z.infer<typeof modelDefaultsSchema>;

/** One row of the picker. Everything the sheet, the form and the estimate need. */
export const modelSummarySchema = z.object({
  /** Stable key: `<nodeClass>/<modelId>`, or `<nodeClass>` when the node has no model input. */
  key: z.string(),
  kind: assetKindSchema,
  /** Display vendor, e.g. "ByteDance". */
  vendor: z.string(),
  /** Comfy node class that runs it. */
  node: z.string(),
  /** The model id sent on the wire, or null when the node runs one model. */
  modelId: z.string().nullable(),
  label: z.string(),
  /** One short phrase: why someone would pick this model. Null when nothing was documented. */
  strengths: z.string().nullable(),
  /** Anything a user should know before spending on it. */
  notes: z.string().nullable(),
  capabilities: modelCapabilitiesSchema,
  /** The capability line the picker shows under the label, e.g. "480p to 1080p, 3 to 12 s, audio". */
  capabilityLine: z.string(),
  price: modelPriceSchema.nullable(),
  /** The price line the picker right aligns, e.g. "9.5 credits, about $0.045". */
  priceLine: z.string(),
  /**
   * The cheapest complete generation this model can do, which is the number the
   * Cheapest sort orders by. A video row's usual line is a rate per second, so
   * without this the sorted column shows figures that do not ascend.
   */
  cheapestLine: z.string(),
  defaults: modelDefaultsSchema,
  constraints: z.array(modelConstraintSchema),
  /** Inputs with no role, for the generic "More options" disclosure. */
  extras: z.array(modelExtraSchema),
  /** Roles the model actually has, so the form knows which blocks to draw. */
  roles: z.array(z.string()),
  supported: z.boolean(),
  /** Why the entry cannot be offered. Null when it can. */
  unsupportedReason: z.string().nullable(),
  /** The Comfy catalog or the vendor marks it deprecated. */
  deprecated: z.boolean(),
  /** Kept out of the picker: superseded, retired or strictly worse than another entry. */
  hidden: z.boolean(),
  recommended: z.boolean(),
  /** True when a vendor documentation record backs this entry. */
  documented: z.boolean(),
  /** Model keys that resolve to this entry, e.g. the legacy "seedream 5.0 pro". */
  aliases: z.array(z.string()),
});
export type ModelSummary = z.infer<typeof modelSummarySchema>;

export const modelsResultSchema = z.object({
  models: z.array(modelSummarySchema),
  /** The current default model of each kind, as a key. */
  defaults: z.object({ image: z.string(), video: z.string() }),
  counts: z.object({ total: z.number(), supported: z.number(), unsupported: z.number(), hidden: z.number() }),
  /** US dollars per credit, so the picker can print money without a second call. */
  creditRate: z.number().nullable(),
  /**
   * What this account has already paid, one row per shape, for the kind asked
   * for. The form quotes from it so the price on the button is the price the
   * server will store on the row, rather than the published one the server has
   * already learned to distrust.
   */
  observed: z.array(observedShapeSchema),
});
export type ModelsResult = z.infer<typeof modelsResultSchema>;

export const modelPrefsSchema = z.object({
  /** Starred model keys, in the order the user starred them. */
  favourites: z.array(z.string()),
  /** Model keys most recently generated with, newest first. */
  recent: z.array(z.string()),
  /**
   * The model the Generate tab is on, one per kind. The tab is a fixed tab and
   * is unmounted every time the user looks at Jobs, so the choice is kept here
   * rather than in React state, and it survives the trip. Absent until
   * something has been chosen, in which case the `imageModel` and `videoModel`
   * settings are still the default.
   */
  chosen: z.object({ image: z.string().nullable(), video: z.string().nullable() }).optional(),
});
export type ModelPrefs = z.infer<typeof modelPrefsSchema>;

const okText = z.object({ ok: z.boolean(), text: z.string() });
const assetResult = z.object({ asset: assetSchema });

/** Values for the model's own extra inputs, keyed by the input's wire name. */
export const modelExtraValuesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

/**
 * Fields every model shares. A model that has no such role ignores the field,
 * so one request shape covers the whole catalog.
 */
const commonGenerateFields = {
  /** A registry key, or a legacy id such as "seedream 5.0 pro". */
  model: modelKeySchema.optional(),
  /** A named preset from the model's own list. */
  sizePreset: z.string().optional(),
  /** An aspect ratio the model offers, e.g. "16:9". */
  aspect: z.string().optional(),
  /** A resolution tier the model offers, e.g. "720p" or "2K". */
  resolution: z.string().optional(),
  /** Free pixel size, for models that take width and height. Clamped to the schema. */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Outputs from one call, for models with a count role. */
  count: z.number().int().positive().max(16).optional(),
  negativePrompt: z.string().optional(),
  /** Omit for a random seed. */
  seed: z.number().int().min(0).max(2147483647).optional(),
  /** Anything under the form's "More options": input wire name to value. */
  extras: modelExtraValuesSchema.optional(),
  /**
   * Reference images, in slot order: an existing asset id, or a path to an
   * image file on the bb server's disk. Each is uploaded to Comfy Cloud and
   * wired into one of the model's own reference slots. A model whose
   * capabilities carry no `referenceImages` refuses the request.
   */
  references: z.array(z.string().min(1)).max(16).optional(),
  parentId: z.string().optional(),
  threadId: z.string().optional(),
  source: assetSourceSchema.optional(),
};

export const generateImageInputSchema = z.object({
  prompt: z.string().min(1),
  ...commonGenerateFields,
});
export type GenerateImageInput = z.infer<typeof generateImageInputSchema>;

export const generateVideoInputSchema = z.object({
  prompt: z.string().min(1),
  ...commonGenerateFields,
  /** The old spelling of `aspect`, still accepted. */
  aspectRatio: z.string().optional(),
  /** Seconds; clamped to the model's range. */
  duration: z.number().int().optional(),
  /** Ignored by models without audio. */
  generateAudio: z.boolean().optional(),
});
export type GenerateVideoInput = z.infer<typeof generateVideoInputSchema>;

export const runWorkflowInputSchema = z.object({
  workflow: workflowSchema,
  /** "auto" looks at the save node (SaveVideo -> video, otherwise image). */
  kind: z.enum(["image", "video", "auto"]).optional(),
  /** Shown in the browser; defaults to the first multiline STRING input found in the graph. */
  prompt: z.string().optional(),
  parentId: z.string().optional(),
  threadId: z.string().optional(),
  source: assetSourceSchema.optional(),
});
export type RunWorkflowInput = z.infer<typeof runWorkflowInputSchema>;

/** No arguments: accepts null, undefined, or an empty object body (`{}` from curl). */
export const noInputSchema = z.object({}).strict().nullish();

export const rpcContract = defineRpcContract({
  status: { input: noInputSchema, output: statusSchema },

  /** Newest first. `before` pages by createdAt. */
  assets_list: {
    input: z.object({
      kind: assetKindSchema.optional(),
      status: assetStatusSchema.optional(),
      starred: z.boolean().optional(),
      query: z.string().optional(),
      // The Library's "Show older" grows this a page at a time up to 2000.
      limit: z.number().int().positive().max(2000).optional(),
      before: z.number().optional(),
    }),
    output: z.object({ assets: z.array(assetSchema) }),
  },
  /** One asset with the workflow graph that produced it and the sanitized Comfy job record (null until it ran). */
  asset_get: {
    input: z.object({ id: z.string() }),
    output: z.object({ asset: assetSchema, workflow: workflowSchema, job: jsonValueSchema.nullable() }),
  },
  generate_image: { input: generateImageInputSchema, output: assetResult },
  generate_video: { input: generateVideoInputSchema, output: assetResult },
  /** Submit an edited or hand-written workflow graph ("regenerate with tweaks"). */
  run_workflow: { input: runWorkflowInputSchema, output: assetResult },
  /** Resubmit the exact workflow of an existing asset as a new asset (same seed unless `newSeed`). */
  asset_retry: { input: z.object({ id: z.string(), newSeed: z.boolean().optional() }), output: assetResult },
  /** Stop tracking a queued or running asset. Comfy Cloud has no cancel endpoint for a submitted job, so the remote job may still finish; the local row is marked cancelled. */
  asset_cancel: { input: z.object({ id: z.string() }), output: assetResult },
  asset_star: { input: z.object({ id: z.string(), starred: z.boolean() }), output: assetResult },
  /** Removes the row and its files (media, workflow, job record). */
  asset_delete: { input: z.object({ id: z.string() }), output: okText },

  /** Credits: the account balance, what this plugin's generations cost, and the shapes it has learned prices for. */
  costs: { input: z.object({ days: z.number().int().positive().max(3650).optional() }).nullish(), output: costsSchema },

  /** Short-lived base URL that serves the asset directory; append the encoded `asset.file`. */
  preview_base: { input: noInputSchema, output: z.object({ baseUrl: z.string(), expiresAtMs: z.number() }) },

  /** Short-lived base URL that serves the plugin's own artwork folder (assets/art); append `<name>.png`. */
  art_base: { input: noInputSchema, output: z.object({ baseUrl: z.string(), expiresAtMs: z.number() }) },

  /**
   * The model registry the picker renders: one summary per entry, supported
   * ones only unless `all` is set. Sorted by vendor then label.
   */
  models: {
    input: z.object({ kind: assetKindSchema.optional(), vendor: z.string().optional(), all: z.boolean().optional(), query: z.string().optional() }).nullish(),
    output: modelsResultSchema,
  },

  /**
   * Every name a stored `asset.model` can hold, mapped to the label the picker
   * shows. Small (about 10 KB) and static between reloads, so the Library, the
   * Viewer and the Jobs rows can name a model without pulling the whole
   * registry into the panel.
   */
  model_labels: { input: noInputSchema, output: z.object({ labels: z.record(z.string(), z.string()) }) },

  /** Favourite and recently used model keys. Send nothing to read; send a field to replace it. */
  model_prefs: {
    input: z
      .object({
        favourites: z.array(z.string()).max(200).optional(),
        recent: z.array(z.string()).max(50).optional(),
        /** The model the panel is now on. Send only the kind that changed. */
        chosen: z.object({ image: z.string().optional(), video: z.string().optional() }).optional(),
      })
      .nullish(),
    output: modelPrefsSchema,
  },

  /** Node metadata for the graph view, from the cached Comfy Cloud object_info. Unknown class types are left out. */
  node_catalog: {
    input: z.object({ classTypes: z.array(z.string()).max(200) }),
    output: z.object({ nodes: z.record(z.string(), nodeInfoSchema) }),
  },
});
export type RpcContract = typeof rpcContract;

/** Realtime channel: published (throttled) whenever an asset row changes. Payload `{ at: number, assetId?: string }`. */
export const COMFY_CHANNEL = "comfy-changed";

// ---------- time estimates ----------

/** Rough seconds a generation takes, as a range. */
export interface TimeEstimate {
  low: number;
  high: number;
}

/** Inputs `estimateSeconds` looks at. Everything is optional; unknown fields are ignored. */
export interface EstimateParams {
  sizePreset?: string | null;
  resolution?: string | null;
  duration?: number | null;
  /** Seedance 1.5 Pro charges twice as much with an audio track. Ignored elsewhere. */
  generateAudio?: boolean | null;
  /** How many generations of the same shape. Multiplies the estimate. */
  count?: number | null;
  /** Free pixel size, for models priced by megapixels or with no size preset. */
  width?: number | null;
  height?: number | null;
  /** A quality tier such as "low", "medium", "high" or "hd", where the model prices by one. */
  quality?: string | null;
  /**
   * How many reference images the request carried.
   *
   * It is part of the shape, not of the estimate: on Seedream 5.0 Pro the first
   * reference is included and each one after it adds 0.63 credits, so a two
   * reference bill learned against the plain signature would teach the wrong
   * price for every plain image of that size. Keyed separately, the account
   * learns each shape on its own.
   */
  references?: number | null;
  /**
   * A draft render, where the model sells one. Pruna P-Video-2 bills a draft at
   * 60 percent of its standard rate, so a price tier may be keyed on it.
   */
  draft?: boolean | null;
  /**
   * True when the request leaves the clip length to the model ("auto"). A per
   * second price cannot be turned into a figure then, so the estimate refuses
   * rather than quoting the five second fallback.
   */
  durationAuto?: boolean | null;
}

/**
 * Wire input names the price tables read as a quality tier. One list, because
 * the form quotes the price from it and the server has to record the same tier
 * in the asset's params or the two disagree.
 */
export const QUALITY_INPUT_NAMES = ["quality", "model.quality", "rendering_speed", "model.rendering_speed"] as const;

/**
 * The same list for the size preset. A row this plugin built records
 * `sizePreset`, but a row built by `run_workflow` keeps the graph's own input
 * names, and then the only size in its params is something like `model.size`.
 *
 * Without this the shape reads as unknown and the row prices at the model's
 * floor: a gpt-image-2.5 row built that way would quote the floor instead of
 * its own shape's figure, purely because the key is spelled differently.
 */
export const SIZE_INPUT_NAMES = ["sizePreset", "size", "model.size", "size_preset", "model.size_preset"] as const;

/** The same list for a draft switch, which Pruna P-Video-2 prices at 60 percent. */
export const DRAFT_INPUT_NAMES = ["draft", "model.draft"] as const;

/**
 * Wire input names that can carry the clip length when the model has no
 * duration role. Kling is the case that matters: `KlingTextToVideoNode` hides
 * both the length and the model version inside one `mode` combo, so a price
 * tier keyed on `duration` alone would quote every clip at the shortest length.
 */
export const DURATION_INPUT_NAMES = ["mode", "model.mode", "duration", "model.duration", "duration_seconds", "model.duration_seconds", "video_length"] as const;

/** Seconds spelled inside a value: "pro mode / 10s duration / kling-v2-5-turbo", "10s", "10". */
export function secondsInValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const labelled = /(\d+(?:\.\d+)?)\s*s(?:ec|econds?)?\b/i.exec(value);
  if (labelled !== null) return Number(labelled[1]);
  const bare = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
  return bare === null ? null : Number(bare[1]);
}

/**
 * Rough time estimate for a generation. The figures are round guesses, not
 * measurements; the high end is twice the base.
 */
export function estimateSeconds(kind: AssetKind, model: string, params: EstimateParams = {}): TimeEstimate {
  let base: number;
  if (kind === "image") {
    const size = params.sizePreset ? parseSizePreset(params.sizePreset) : null;
    const big = size !== null && Math.max(size.width, size.height) >= 1600;
    base = big ? 40 : 20;
  } else {
    const info = (VIDEO_MODEL_INFO as Record<string, VideoModelInfo | undefined>)[model] ?? null;
    const seedance2 = info ? info.node === "ByteDance2TextToVideoNode" : /^Seedance 2/.test(model);
    const seconds = typeof params.duration === "number" && params.duration > 0 ? params.duration : (info?.defaultDuration ?? 5);
    base = seedance2 ? 60 + 10 * seconds : 10 + 5 * seconds;
    // Read through a WxH preset too, so a model that names its sizes in pixels
    // is not quoted the 720p time for a 4K clip. Compare tier *heights*, never
    // tier names, so a new tier such as 1440p still doubles the estimate.
    if (tierHeight(requestTier(params)) >= 1080) base *= 2;
  }
  const count = typeof params.count === "number" && params.count > 1 ? Math.floor(params.count) : 1;
  base *= count;
  return { low: Math.round(base), high: Math.round(base * 2) };
}

// ---------- what a generation costs ----------
//
// Comfy Cloud bills in credits. 211 credits are one US dollar (CREDITS_PER_USD
// in Comfy's own frontend, and the same factor inline in the ComfyUI backend),
// so every credit figure here converts to money with one constant and the
// plugin shows both.
//
// The per model numbers below are Comfy's published prices. Nothing is
// guessed: a shape with no published price and no observation returns null
// and confidence "unknown", and the UI says "cost unknown".

/** Credits in one US dollar. Comfy's `CREDITS_PER_USD`. */
export const CREDITS_PER_USD = 211;
/** US dollars one credit is worth. The default of the `creditRate` setting. */
export const DEFAULT_CREDIT_RATE = 1 / CREDITS_PER_USD;

/**
 * How much to trust a credit figure.
 * - `measured`: billing events of exactly this shape on this account.
 * - `published`: Comfy's own price badge for the model.
 * - `inferred`: derived from a different shape, for example a published per
 *   token rate applied to a length and resolution this account has never run.
 * - `unknown`: nothing to go on. `credits` is null.
 *
 * The zod enum is declared above, next to the RPC contract that uses it.
 */
export interface CostEstimate {
  credits: number | null;
  confidence: CostConfidence;
}

/** Dollars for a number of credits at a rate in USD per credit. Null when the rate is unknown. */
export function usdForCredits(credits: number | null, rate: number | null | undefined): number | null {
  if (credits === null || rate === null || rate === undefined || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.round(credits * rate * 10000) / 10000;
}

export function roundCredits(credits: number): number {
  return Math.round(credits * 100) / 100;
}

/** Credits as the UI and the CLI write them: at most two decimals, no trailing zeros. */
export function formatCredits(credits: number): string {
  return String(roundCredits(credits));
}

/**
 * Dollars as the UI writes them: two decimals down to a cent, four below it so
 * a $0.003 charge is not "$0.00". Rounds half up by hand, because toFixed
 * follows the binary value and turns $0.045 into "0.04".
 */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${(Math.round(usd * 10000) / 10000).toFixed(4)}`;
  return `$${(Math.round(usd * 100) / 100).toFixed(2)}`;
}

// ---------- images ----------

/** Comfy bills images by pixel count, not by aspect ratio: every 1K preset costs the same. */
export const IMAGE_TIERS = ["1K", "2K", "3K", "4K"] as const;
export type ImageTier = (typeof IMAGE_TIERS)[number];

/** Megapixels of a size preset, or null when it cannot be parsed. */
export function megapixels(sizePreset: string | null | undefined): number | null {
  const size = typeof sizePreset === "string" ? parseSizePreset(sizePreset) : null;
  return size === null ? null : (size.width * size.height) / 1_000_000;
}

/**
 * Tier of a size preset, from its "(2K)" prefix or, failing that, its pixel
 * count. Only a sample key: the price itself steps at 2.61 MP, not here. The
 * longest edge cannot tell the tiers apart (the 3K 21:9 preset is wider than
 * the 4K 1:1 one), so this counts megapixels.
 */
export function imageTier(sizePreset: string | null | undefined): ImageTier | null {
  if (typeof sizePreset !== "string" || sizePreset.trim() === "") return null;
  const tagged = /\(([1-4])K\)/.exec(sizePreset);
  if (tagged) return `${tagged[1]}K` as ImageTier;
  const mp = megapixels(sizePreset);
  if (mp === null) return null;
  if (mp <= 2) return "1K";
  if (mp <= 6.5) return "2K";
  if (mp <= 12) return "3K";
  return "4K";
}

export interface ImagePrice {
  /** Credits for one image at or below `breakMegapixels`. */
  credits: number;
  /** Credits above the break. Absent on the models that charge one price at every size. */
  largeCredits?: number;
  /** Where the price steps up. Only Seedream 5.0 Pro has a step. */
  breakMegapixels?: number;
  confidence: CostConfidence;
  /** Where the number comes from, in one sentence. Printed by the CLI and the skill. */
  note: string;
}

/** Credits per image, from Comfy's published price badges. */
export const IMAGE_PRICES: Record<string, ImagePrice> = {
  "seedream 5.0 pro": {
    credits: 9.5,
    largeCredits: 18.99,
    breakMegapixels: 2.61,
    confidence: "published",
    note: "9.50 credits ($0.045) up to 2.61 MP, 18.99 ($0.09) above it. Comfy's published figures.",
  },
  "seedream 5.0 lite": {
    credits: 7.39,
    confidence: "published",
    note: "7.39 credits ($0.035) per image at every size, so a 4K image costs the same as a 1K one. Comfy's published figure.",
  },
  "seedream-4-5-251128": { credits: 8.44, confidence: "published", note: "8.44 credits ($0.04) per image at every size. Comfy's published price." },
  "seedream-4-0-250828": { credits: 6.33, confidence: "published", note: "6.33 credits ($0.03) per image at every size. Comfy's published price." },
};


// ---------- videos ----------
//
// Comfy bills video per million tokens, where
//   tokens = frames x width x height / 1024,  frames = duration x fps + 1
// so the cost is linear in length and scales with pixels. The trailing frame
// is counted, so a 5 s 480p clip is 121 x 864 x 480 / 1024 = 49005 tokens,
// where 121 is 5 x 24 + 1.

/** Frames per second Seedance renders. */
export const VIDEO_FPS = 24;

/** Pixels Seedance renders at each tier, 16:9. */
export const VIDEO_FRAME: Record<VideoResolution, { width: number; height: number }> = {
  "480p": { width: 864, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "4k": { width: 3840, height: 2160 },
};

/** Tokens Comfy bills for one clip: one frame more than the duration alone would give. */
export function videoTokens(resolution: VideoResolution, seconds: number): number {
  const frame = VIDEO_FRAME[resolution] ?? VIDEO_FRAME["480p"];
  return ((seconds * VIDEO_FPS + 1) * frame.width * frame.height) / 1024;
}

export interface VideoPrice {
  /** USD per million tokens: one number, or one per resolution when the model's badge varies. */
  usdPerMillionTokens: number | Partial<Record<VideoResolution, number>>;
  /** Seedance 1.5 Pro doubles its rate when it generates audio. */
  audioMultiplier?: number;
  confidence: CostConfidence;
  note: string;
}

/** Comfy's published per token rates, from the price badges on the partner nodes. */
export const VIDEO_PRICES: Record<string, VideoPrice> = {
  "seedance-1-0-pro-fast-251015": {
    usdPerMillionTokens: 1.0,
    confidence: "published",
    note: "$1.00 per million tokens: about 2.05 credits per second at 480p, 10.25 at 1080p.",
  },
  "seedance-1-5-pro-251215": {
    usdPerMillionTokens: 1.2,
    audioMultiplier: 2,
    confidence: "published",
    note: "$1.20 per million tokens, doubled to $2.40 with an audio track: about 2.46 credits per second at 480p, silent, and 12.31 at 1080p.",
  },
  "seedance-1-0-pro-250528": { usdPerMillionTokens: 2.5, confidence: "published", note: "$2.50 per million tokens: about 5.13 credits per second at 480p, 25.64 at 1080p." },
  "Seedance 2.0 Fast": {
    usdPerMillionTokens: 8.008,
    confidence: "published",
    note: "$8.008 per million tokens: about 16.42 credits per second at 480p, 36.5 at 720p.",
  },
  "Seedance 2.0": {
    usdPerMillionTokens: { "480p": 10.01, "720p": 10.01, "1080p": 11.011, "4k": 5.72 },
    confidence: "published",
    note: "$10.01 per million tokens at 480p and 720p, $11.011 at 1080p, $5.72 at 4k: about 20.53 credits per second at 480p and 112.91 at 1080p.",
  },
  "Seedance 2.5": {
    usdPerMillionTokens: { "480p": 15.301, "720p": 15.301, "1080p": 16.731 },
    confidence: "published",
    note: "$15.301 per million tokens at 480p and 720p, $16.731 at 1080p: about 31.38 credits per second at 480p and 171.57 at 1080p. A 5 s 1080p clip is about 865 credits, roughly 90 images. No 4k rate is published.",
  },
};

function videoRate(price: VideoPrice, resolution: VideoResolution): number | null {
  const rate = typeof price.usdPerMillionTokens === "number" ? price.usdPerMillionTokens : price.usdPerMillionTokens[resolution];
  return typeof rate === "number" && rate > 0 ? rate : null;
}

/** Credits per second of video at one resolution, for a model's capability line. Null when unpriced. */
export function creditsPerSecond(model: string, resolution: VideoResolution = "480p", withAudio = false): number | null {
  const price = VIDEO_PRICES[model];
  if (!price) return null;
  const rate = videoRate(price, resolution);
  if (rate === null) return null;
  const multiplier = withAudio && price.audioMultiplier ? price.audioMultiplier : 1;
  // Per second of a longer clip, so the extra frame does not dominate.
  const perSecond = (videoTokens(resolution, 10) - videoTokens(resolution, 0)) / 10;
  return roundCredits((perSecond / 1_000_000) * rate * multiplier * CREDITS_PER_USD);
}

// ---------- pricing any model in the registry ----------
//
// The tables above price the four legacy Seedream and six Seedance models
// from Comfy's published figures for those shapes. Every
// other model carries a `ModelPrice` from models.overrides.ts, normalised from
// the vendor documentation in qa/model-docs. `priceCredits` is the one place
// that turns such a price plus a request into a number of credits.

/** Pixels of a request, from its preset or its width and height. Null when neither is known. */
export function requestPixels(params: EstimateParams): number | null {
  const preset = typeof params.sizePreset === "string" ? parseSizePreset(params.sizePreset) : null;
  if (preset !== null) return preset.width * preset.height;
  if (typeof params.width === "number" && typeof params.height === "number" && params.width > 0 && params.height > 0) return params.width * params.height;
  return null;
}

/** Normalised resolution string, so "720P" and "720p" match the same tier. */
function normaliseTierValue(value: string): string {
  return value.trim().toLowerCase();
}

/** The standard tier heights, cheapest first. A size names the largest tier its short edge reaches. */
const TIER_HEIGHTS = [360, 480, 720, 1080, 1440, 2160] as const;

/**
 * A video tier name a price can be keyed on ("720p", "4k"), or null when the
 * text is not one. "1K" and "2K" are image tiers and deliberately excluded: an
 * image's price steps by megapixels, not by a short edge.
 */
function videoTierName(value: string): string | null {
  const text = normaliseTierValue(value);
  if (text === "4k" || text === "uhd" || text === "2160p") return "2160p";
  const match = /^(\d{3,4})p$/.exec(text);
  return match === null ? null : `${Number(match[1])}p`;
}

/**
 * The tier a pixel size belongs to: the largest standard height its short edge
 * reaches, so 1280x720 and 720x1280 are both "720p" and 3840x2160 is "2160p".
 * This is what lets a price keyed on "4k" match a model that spells its sizes
 * as WxH presets (LTX-2.5 offers "3840x2160", which contains no "4k").
 */
/** The pixel height a tier name stands for, or 0 when the text is not a tier. */
function tierHeight(tier: string | null): number {
  if (tier === null) return 0;
  const match = /^(\d{3,4})p$/.exec(normaliseTierValue(tier));
  return match === null ? 0 : Number(match[1]);
}

export function tierOfPixels(width: number, height: number): string | null {
  const edge = Math.min(width, height);
  if (!Number.isFinite(edge) || edge <= 0) return null;
  let tier: number | null = null;
  for (const height of TIER_HEIGHTS) if (edge >= height) tier = height;
  return tier === null ? null : `${tier}p`;
}

/** The tier a request asks for, from its resolution or, failing that, its pixels. */
function requestTier(params: EstimateParams): string | null {
  if (typeof params.resolution === "string") {
    const named = videoTierName(params.resolution);
    if (named !== null) return named;
  }
  if (typeof params.sizePreset === "string") {
    const named = videoTierName(params.sizePreset);
    if (named !== null) return named;
  }
  const size = typeof params.sizePreset === "string" ? parseSizePreset(params.sizePreset) : null;
  if (size !== null) return tierOfPixels(size.width, size.height);
  if (typeof params.width === "number" && typeof params.height === "number") return tierOfPixels(params.width, params.height);
  return null;
}

/** True when one `when` clause of a price tier holds for a request. */
function tierMatches(tier: PriceTier, params: EstimateParams, seconds: number): boolean {
  const pixels = requestPixels(params);
  for (const [name, want] of Object.entries(tier.when)) {
    switch (name) {
      case "resolution":
      case "tier": {
        const have = typeof params.resolution === "string" ? params.resolution : null;
        const alt = typeof params.sizePreset === "string" ? params.sizePreset : null;
        const wanted = normaliseTierValue(String(want));
        if (have !== null && normaliseTierValue(have) === wanted) break;
        if (alt !== null && normaliseTierValue(alt).includes(wanted)) break;
        // A tier keyed by name against a model that speaks in pixels: "4k" is
        // nowhere in "3840x2160", so both sides are reduced to a tier and
        // compared. Only video tiers, so an image's "2K" is untouched.
        const named = videoTierName(String(want));
        if (named !== null && named === requestTier(params)) break;
        return false;
      }
      case "audio":
        if ((params.generateAudio === true) !== (want === true)) return false;
        break;
      case "draft":
        if ((params.draft === true) !== (want === true)) return false;
        break;
      case "duration":
        if (Math.round(seconds) !== Math.round(Number(want))) return false;
        break;
      case "quality":
        if (typeof params.quality !== "string" || normaliseTierValue(params.quality) !== normaliseTierValue(String(want))) return false;
        break;
      case "size": {
        const have = typeof params.sizePreset === "string" ? params.sizePreset : null;
        const size = have === null ? (typeof params.width === "number" && typeof params.height === "number" ? `${params.width}x${params.height}` : null) : have;
        if (size === null || !normaliseTierValue(size).includes(normaliseTierValue(String(want)))) return false;
        break;
      }
      case "minPixels":
        if (pixels === null || pixels < Number(want)) return false;
        break;
      case "maxPixels":
        if (pixels === null || pixels > Number(want)) return false;
        break;
      default:
        // An unknown `when` name cannot be checked, so the tier cannot be used.
        return false;
    }
  }
  return true;
}

/** Seconds a request asks for, defaulting to 5 the way the estimate does elsewhere. */
function requestSeconds(params: EstimateParams, fallback = 5): number {
  return typeof params.duration === "number" && params.duration > 0 ? Math.round(params.duration) : fallback;
}

/**
 * Credits one request costs at a registry price, or null when the price does
 * not cover the shape. `count` multiplies whole runs; `extraCredits` is for the
 * models that charge less for the second output of a single call.
 */
/** The tier a request falls in: the most specific `when` that holds, or null. */
function bestTier(price: ModelPrice, params: EstimateParams, seconds: number): PriceTier | null {
  let best: PriceTier | null = null;
  let bestKeys = -1;
  for (const tier of price.tiers ?? []) {
    const keys = Object.keys(tier.when).length;
    if (keys > bestKeys && tierMatches(tier, params, seconds)) {
      best = tier;
      bestKeys = keys;
    }
  }
  return best;
}

/**
 * True when the vendor publishes a span for this shape rather than a figure, so
 * the number `priceCredits` returns is the low end and not a quote. GPT Image
 * bills on tokens and the token count follows the size the model decides to
 * return, which is why its own record carries a range on every quality tier.
 */
function isSpan(price: ModelPrice, kind: AssetKind, params: EstimateParams): boolean {
  // A reference the vendor prices as a span makes the whole quote a floor, so
  // the surfaces say "about" even where the shape itself has an exact figure.
  const refs = billedReferences(price, params);
  if (refs !== null && refs > 0 && price.reference?.creditsMax !== undefined) return true;
  const tier = bestTier(price, params, requestSeconds(params, kind === "video" ? 5 : 1));
  return tier === null ? price.creditsRange !== undefined : tier.creditsRange !== undefined;
}

export function priceCredits(price: ModelPrice, kind: AssetKind, params: EstimateParams = {}): number | null {
  // "auto" hands the length to the model after the quote. On a price per second
  // or per token the length is the bill, so there is no honest figure to give:
  // Pruna P-Video-2 can return anything from 1 to 20 seconds.
  if (params.durationAuto === true && price.unit !== "per-image" && price.unit !== "per-run" && price.unit !== "per-video") return null;
  const seconds = requestSeconds(params, kind === "video" ? 5 : 1);
  let rate = price.credits;
  let base = price.baseCredits;
  if (price.tiers && price.tiers.length > 0) {
    const best = bestTier(price, params, seconds);
    // Tiers that cover the whole model and no match means the shape has no price.
    if (best === null && price.credits === null) return null;
    if (best !== null) {
      rate = best.credits;
      base = best.baseCredits ?? undefined;
    }
  }
  if (rate === null || !Number.isFinite(rate)) return null;

  let credits: number;
  switch (price.unit) {
    case "per-second":
      credits = base === undefined ? rate * seconds : base + rate * Math.max(0, seconds - 1);
      break;
    case "per-run":
    case "per-video":
      credits = rate;
      break;
    case "per-image":
      credits = rate;
      if (price.perExtraMegapixelCredits !== undefined) {
        const pixels = requestPixels(params);
        if (pixels !== null) credits += price.perExtraMegapixelCredits * Math.max(0, Math.ceil(pixels / 1_048_576) - 1);
      }
      break;
    case "per-1m-tokens":
    case "per-1k-tokens": {
      // Token billed video: tokens = (duration x fps + 1) x width x height / 1024,
      // the formula Comfy's Seedance billing uses.
      const resolution = typeof params.resolution === "string" ? (params.resolution.toLowerCase() as VideoResolution) : null;
      if (resolution === null || !(resolution in VIDEO_FRAME)) return null;
      const perMillion = price.unit === "per-1k-tokens" ? rate * 1000 : rate;
      credits = (videoTokens(resolution, seconds) / 1_000_000) * perMillion;
      break;
    }
    default:
      return null;
  }

  // A reference image is billed, and on a cheap shape it can cost more than the
  // generation: on gpt-image-2 at quality low one reference costs more than
  // the image itself. **A model whose price says nothing about references refuses
  // to quote rather than quoting the text only figure.** A caller may check the
  // estimate against a spending limit, so a confident wrong number could carry a
  // batch past that limit unseen, while a missing one is visibly missing.
  const refs = billedReferences(price, params);
  if (refs === null) return null;
  if (refs > 0) credits += (price.reference?.credits ?? 0) * refs;

  const count = typeof params.count === "number" && params.count > 1 ? Math.floor(params.count) : 1;
  if (count > 1) {
    credits = price.extraCredits !== undefined && price.unit === "per-image" ? credits + price.extraCredits * (count - 1) : credits * count;
  }
  return roundCredits(credits);
}

/**
 * How many of a request's reference images are billed, 0 when it has none, or
 * null when it has some and the price cannot say what they cost.
 */
function billedReferences(price: ModelPrice, params: EstimateParams): number | null {
  const asked = typeof params.references === "number" && params.references > 0 ? Math.floor(params.references) : 0;
  if (asked === 0) return 0;
  if (price.reference === undefined) return null;
  return Math.max(0, asked - (price.reference.included ?? 0));
}

// ---------- the estimate ----------

/** Seconds an asset's stored params spell out in one of their extras, or null. */
function secondsInParams(params: Params): number | null {
  for (const name of DURATION_INPUT_NAMES) {
    const seconds = secondsInValue(params[name]);
    if (seconds !== null) return seconds;
  }
  return null;
}

/**
 * The estimate inputs held in an asset's params. One place, so the runner, the
 * CLI, the Jobs rows and the Viewer all key an estimate the same way.
 */
export function estimateParamsOf(asset: {
  params?: Params | null;
  kind?: AssetKind;
  /**
   * The stored row's own dimensions, which are the file's and are therefore the
   * truth about what was made. Used only where the params do not say: a queued
   * row has no file yet, so the live estimate still comes from the request.
   */
  width?: number | null;
  height?: number | null;
}): EstimateParams {
  const params = asset.params ?? {};
  return {
    sizePreset: SIZE_INPUT_NAMES.map((name) => params[name]).find((value): value is string => typeof value === "string" && value !== "") ?? null,
    resolution: typeof params.resolution === "string" ? params.resolution : null,
    // A model with no duration role can still be spelling the length inside an
    // extra, and a price tier keyed on `duration` has to see it.
    duration: typeof params.duration === "number" ? params.duration : secondsInParams(params),
    generateAudio: typeof params.generateAudio === "boolean" ? params.generateAudio : null,
    // A model with no preset list prices by its own pixel size, one that
    // batches charges per image, and Ideogram and GPT Image price by a quality
    // tier that lives in an extra. Without these three the row the server
    // stores would quote a different number from the one the form showed.
    width: typeof params.width === "number" ? params.width : typeof asset.width === "number" ? asset.width : null,
    height: typeof params.height === "number" ? params.height : typeof asset.height === "number" ? asset.height : null,
    count: typeof params.count === "number" ? params.count : null,
    // `quality` is the name the plugin records, but a row built by
    // `run_workflow` keeps the graph's own input names, so those count too.
    quality: QUALITY_INPUT_NAMES.map((name) => params[name]).find((value): value is string => typeof value === "string" && value !== "") ?? null,
    references: typeof params.referenceCount === "number" ? params.referenceCount : null,
    draft: DRAFT_INPUT_NAMES.map((name) => params[name]).find((value): value is boolean => typeof value === "boolean") ?? null,
    // A graph sent through run_workflow can carry "auto" where the plugin's own
    // form only ever sends a number of seconds.
    durationAuto: DURATION_INPUT_NAMES.some((name) => typeof params[name] === "string" && (params[name] as string).trim().toLowerCase() === "auto") ? true : null,
  };
}

/**
 * Credits the cheapest complete generation this price allows, for sorting a
 * catalog whose models are priced in five different units.
 *
 * Every tier is quoted through `priceCredits` with its own `when` values rather
 * than read as a number, because on a per second or per 1000 tokens price the
 * tier holds a **rate**, not the cost of a generation, and a rate read as a
 * cost would sort the dearest video models first.
 *
 * `floorShape` is the base every caller passes, so the picker's order, the
 * figure it prints beside it and `bb comfy models` are one number.
 */
export function floorShape(capabilities: ModelCapabilities, defaults: ModelDefaults): EstimateParams {
  return {
    sizePreset: defaults.sizePreset,
    resolution: capabilities.resolutions[0] ?? null,
    // A model with no length control still returns a length, and on a per
    // second price that is what the cheapest real clip costs. The fallback
    // prices Gemini Omni Flash 1.1 at the ten seconds one click buys, not at
    // five.
    duration: capabilities.duration?.min ?? capabilities.promptDurationDefault ?? null,
    width: defaults.width,
    height: defaults.height,
  };
}

export function floorCredits(price: ModelPrice, kind: AssetKind, base: EstimateParams = {}): number | null {
  const quotes: number[] = [];
  const add = (params: EstimateParams): void => {
    const value = priceCredits(price, kind, params);
    if (value !== null && Number.isFinite(value)) quotes.push(value);
  };
  add(base);
  for (const tier of price.tiers ?? []) {
    const when = tier.when as Record<string, unknown>;
    const shape: EstimateParams = { ...base };
    if (typeof when.resolution === "string") shape.resolution = when.resolution;
    if (typeof when.tier === "string") shape.resolution = when.tier;
    if (typeof when.size === "string") shape.sizePreset = when.size;
    if (typeof when.quality === "string") shape.quality = when.quality;
    if (typeof when.duration === "number") shape.duration = when.duration;
    if (typeof when.audio === "boolean") shape.generateAudio = when.audio;
    if (typeof when.draft === "boolean") shape.draft = when.draft;
    add(shape);
  }
  return quotes.length === 0 ? null : Math.min(...quotes);
}

/** One shape of generation: the key of the cost_samples table. */
export function costSignature(kind: AssetKind, model: string, params: EstimateParams = {}): string {
  // Any reference image changes the shape. "Beyond the first" is right for
  // Seedream, whose base price covers one, and wrong for GPT Image, which bills
  // from the first: a text only run and a run with one reference are different
  // shapes, not noisy samples of the same one. Absent, this adds nothing and
  // the signature is the plain one. `resignCostSamples` moves any sample whose
  // signature changed at the next service start.
  const references = typeof params.references === "number" && params.references > 0 ? `|${params.references}ref` : "";
  if (kind === "image") {
    // A quality tier changes the price by up to ten times, so it is part of the
    // shape whether or not the model also has a size preset.
    const quality = typeof params.quality === "string" && params.quality !== "" ? `|${params.quality.toLowerCase()}` : "";
    const tier = imageTier(params.sizePreset);
    if (tier !== null) return `image|${model}|${tier}${quality}${references}`;
    // Models with no preset list carry their own pixel size instead.
    const pixels = requestPixels(params);
    const size = pixels === null ? (params.resolution ?? "unknown") : `${params.width}x${params.height}`;
    return `image|${model}|${size}${quality}${references}`;
  }
  const info = (VIDEO_MODEL_INFO as Record<string, VideoModelInfo | undefined>)[model];
  const seconds = typeof params.duration === "number" && params.duration > 0 ? Math.round(params.duration) : (info?.defaultDuration ?? 5);
  // A draft bills at a different rate, and an "auto" length is not the five
  // second default, so neither may teach the shape a plain request is quoted by.
  const length = params.durationAuto === true ? "auto" : `${seconds}s`;
  const draft = params.draft === true ? "|draft" : "";
  return `video|${model}|${params.resolution ?? "480p"}|${length}${draft}${references}`;
}

export interface ObservedCost {
  /** Median of the most recent samples of this signature. */
  credits: number;
  samples: number;
}

/** What the plugin has learned from its own bills. `observedCredits` in store.ts implements it. */
export type ObservedLookup = (signature: string) => ObservedCost | null;

/** Two bills of the same shape are enough to trust this account over the price list. */
export const MEASURED_SAMPLE_MIN = 2;

/**
 * Credits a generation is expected to cost, and how much the number is worth.
 *
 * Pass `observed` (the store's `observedCredits`) and this account's own
 * billing history wins once it has seen the same shape twice, which keeps the
 * estimate right when Comfy moves a price.
 */
export function estimateCredits(kind: AssetKind, model: string, params: EstimateParams = {}, observed?: ObservedLookup, registryPrice?: ModelPrice | null): CostEstimate {
  const count = typeof params.count === "number" && params.count > 1 ? Math.floor(params.count) : 1;

  if (observed) {
    const seen = observed(costSignature(kind, model, params));
    if (seen && seen.samples >= MEASURED_SAMPLE_MIN && Number.isFinite(seen.credits) && seen.credits > 0) {
      return { credits: roundCredits(seen.credits * count), confidence: "measured" };
    }
  }

  /**
   * The two legacy tables predate reference images and say nothing about them,
   * so a reference run on one of the ten legacy ids would be quoted at its
   * text only price: Seedream is the default image model and bills 0.63 for
   * every reference past the first. References are priced from the registry
   * wherever the estimate came from, and a request that carries one with no
   * figure anywhere is refused a quote rather than quoted low.
   */
  function withReferences(estimate: CostEstimate): CostEstimate {
    const asked = typeof params.references === "number" && params.references > 0 ? Math.floor(params.references) : 0;
    if (asked === 0) return estimate;
    const reference = registryPrice?.reference;
    if (reference === undefined) return { credits: null, confidence: "unknown" };
    if (estimate.credits === null) return estimate;
    const billed = Math.max(0, asked - (reference.included ?? 0));
    if (billed === 0) return estimate;
    // Adding a reference surcharge to the base makes the total an inference.
    return { credits: roundCredits(estimate.credits + reference.credits * billed * count), confidence: "inferred" };
  }

  /** Anything the two legacy tables do not cover falls through to the registry price. */
  function fromRegistry(): CostEstimate {
    if (!registryPrice) return { credits: null, confidence: "unknown" };
    const credits = priceCredits(registryPrice, kind, params);
    if (credits === null) return { credits: null, confidence: "unknown" };
    // A published rate applied to a shape we have never run is inferred, not published.
    const confidence: CostConfidence = registryPrice.unit === "per-image" ? registryPrice.confidence : "inferred";
    // A published span is a floor, not a quote: GPT Image bills on tokens and
    // the token count follows the size the model decides to return. Asked for
    // "auto" it can return an odd size and bill above the published figure, so
    // the figure has to carry an "about" rather than read as the price.
    return { credits, confidence: isSpan(registryPrice, kind, params) ? "inferred" : confidence };
  }

  if (kind === "image") {
    const price = IMAGE_PRICES[model];
    if (!price) return fromRegistry();
    const mp = megapixels(params.sizePreset);
    if (price.largeCredits !== undefined && price.breakMegapixels !== undefined) {
      if (mp === null) return fromRegistry();
      const each = mp > price.breakMegapixels ? price.largeCredits : price.credits;
      return withReferences({ credits: roundCredits(each * count), confidence: price.confidence });
    }
    return withReferences({ credits: roundCredits(price.credits * count), confidence: price.confidence });
  }

  const price = VIDEO_PRICES[model];
  if (!price) return fromRegistry();
  const info = (VIDEO_MODEL_INFO as Record<string, VideoModelInfo | undefined>)[model];
  const seconds = typeof params.duration === "number" && params.duration > 0 ? Math.round(params.duration) : (info?.defaultDuration ?? 5);
  const resolution = (params.resolution ?? "480p") as VideoResolution;
  // A resolution the model does not offer has no price, whatever the formula says.
  if (info && !info.resolutions.includes(resolution)) return { credits: null, confidence: "unknown" };
  const rate = videoRate(price, resolution);
  if (rate === null) return { credits: null, confidence: "unknown" };
  const multiplier = params.generateAudio === true && price.audioMultiplier ? price.audioMultiplier : 1;
  const credits = (videoTokens(resolution, seconds) / 1_000_000) * rate * multiplier * CREDITS_PER_USD * count;
  return withReferences({ credits: roundCredits(credits), confidence: price.confidence === "published" ? "inferred" : price.confidence });
}

/** One sentence about where a model's price comes from, or null when we have none. */
export function costNote(kind: AssetKind, model: string, registryPrice?: ModelPrice | null): string | null {
  const price = kind === "image" ? IMAGE_PRICES[model] : VIDEO_PRICES[model];
  if (price) return price.note;
  if (registryPrice) return registryPrice.note;
  return `No published price and no billing event yet for ${model}.`;
}
