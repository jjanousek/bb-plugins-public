// bb-plugin-comfy-cloud: backend entry. Wiring only.
//
// Settings, key resolution (key.ts), SQLite (store.ts), the Comfy Cloud
// client (comfy.ts), graph builders (workflows.ts), the job loop (runner.ts),
// the RPC handlers of contract.ts, the comfy_* agent tools and the `bb comfy`
// CLI. The API key is read server side on every generation and never leaves
// this process: not in logs, RPC, CLI, tool output, realtime or stored JSON.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi, PluginAgentToolResult, PluginCliResult, PluginHttpHandler } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  COMFY_CHANNEL,
  CREDITS_PER_USD,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  assetKindSchema,
  assetStatusSchema,
  estimateCredits,
  IMAGE_MODELS,
  QUALITY_INPUT_NAMES,
  VIDEO_MODELS,
  estimateParamsOf,
  floorCredits,
  formatCredits,
  registryAge,
  registryAgeLine,
  registryStaleNote,
  formatUsd,
  imageModelSchema,
  rpcContract,
  usdForCredits,
  videoModelSchema,
  workflowSchema,
  type Asset,
  type AssetKind,
  type AssetSource,
  type CostEstimate,
  type Costs,
  type GenerateImageInput,
  type ModelsResult,
  type GenerateVideoInput,
  type ImageModel,
  type JsonValue,
  type NodeInfo,
  type Params,
  type RunWorkflowInput,
  type Status,
  type VideoModel,
  type Workflow,
} from "./contract";
import { createComfyClient, errorText, sanitize } from "./comfy";
import { derivativePath } from "./thumbs";
import { MEDIA_ROUTE, mediaVersion, serveMedia } from "./media";
import { guarded } from "./timers";
import { CONFIGURE_HINT, resolveKey, type ResolvedKey } from "./key";
import { FAVOURITES_KEY, MIGRATIONS, RECENT_KEY, RECENT_LIMIT, chosenKey, createStore, isTerminal, newAssetId, type ListFilter } from "./store";
import { createRunner, readWorkflowFile, type VideoProbe } from "./runner";
import {
  MAX_SEED,
  buildWorkflow,
  capPrompt,
  clampImageNodes,
  inspectWorkflow,
  randomSeed,
  resolveImageSpec,
  resolveVideoSpec,
  specParams,
  withSeed,
  type ReferenceImage,
} from "./workflows";
import {
  CATALOG_DATE,
  GENERATED_AT,
  MODEL_ENTRIES,
  assetCostSignature,
  capabilitiesOf,
  capabilityLine,
  extrasOf,
  getModel,
  listModels,
  modelSummary,
  priceForEstimate,
  priceKeyOf,
  priceLine,
  type RegistryEntry,
} from "./registry";

const DEFAULT_DATA_DIR = process.env.BB_DATA_DIR ?? path.join(os.homedir(), ".bb");
const IMAGE_WAIT_MS = 6 * 60_000;
const VIDEO_WAIT_MS = 10 * 60_000;
const CATALOG_MAX_AGE_MS = 24 * 3600_000;
const CATALOG_CHECK_MS = 60 * 60_000;
const PUBLISH_THROTTLE_MS = 300;
const CLI_MAX_ROWS = 200;
/** The server's own time zone; CLI and agent-tool times are printed in it. */
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** How long a credit balance is served from memory before it is fetched again. */
const BALANCE_MAX_AGE_MS = 60_000;
/** Deadline for the one balance fetch a status call may wait on. */
const BALANCE_WAIT_MS = 8_000;
/** How long a waiting CLI command or agent tool gives Comfy to settle the charge. */
const COST_WAIT_MS = 20_000;
/** Default window of `bb comfy costs` and the costs RPC. */
const COSTS_DEFAULT_DAYS = 30;
const COSTS_RECENT_ROWS = 50;
/** Completed assets the one-time cost backfill looks at, newest first. */
const BACKFILL_MAX_ASSETS = 200;
/** Biggest reference image the plugin will upload. Comfy Cloud has its own limit; this one is ours. */
const REFERENCE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Image files a reference may be. The bytes are what Comfy Cloud stores, so the
 * extension is only a sanity check on what the caller pointed at: a text file
 * uploads happily and then fails inside the model.
 */
const REFERENCE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;

/** The directory of the loaded server module and its parent (dist/ loads live one level below the plugin root). */
function defaultPluginDirs(): string[] {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    return [dir, path.dirname(dir)];
  } catch {
    return [];
  }
}

/** Folder holding the plugin's own artwork masks, built by scripts/make-art.mjs. */
export const ART_FOLDER = path.join("assets", "art");

/**
 * Keys for the two "default model" selects. A host select takes plain strings
 * with no per-option label, so the recommended models come first and the panel's
 * picker is where friendly names live. The shipped defaults are always in the
 * list, so an existing setting never becomes invalid.
 */
/**
 * Every name an asset row can carry, mapped to its friendly label: the registry
 * key, the bare model id, and the legacy ids that resolve to an entry. Built
 * once at load, because it never changes between reloads.
 */
export const MODEL_LABELS: Record<string, string> = (() => {
  // "(legacy node)" tells two picker rows apart. An asset row is not a choice
  // between nodes, so it gets the model's own name.
  const plain = (entry: RegistryEntry): string => entry.label.replace(/\s*\((?:legacy|superseded)(?: node)?\)$/i, "");
  const labels: Record<string, string> = {};
  const bare = new Set<string>();
  for (const entry of MODEL_ENTRIES) {
    labels[entry.key] = plain(entry);
    for (const name of [entry.modelId, ...entry.aliases]) if (name !== null) bare.add(name);
  }
  // A bare id several nodes offer is named by the entry `resolveModelKey` would
  // pick, not by whichever node the catalog happens to list first: "Seedance
  // 2.0" is the text-to-video model, not the first-and-last-frame node's.
  for (const name of bare) {
    if (labels[name] !== undefined) continue;
    const entry = getModel(name);
    if (entry !== null) labels[name] = plain(entry);
  }
  return labels;
})();

export function settingOptions(kind: AssetKind): string[] {
  const shipped = kind === "image" ? DEFAULT_IMAGE_MODEL : DEFAULT_VIDEO_MODEL;
  // The ten bare legacy ids come first. A select setting only stores one of the
  // strings it offers, so leaving them out would make the host reject a setting
  // that holds a bare id and fall back to the shipped default. They resolve
  // through `MODEL_ALIASES`.
  const legacy = kind === "image" ? IMAGE_MODELS : VIDEO_MODELS;
  const usable = listModels({ kind });
  const recommended = usable.filter((e) => e.recommended).map((e) => e.key);
  const rest = usable.filter((e) => !e.recommended).map((e) => e.key);
  return [...new Set([shipped, ...legacy, ...recommended, ...rest])];
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * First plugin directory that actually holds `assets/art`, searched the way key.ts
 * searches for a .env: the module directory first, then its parent so a dist/ load
 * still finds the repo folder. Null when the artwork was never built.
 */
export function resolveArtDir(dirs: readonly string[], exists: (dir: string) => boolean = isDirectory): string | null {
  for (const dir of dirs) {
    const candidate = path.join(dir, ART_FOLDER);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

const timeFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: TIME_ZONE, dateStyle: "short", timeStyle: "medium" });
/** YYYY-MM-DD in the server's own zone, for the registry age lines. */
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const dayOf = (ms: number): string => dayFormat.format(new Date(ms));

const zoneFormat = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "short" });

/** Absolute time in the server's zone, e.g. "2031-05-20 14:30:00 UTC". */
function fmtTime(ms: number | null): string {
  if (ms === null) return "none";
  const zone = zoneFormat.formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? TIME_ZONE;
  return `${timeFormat.format(new Date(ms))} ${zone}`;
}

function fmtAge(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Local date folder, e.g. "2031-05-20". */
function dateFolder(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}~` : flat;
}

function dimensions(asset: Asset): string {
  const size = asset.width !== null && asset.height !== null ? `${asset.width}x${asset.height}` : "";
  const duration = asset.durationS !== null ? `${asset.durationS}s` : "";
  return [size, duration].filter(Boolean).join(", ") || "-";
}

/** Longest prompt and params text printed by the CLI and the agent tools. */
const CLI_PROMPT_MAX = 500;
const CLI_PARAMS_MAX = 300;

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}... [${text.length} chars]`;
}

/** "9.5 credits ($0.05)", or just the credits when no rate is configured. */
function creditsText(credits: number, rate: number | null): string {
  const usd = usdForCredits(credits, rate);
  return `${formatCredits(credits)} credits${usd === null ? "" : ` (${formatUsd(usd)})`}`;
}

/**
 * The cost line of `bb comfy show`: what it was expected to cost, what it was
 * billed, and the gap between them. Empty when neither number exists.
 */
export function costLine(asset: Asset, rate: number | null): string | null {
  const estimated = typeof asset.estimatedCredits === "number" ? asset.estimatedCredits : null;
  const actual = typeof asset.actualCredits === "number" ? asset.actualCredits : null;
  if (estimated === null && actual === null) return null;
  const parts: string[] = [];
  if (actual !== null) parts.push(`billed ${creditsText(actual, rate)}`);
  if (estimated !== null) parts.push(`${actual === null ? "estimated " : "estimate was "}${creditsText(estimated, rate)}`);
  if (actual !== null && estimated !== null && estimated > 0) {
    const gap = actual - estimated;
    const percent = Math.round((Math.abs(gap) / estimated) * 100);
    parts.push(gap === 0 ? "exact" : `${gap > 0 ? "+" : "-"}${formatCredits(Math.abs(gap))} (${percent}% ${gap > 0 ? "over" : "under"})`);
  }
  const billed = asset.billedModel ? `, billed as ${asset.billedModel}${asset.outputTier ? ` (tier ${asset.outputTier})` : ""}` : "";
  return `cost: ${parts.join(", ")}${billed}`;
}

function describeAsset(asset: Asset, rate: number | null = null): string {
  const lines = [
    `${asset.id}: ${asset.status}${asset.error ? ` (${asset.error})` : ""}`,
    `kind: ${asset.kind}, model: ${asset.model}${asset.source !== "unknown" ? `, source: ${asset.source}` : ""}`,
    `file: ${asset.path ?? "not downloaded yet"}`,
  ];
  if (asset.status === "completed") {
    lines.push(`size: ${dimensions(asset)}${asset.mime ? `, ${asset.mime}` : ""}${asset.sizeBytes !== null ? `, ${Math.round(asset.sizeBytes / 1024)} KB` : ""}`);
  }
  const cost = costLine(asset, rate);
  if (cost) lines.push(cost);
  lines.push(`params: ${cap(JSON.stringify(asset.params), CLI_PARAMS_MAX)}`);
  lines.push(`workflow: ${asset.workflowPath}`);
  lines.push(`created: ${fmtTime(asset.createdAt)}${asset.completedAt ? `, finished: ${fmtTime(asset.completedAt)}` : ""}${asset.parentId ? `, parent: ${asset.parentId}` : ""}`);
  lines.push(`prompt: ${cap(asset.prompt, CLI_PROMPT_MAX)}`);
  return lines.join("\n");
}

