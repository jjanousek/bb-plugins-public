// comfy.ts: the Comfy Cloud HTTP client plus the pure helpers around its JSON
// shapes (job records, status payloads, outputs). No bb API here, so it is
// unit-testable with a stubbed fetch.
//
// The API as this client uses it (fixtures in test/fixtures):
//   POST /api/prompt            -> { prompt_id, node_errors }
//   GET  /api/job/<id>/status   -> { status: executing|success|error, error_message? }
//   GET  /api/jobs/<id>         -> full job; outputs[node].images[] for images and videos
//   GET  /api/view?filename=..  -> 302 to a signed storage URL; follow it
//   GET  /api/object_info       -> large, cache it on disk
//   POST /api/upload/image      -> multipart, field "image"; { name, subfolder, type }
//   GET  /api/billing/balance   -> a balance in US cents, despite the _micros field names
//   GET  /api/billing/events    -> { events, page, totalPages }, newest first, one per generation
// Every request carries X-API-Key; partner nodes also need the key as
// extra_data.api_key_comfy_org in the submit body. The job record echoes that
// extra_data, so every record leaving this module is sanitized.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { AssetKind, JsonValue, Workflow } from "./contract";
import { CREDITS_PER_USD } from "./contract";

export const COMFY_BASE_URL = "https://cloud.comfy.org";
/** Keys that carry the API key inside Comfy request and job bodies. */
const SECRET_KEYS = new Set(["extra_data", "api_key_comfy_org"]);
const BODY_EXCERPT = 300;

export class ComfyError extends Error {
  readonly httpStatus: number | null;
  /** True when retrying the same request cannot succeed (rejected graph, bad key, unknown job). */
  readonly permanent: boolean;
  /**
   * True only when Comfy Cloud certainly did not act on the request: it never
   * left the box (the name did not resolve, the connection was refused) or
   * Comfy answered with a refusal (any 4xx, or a graph it rejected). A
   * timeout, a reset, a 5xx or an unreadable 200 may have been acted on,
   * which is what makes a lost submit reply dangerous to send again.
   */
  readonly notAccepted: boolean;
  constructor(message: string, httpStatus: number | null, permanent: boolean, notAccepted = false) {
    super(message);
    this.name = "ComfyError";
    this.httpStatus = httpStatus;
    this.permanent = permanent;
    this.notAccepted = notAccepted;
  }
}

/**
 * Error codes Node's fetch raises before a single byte of the request leaves
 * the box: name resolution and the TCP connect. A bad host name is
 * `TypeError: fetch failed` with a cause whose code is ENOTFOUND, and a
 * resolver that cannot answer yet gives EAI_AGAIN. A
 * timeout carries no code at all, and is not on this list.
 */
const UNSENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

export function neverSent(cause: unknown): boolean {
  const code = (cause as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && UNSENT_CODES.has(code);
}

export function errorText(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause;
    const detail = inner instanceof Error ? ` (${inner.message})` : "";
    return `${cause.message}${detail}`;
  }
  return String(cause);
}

/** Replace every occurrence of the key in free text. */
export function redact(text: string, key: string | null | undefined): string {
  if (!key) return text;
  return text.split(key).join("[redacted]");
}

/**
 * Deep copy as plain JSON with every `extra_data` and `api_key_comfy_org`
 * key removed and any string containing the key redacted.
 */
export function sanitize(value: unknown, key?: string | null): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return key && value.includes(key) ? redact(value, key) : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
  if (typeof value === "object") {
    const out: { [k: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k)) continue;
      out[k] = sanitize(v, key);
    }
    return out;
  }
  return null;
}

/** True when a serialized record still carries a key field. Used by tests and as a write guard. */
export function containsSecret(text: string): boolean {
  return text.includes("api_key_comfy_org") || text.includes('"extra_data"');
}

export function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * One readable line for an error text from Comfy Cloud. Validation failures
 * arrive as "Failed to send prompt request: request returned error status
 * 400: {json with error and node_errors}"; the json is unpacked into
 * "Workflow rejected: <message>; node 1 (<class>): <what is wrong> (<input>)".
 */
export function describeErrorText(text: string): string {
  const brace = text.indexOf("{");
  if (brace >= 0) {
    const embedded = parseJsonObject(text.slice(brace));
    if (embedded) {
      const detail = [formatError(embedded.error), formatNodeErrors(embedded.node_errors)].filter(Boolean).join("; ");
      if (detail !== "") return `Workflow rejected: ${detail}`;
    }
  }
  return firstLine(text);
}

/** Field names as a person would read them. */
const FIELD_LABELS: Record<string, string> = {
  width: "Width",
  height: "Height",
  seed: "Seed",
  duration: "Duration",
  resolution: "Resolution",
  aspect_ratio: "Aspect ratio",
  size_preset: "Size preset",
  prompt: "Prompt",
  model: "Model",
};

function fieldLabel(raw: string): string {
  const short = (raw.split(".").pop() ?? raw).trim();
  const known = FIELD_LABELS[short];
  if (known) return known;
  const spaced = short.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Plain sentence for an error text from Comfy Cloud, for `asset.error` and the
 * panel. The raw text stays in the job record. `model` is the asset's model, so
 * a range complaint can name it. Pure: unit tested in test/server.test.ts.
 */
export function friendlyError(text: string, model?: string | null): string {
  const raw = (text ?? "").trim();
  if (raw === "") return "The generation failed.";
  const forModel = model ? ` for ${model}` : "";

  const min = /Value (?:-?\d+(?:\.\d+)? )?smaller than min of (-?\d+(?:\.\d+)?)(?:\s*\(([\w.]+)\))?/.exec(raw);
  if (min) {
    const label = min[2] ? fieldLabel(min[2]) : "The value";
    return `${label} must be at least ${min[1]}${forModel}.`;
  }
  const max = /Value (?:-?\d+(?:\.\d+)? )?(?:bigger|greater|larger) than max of (-?\d+(?:\.\d+)?)(?:\s*\(([\w.]+)\))?/.exec(raw);
  if (max) {
    const label = max[2] ? fieldLabel(max[2]) : "The value";
    return `${label} must be at most ${max[1]}${forModel}.`;
  }

  // Comfy Cloud answers a model id the key cannot use with a "does not exist
  // or you do not have access" line; the sentence names the model when the
  // line does.
  if (/does not exist or you do not have access/i.test(raw)) {
    const named = /(?:model or endpoint|model)\s+([^\s,]+)\s+does not exist/i.exec(raw);
    const what = named?.[1] ?? model ?? "that model";
    return `${what} is not available to this Comfy Cloud account.`;
  }

  if (/\b(timed out|timeout|TimeoutError|aborted due to timeout)\b/i.test(raw)) {
    return "Comfy Cloud did not answer in time. Try again.";
  }
  if (/\b(AbortError|The operation was aborted)\b/i.test(raw)) {
    return "The request was stopped before Comfy Cloud answered.";
  }
  if (/\b(fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|network)\b/i.test(raw)) {
    return "Could not reach Comfy Cloud. Check the connection and try again.";
  }
  if (/HTTP 401|HTTP 403|Unauthorized|Forbidden|invalid api key/i.test(raw)) {
    return "Comfy Cloud refused the API key. Check the key in settings.";
  }
  if (/HTTP 429|rate limit/i.test(raw)) {
    return "Comfy Cloud is rate limiting this account. Wait a moment and try again.";
  }

  const rejected = /^(?:Workflow rejected|Comfy Cloud rejected the workflow): (.*)$/s.exec(raw);
  if (rejected) {
    const detail = (rejected[1] ?? "").trim();
    const node = /node \d+ \([^)]*\): ([^;]+?)(?:\s*\(([\w.]+)\))?(?:;|$)/.exec(detail);
    if (node) {
      const reason = (node[1] ?? "").trim();
      const field = node[2] ? `${node[2]}: ` : "";
      return `Comfy rejected the workflow: ${field}${reason}`;
    }
    return `Comfy rejected the workflow: ${firstLine(detail)}`;
  }

  return firstLine(raw) || "The generation failed.";
}