/**
 * What an agent or a CLI user is told about a row whose outcome is not known
 * yet. The instruction matters more than the status: a retry here is exactly
 * the second payment the unknown state exists to prevent.
 */
function unknownText(asset: Asset): string {
  return `${asset.id} is not known yet: ${asset.error ?? "waiting to hear back from Comfy Cloud."} Do not generate it again, which could pay twice; check later with: bb comfy show ${asset.id}`;
}

function assetLine(asset: Asset): string {
  return [asset.id, asset.status.padEnd(9), asset.kind.padEnd(5), dimensions(asset).padEnd(12), fmtAge(asset.createdAt).padEnd(9), oneLine(asset.prompt || asset.model, 70)].join("  ");
}

const BOOLEAN_FLAGS = new Set(["json", "no-wait", "audio", "new-seed", "workflow", "job", "starred", "help"]);

/** `--flag value`, `--flag=value`, and known switches; the rest is positional. */
/**
 * Positional words, the last value of every flag, and every value of a flag
 * that was given more than once.
 *
 * `flags` is last wins, as for every flag here.
 * `repeated` is beside it rather than instead of it, so `--reference a
 * --reference b` reaches the reference list without changing what `--model x
 * --model y` means anywhere else.
 */
function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true>; repeated: Record<string, string[]> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const repeated: Record<string, string[]> = {};
  const remember = (name: string, value: string): void => {
    flags[name] = value;
    (repeated[name] ??= []).push(value);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--") || arg === "--") {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      remember(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      remember(name, next);
      i += 1;
    }
  }
  return { positional, flags, repeated };
}

/**
 * `--extra quality=VERY_LOW,prompt_upsampling=OFF` into the extras bag. Values
 * stay strings: the builder fits each one to the input it is going to, which
 * is the only place that knows whether "3" is a number, a boolean or a combo
 * option spelled with a digit.
 */