/** `/api/job/<id>/status` puts a JSON string in `error_message`; users get its exception_message. */
export function parseStatusError(errorMessage: unknown): string {
  if (typeof errorMessage !== "string" || errorMessage.trim() === "") return "Comfy job failed";
  const parsed = parseJsonObject(errorMessage);
  if (parsed && typeof parsed.exception_message === "string") {
    const line = describeErrorText(parsed.exception_message);
    if (line !== "") return line;
  }
  return describeErrorText(errorMessage) || "Comfy job failed";
}

/** First line of `execution_error.exception_message` from a `/api/jobs/<id>` record. */
export function jobErrorMessage(job: unknown): string | null {
  const record = job as { execution_error?: { exception_message?: unknown } } | null;
  const message = record?.execution_error?.exception_message;
  if (typeof message === "string") return describeErrorText(message) || "Comfy job failed";
  return null;
}

export interface ComfyOutput {
  nodeId: string;
  filename: string;
  subfolder: string;
  type: string;
  animated: boolean;
}

/** Every `images[]` entry across output nodes, in node id order. Videos are listed under images too. */
export function jobOutputs(job: unknown): ComfyOutput[] {
  const outputs = (job as { outputs?: unknown } | null)?.outputs;
  if (!outputs || typeof outputs !== "object") return [];
  const result: ComfyOutput[] = [];
  const nodeIds = Object.keys(outputs as Record<string, unknown>).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  for (const nodeId of nodeIds) {
    const node = (outputs as Record<string, unknown>)[nodeId] as { images?: unknown; animated?: unknown } | null;
    if (!node || typeof node !== "object" || !Array.isArray(node.images)) continue;
    const animated = Array.isArray(node.animated) && node.animated.some((flag) => flag === true);
    for (const image of node.images as unknown[]) {
      const entry = image as { filename?: unknown; subfolder?: unknown; type?: unknown } | null;
      if (!entry || typeof entry.filename !== "string") continue;
      result.push({
        nodeId,
        filename: entry.filename,
        subfolder: typeof entry.subfolder === "string" ? entry.subfolder : "",
        type: typeof entry.type === "string" && entry.type !== "" ? entry.type : "output",
        animated,
      });
    }
  }
  return result;
}

export function outputKind(output: ComfyOutput): AssetKind {
  return output.animated || /\.(mp4|webm|mov|mkv)$/i.test(output.filename) ? "video" : "image";
}

/** The first output; when a kind is preferred and present, the first output of that kind. */
export function pickOutput(job: unknown, prefer: AssetKind | null): ComfyOutput | null {
  const outputs = jobOutputs(job);
  if (prefer) {
    const match = outputs.find((output) => outputKind(output) === prefer);
    if (match) return match;
  }
  return outputs[0] ?? null;
}

export type JobState = "executing" | "success" | "error";
export interface JobStatus {
  state: JobState;
  /** Short user-facing message when `state` is "error". */
  error: string | null;
}

function mapState(status: unknown, errorOf: () => string): JobStatus {
  const s = typeof status === "string" ? status.toLowerCase() : "";
  if (s === "success" || s === "completed") return { state: "success", error: null };
  // "lost" and "non_retryable_error" are terminal on Comfy Cloud's own list of
  // job states; read as "still executing" they would keep a row waiting for
  // ever, and an unknown row is checked until its job ends.
  if (s === "error" || s === "failed" || s === "cancelled" || s === "lost" || s === "non_retryable_error") return { state: "error", error: errorOf() };
  return { state: "executing", error: null };
}

function formatNodeErrors(nodeErrors: unknown): string | null {
  if (!nodeErrors || typeof nodeErrors !== "object") return null;
  const parts: string[] = [];
  for (const [nodeId, value] of Object.entries(nodeErrors as Record<string, unknown>)) {
    const node = value as { class_type?: unknown; errors?: unknown } | null;
    const classType = typeof node?.class_type === "string" ? node.class_type : "node";
    const errors = Array.isArray(node?.errors) ? (node.errors as unknown[]) : [];
    if (errors.length === 0) {
      parts.push(`node ${nodeId} (${classType})`);
      continue;
    }
    for (const err of errors) {
      const e = err as { message?: unknown; details?: unknown } | null;
      const message = typeof e?.message === "string" ? e.message : "invalid input";
      const details = typeof e?.details === "string" && e.details !== "" ? ` (${e.details})` : "";
      parts.push(`node ${nodeId} (${classType}): ${message}${details}`);
    }
  }
  return parts.length === 0 ? null : parts.join("; ");
}

function formatError(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  const e = error as { message?: unknown; details?: unknown };
  const message = typeof e.message === "string" ? e.message : JSON.stringify(error);
  const details = typeof e.details === "string" && e.details !== "" ? ` (${e.details})` : "";
  return `${message}${details}`;
}

function permanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

// ---------- uploads ----------

/** One image uploaded to Comfy Cloud's input storage. */
export interface UploadedImage {
  /** The name a LoadImage node's `image` input takes. Content addressed: sha256 plus the extension. */
  name: string;
  subfolder: string;
  type: string;
}

/** Uploads remembered per client, so one file is never sent twice in a session. */
const UPLOAD_CACHE_MAX = 200;

/** A file name Comfy Cloud is happy to echo back. The bytes decide the stored name, so this is cosmetic. */
export function uploadFilename(filename: string): string {
  const base = (filename.split(/[\\/]/).pop() ?? "").trim();
  const safe = base.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(-80);
  return safe === "" ? "reference.png" : safe;
}

// ---------- billing ----------

export interface BillingBalance {
  /** Credits left. */
  credits: number;
  /** The same balance in US dollars. */
  usd: number;
}

/** One `api_usage_completed` row, reduced to the fields we use. Never carries a prompt or a key. */
export interface BillingEvent {
  /** The Comfy prompt id of the generation this charge belongs to. */
  jobId: string | null;
  credits: number | null;
  /** Model id Comfy billed under, e.g. "seedream-5-0-pro-260628". */
  model: string | null;
  /** "standard" or "large" on Seedream; absent on video. */
  outputTier: string | null;
  createdAt: number | null;
}

export interface BillingPage {
  events: BillingEvent[];
  page: number;
  totalPages: number;
}

export interface BillingEventsOptions extends CallOptions {
  page?: number;
  limit?: number;
}