export function parseExtras(text: string | undefined): Record<string, string> | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  const out: Record<string, string> = {};
  for (const pair of text.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--extra takes name=value pairs separated by commas, not "${pair.trim()}".`);
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function flagString(flags: Record<string, string | true>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

/** Every value of a repeatable flag, in the order it was given. */
function flagList(repeated: Record<string, string[]>, name: string): string[] | undefined {
  const values = repeated[name]?.map((value) => value.trim()).filter((value) => value !== "");
  return values === undefined || values.length === 0 ? undefined : values;
}

function flagInt(flags: Record<string, string | true>, name: string): number | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${name} needs a number.`);
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be a whole number (got "${value}").`);
  return n;
}

const USAGE = [
  "bb comfy: image and video generation on Comfy Cloud",
  "",
  "  bb comfy image <prompt...> [--size <preset>] [--model <m>] [--reference <asset id or path>]... [--seed N] [--no-wait]",
  "  bb comfy video <prompt...> [--resolution 480p|720p|1080p|4k] [--aspect 16:9|4:3|1:1|3:4|9:16|21:9] [--duration N] [--model <m>] [--audio] [--reference <asset id or path>]... [--seed N] [--no-wait]",
  "  bb comfy run <workflow.json> [--kind image|video] [--prompt <text>] [--parent <id>] [--no-wait]   (path on the bb server's disk)",
  "  bb comfy list [--kind image|video] [--status queued|running|unknown|completed|failed|cancelled] [--starred] [--limit N] [--query text]",
  "  bb comfy show <id> [--workflow] [--job]",
  "  bb comfy retry <id> [--new-seed] [--no-wait]",
  "  bb comfy cancel <id> | star <id> | unstar <id> | delete <id>",
  "  bb comfy costs [--days N] [--json]",
  "  bb comfy status | models | sizes [--model <m>]",
  "",
  "Every command accepts --json. Waiting commands end with the absolute file path on its own line.",
  "--reference takes an asset id or an image path on the bb server and can be given more than once. Only some models accept one; bb comfy sizes says so per model.",
].join("\n");

type ToolResult = PluginAgentToolResult;

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Compact catalog entry from one raw object_info node. */
function inputType(spec: unknown): string {
  if (Array.isArray(spec)) {
    const first: unknown = spec[0];
    if (typeof first === "string") return first;
    if (Array.isArray(first) || (first && typeof first === "object")) return "COMBO";
  }
  if (typeof spec === "string") return spec;
  return "UNKNOWN";
}

function toNodeInfo(classType: string, raw: unknown): NodeInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const node = raw as {
    display_name?: unknown;
    name?: unknown;
    category?: unknown;
    output?: unknown;
    input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> };
    input_order?: { required?: unknown; optional?: unknown };
  };
  const inputs: NodeInfo["inputs"] = [];
  const seen = new Set<string>();
  const add = (group: Record<string, unknown> | undefined, order: unknown, required: boolean) => {
    if (!group || typeof group !== "object") return;
    const ordered = Array.isArray(order) ? (order.filter((n): n is string => typeof n === "string" && n in group) as string[]) : [];
    const names = [...ordered, ...Object.keys(group).filter((n) => !ordered.includes(n))];
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      inputs.push({ name, type: inputType(group[name]), required });
    }
  };
  add(node.input?.required, node.input_order?.required, true);
  add(node.input?.optional, node.input_order?.optional, false);
  const outputs = Array.isArray(node.output) ? node.output.map((o: unknown) => (typeof o === "string" ? o : Array.isArray(o) ? "COMBO" : String(o))) : [];
  const displayName =
    typeof node.display_name === "string" && node.display_name !== "" ? node.display_name : typeof node.name === "string" && node.name !== "" ? node.name : classType;
  const outputNode = (node as { output_node?: unknown }).output_node === true;
  return { classType, displayName, category: typeof node.category === "string" ? node.category : "", outputs, inputs, outputNode };
}

export interface PluginOptions {
  /** Job loop tick; the default is 3 s. Tests shorten it. */
  tickMs?: number;
  /** Fetch implementation for the Comfy client; defaults to the global fetch at call time. */
  fetch?: typeof fetch;
  /** Directories searched for a git-ignored .env; defaults to the module directory and its parent. */
  pluginDirs?: string[];
  /** Video dimension probe; defaults to ffprobe on PATH. */
  probeVideo?: (file: string) => Promise<VideoProbe | null>;
  /** bb data directory (default assets and the catalog cache live under plugins/<id>); defaults to BB_DATA_DIR or ~/.bb. */
  dataDir?: string;
}

export function createPlugin(options: PluginOptions = {}) {
  return async function plugin(bb: BbPluginApi): Promise<void> {
    const settings = bb.settings.define({
      apiKey: { type: "string", label: "API key", description: "Your Comfy Cloud API key. Leave it empty if the key file below has it.", secret: true },
      keyFile: { type: "string", label: "Key file", description: "Path to a dotenv file on the bb server holding COMFY_API_KEY.", default: "" },
      imageModel: {
        type: "select",
        label: "Default image model",
        description: "Used when a request does not name a model. Every model the picker offers is listed; `bb comfy models` spells out what each one costs.",
        options: settingOptions("image"),
        default: DEFAULT_IMAGE_MODEL,
      },
      videoModel: {
        type: "select",
        label: "Default video model",
        description: "Used when a request does not name a model. Video prices differ by two orders of magnitude; `bb comfy models --kind video` sorts them.",
        options: settingOptions("video"),
        default: DEFAULT_VIDEO_MODEL,
      },
      assetDir: { type: "string", label: "Asset folder", description: "Where generated files are kept. Empty means <bb data dir>/plugins/comfy-cloud/assets.", default: "" },
      creditRate: {
        type: "string",
        label: "Credits per US dollar",
        description: "How many Comfy credits one US dollar buys. The default is Comfy's published rate. Leave it empty to show credits only and never a dollar figure.",
        default: String(CREDITS_PER_USD),
      },
    });
    let current = await settings.get();
    /** Why the asset directory could not be prepared, or null when it is fine. Surfaced in status. */
    let assetDirError: string | null = null;
    settings.onChange((next) => {
      current = next;
      // The host calls this outside our own error handling, so nothing may throw out of it.
      try {
        ensureDir(assetDir());
        assetDirError = null;
      } catch (cause) {
        assetDirError = `Could not create the asset folder ${assetDir()}: ${errorText(cause)}`;
        bb.log.warn(assetDirError);
      }
      bb.log.info(`settings changed; key source now: ${keyState().source ?? "none"}`);
    });

    const pluginDirs = options.pluginDirs ?? defaultPluginDirs();
    const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;

    function keyState(): ResolvedKey {
      return resolveKey({ settingKey: current.apiKey, pluginDirs, keyFile: current.keyFile });
    }
    function assetDir(): string {
      const custom = current.assetDir.trim();
      return custom !== "" ? path.resolve(custom) : path.join(dataDir, "plugins", bb.pluginId, "assets");
    }
    function ensureDir(dir: string): string {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
    /**
     * The default model of one kind, as the caller set it. A setting that no
     * longer resolves (Comfy retired the model, or the setting was hand edited)
     * falls back to the shipped default rather than failing every generation.
     */
    function imageModel(): ImageModel {
      const wanted = imageModelSchema.safeParse(current.imageModel);
      const entry = wanted.success ? getModel(wanted.data) : null;
      return entry !== null && entry.kind === "image" && entry.supported ? wanted.data! : DEFAULT_IMAGE_MODEL;
    }
    function videoModel(): VideoModel {
      const wanted = videoModelSchema.safeParse(current.videoModel);
      const entry = wanted.success ? getModel(wanted.data) : null;
      return entry !== null && entry.kind === "video" && entry.supported ? wanted.data! : DEFAULT_VIDEO_MODEL;
    }
    function defaultModel(kind: AssetKind): string {
      return kind === "image" ? imageModel() : videoModel();
    }
    /**
     * US dollars one credit is worth. The setting is the other way round
     * (credits per dollar, which is how Comfy states it), so this inverts it.
     * Null when the setting is empty or not a positive number: then nothing in
     * the plugin prints a dollar figure.
     */
    function creditRate(): number | null {
      const raw = (current.creditRate ?? "").trim();
      if (raw === "") return null;
      const perDollar = Number(raw);
      if (!Number.isFinite(perDollar) || perDollar <= 0) return null;
      return 1 / perDollar;
    }

    try {
      ensureDir(assetDir());
    } catch (cause) {
      assetDirError = `Could not create the asset folder ${assetDir()}: ${errorText(cause)}`;
      bb.log.warn(assetDirError);
    }
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const store = createStore(db);
    const client = createComfyClient({ fetch: options.fetch });

    /** Credit balance, refreshed at most once a minute and never on the hot path. */
    let balance: { credits: number; usd: number } | null = null;
    let balanceAt = 0;
    let balanceFetching: Promise<void> | null = null;
    /** When the balance first failed in the current outage, or null while it reads. */
    let balanceDownSince: number | null = null;

    // ---------- realtime (one signal per 300 ms) ----------
    let publishTimer: NodeJS.Timeout | null = null;
    let lastChangedId: string | null = null;
    function changed(assetId?: string): void {
      if (assetId) lastChangedId = assetId;
      // A generation moved: the balance on file is stale now.
      balanceAt = 0;
      if (publishTimer) return;
      publishTimer = setTimeout(() => {
        publishTimer = null;
        const id = lastChangedId;
        lastChangedId = null;
        // `guarded` because this is a timer body: see timers.ts for why a throw
        // here reaches the shared plugin process rather than a caller. The
        // timer is cleared before the publish runs, so a failed publish still
        // leaves the next `changed()` free to arm a new one.
        guarded("realtime publish", () => bb.realtime.publish(COMFY_CHANNEL, id ? { at: Date.now(), assetId: id } : { at: Date.now() }), bb.log);
      }, PUBLISH_THROTTLE_MS);
    }

    const runner = createRunner({
      store,
      client,
      getKey: () => keyState().key,
      assetDir,
      log: bb.log,
      onChange: changed,
      tickMs: options.tickMs,
      probeVideo: options.probeVideo,
    });

    // ---------- credits (balance cached for a minute, never blocking a generation) ----------
    function refreshBalance(signal?: AbortSignal): Promise<void> {
      if (balanceFetching) return balanceFetching;
      const { key } = keyState();
      if (!key) return Promise.resolve();
      balanceFetching = (async () => {
        try {
          balance = await client.billingBalance(key, { signal });
          balanceAt = Date.now();
          if (balanceDownSince !== null) {
            bb.log.info(`credit balance readable again after ${Math.round((Date.now() - balanceDownSince) / 60_000)} min`);
            balanceDownSince = null;
          }
        } catch (cause) {
          // A balance we cannot read is not an error the user has to act on.
          // Warn once per outage: every status poll retries it about once a
          // minute, so a long outage would otherwise log a warning at every
          // one of them. The recovery line above closes the outage.
          if (balanceDownSince === null) {
            balanceDownSince = Date.now();
            bb.log.warn(`credit balance unavailable: ${errorText(cause)} (quiet until it recovers)`);
          }
          balanceAt = Date.now();
        } finally {
          balanceFetching = null;
        }
      })();
      return balanceFetching;
    }

    /**
     * Wait for the balance only when there is none yet; afterwards refresh in
     * the background so a status poll never waits on Comfy Cloud.
     */
    async function ensureBalance(): Promise<void> {
      if (Date.now() - balanceAt < BALANCE_MAX_AGE_MS && balance !== null) return;
      if (balance === null) {
        await Promise.race([refreshBalance(AbortSignal.timeout(BALANCE_WAIT_MS)), sleep(BALANCE_WAIT_MS)]);
        return;
      }
      void refreshBalance();
    }

    /** What the plugin has learned about prices, passed into every estimate. */
    const observed = (signature: string) => store.observedCredits(signature);

    function estimateFor(kind: AssetKind, model: string, params: Params): CostEstimate {
      const shape = estimateParamsOf({ params, kind });
      // The price tables and this account's own samples are keyed by the id
      // Comfy bills under, which is what the panel quotes from too, so a
      // registry key is resolved before anything is looked up.
      return estimateCredits(kind, priceKeyOf(model), shape, observed, priceForEstimate(getModel(model), shape.duration));
    }

    /** Midnight in the server's own zone. */
    function startOfToday(): number {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }

    /**
     * One row per model in the spend table. The same model can be stored under
     * a bare id (CLI, agent tools, and older stored rows) and
     * under a registry key (the panel), so the rows are folded onto the id
     * Comfy bills under before they are shown.
     */
    function mergeByModel(rows: readonly { model: string; kind: AssetKind; credits: number; count: number }[]): { model: string; kind: AssetKind; credits: number; count: number }[] {
      const merged = new Map<string, { model: string; kind: AssetKind; credits: number; count: number }>();
      for (const row of rows) {
        const model = priceKeyOf(row.model);
        const key = `${row.kind}:${model}`;
        const seen = merged.get(key);
        if (seen === undefined) merged.set(key, { model, kind: row.kind, credits: row.credits, count: row.count });
        else {
          seen.credits = Math.round((seen.credits + row.credits) * 100) / 100;
          seen.count += row.count;
        }
      }
      return [...merged.values()].sort((a, b) => b.credits - a.credits);
    }

    function costsInfo(days: number): Costs {
      const window = Math.max(1, Math.floor(days));
      const since = Date.now() - window * 86_400_000;
      const rate = creditRate();
      return {
        balanceCredits: balance?.credits ?? null,
        balanceUsd: balance?.usd ?? null,
        creditRate: rate,
        spend: {
          today: store.spendSince(startOfToday()),
          week: store.spendSince(Date.now() - 7 * 86_400_000),
          total: store.spendSince(0),
        },
        byModel: mergeByModel(store.creditsByModel(since)),
        recent: store.recentCosts(since, COSTS_RECENT_ROWS).map((asset) => ({
          id: asset.id,
          kind: asset.kind,
          model: asset.model,
          credits: asset.actualCredits ?? null,
          estimatedCredits: asset.estimatedCredits ?? null,
          createdAt: asset.createdAt,
        })),
        observed: store.observedShapes(),
        days: window,
      };
    }

    /**
     * Give Comfy a moment to settle the charge so a waiting CLI command or
     * agent tool can report what the generation actually cost. Returns as soon
     * as the runner has written it, and gives up quietly.
     */
    async function awaitCost(id: string, timeoutMs: number, signal?: AbortSignal): Promise<Asset> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const asset = store.get(id);
        if (!asset || typeof asset.actualCredits === "number" || asset.status !== "completed") return asset ?? ({ id } as Asset);
        // The runner stops tracking a row once the charge lands or it gives up.
        if (!runner.awaitingBill(id) || signal?.aborted || Date.now() >= deadline) return asset;
        await sleep(250, signal);
      }
    }

    // ---------- node catalog (object_info cached on disk, refreshed daily) ----------
    const catalogPath = path.join(dataDir, "plugins", bb.pluginId, "object_info.json");
    let catalogCache: { mtimeMs: number; nodes: Map<string, NodeInfo> } | null = null;
    let catalogFetching: Promise<void> | null = null;

    function catalogStat(): fs.Stats | null {
      try {
        return fs.statSync(catalogPath);
      } catch {
        return null;
      }
    }

    /**
     * The day the cached catalog was fetched, from its mtime alone. Reading the
     * date does not read the 6 MB file, so the rule that runtime never parses
     * object_info still holds; this is how a stale registry can say so.
     */
    function catalogFetchedDay(): string | null {
      const stat = catalogStat();
      return stat === null ? null : dayOf(stat.mtimeMs);
    }

    function loadCatalog(): Map<string, NodeInfo> | null {
      const stat = catalogStat();
      if (!stat) return null;
      if (catalogCache && catalogCache.mtimeMs === stat.mtimeMs) return catalogCache.nodes;
      try {
        const raw = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Record<string, unknown>;
        const nodes = new Map<string, NodeInfo>();
        for (const [classType, value] of Object.entries(raw)) {
          const info = toNodeInfo(classType, value);
          if (info) nodes.set(classType, info);
        }
        catalogCache = { mtimeMs: stat.mtimeMs, nodes };
        return nodes;
      } catch (cause) {
        bb.log.warn(`node catalog unreadable: ${errorText(cause)}`);
        return null;
      }
    }

    function refreshCatalog(force = false, signal?: AbortSignal): Promise<void> {
      if (catalogFetching) return catalogFetching;
      const stat = catalogStat();
      if (!force && stat && Date.now() - stat.mtimeMs < CATALOG_MAX_AGE_MS) return Promise.resolve();
      const { key } = keyState();
      if (!key) return Promise.resolve();
      catalogFetching = (async () => {
        try {
          const info = await client.objectInfo(key, { signal });
          ensureDir(path.dirname(catalogPath));
          const part = `${catalogPath}.part`;
          fs.writeFileSync(part, JSON.stringify(info));
          fs.renameSync(part, catalogPath);
          catalogCache = null;
          bb.log.info(`node catalog cached: ${Object.keys(info).length} nodes`);
        } catch (cause) {
          bb.log.warn(`node catalog refresh failed: ${errorText(cause)}`);
        } finally {
          catalogFetching = null;
        }
      })();
      return catalogFetching;
    }

    /**
     * The params a price shape is read from. A row generated before the plugin
     * recorded a quality tier still carries it in its own graph, which is on
     * disk beside it, so two Ideogram runs at VERY_LOW and MEDIUM do not teach
     * each other a price neither of them was billed.
     */
    function paramsForSignature(asset: Asset): Params {
      const params = asset.params ?? {};
      if (QUALITY_INPUT_NAMES.some((name) => typeof params[name] === "string" && params[name] !== "")) return params;
      let inputs: Record<string, JsonValue>;
      try {
        inputs = readWorkflowFile(asset.workflowPath)["1"]?.inputs ?? {};
      } catch {
        return params;
      }
      for (const name of QUALITY_INPUT_NAMES) {
        const value = inputs[name];
        if (typeof value === "string" && value !== "") return { ...params, quality: value };
      }
      return params;
    }

    // ---------- background: job loop plus the daily catalog check ----------
    bb.background.service("jobs", {
      async start(signal) {
        // Cheap, synchronous and idempotent: put every sample this account has
        // already learned under the key the plugin asks for today, so a model
        // billed under a bare id and under a registry key is one shape.
        try {
          const moved = store.resignCostSamples((asset) => ({
            signature: assetCostSignature({ ...asset, params: paramsForSignature(asset) }),
            model: priceKeyOf(asset.model),
          }));
          if (moved > 0) bb.log.info(`re-keyed ${moved} learned price sample(s)`);
        } catch (cause) {
          bb.log.warn(`could not re-key the price samples: ${errorText(cause)}`);
        }
        const catalogLoop = (async () => {
          await sleep(5_000, signal);
          while (!signal.aborted) {
            await refreshCatalog(false, signal);
            await sleep(CATALOG_CHECK_MS, signal);
          }
        })();
        // One pass over completed assets that never got a charge, for the rows
        // generated before the cost columns existed. Bounded to the newest two
        // pages of billing events; it runs once per load and never blocks.
        const backfill = (async () => {
          await sleep(8_000, signal);
          if (signal.aborted) return;
          try {
            await runner.backfillCosts(BACKFILL_MAX_ASSETS, signal);
          } catch (cause) {
            bb.log.warn(`cost backfill failed: ${errorText(cause)}`);
          }
        })();
        // Small copies for rows generated before they existed. Slower than the
        // cost pass and nothing waits on it, so it starts later and runs on its
        // own; every surface falls back to the original until it lands.
        const derivatives = (async () => {
          await sleep(15_000, signal);
          if (signal.aborted) return;
          try {
            await runner.backfillDerivatives(BACKFILL_MAX_ASSETS, signal);
          } catch (cause) {
            bb.log.warn(`thumbnail backfill failed: ${errorText(cause)}`);
          }
        })();
        await Promise.all([runner.run(signal), catalogLoop, backfill, derivatives]);
      },
    });

    // ---------- asset operations ----------
    interface NewAsset {
      kind: AssetKind;
      prompt: string;
      model: string;
      params: Params;
      workflow: Workflow;
      parentId?: string | null;
      threadId?: string | null;
      source?: AssetSource;
    }

    function mustGet(id: string): Asset {
      const asset = store.get(id.trim());
      if (!asset) throw new Error(`Asset ${id} not found.`);
      return asset;
    }

    function createAsset(input: NewAsset): Asset {
      const id = newAssetId(input.kind);
      const createdAt = Date.now();
      const folder = ensureDir(path.join(assetDir(), dateFolder(createdAt)));
      const workflowPath = path.join(folder, `${id}.workflow.json`);
      const graph = sanitize(input.workflow, keyState().key);
      fs.writeFileSync(workflowPath, JSON.stringify(graph, null, 2));
      const estimate = estimateFor(input.kind, input.model, input.params);
      const asset: Asset = {
        id,
        kind: input.kind,
        status: "queued",
        prompt: input.prompt,
        model: input.model,
        params: input.params,
        file: null,
        path: null,
        workflowPath,
        mime: null,
        width: null,
        height: null,
        durationS: null,
        sizeBytes: null,
        comfyPromptId: null,
        parentId: input.parentId ?? null,
        threadId: input.threadId ?? null,
        source: input.source ?? "unknown",
        starred: false,
        error: null,
        estimatedCredits: estimate.credits,
        actualCredits: null,
        billedModel: null,
        outputTier: null,
        createdAt,
        startedAt: null,
        completedAt: null,
      };
      store.insert(asset);
      const price = estimate.credits === null ? "cost unknown" : `about ${creditsText(estimate.credits, creditRate())} (${estimate.confidence})`;
      bb.log.info(`${id} queued (${input.kind}, ${input.model}, source ${asset.source}, ${price})`);
      changed(id);
      runner.kick();
      return asset;
    }

    /**
     * The file one reference names: an asset of this plugin, or an image on the
     * bb server's disk. The asset id form is the one worth having, because it
     * turns "vary this one" into a single call.
     */
    function referenceFile(wanted: string, cwd: string | undefined): { file: string; from: string } {
      const asset = store.get(wanted);
      if (asset !== null) {
        if (asset.kind !== "image") throw new Error(`${asset.id} is a video. A reference has to be an image.`);
        if (asset.path === null) throw new Error(`${asset.id} has no file yet: it is ${asset.status}.`);
        if (!fs.existsSync(asset.path)) throw new Error(`${asset.id} has no file on disk any more (${asset.path}).`);
        return { file: asset.path, from: asset.id };
      }
      const resolved = path.resolve(cwd ?? process.cwd(), wanted);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        throw new Error(`No asset and no file called "${wanted}". A reference is an asset id from bb comfy list, or the path of an image on the bb server.`);
      }
      if (!stat.isFile()) throw new Error(`${resolved} is not a file.`);
      if (!REFERENCE_EXTENSIONS.some((extension) => resolved.toLowerCase().endsWith(extension))) {
        throw new Error(`${resolved} is not an image the plugin uploads (${REFERENCE_EXTENSIONS.join(", ")}).`);
      }
      return { file: resolved, from: resolved };
    }

    /**
     * Upload every named reference and return what the builder wires in.
     *
     * The uploads happen before the asset row exists, so a bad path or a missing
     * asset fails the call rather than leaving a queued row that can never run.
     * Uploads are free and content addressed, so a repeat costs one round trip
     * at most and the client caches even that.
     */
    async function resolveReferences(names: readonly string[] | undefined, cwd: string | undefined, signal?: AbortSignal): Promise<ReferenceImage[]> {
      const wanted = (names ?? []).map((name) => name.trim()).filter((name) => name !== "");
      if (wanted.length === 0) return [];
      const key = keyState().key;
      // Everything else queues without a key and waits for one; a reference
      // cannot, because the graph needs the name Comfy Cloud gives the bytes.
      if (key === null) throw new Error(`A reference image has to be uploaded to Comfy Cloud first, and that needs the API key. ${CONFIGURE_HINT}`);
      const references: ReferenceImage[] = [];
      for (const name of wanted) {
        const { file, from } = referenceFile(name, cwd);
        const bytes = fs.readFileSync(file);
        if (bytes.length === 0) throw new Error(`${from} is empty.`);
        if (bytes.length > REFERENCE_MAX_BYTES) {
          throw new Error(`${from} is ${Math.round(bytes.length / 1024 / 1024)} MB, over the ${REFERENCE_MAX_BYTES / 1024 / 1024} MB the plugin uploads.`);
        }
        const uploaded = await client.uploadImage(key, bytes, path.basename(file), { signal });
        references.push({ name: uploaded.name, from });
      }
      bb.log.info(`uploaded ${references.length} reference image(s): ${references.map((reference) => reference.from).join(", ")}`);
      return references;
    }

    /** A generate call with the extra context only the CLI has. */
    type GenerateOptions = { cwd?: string; signal?: AbortSignal };

    async function generateImage(input: GenerateImageInput, options: GenerateOptions = {}): Promise<Asset> {
      const references = await resolveReferences(input.references, options.cwd, options.signal);
      const spec = resolveImageSpec(input, imageModel(), references);
      store.noteRecent(spec.entry.key);
      return createAsset({
        kind: "image",
        prompt: spec.prompt,
        model: spec.model,
        params: specParams(spec),
        workflow: buildWorkflow(spec),
        parentId: input.parentId ?? null,
        threadId: input.threadId ?? null,
        source: input.source,
      });
    }

    async function generateVideo(input: GenerateVideoInput, options: GenerateOptions = {}): Promise<Asset> {
      const references = await resolveReferences(input.references, options.cwd, options.signal);
      const spec = resolveVideoSpec(input, videoModel(), references);
      store.noteRecent(spec.entry.key);
      return createAsset({
        kind: "video",
        prompt: spec.prompt,
        model: spec.model,
        params: specParams(spec),
        workflow: buildWorkflow(spec),
        parentId: input.parentId ?? null,
        threadId: input.threadId ?? null,
        source: input.source,
      });
    }

    function runWorkflow(input: RunWorkflowInput): Asset {
      const parsed = workflowSchema.safeParse(sanitize(input.workflow, keyState().key));
      if (!parsed.success) throw new Error(`Not a ComfyUI API workflow (node id -> { class_type, inputs }): ${parsed.error.issues[0]?.message ?? "invalid"}`);
      // model.width and model.height are validated even when the preset decides
      // the size, so a hand edited graph gets them pulled into range here.
      const workflow = clampImageNodes(parsed.data);
      if (Object.keys(workflow).length === 0) throw new Error("The workflow has no nodes.");
      const info = inspectWorkflow(workflow);
      const kind: AssetKind = input.kind && input.kind !== "auto" ? input.kind : info.kind;
      return createAsset({
        kind,
        prompt: capPrompt((input.prompt ?? info.prompt ?? "").trim()),
        model: info.model ?? "custom",
        params: info.params,
        workflow,
        parentId: input.parentId ?? null,
        threadId: input.threadId ?? null,
        source: input.source,
      });
    }

    /**
     * Retry pays for a new job, so first make sure the row's own job is not
     * the answer: a row marked failed or unknown whose job Comfy Cloud
     * actually finished is taken back and downloaded, with its bill recorded,
     * and the caller gets that row instead of a second charge. A new seed is
     * a request for a different picture, so it always makes a new job.
     */
    async function retryAsset(id: string, newSeed: boolean, source: AssetSource, threadId?: string | null, signal?: AbortSignal): Promise<Asset> {
      const asset = mustGet(id);
      if (!newSeed) {
        const recovered = await runner.recover(asset, signal);
        if (recovered !== null) {
          changed(recovered.id);
          return recovered;
        }
      }
      let workflow = readWorkflowFile(asset.workflowPath);
      const params: Params = { ...asset.params };
      if (newSeed) {
        const seed = randomSeed();
        workflow = withSeed(workflow, seed);
        params.seed = seed;
      }
      return createAsset({
        kind: asset.kind,
        prompt: asset.prompt,
        model: asset.model,
        params,
        workflow,
        parentId: asset.id,
        threadId: threadId ?? asset.threadId,
        source,
      });
    }

    function cancelAsset(id: string): Asset {
      const asset = mustGet(id);
      if (isTerminal(asset.status)) throw new Error(`${asset.id} is already ${asset.status}.`);
      const updated = store.update(asset.id, { status: "cancelled", completedAt: Date.now(), error: null }) as Asset;
      bb.log.info(`${asset.id} cancelled${asset.comfyPromptId ? ` (Comfy job ${asset.comfyPromptId} may still finish remotely)` : ""}`);
      changed(asset.id);
      return updated;
    }

    function starAsset(id: string, starred: boolean): Asset {
      const asset = mustGet(id);
      const updated = store.update(asset.id, { starred }) as Asset;
      changed(asset.id);
      return updated;
    }

    function jobPathOf(asset: Asset): string {
      return path.join(path.dirname(asset.workflowPath), `${asset.id}.job.json`);
    }

    function deleteAsset(id: string): string {
      const asset = mustGet(id);
      // The small copies go with the original: they are derived from it and
      // mean nothing without it. Derived from the row's own absolute path
      // rather than read from the columns, so a row whose column never got
      // written still has its files cleaned up.
      // The `.part` names are a regeneration interrupted by a shutdown.
      const derivatives =
        asset.path === null
          ? []
          : (["thumb", "medium"] as const).flatMap((kind) => [derivativePath(asset.path as string, kind), `${derivativePath(asset.path as string, kind)}.part`]);
      // A download cut off by a hard kill leaves `<id>.<ext>.part` beside the
      // workflow, and a row that never completed has no path to derive it
      // from, so every `<id>.*.part` in the row's own folder goes too.
      const folder = path.dirname(asset.workflowPath);
      let partials: string[] = [];
      try {
        partials = fs.readdirSync(folder).filter((name) => name.startsWith(`${asset.id}.`) && name.endsWith(".part")).map((name) => path.join(folder, name));
      } catch {
        partials = [];
      }
      const files = [...new Set([asset.path, ...derivatives, asset.workflowPath, jobPathOf(asset), asset.path ? `${asset.path}.part` : null, ...partials])];
      for (const file of files) {
        if (!file) continue;
        try {
          fs.rmSync(file, { force: true });
        } catch (cause) {
          bb.log.warn(`could not remove ${file}: ${errorText(cause)}`);
        }
      }
      store.remove(asset.id);
      changed(asset.id);
      return `Deleted ${asset.id}${asset.path ? ` and ${path.basename(asset.path)}` : ""}.`;
    }

    function workflowOf(asset: Asset): Workflow {
      try {
        const parsed = workflowSchema.safeParse(readWorkflowFile(asset.workflowPath));
        return parsed.success ? parsed.data : {};
      } catch {
        return {};
      }
    }

    function jobOf(asset: Asset): JsonValue | null {
      try {
        return sanitize(JSON.parse(fs.readFileSync(jobPathOf(asset), "utf8")), keyState().key);
      } catch {
        return null;
      }
    }

    /**
     * The picker's list. Hidden and unsupported entries are left out unless
     * `all` is set, but the two current defaults are always in, so the sheet can
     * always show the model the user is on.
     */
    function visibleModels(input: { kind?: AssetKind; vendor?: string; all?: boolean; query?: string }, pins: readonly string[] = [imageModel(), videoModel()]): RegistryEntry[] {
      const chosen = listModels(input);
      const keys = new Set(chosen.map((e) => e.key));
      // A default that points at a deprecated entry is still the model the user
      // is on, so it goes back into an unnarrowed list. A vendor or a search
      // term is a deliberate narrowing and is left alone.
      if (input.vendor !== undefined || (input.query ?? "") !== "") return chosen;
      for (const id of pins) {
        const entry = getModel(id);
        if (entry === null || keys.has(entry.key) || !entry.supported) continue;
        if (input.kind !== undefined && entry.kind !== input.kind) continue;
        chosen.push(entry);
        keys.add(entry.key);
      }
      return chosen;
    }

    /**
     * The picker's payload pins more than the CLI's table does: the model each
     * kind is on, plus everything Favourites and Recent name. Hidden is not
     * gone (the four V2 Seedream entries are hidden because a live node offers
     * the same model), so a hidden entry named there still needs its row.
     * `listedModels` in the panel keeps a pinned hidden entry out of the vendor
     * sections, so it appears only in the section that named it. `bb comfy
     * models` keeps the plain list, or its own footer count would move with
     * somebody's favourites.
     */
    function pickerModels(input: { kind?: AssetKind; vendor?: string; all?: boolean; query?: string }): RegistryEntry[] {
      return visibleModels(input, [imageModel(), videoModel(), ...store.getList(FAVOURITES_KEY), ...store.getList(RECENT_KEY)]);
    }

    function modelsResult(input: { kind?: AssetKind; vendor?: string; all?: boolean; query?: string }): ModelsResult {
      const rate = creditRate();
      const chosen = pickerModels(input);
      const scope = MODEL_ENTRIES.filter((e) => input.kind === undefined || e.kind === input.kind);
      return {
        models: chosen.map((entry) => modelSummary(entry, rate)),
        defaults: { image: getModel(imageModel())?.key ?? imageModel(), video: getModel(videoModel())?.key ?? videoModel() },
        counts: {
          total: scope.length,
          supported: scope.filter((e) => e.supported).length,
          unsupported: scope.filter((e) => !e.supported).length,
          hidden: scope.filter((e) => e.hidden).length,
        },
        creditRate: rate,
        // The form prices from the same samples the server will, so the number
        // in the button is the number stored on the row it creates.
        observed: store.observedShapes().filter((shape) => input.kind === undefined || shape.kind === input.kind),
      };
    }

    function statusInfo(): Status {
      const { key, source } = keyState();
      return {
        configured: key !== null,
        keySource: source,
        configureHint: key !== null ? null : CONFIGURE_HINT,
        assetDir: assetDir(),
        imageModel: imageModel(),
        videoModel: videoModel(),
        counts: store.counts(),
        catalogLoaded: catalogStat() !== null,
        registry: { generatedAt: GENERATED_AT, catalogDate: CATALOG_DATE, catalogFetched: catalogFetchedDay() },
        assetDirError,
        balanceCredits: balance?.credits ?? null,
        balanceUsd: balance?.usd ?? null,
        creditRate: creditRate(),
      };
    }

    /** statusInfo with a balance that has been fetched at least once. */
    async function statusFresh(): Promise<Status> {
      await ensureBalance();
      return statusInfo();
    }

    function listAssets(filter: ListFilter): Asset[] {
      return store.list(filter).map(versioned);
    }

    /**
     * A row as the panel gets it: with the media route's version token for
     * each of its files (media.ts). Three stats a row, which is cheap beside
     * the query that produced it, and what lets a browser keep every picture
     * for a year instead of asking again at every opening of the panel.
     */
    function versioned(asset: Asset): Asset {
      if (asset.status !== "completed") return asset;
      const root = assetDir();
      return {
        ...asset,
        fileVersion: mediaVersion(root, asset.file),
        thumbVersion: mediaVersion(root, asset.thumbPath),
        mediumVersion: mediaVersion(root, asset.mediumPath),
      };
    }

    /**
     * Rewrite one stored list of model keys to the entries that still exist,
     * dropping the rest. Idempotent, and it writes only when something moved.
     */
    function prune(key: string): string[] {
      const stored = store.getList(key);
      const kept: string[] = [];
      for (const id of stored) {
        const entry = getModel(id);
        if (entry !== null && entry.supported && !kept.includes(entry.key)) kept.push(entry.key);
      }
      if (kept.length === stored.length && kept.every((value, index) => value === stored[index])) return stored;
      return store.setList(key, kept, key === RECENT_KEY ? RECENT_LIMIT : undefined);
    }

    // ---------- RPC ----------
    bb.rpc.register(rpcContract, {
      status: () => statusFresh(),
      costs: async (input) => {
        await ensureBalance();
        return costsInfo(input?.days ?? COSTS_DEFAULT_DAYS);
      },
      assets_list: (input) => ({ assets: listAssets(input) }),
      asset_get: ({ id }) => {
        const asset = mustGet(id);
        return { asset: versioned(asset), workflow: workflowOf(asset), job: jobOf(asset) };
      },
      models: (input) => modelsResult(input ?? {}),
      model_labels: () => ({ labels: MODEL_LABELS }),
      model_prefs: (input) => {
        if (input?.favourites !== undefined) store.setList(FAVOURITES_KEY, input.favourites);
        if (input?.recent !== undefined) store.setList(RECENT_KEY, input.recent, RECENT_LIMIT);
        // The lists self-heal. A key Comfy Cloud has retired, or one this
        // account cannot run, resolves to nothing and is written out of the
        // stored list rather than dropped silently at draw time: a Recent
        // heading over fewer rows than the user remembers using is a bug they
        // cannot see the cause of. A key that still resolves is rewritten to
        // the entry's own key, so an alias stops counting as a second model.
        prune(FAVOURITES_KEY);
        prune(RECENT_KEY);
        // The panel's own choice, so a fixed tab that unmounts on every switch
        // to Jobs comes back on the model the user picked. Only a key the
        // registry still offers is kept: a model Comfy retires must not strand
        // the tab on a row that no longer exists.
        for (const kind of ["image", "video"] as const) {
          const wanted = input?.chosen?.[kind];
          if (wanted === undefined) continue;
          const entry = getModel(wanted);
          if (entry !== null && entry.kind === kind && entry.supported) store.setText(chosenKey(kind), entry.key);
        }
        return {
          favourites: store.getList(FAVOURITES_KEY),
          recent: store.getList(RECENT_KEY),
          chosen: { image: store.getText(chosenKey("image")), video: store.getText(chosenKey("video")) },
        };
      },
      generate_image: async (input) => ({ asset: await generateImage({ ...input, source: input.source ?? "panel" }) }),
      generate_video: async (input) => ({ asset: await generateVideo({ ...input, source: input.source ?? "panel" }) }),
      run_workflow: (input) => ({ asset: runWorkflow({ ...input, source: input.source ?? "panel" }) }),
      asset_retry: async ({ id, newSeed }) => ({ asset: await retryAsset(id, newSeed ?? false, "panel") }),
      asset_cancel: ({ id }) => ({ asset: cancelAsset(id) }),
      asset_star: ({ id, starred }) => ({ asset: versioned(starAsset(id, starred)) }),
      asset_delete: ({ id }) => ({ ok: true, text: deleteAsset(id) }),
      // The fallback for a row with no version token; the panel prefers the
      // media route below. Kept because an old server has no route at all.
      preview_base: async () => {
        const preview = await bb.sdk.files.createPreview({ rootPath: ensureDir(assetDir()), ttlMs: 60 * 60 * 1000 });
        return { baseUrl: preview.baseUrl, expiresAtMs: preview.expiresAtMs };
      },
      art_base: async () => {
        const dir = resolveArtDir(pluginDirs);
        if (dir === null) throw new Error(`No artwork found. Expected ${ART_FOLDER} in ${pluginDirs.join(" or ") || "the plugin folder"}; rebuild it with: node scripts/make-art.mjs`);
        const preview = await bb.sdk.files.createPreview({ rootPath: dir, ttlMs: 60 * 60 * 1000 });
        return { baseUrl: preview.baseUrl, expiresAtMs: preview.expiresAtMs };
      },
      node_catalog: ({ classTypes }) => {
        const nodes = loadCatalog();
        if (!nodes) void refreshCatalog();
        const out: Record<string, NodeInfo> = {};
        for (const classType of new Set(classTypes)) {
          const info = nodes?.get(classType);
          if (info) out[classType] = info;
        }
        return { nodes: out };
      },
    });

    // ---------- media route ----------
    // Every picture and clip the panel draws, with a cache header the browser
    // may keep: see media.ts for why bb's own preview cannot, and for the
    // version rule that makes a year safe. Default "local" auth, so another
    // origin gets a 403 from bb before this runs. `serveMedia` never throws;
    // a missing file is a 404 and an unreadable one a 500.
    const media: PluginHttpHandler = (context) =>
      serveMedia(assetDir(), {
        method: context.req.method,
        p: context.req.query("p"),
        v: context.req.query("v"),
        download: context.req.query("download"),
        ifNoneMatch: context.req.header("if-none-match"),
        range: context.req.header("range"),
        ifRange: context.req.header("if-range"),
      });
    bb.http.route("GET", MEDIA_ROUTE, media);
    bb.http.route("HEAD", MEDIA_ROUTE, media);

    // ---------- agent tools ----------
    async function toolGenerate(create: () => Asset | Promise<Asset>, wait: boolean, waitMs: number, signal: AbortSignal): Promise<ToolResult> {
      if (keyState().key === null) return fail(CONFIGURE_HINT);
      let asset: Asset;
      try {
        asset = await create();
      } catch (cause) {
        return fail(errorText(cause));
      }
      const rate = creditRate();
      if (!wait) return `${asset.id} queued. Check later with comfy_asset({ id: "${asset.id}" }) or: bb comfy show ${asset.id}\n${describeAsset(asset, rate)}`;
      let done = await runner.waitFor(asset.id, waitMs, signal);
      // Comfy settles the charge a few seconds after the job, so wait for it
      // rather than telling the caller the estimate when the bill is coming.
      if (done.status === "completed") done = await awaitCost(done.id, COST_WAIT_MS, signal);
      if (done.status === "completed") return describeAsset(done, rate);
      if (done.status === "unknown") return `${unknownText(done)}\n${describeAsset(done, rate)}`;
      if (isTerminal(done.status)) return fail(describeAsset(done, rate));
      return `${done.id} is still ${done.status} after ${Math.round(waitMs / 60_000)} minutes. Check later with comfy_asset({ id: "${done.id}" }).\n${describeAsset(done, rate)}`;
    }

    bb.agents.registerTool({
      name: "comfy_generate_image",
      description:
        "Generate an image on Comfy Cloud. Returns the asset id, the absolute file path on the bb server (open it with your file reading tool) and what the generation cost in credits. Any model key from comfy_models works; the default is Seedream 5.0 Pro at 9.5 credits (about $0.05) at 1K and 18.99 at 2K. Image prices run from about 0.7 to 53 credits, so run comfy_models before picking an unfamiliar one. Waits up to 6 minutes by default.",
      presentation: { label: { pending: "Generating an image on Comfy Cloud", completed: "Generated an image on Comfy Cloud" } },
      parameters: z.object({
        prompt: z.string().min(1).describe("What to draw: concrete nouns, lighting, style"),
        size_preset: z.string().optional().describe('One of the model\'s presets, e.g. "(1K) 1024x1024 (1:1)"; see comfy_models or bb comfy sizes'),
        aspect: z.string().optional().describe('Aspect ratio for models that take one, e.g. "16:9"'),
        resolution: z.string().optional().describe('Resolution tier for models that take one, e.g. "2K"'),
        width: z.number().int().positive().optional().describe("Pixel width, for models with free dimensions"),
        height: z.number().int().positive().optional().describe("Pixel height, for models with free dimensions"),
        count: z.number().int().positive().max(16).optional().describe("Images from one call, for models that batch"),
        model: z.string().optional().describe('Model key from comfy_models, e.g. "ByteDanceSeedreamNodeV3/seedream 5.0 pro". Defaults to the imageModel setting'),
        reference_image: z
          .array(z.string().min(1))
          .max(16)
          .optional()
          .describe(
            'Reference images to draw from: an asset id of an earlier generation ("img_ab12cd34"), or the absolute path of an image on the bb server. Give several to combine them. Only some models take them; comfy_models shows which, and one that does not says so.',
          ),
        seed: z.number().int().min(0).max(MAX_SEED).optional().describe("Omit for a random seed"),
        extras: z.string().optional().describe('Any other input the model declares, as name=value pairs separated by commas, e.g. "quality=VERY_LOW". bb comfy sizes lists them per model'),
        wait: z.boolean().optional().describe("Default true: wait for the result"),
      }),
      execute: ({ prompt, size_preset, aspect, resolution, width, height, count, model, reference_image, seed, extras, wait }, ctx) =>
        toolGenerate(
          () =>
            generateImage(
              {
                prompt,
                sizePreset: size_preset,
                aspect,
                resolution,
                width,
                height,
                count,
                model,
                references: reference_image,
                seed,
                extras: parseExtras(extras),
                threadId: ctx.threadId,
                source: "tool",
              },
              { signal: ctx.signal },
            ),
          wait ?? true,
          IMAGE_WAIT_MS,
          ctx.signal,
        ),
    });

    bb.agents.registerTool({
      name: "comfy_generate_video",
      description:
        "Generate a short video on Comfy Cloud. Returns the asset id, the absolute .mp4 path on the bb server and what the generation cost in credits. Video is far more expensive than images and the models differ by two orders of magnitude: a 3 s 480p seedance-1-0-pro-fast clip is about 6 credits, a 5 s 1080p Seedance 2.5 clip about 858, and the dearest model in the catalog passes 3000 credits for one clip. Run comfy_models and comfy_costs first, and confirm with the user before spending more than about 100 credits. Waits up to 10 minutes by default.",
      presentation: { label: { pending: "Generating a video on Comfy Cloud", completed: "Generated a video on Comfy Cloud" } },
      parameters: z.object({
        prompt: z.string().min(1).describe("One subject, one camera move, what happens"),
        resolution: z.string().optional().describe('Default is the model\'s lowest tier, e.g. "480p"'),
        aspect_ratio: z.string().optional().describe("Default 16:9, where the model offers ratios"),
        duration: z.number().int().optional().describe("Seconds; clamped to the model's range"),
        model: z.string().optional().describe("Model key from comfy_models. Defaults to the videoModel setting"),
        generate_audio: z.boolean().optional().describe("Only models that support audio honor this"),
        reference_image: z
          .array(z.string().min(1))
          .max(16)
          .optional()
          .describe(
            'Reference images the clip is built from: an asset id of an earlier generation ("img_ab12cd34"), or the absolute path of an image on the bb server. Only some video models take them, and one that does not says so.',
          ),
        seed: z.number().int().min(0).max(MAX_SEED).optional(),
        extras: z.string().optional().describe('Any other input the model declares, as name=value pairs separated by commas, e.g. "mode=pro". bb comfy sizes lists them per model'),
        wait: z.boolean().optional().describe("Default true: wait for the result"),
      }),
      execute: ({ prompt, resolution, aspect_ratio, duration, model, generate_audio, reference_image, seed, extras, wait }, ctx) =>
        toolGenerate(
          () =>
            generateVideo(
              {
                prompt,
                resolution,
                aspectRatio: aspect_ratio,
                duration,
                model,
                generateAudio: generate_audio,
                references: reference_image,
                seed,
                extras: parseExtras(extras),
                threadId: ctx.threadId,
                source: "tool",
              },
              { signal: ctx.signal },
            ),
          wait ?? true,
          VIDEO_WAIT_MS,
          ctx.signal,
        ),
    });

    bb.agents.registerTool({
      name: "comfy_run_workflow",
      description:
        "Submit a ComfyUI API-format workflow JSON (node id -> { class_type, inputs }) to Comfy Cloud, for example the workflow of an existing asset with edited inputs. Pass parent_id to link it to the asset it was tweaked from.",
      presentation: { label: { pending: "Running a Comfy workflow", completed: "Ran a Comfy workflow" } },
      parameters: z.object({
        workflow_json: z.string().min(2).describe("The workflow as a JSON string"),
        kind: z.enum(["image", "video", "auto"]).optional().describe("Default auto: SaveVideo means video"),
        prompt: z.string().optional().describe("Shown in the browser; defaults to the prompt found in the graph"),
        parent_id: z.string().optional(),
        wait: z.boolean().optional().describe("Default true: wait for the result"),
      }),
      execute: ({ workflow_json, kind, prompt, parent_id, wait }, ctx) => {
        let workflow: unknown;
        try {
          workflow = JSON.parse(workflow_json);
        } catch (cause) {
          return fail(`workflow_json is not valid JSON: ${errorText(cause)}`);
        }
        const parsed = workflowSchema.safeParse(sanitize(workflow));
        if (!parsed.success) return fail(`Not a ComfyUI API workflow (node id -> { class_type, inputs }): ${parsed.error.issues[0]?.message ?? "invalid"}`);
        const graphKind = kind && kind !== "auto" ? kind : inspectWorkflow(parsed.data).kind;
        return toolGenerate(
          () => runWorkflow({ workflow: parsed.data, kind: kind ?? "auto", prompt, parentId: parent_id, threadId: ctx.threadId, source: "tool" }),
          wait ?? true,
          graphKind === "video" ? VIDEO_WAIT_MS : IMAGE_WAIT_MS,
          ctx.signal,
        );
      },
    });

    bb.agents.registerTool({
      name: "comfy_assets",
      description: "List generated assets, newest first: id, status, kind, size, age, prompt.",
      presentation: { label: { pending: "Listing Comfy assets", completed: "Listed Comfy assets" } },
      parameters: z.object({
        kind: assetKindSchema.optional(),
        status: assetStatusSchema.optional(),
        query: z.string().optional().describe("Substring of the prompt or model, or an exact id"),
        limit: z.number().int().positive().max(200).optional().describe("Default 30"),
      }),
      execute: ({ kind, status, query, limit }) => {
        const assets = listAssets({ kind, status, query, limit: limit ?? 30 });
        if (assets.length === 0) return "No assets match.";
        return [`${assets.length} asset(s), newest first (id  status  kind  size  age  prompt):`, ...assets.map(assetLine)].join("\n");
      },
    });

    bb.agents.registerTool({
      name: "comfy_asset",
      description: "One asset: status, absolute file path, dimensions, params, prompt, and optionally the workflow JSON that produced it.",
      presentation: { label: { pending: "Reading a Comfy asset", completed: "Read a Comfy asset" } },
      parameters: z.object({
        id: z.string().min(1),
        workflow: z.boolean().optional().describe("Include the workflow JSON"),
      }),
      execute: ({ id, workflow }) => {
        let asset: Asset;
        try {
          asset = mustGet(id);
        } catch (cause) {
          return fail(errorText(cause));
        }
        const text = describeAsset(asset, creditRate());
        return workflow ? `${text}\nworkflow JSON:\n${JSON.stringify(workflowOf(asset), null, 2)}` : text;
      },
    });

    bb.agents.registerTool({
      name: "comfy_status",
      description:
        "Comfy Cloud plugin status: configured or not (and which key source), credits left on the account and what this plugin has spent, default models and their presets, asset counts, asset directory.",
      presentation: { label: { pending: "Checking Comfy Cloud status", completed: "Checked Comfy Cloud status" } },
      parameters: z.object({}),
      execute: async () => statusText(await statusFresh()),
    });

    bb.agents.registerTool({
      name: "comfy_costs",
      description:
        "What Comfy Cloud generation costs: credits left on the account, what this plugin has spent today, this week and in total, the per model breakdown, and the prices learned from this account's own bills. Check this before an expensive video.",
      presentation: { label: { pending: "Checking Comfy Cloud costs", completed: "Checked Comfy Cloud costs" } },
      parameters: z.object({ days: z.number().int().positive().max(3650).optional().describe("Window of the per model table; default 30") }),
      execute: async ({ days }) => {
        await ensureBalance();
        return costsText(costsInfo(days ?? COSTS_DEFAULT_DAYS));
      },
    });

    bb.agents.registerTool({
      name: "comfy_models",
      description:
        "Every model Comfy Cloud offers through this plugin: vendor, key, what it can do and what it costs, cheapest first inside each vendor. Pass the key to comfy_generate_image or comfy_generate_video. Image prices run from about 0.7 to 53 credits; video runs from about 6 credits for a short 480p clip to over 3000 for a long 4K one, so read the price before spending.",
      presentation: { label: { pending: "Listing Comfy Cloud models", completed: "Listed Comfy Cloud models" } },
      parameters: z.object({
        kind: assetKindSchema.optional().describe("image or video; both when omitted"),
        vendor: z.string().optional().describe('One vendor, e.g. "ByteDance" or "Google"'),
        query: z.string().optional().describe("Substring of the key, label, vendor or model id"),
        all: z.boolean().optional().describe("Include unsupported and hidden entries with the reason"),
      }),
      execute: ({ kind, vendor, query, all }) => modelsText({ kind, vendor, query, all }),
    });

    /** " The catalog on disk is N days newer ..." when the registry is behind, or "". */
    function staleTail(): string {
      const age = registryAge({ generatedAt: GENERATED_AT, catalogDate: CATALOG_DATE, catalogFetched: catalogFetchedDay() }, dayOf(Date.now()));
      const note = registryStaleNote(age);
      return note === "" ? "" : ` ${note}`;
    }

    function statusText(s: Status): string {
      const rate = s.creditRate ?? null;
      const modelLine = (kind: AssetKind): string => {
        const id = defaultModel(kind);
        const entry = getModel(id);
        if (entry === null) return `${kind === "image" ? "Image" : "Video"} model: ${id} (not in the registry)`;
        return `${kind === "image" ? "Image" : "Video"} model: ${entry.key} (${entry.label}; ${capabilityLine(entry)}; ${priceLine(entry, rate)})`;
      };
      const balanceLine =
        typeof s.balanceCredits === "number" ? `Credits left: ${creditsText(s.balanceCredits, rate)}` : "Credits left: not read yet (no key, or Comfy Cloud did not answer)";
      const spent = store.spendSince(0);
      return [
        `Comfy Cloud: ${s.configured ? `configured (key source: ${s.keySource})` : "NOT configured"}`,
        ...(s.configureHint ? [s.configureHint] : []),
        balanceLine,
        // Both figures are all time, and the line says so. A count with no
        // period on it reads as recent: say the window or do not show the
        // number.
        `Spent here, all time: ${creditsText(spent, rate)} across ${store.counts().total} generation(s). Today and this week: bb comfy costs`,
        `Asset dir: ${s.assetDir}`,
        modelLine("image"),
        modelLine("video"),
        // One number on every user-facing surface, and it is the number of
        // models you can actually choose: the supported count includes the
        // hidden legacy and superseded duplicates the picker never offers, so
        // it is not the figure quoted here. The fuller breakdown stays on
        // `bb comfy models --all`.
        `Models: ${listModels().length} to choose from (${listModels({ kind: "image" }).length} image, ${listModels({ kind: "video" }).length} video) out of ${MODEL_ENTRIES.length} entries in the ${CATALOG_DATE} catalog snapshot. Full list: bb comfy models, or --all for every entry`,
        // "queued or running" is live state and "failed" is the whole library,
        // on one line, so the recent half is spelled out when there is one:
        // that is the figure the sidebar badge is showing, and the two agreeing
        // is the point. Nothing is added when nothing failed lately.
        `Assets: ${s.counts.total} total, ${s.counts.images} images, ${s.counts.videos} videos, ${s.counts.running} in progress, ${s.counts.failed} failed${s.counts.failedRecent > 0 ? ` (${s.counts.failedRecent} in the last day)` : ""}`,
        `Node catalog: ${s.catalogLoaded ? "cached" : "not fetched yet"}`,
        registryAgeLine(registryAge(s.registry, dayOf(Date.now()))),
      ].join("\n");
    }

    /**
     * Cheapest a model can be run for, used to sort the table. Unpriced models
     * sort last. `floorCredits` in contract.ts quotes each tier through its own
     * `when` values, which is the only way a per image, per clip, per second
     * and per 1000 tokens price end up in one comparable column.
     */
    function cheapestRun(entry: RegistryEntry): number {
      if (entry.price === null) return Number.POSITIVE_INFINITY;
      const caps = capabilitiesOf(entry);
      const value = floorCredits(entry.price, entry.kind, {
        sizePreset: caps.sizePresets[0] ?? null,
        resolution: caps.resolutions[0] ?? null,
        duration: caps.duration?.min ?? null,
      });
      return value ?? Number.POSITIVE_INFINITY;
    }

    /** `bb comfy models`: one line per model, sorted by price inside each vendor. */
    function modelsText(filter: { kind?: AssetKind; vendor?: string; all?: boolean; query?: string }): string {
      const rate = creditRate();
      const rows = visibleModels(filter).sort(
        (a, b) => a.vendor.localeCompare(b.vendor) || cheapestRun(a) - cheapestRun(b) || a.label.localeCompare(b.label),
      );
      if (rows.length === 0) return "No models match.";
      const defaults = new Set([getModel(imageModel())?.key, getModel(videoModel())?.key]);
      const lines: string[] = [];
      let vendor = "";
      for (const entry of rows) {
        if (entry.vendor !== vendor) {
          vendor = entry.vendor;
          lines.push(`${vendor}:`);
        }
        const flags = [
          defaults.has(entry.key) ? "default" : null,
          entry.recommended ? "recommended" : null,
          // The one capability a caller cannot see anywhere else on this list,
          // and the reason a whole class of requests picks one model over another.
          entry.referenceImages === undefined ? null : `takes up to ${entry.referenceImages.max} reference images`,
          entry.deprecated ? "deprecated" : null,
          entry.hidden ? "hidden" : null,
          entry.supported ? null : "UNSUPPORTED",
        ].filter((f): f is string => f !== null);
        lines.push(`  ${entry.key}${flags.length > 0 ? `  [${flags.join(", ")}]` : ""}`);
        lines.push(`    ${entry.kind}, ${capabilityLine(entry)}  |  ${priceLine(entry, rate)}`);
        if (entry.strengths !== null) lines.push(`    ${entry.strengths}`);
        if (!entry.supported) lines.push(`    why not: ${entry.unsupportedReason ?? "unknown"}`);
        if (capabilitiesOf(entry).schemaDerived) lines.push("    capabilities read from the node schema; no vendor documentation on file");
      }
      const scope = MODEL_ENTRIES.filter((e) => filter.kind === undefined || e.kind === filter.kind);
      lines.push(
        `${rows.length} shown of ${scope.length} entries (${scope.filter((e) => e.supported).length} supported, ${scope.filter((e) => e.hidden).length} hidden), sorted inside each vendor by the cheapest single generation.`,
        // A stale list is worth saying on the list itself, not only on status:
        // this is where somebody picks a model, and a stale list can still
        // show rows Comfy Cloud has already retired.
        `Catalog snapshot ${CATALOG_DATE}. Use --all to include unsupported and hidden entries with the reason.${staleTail()}`,
      );
      return lines.join("\n");
    }

    /** `bb comfy costs`: the balance, what this plugin has spent, and where it went. */
    function costsText(costs: Costs): string {
      const rate = costs.creditRate;
      const lines = [
        costs.balanceCredits === null ? "Credits left: not read yet" : `Credits left: ${creditsText(costs.balanceCredits, rate)}`,
        `Spent by this plugin: ${creditsText(costs.spend.today, rate)} today, ${creditsText(costs.spend.week, rate)} this week, ${creditsText(costs.spend.total, rate)} in total`,
      ];
      lines.push(`Last ${costs.days} day(s), per model:`);
      if (costs.byModel.length === 0) lines.push("  nothing billed yet");
      for (const row of costs.byModel) {
        lines.push(`  ${row.model.padEnd(30)} ${row.kind.padEnd(6)} ${String(row.count).padStart(4)} run(s)  ${creditsText(row.credits, rate)}`);
      }
      if (costs.observed.length > 0) {
        lines.push("Prices learned from this account's own bills:");
        for (const row of costs.observed) {
          lines.push(`  ${row.signature.padEnd(44)} ${creditsText(row.credits, rate)} from ${row.samples} sample(s)`);
        }
      }
      if (rate === null) lines.push("No credit rate set, so no dollar figures. Set one with: bb plugin config comfy-cloud set creditRate 211");
      return lines.join("\n");
    }

    // ---------- CLI ----------
    bb.cli.register({
      name: "comfy",
      summary: "Generate images and videos on Comfy Cloud, list and inspect the results",
      commands: [
        {
          name: "image",
          summary: "Generate an image (waits; --no-wait to return at once)",
          usage: "bb comfy image <prompt...> [--size <preset>] [--aspect <r>] [--resolution <tier>] [--width N] [--height N] [--count N] [--model <key>] [--reference <asset id or path>]... [--seed N] [--negative <text>] [--extra name=value,...] [--no-wait]",
        },
        {
          name: "video",
          summary: "Generate a video (waits; --no-wait to return at once)",
          usage: "bb comfy video <prompt...> [--resolution <tier>] [--aspect <ratio>] [--duration N] [--model <key>] [--audio] [--reference <asset id or path>]... [--seed N] [--negative <text>] [--extra name=value,...] [--no-wait]",
        },
        {
          name: "run",
          summary: "Submit a workflow JSON file that lives on the bb server's disk",
          usage: "bb comfy run <workflow.json path on the bb server> [--kind image|video] [--prompt <text>] [--parent <id>] [--no-wait]",
        },
        { name: "list", summary: "List assets, newest first", usage: "bb comfy list [--kind image|video] [--status s] [--starred] [--limit N] [--query text] [--json]" },
        { name: "show", summary: "One asset, optionally with its workflow and job record", usage: "bb comfy show <id> [--workflow] [--job] [--json]" },
        { name: "retry", summary: "Resubmit an asset's workflow as a new asset", usage: "bb comfy retry <id> [--new-seed] [--no-wait]" },
        { name: "cancel", summary: "Stop tracking a queued or running asset", usage: "bb comfy cancel <id>" },
        { name: "star", summary: "Star an asset", usage: "bb comfy star <id>" },
        { name: "unstar", summary: "Remove the star", usage: "bb comfy unstar <id>" },
        { name: "delete", summary: "Delete an asset and its files", usage: "bb comfy delete <id>" },
        { name: "costs", summary: "Credits left, what this plugin has spent, and the per model breakdown", usage: "bb comfy costs [--days N] [--json]" },
        { name: "status", summary: "Configured?, key source, credits left, models, counts, asset dir", usage: "bb comfy status [--json]" },
        {
          name: "models",
          summary: "Every model, its capabilities and its price, cheapest first inside each vendor",
          usage: "bb comfy models [search words] [--kind image|video] [--vendor X] [--query text] [--all] [--json]",
        },
        { name: "sizes", summary: "Everything one model can be asked for: sizes, ratios, lengths and its own options", usage: "bb comfy sizes [--model <key>] [--json]" },
      ],
      async run(argv, ctx): Promise<PluginCliResult> {
        const { positional, flags, repeated } = parseArgs(argv);
        const json = flags.json === true;
        const [command, ...rest] = positional;
        const ok = (text: string, value?: unknown): PluginCliResult => ({ exitCode: 0, stdout: json && value !== undefined ? JSON.stringify(value, null, 2) : text });
        const bad = (text: string): PluginCliResult => ({ exitCode: 1, stderr: text });
        const source: AssetSource = "cli";

        async function waitAndReport(asset: Asset, waitMs: number): Promise<PluginCliResult> {
          if (flags["no-wait"] === true) {
            const cost = costLine(asset, creditRate());
            return ok(`${asset.id} queued${cost ? ` (${cost})` : ""}. Check with: bb comfy show ${asset.id}`, { asset });
          }
          let done = await runner.waitFor(asset.id, waitMs, ctx.signal);
          if (done.status === "completed") done = await awaitCost(done.id, COST_WAIT_MS, ctx.signal);
          if (json) return { exitCode: done.status === "failed" || done.status === "cancelled" || done.status === "unknown" ? 1 : 0, stdout: JSON.stringify({ asset: done }, null, 2) };
          if (done.status === "completed") {
            const seconds = Math.round(((done.completedAt ?? Date.now()) - done.createdAt) / 1000);
            const cost = costLine(done, creditRate());
            return ok(`${done.id} completed in ${seconds}s (${dimensions(done)}${done.mime ? `, ${done.mime}` : ""})${cost ? `\n${cost}` : ""}\n${done.path ?? ""}`);
          }
          if (done.status === "unknown") return bad(unknownText(done));
          if (isTerminal(done.status)) return bad(`${done.id} ${done.status}${done.error ? `: ${done.error}` : ""}`);
          return ok(`${done.id} is still ${done.status} after ${Math.round(waitMs / 60_000)} minutes. Check with: bb comfy show ${done.id}`);
        }

        function requireKey(): PluginCliResult | null {
          return keyState().key === null ? bad(CONFIGURE_HINT) : null;
        }

        try {
          switch (command) {
            case undefined:
            case "help":
              return ok(USAGE, { usage: USAGE });
            case "image": {
              const prompt = rest.join(" ").trim();
              if (prompt === "") return bad("Usage: bb comfy image <prompt...> [--size <preset>] [--aspect <r>] [--resolution <tier>] [--width N] [--height N] [--count N] [--model <key>] [--reference <asset id or path>]... [--seed N] [--negative <text>] [--extra name=value,...] [--no-wait]");
              const missing = requireKey();
              if (missing) return missing;
              const asset = await generateImage(
                {
                  prompt,
                  sizePreset: flagString(flags, "size"),
                  aspect: flagString(flags, "aspect"),
                  resolution: flagString(flags, "resolution"),
                  width: flagInt(flags, "width"),
                  height: flagInt(flags, "height"),
                  count: flagInt(flags, "count"),
                  model: flagString(flags, "model"),
                  references: flagList(repeated, "reference"),
                  seed: flagInt(flags, "seed"),
                  negativePrompt: flagString(flags, "negative"),
                  extras: parseExtras(flagString(flags, "extra")),
                  threadId: ctx.threadId,
                  source,
                },
                { cwd: ctx.cwd, signal: ctx.signal },
              );
              return waitAndReport(asset, IMAGE_WAIT_MS);
            }
            case "video": {
              const prompt = rest.join(" ").trim();
              if (prompt === "") return bad("Usage: bb comfy video <prompt...> [--resolution <tier>] [--aspect <ratio>] [--duration N] [--model <key>] [--audio] [--reference <asset id or path>]... [--seed N] [--negative <text>] [--extra name=value,...] [--no-wait]");
              const missing = requireKey();
              if (missing) return missing;
              const asset = await generateVideo(
                {
                  prompt,
                  model: flagString(flags, "model"),
                  resolution: flagString(flags, "resolution"),
                  aspect: flagString(flags, "aspect"),
                  duration: flagInt(flags, "duration"),
                  generateAudio: flags.audio === true,
                  references: flagList(repeated, "reference"),
                  seed: flagInt(flags, "seed"),
                  negativePrompt: flagString(flags, "negative"),
                  extras: parseExtras(flagString(flags, "extra")),
                  threadId: ctx.threadId,
                  source,
                },
                { cwd: ctx.cwd, signal: ctx.signal },
              );
              return waitAndReport(asset, VIDEO_WAIT_MS);
            }
            case "run": {
              const file = rest[0];
              if (!file) return bad("Usage: bb comfy run <workflow.json path on the bb server> [--kind image|video] [--prompt <text>] [--parent <id>] [--no-wait]");
              const missing = requireKey();
              if (missing) return missing;
              const resolved = path.resolve(ctx.cwd ?? process.cwd(), file);
              let raw: unknown;
              try {
                raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
              } catch (cause) {
                return bad(`Cannot read ${resolved} on the bb server: ${errorText(cause)}`);
              }
              const parsed = workflowSchema.safeParse(sanitize(raw));
              if (!parsed.success) return bad(`${resolved} is not a ComfyUI API workflow: ${parsed.error.issues[0]?.message ?? "invalid"}`);
              const kindFlag = flagString(flags, "kind");
              const kind = kindFlag === undefined ? "auto" : z.enum(["image", "video", "auto"]).parse(kindFlag);
              const asset = runWorkflow({
                workflow: parsed.data,
                kind,
                prompt: flagString(flags, "prompt"),
                parentId: flagString(flags, "parent"),
                threadId: ctx.threadId,
                source,
              });
              return waitAndReport(asset, asset.kind === "video" ? VIDEO_WAIT_MS : IMAGE_WAIT_MS);
            }
            case "list": {
              const kindFlag = flagString(flags, "kind");
              const statusFlag = flagString(flags, "status");
              const limit = Math.min(CLI_MAX_ROWS, flagInt(flags, "limit") ?? 50);
              const assets = listAssets({
                kind: kindFlag === undefined ? undefined : assetKindSchema.parse(kindFlag),
                status: statusFlag === undefined ? undefined : assetStatusSchema.parse(statusFlag),
                starred: flags.starred === true ? true : undefined,
                query: flagString(flags, "query"),
                limit,
              });
              const text = assets.length === 0 ? "No assets." : [`${assets.length} asset(s), newest first:`, ...assets.map(assetLine)].join("\n");
              return ok(text, { assets });
            }
            case "show": {
              if (!rest[0]) return bad("Usage: bb comfy show <id> [--workflow] [--job] [--json]");
              const asset = mustGet(rest[0]);
              const parts = [describeAsset(asset, creditRate())];
              const value: Record<string, unknown> = { asset };
              if (flags.workflow === true) {
                const workflow = workflowOf(asset);
                value.workflow = workflow;
                parts.push("workflow JSON:", JSON.stringify(workflow, null, 2));
              }
              if (flags.job === true) {
                const job = jobOf(asset);
                value.job = job;
                parts.push("job record:", job === null ? "none yet" : JSON.stringify(job, null, 2));
              }
              return ok(parts.join("\n"), value);
            }
            case "retry": {
              if (!rest[0]) return bad("Usage: bb comfy retry <id> [--new-seed] [--no-wait]");
              const missing = requireKey();
              if (missing) return missing;
              const asset = await retryAsset(rest[0], flags["new-seed"] === true, source, ctx.threadId, ctx.signal);
              return waitAndReport(asset, asset.kind === "video" ? VIDEO_WAIT_MS : IMAGE_WAIT_MS);
            }
            case "cancel": {
              if (!rest[0]) return bad("Usage: bb comfy cancel <id>");
              const asset = cancelAsset(rest[0]);
              return ok(`${asset.id} cancelled.`, { asset });
            }
            case "star":
            case "unstar": {
              if (!rest[0]) return bad(`Usage: bb comfy ${command} <id>`);
              const asset = starAsset(rest[0], command === "star");
              return ok(`${asset.id} ${asset.starred ? "starred" : "unstarred"}.`, { asset });
            }
            case "delete": {
              if (!rest[0]) return bad("Usage: bb comfy delete <id>");
              const text = deleteAsset(rest[0]);
              return ok(text, { ok: true, text });
            }
            case "costs": {
              await ensureBalance();
              const costs = costsInfo(flagInt(flags, "days") ?? COSTS_DEFAULT_DAYS);
              return ok(costsText(costs), costs);
            }
            case "status": {
              const s = await statusFresh();
              return ok(statusText(s), s);
            }
            case "models": {
              const kindFlag = flagString(flags, "kind");
              const filter = {
                kind: kindFlag === undefined ? undefined : assetKindSchema.parse(kindFlag),
                vendor: flagString(flags, "vendor"),
                query: flagString(flags, "query") ?? (rest.length > 0 ? rest.join(" ") : undefined),
                all: flags.all === true,
              };
              return ok(modelsText(filter), modelsResult(filter));
            }
            case "sizes": {
              const modelFlag = flagString(flags, "model");
              const entry = getModel(modelFlag ?? imageModel());
              if (entry === null) return bad(`Unknown model "${modelFlag}". Run: bb comfy models`);
              const caps = capabilitiesOf(entry);
              const lines = [`${entry.label} (${entry.key}):`];
              if (caps.sizePresets.length > 0) lines.push("  size presets:", ...caps.sizePresets.map((p) => `    ${p}`));
              if (caps.resolutions.length > 0) lines.push(`  resolutions: ${caps.resolutions.join(", ")}`);
              if (caps.aspects.length > 0) lines.push(`  aspect ratios: ${caps.aspects.join(", ")}`);
              if (caps.dimensions !== null) {
                lines.push(
                  `  width ${caps.dimensions.widthMin} to ${caps.dimensions.widthMax}, height ${caps.dimensions.heightMin} to ${caps.dimensions.heightMax}, step ${caps.dimensions.step}`,
                );
              }
              if (caps.duration !== null) lines.push(`  length ${caps.duration.min} to ${caps.duration.max} s`);
              if (caps.referenceImages != null) lines.push(`  reference images: up to ${caps.referenceImages.max} (--reference <asset id or path>, repeat for more)`);
              if (lines.length === 1) lines.push("  one fixed size; nothing to choose");
              // Everything else the node declares, which is what --extra and
              // the tools' `extras` bag reach. Without this an agent cannot
              // discover that Ideogram has a quality tier at a third the price.
              const extras = extrasOf(entry);
              if (extras.length > 0) {
                lines.push("  options (--extra name=value):");
                for (const extra of extras) {
                  const range = extra.options !== undefined ? extra.options.join(", ") : [extra.min, extra.max].every((n) => typeof n === "number") ? `${extra.min} to ${extra.max}` : extra.type.toLowerCase();
                  lines.push(`    ${extra.name} = ${range}${extra.default === undefined ? "" : ` (default ${String(extra.default)})`}`);
                }
              }
              return ok(lines.join("\n"), { model: entry.key, ...caps, extras });
            }
            default:
              return bad(`Unknown command "${command}".\n${USAGE}`);
          }
        } catch (cause) {
          if (cause instanceof z.ZodError) {
            const issue = cause.issues[0];
            return bad(issue ? `${issue.path.join(".") || "value"}: ${issue.message}` : "invalid value");
          }
          return bad(errorText(cause));
        }
      },
    });

    bb.onDispose(() => {
      if (publishTimer) clearTimeout(publishTimer);
      publishTimer = null;
    });

    const initial = keyState();
    bb.log.info(`comfy-cloud loaded; key source: ${initial.source ?? "none"}; asset dir: ${assetDir()}`);
    if (initial.key === null) bb.status.needsConfiguration(CONFIGURE_HINT);
  };
}

export default createPlugin();