function firstNumber(source: Record<string, unknown>, names: readonly string[]): number | null {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

/**
 * Reduce one billing page to the fields the plugin stores.
 *
 * The raw event carries `params.prompt`, which can be long and is the user's
 * own text, and the payload is never written anywhere, so only the five fields
 * above survive. Pure: unit tested in test/server.test.ts.
 */
export function parseBillingPage(data: unknown, key?: string | null): BillingPage {
  const record = (data ?? {}) as { events?: unknown; page?: unknown; totalPages?: unknown };
  const raw = Array.isArray(record.events) ? record.events : [];
  const events: BillingEvent[] = [];
  for (const entry of raw) {
    const event = entry as { params?: unknown; createdAt?: unknown } | null;
    const params = (event?.params ?? {}) as Record<string, unknown>;
    const jobId = typeof params.job_id === "string" && params.job_id !== "" ? redact(params.job_id, key) : null;
    const credits = firstNumber(params, ["credits_used"]);
    const model = typeof params.model === "string" && params.model !== "" ? redact(params.model, key) : null;
    const outputTier = typeof params.output_tier === "string" && params.output_tier !== "" ? params.output_tier : null;
    const at = typeof event?.createdAt === "string" ? Date.parse(event.createdAt) : NaN;
    events.push({ jobId, credits, model, outputTier, createdAt: Number.isFinite(at) ? at : null });
  }
  const page = typeof record.page === "number" && record.page > 0 ? record.page : 1;
  const totalPages = typeof record.totalPages === "number" && record.totalPages > 0 ? record.totalPages : 1;
  return { events, page, totalPages };
}

/** The charge for one Comfy job, or null when this page does not hold it. Ignores rows with no credits (older events and GPU time rows). */
export function findBillingEvent(events: readonly BillingEvent[], jobId: string): BillingEvent | null {
  return events.find((event) => event.jobId === jobId && typeof event.credits === "number" && event.credits > 0) ?? null;
}

// ---------- the job list ----------

export interface ListedJob {
  id: string;
  status: string;
  /** When Comfy Cloud created the job, in milliseconds. */
  createdAt: number;
}

export interface JobList {
  jobs: ListedJob[];
  hasMore: boolean;
}

export interface ListJobsOptions extends CallOptions {
  limit?: number;
  offset?: number;
}

/**
 * One page of `GET /api/jobs`. The published schema says `create_time` is in
 * seconds, while the service can answer in milliseconds. Both are read, so
 * the rule survives either side being corrected. Pure; the tests' fake job
 * list serves milliseconds.
 */
export function parseJobList(data: unknown): JobList {
  const record = (data ?? {}) as { jobs?: unknown; pagination?: { has_more?: unknown } };
  const jobs: ListedJob[] = [];
  for (const entry of Array.isArray(record.jobs) ? record.jobs : []) {
    const job = entry as { id?: unknown; status?: unknown; create_time?: unknown } | null;
    if (typeof job?.id !== "string" || job.id === "") continue;
    const raw = typeof job.create_time === "number" && Number.isFinite(job.create_time) ? job.create_time : null;
    if (raw === null) continue;
    jobs.push({ id: job.id, status: typeof job.status === "string" ? job.status : "", createdAt: raw < 1e12 ? raw * 1000 : raw });
  }
  return { jobs, hasMore: record.pagination?.has_more === true };
}

/** The graph a job record carries, as Comfy Cloud stored it, or null when the record has none. */
export function jobPrompt(job: unknown): Record<string, unknown> | null {
  const prompt = (job as { workflow?: { prompt?: unknown } } | null)?.workflow?.prompt;
  return prompt && typeof prompt === "object" && !Array.isArray(prompt) ? (prompt as Record<string, unknown>) : null;
}

/** JSON with every object's keys sorted, so two graphs compare by content and not by key order. */
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, sort(v)]),
          )
        : item;
  return JSON.stringify(sort(value));
}

export interface ComfyClientOptions {
  baseUrl?: string;
  /** Defaults to the global fetch, looked up per call so tests can stub it after import. */
  fetch?: typeof fetch;
}

/** Per-call abort. Every client method accepts one. */
export interface CallOptions {
  signal?: AbortSignal;
}

/** Request deadlines. Short for control calls, long for the two big transfers. */
export const SHORT_TIMEOUT_MS = 30_000;
export const LONG_TIMEOUT_MS = 180_000;

/** The caller's signal combined with a deadline, so a stalled request cannot block the queue. */
function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export function createComfyClient(options: ComfyClientOptions = {}) {
  const base = (options.baseUrl ?? COMFY_BASE_URL).replace(/\/$/, "");
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  /** sha256 of the bytes to the reply Comfy gave for them. Storage is content addressed, so this is exact. */
  const uploads = new Map<string, UploadedImage>();

  interface RequestInitLite {
    body?: unknown;
    /** Multipart body. Never set content-type beside it: fetch writes the boundary. */
    form?: FormData;
    accept?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    redirect?: RequestRedirect;
  }

  async function request(key: string, method: string, pathname: string, init: RequestInitLite = {}): Promise<Response> {
    const headers: Record<string, string> = { "X-API-Key": key, accept: init.accept ?? "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    try {
      return await fetchImpl(`${base}${pathname}`, {
        method,
        headers,
        body: init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
        redirect: init.redirect ?? "follow",
        signal: withDeadline(init.signal, init.timeoutMs ?? SHORT_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new ComfyError(`Comfy Cloud ${method} ${pathname.split("?")[0]}: ${redact(errorText(cause), key)}`, null, false, neverSent(cause));
    }
  }

  async function failFrom(res: Response, key: string, what: string): Promise<never> {
    const text = redact((await res.text().catch(() => "")).slice(0, BODY_EXCERPT).replace(/\s+/g, " ").trim(), key);
    // A 4xx is Comfy refusing the request, so nothing was started; a 5xx may
    // come from a proxy after the work was queued, so it proves nothing.
    throw new ComfyError(`Comfy Cloud ${what}: HTTP ${res.status}${text ? ` ${text}` : ""}`, res.status, permanentStatus(res.status), res.status >= 400 && res.status < 500);
  }

  async function readJson<T>(res: Response, key: string, what: string): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch (cause) {
      throw new ComfyError(`Comfy Cloud ${what}: bad JSON (${redact(errorText(cause), key)})`, res.status, false);
    }
  }

  return {
    /** Submit a graph. Rejected graphs throw a permanent ComfyError with the node errors. */
    async submit(key: string, workflow: Workflow, opts: CallOptions = {}): Promise<{ promptId: string }> {
      const res = await request(key, "POST", "/api/prompt", { body: { prompt: workflow, extra_data: { api_key_comfy_org: key } }, signal: opts.signal });
      if (!res.ok) await failFrom(res, key, "POST /api/prompt");
      const data = await readJson<{ prompt_id?: unknown; node_errors?: unknown; error?: unknown }>(res, key, "POST /api/prompt");
      const nodeErrors = formatNodeErrors(data.node_errors);
      const topError = formatError(data.error);
      if (topError || nodeErrors) {
        throw new ComfyError(`Comfy Cloud rejected the workflow: ${redact([topError, nodeErrors].filter(Boolean).join("; "), key)}`, res.status, true, true);
      }
      if (typeof data.prompt_id !== "string" || data.prompt_id === "") {
        throw new ComfyError("Comfy Cloud returned no prompt_id", res.status, true);
      }
      return { promptId: data.prompt_id };
    },

    /**
     * Upload one image so a LoadImage node can name it, and return the name
     * Comfy Cloud stored it under.
     *
     * Storage is content addressed by sha256, so the same bytes always come
     * back as the same name, `overwrite` is ignored, and there is no charge.
     * That is also why the result is cached on this client by the digest of the
     * bytes: the same reference image used twice in a session costs one round
     * trip, not two.
     */
    async uploadImage(key: string, bytes: Uint8Array, filename: string, opts: CallOptions = {}): Promise<UploadedImage> {
      const digest = createHash("sha256").update(bytes).digest("hex");
      const cached = uploads.get(digest);
      if (cached !== undefined) return cached;
      const form = new FormData();
      // The field name is "image", the legacy ComfyUI upload contract. Anything
      // else is accepted and then ignored, which looks like a working upload.
      // A fresh Uint8Array so the Blob owns a plain ArrayBuffer, whatever the caller read the file with.
      form.append("image", new Blob([new Uint8Array(bytes)]), uploadFilename(filename));
      form.append("type", "input");
      const res = await request(key, "POST", "/api/upload/image", { form, signal: opts.signal, timeoutMs: LONG_TIMEOUT_MS });
      if (!res.ok) await failFrom(res, key, "POST /api/upload/image");
      const data = await readJson<{ name?: unknown; subfolder?: unknown; type?: unknown }>(res, key, "POST /api/upload/image");
      if (typeof data.name !== "string" || data.name === "") {
        throw new ComfyError("Comfy Cloud POST /api/upload/image: the reply carries no file name", res.status, true);
      }
      const uploaded: UploadedImage = {
        name: redact(data.name, key),
        subfolder: typeof data.subfolder === "string" ? data.subfolder : "",
        type: typeof data.type === "string" && data.type !== "" ? data.type : "input",
      };
      if (uploads.size >= UPLOAD_CACHE_MAX) uploads.clear();
      uploads.set(digest, uploaded);
      return uploaded;
    },

    /** Poll one job. Falls back to /api/jobs/<id> when the status route answers 404. */
    async status(key: string, promptId: string, opts: CallOptions = {}): Promise<JobStatus> {
      const id = encodeURIComponent(promptId);
      const res = await request(key, "GET", `/api/job/${id}/status`, { signal: opts.signal });
      if (res.status === 404) {
        const fallback = await request(key, "GET", `/api/jobs/${id}`, { signal: opts.signal });
        if (!fallback.ok) await failFrom(fallback, key, "GET /api/jobs/<id>");
        const job = await readJson<{ status?: unknown }>(fallback, key, "GET /api/jobs/<id>");
        return mapState(job.status, () => redact(jobErrorMessage(job) ?? "Comfy job failed", key));
      }
      if (!res.ok) await failFrom(res, key, "GET /api/job/<id>/status");
      const data = await readJson<{ status?: unknown; error_message?: unknown }>(res, key, "GET /api/job/<id>/status");
      return mapState(data.status, () => redact(parseStatusError(data.error_message), key));
    },

    /**
     * The account's jobs, newest first, one page. Lightweight rows: no graph
     * and no outputs, so finding one job means reading its full record with
     * `job()`. Used to find a job whose submit reply was lost.
     */
    async listJobs(key: string, opts: ListJobsOptions = {}): Promise<JobList> {
      const limit = Math.min(1000, Math.max(1, Math.floor(opts.limit ?? 100)));
      const offset = Math.max(0, Math.floor(opts.offset ?? 0));
      const res = await request(key, "GET", `/api/jobs?limit=${limit}&offset=${offset}&sort_by=create_time&sort_order=desc`, { signal: opts.signal });
      if (!res.ok) await failFrom(res, key, "GET /api/jobs");
      const data = await readJson<Record<string, unknown>>(res, key, "GET /api/jobs");
      return parseJobList(data);
    },

    /** The full job record, sanitized (no extra_data, no key anywhere). */
    async job(key: string, promptId: string, opts: CallOptions = {}): Promise<JsonValue> {
      const res = await request(key, "GET", `/api/jobs/${encodeURIComponent(promptId)}`, { signal: opts.signal });
      if (!res.ok) await failFrom(res, key, "GET /api/jobs/<id>");
      const data = await readJson<unknown>(res, key, "GET /api/jobs/<id>");
      return sanitize(data, key);
    },

    /**
     * Download one output to `dest`, streaming to `<dest>.part` first.
     *
     * /api/view answers 302 to a signed storage URL. The redirect is followed
     * by hand with `redirect: "manual"` because Node's fetch keeps custom
     * headers across a cross origin redirect (it only strips Authorization,
     * Cookie and Host), which would hand the API key to storage.googleapis.com.
     * The second request carries no plugin headers at all.
     */
    async download(key: string, output: ComfyOutput, dest: string, opts: CallOptions = {}): Promise<{ mime: string | null; sizeBytes: number }> {
      const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: output.type || "output" });
      let res = await request(key, "GET", `/api/view?${query.toString()}`, {
        accept: "*/*",
        signal: opts.signal,
        timeoutMs: LONG_TIMEOUT_MS,
        redirect: "manual",
      });
      for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400; hop += 1) {
        const location = res.headers.get("location");
        if (!location) break;
        const target = new URL(location, `${base}/api/view`).toString();
        try {
          // No headers here on purpose: the signed URL needs none and must never see the key.
          res = await fetchImpl(target, { method: "GET", redirect: "manual", signal: withDeadline(opts.signal, LONG_TIMEOUT_MS) });
        } catch (cause) {
          throw new ComfyError(`Comfy Cloud download failed: ${redact(errorText(cause), key)}`, null, false);
        }
      }
      if (res.status >= 300 && res.status < 400) throw new ComfyError("Comfy Cloud GET /api/view: too many redirects", res.status, false);
      if (!res.ok) await failFrom(res, key, "GET /api/view");
      const body = res.body;
      if (!body) throw new ComfyError("Comfy Cloud GET /api/view: empty body", res.status, false);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const part = `${dest}.part`;
      try {
        await pipeline(Readable.fromWeb(body as unknown as NodeReadableStream), fs.createWriteStream(part), { signal: opts.signal });
        fs.renameSync(part, dest);
      } catch (cause) {
        fs.rmSync(part, { force: true });
        throw new ComfyError(`Comfy Cloud download failed: ${redact(errorText(cause), key)}`, null, false);
      }
      const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      const mime = type === "" || type === "application/octet-stream" || type === "binary/octet-stream" ? null : type;
      return { mime, sizeBytes: fs.statSync(dest).size };
    },

    /**
     * Credits left on the account.
     *
     * `/api/billing/balance` answers `{ effective_balance_micros, ... }` but
     * the numbers are US cents, not millionths. So this divides by 100 for
     * dollars and multiplies by CREDITS_PER_USD for credits.
     */
    async billingBalance(key: string, opts: CallOptions = {}): Promise<BillingBalance> {
      const res = await request(key, "GET", "/api/billing/balance", { signal: opts.signal });
      if (!res.ok) await failFrom(res, key, "GET /api/billing/balance");
      const data = await readJson<Record<string, unknown>>(res, key, "GET /api/billing/balance");
      const cents = firstNumber(data, ["effective_balance_micros", "amount_micros", "cloud_credit_balance_micros", "prepaid_balance_micros"]);
      if (cents === null) throw new ComfyError("Comfy Cloud GET /api/billing/balance: no balance field", res.status, false);
      const usd = cents / 100;
      return { usd: Math.round(usd * 10000) / 10000, credits: Math.round(usd * CREDITS_PER_USD * 100) / 100 };
    },

    /** One page of billing events, newest first. Page 1 is the newest 100. */
    async billingEvents(key: string, opts: BillingEventsOptions = {}): Promise<BillingPage> {
      const page = Math.max(1, Math.floor(opts.page ?? 1));
      const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 100)));
      const res = await request(key, "GET", `/api/billing/events?limit=${limit}&page=${page}`, { signal: opts.signal });
      if (!res.ok) await failFrom(res, key, "GET /api/billing/events");
      const data = await readJson<Record<string, unknown>>(res, key, "GET /api/billing/events");
      return parseBillingPage(data, key);
    },

    /** The whole node catalog. Large; callers cache it on disk. */
    async objectInfo(key: string, opts: CallOptions = {}): Promise<Record<string, unknown>> {
      const res = await request(key, "GET", "/api/object_info", { signal: opts.signal, timeoutMs: LONG_TIMEOUT_MS });
      if (!res.ok) await failFrom(res, key, "GET /api/object_info");
      const data = await readJson<unknown>(res, key, "GET /api/object_info");
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new ComfyError("Comfy Cloud GET /api/object_info: not an object", res.status, false);
      return data as Record<string, unknown>;
    },
  };
}

export type ComfyClient = ReturnType<typeof createComfyClient>;
