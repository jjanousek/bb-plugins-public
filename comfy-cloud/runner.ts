// runner.ts: the background job loop. Submits queued rows, polls running
// ones, downloads finished outputs next to their workflow JSON and probes
// media dimensions. Pure apart from the filesystem: bb wiring is injected.
//
// State machine per row:
//   queued  -> running   (submitted, comfyPromptId set, startedAt set)
//   queued  -> unknown   (a submit that may have reached Comfy Cloud got no
//                         answer, and its job cannot be found yet: see
//                         `submitRow`. Never sent again blindly.)
//   running -> completed (success, file downloaded, .job.json written)
//   running -> failed    (Comfy reported an error, or a permanent error about
//                         the job itself)
//   running -> unknown   (10 transient errors in a row, the key refused, or
//                         still running after 20 minutes: the plugin cannot
//                         say how the job ends, so it does not say "failed")
//   unknown -> running   (a check found the job again; it completes or fails
//                         from there)
//   queued/running/unknown -> cancelled (user action; handled by the server)
//
// A job Comfy Cloud finished has been paid for. Marking it failed because the
// network dropped or the run was long would drop the result and its bill, and
// a Retry would pay again. So a row is only marked failed on Comfy's own word,
// and an unknown row is checked once a minute until Comfy answers. Retry asks
// first too (`recover`).
//
// A completed row then waits for its bill: Comfy settles a charge on
// /api/billing/events seconds after the job finishes, so the loop looks the
// job id up on the next few ticks and writes actualCredits when it appears.
// Billing is never allowed to fail a generation that already succeeded.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Asset, AssetKind, Workflow } from "./contract";
import { ComfyError, canonicalJson, containsSecret, errorText, findBillingEvent, friendlyError, jobPrompt, pickOutput, redact, type BillingEvent, type ComfyClient, type JobStatus } from "./comfy";
import { assetCostSignature, priceKeyOf } from "./registry";
import { isTerminal, type Store } from "./store";
import { DERIVATIVE_REVISION, derivativePath, makeDerivative } from "./thumbs";

export const TICK_MS = 3_000;
/** Billing pages scanned per attempt. 100 events a page, newest first. */
export const BILLING_PAGES = 2;
/** Attempts before a completed asset is left with no actual cost. */
export const BILLING_TRIES = 5;
/** Milliseconds to wait after a miss before looking again: settlement is quick but eventual. */
export const BILLING_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000];
/**
 * Milliseconds to wait after a lookup that failed, by how many have failed in
 * a row. A failed lookup is the billing endpoint's outage, not the row's, so it
 * costs no try: the rows wait here until billing answers again.
 */
export const BILLING_OUTAGE_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];
export const MAX_IN_FLIGHT = 4;
export const RUNNING_TIMEOUT_MS = 20 * 60_000;
export const MAX_CONSECUTIVE_ERRORS = 10;
/** How often an unknown row asks Comfy Cloud about its job again. */
export const UNKNOWN_CHECK_MS = 60_000;
/**
 * How far past the submit a lost job is looked for. Comfy stamps a job when
 * it takes it, a moment after the request leaves; a minute either side covers
 * that and the two clocks, and the graph comparison does the rest.
 */
export const SUBMIT_MATCH_SLACK_MS = 60_000;
/** Newest jobs read when looking for a lost submit. An account can hold many jobs; a lost one is minutes old. */
export const SUBMIT_SEARCH_JOBS = 200;
/**
 * How long a lost submit is looked for before the row is left for the user.
 * By then a job that exists is long in the list; one that is not there was
 * never made, and only a person can decide to pay for it again.
 */
export const SUBMIT_SEARCH_MS = 30 * 60_000;

/** Why a row is unknown, in the words the panel and the CLI show. */
export const UNKNOWN_REASON = {
  unreachable: "Lost contact with Comfy Cloud while this job ran. It may have finished, so it is not marked failed; the plugin checks again every minute and fetches the result when Comfy Cloud answers.",
  refused: "Comfy Cloud refused the API key while this job ran, so the plugin cannot see how it ended. It checks again every minute; fix the key in settings and the result is fetched if the job finished.",
  submit: "The request may have reached Comfy Cloud, but no answer came back. It is not sent again, which could pay twice; the plugin looks for the job in Comfy Cloud's job list every minute.",
  unfound: "The request may have reached Comfy Cloud, but the job cannot be found in its job list. It is not sent again, which could pay twice. Retry sends it once more if you want a new one.",
  slow: "Still running on Comfy Cloud after 20 minutes. The plugin checks again every minute and fetches the result if it finishes.",
  fetch: "Comfy Cloud finished this job, but its result could not be fetched. It is not marked failed; the plugin tries again every minute.",
} as const;

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);
const VIDEO_EXTS = new Set(["mp4", "webm"]);
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
};
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export interface ImageSize {
  width: number;
  height: number;
}

export interface VideoProbe {
  width: number | null;
  height: number | null;
  durationS: number | null;
}

/** Dimensions from PNG, JPEG or WebP header bytes. */
export function imageDimensions(buf: Buffer): ImageSize | null {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1] as number;
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const length = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + length;
    }
    return null;
  }
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const b0 = buf[21] as number;
      const b1 = buf[22] as number;
      const b2 = buf[23] as number;
      const b3 = buf[24] as number;
      return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return null;
}

export function probeImage(file: string): ImageSize | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(512 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return imageDimensions(buf.subarray(0, n));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * A path under the asset root as the panel needs it: relative, forward slashes.
 * The columns hold the same shape as `file` so `previewUrl` can take them
 * straight, and the absolute path is always derivable from the row's own.
 */
export function relativeToRoot(root: string, file: string): string {
  const relative = path.relative(root, file);
  return relative.startsWith("..") ? path.basename(file) : relative.split(path.sep).join("/");
}

/**
 * Both small copies of one asset. Never throws: a generation that succeeded
 * must not be reported as failed because ffmpeg was missing or slow, so a
 * failure is logged and the column stays null.
 */
export async function makeDerivatives(
  file: string,
  kind: AssetKind,
  root: string,
  warn: (message: string) => void,
): Promise<{ thumbPath: string | null; mediumPath: string | null }> {
  const thumb = await makeDerivative(file, "thumb", kind);
  // A video's medium would be a still of a clip the viewer plays in full, so
  // only the poster frame is worth making.
  const medium = kind === "video" ? null : await makeDerivative(file, "medium", kind);
  if (thumb === null) warn("could not make a thumbnail; the grid will use the original");
  else if (kind !== "video" && medium === null) warn("could not make a view copy; the viewer will show the original");
  return {
    thumbPath: thumb === null ? null : relativeToRoot(root, thumb),
    mediumPath: medium === null ? null : relativeToRoot(root, medium),
  };
}

/**
 * True when a row has every small copy its kind gets: a thumbnail, and for an
 * image a view copy too. Only a complete set is recorded at the current
 * DERIVATIVE_REVISION, so a half made pair is tried again at the next start.
 */
function completeSet(kind: AssetKind, derivatives: { thumbPath: string | null; mediumPath: string | null }): boolean {
  return derivatives.thumbPath !== null && (kind === "video" || derivatives.mediumPath !== null);
}

/** Width, height and duration through `ffprobe` on PATH; null when it is missing or fails. */
export function probeVideo(file: string): Promise<VideoProbe | null> {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file],
      { timeout: 20_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          const parsed = JSON.parse(stdout) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
          const stream = parsed.streams?.[0];
          const duration = Number(parsed.format?.duration);
          resolve({
            width: typeof stream?.width === "number" ? stream.width : null,
            height: typeof stream?.height === "number" ? stream.height : null,
            durationS: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : null,
          });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

export function extensionFor(filename: string, mime: string | null, kind: AssetKind): string {
  const fromName = path.extname(filename).slice(1).toLowerCase();
  if (IMAGE_EXTS.has(fromName) || VIDEO_EXTS.has(fromName)) return fromName === "jpeg" ? "jpg" : fromName;
  if (mime && EXT_BY_MIME[mime]) return EXT_BY_MIME[mime] as string;
  return kind === "video" ? "mp4" : "png";
}

export function mimeFor(ext: string): string | null {
  return MIME_BY_EXT[ext] ?? null;
}

export interface RunnerLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RunnerDeps {
  store: Store;
  client: ComfyClient;
  /** Re-read on every tick; null means "not configured", rows wait. */
  getKey: () => string | null;
  assetDir: () => string;
  log: RunnerLog;
  /** Called after every row change. */
  onChange: (assetId: string) => void;
  tickMs?: number;
  maxInFlight?: number;
  runningTimeoutMs?: number;
  maxConsecutiveErrors?: number;
  unknownCheckMs?: number;
  probeVideo?: (file: string) => Promise<VideoProbe | null>;
  now?: () => number;
}

export function readWorkflowFile(file: string): Workflow {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a workflow object`);
  return parsed as Workflow;
}

export function createRunner(deps: RunnerDeps) {
  const tickMs = deps.tickMs ?? TICK_MS;
  const maxInFlight = deps.maxInFlight ?? MAX_IN_FLIGHT;
  const runningTimeoutMs = deps.runningTimeoutMs ?? RUNNING_TIMEOUT_MS;
  const maxErrors = deps.maxConsecutiveErrors ?? MAX_CONSECUTIVE_ERRORS;
  const unknownCheckMs = deps.unknownCheckMs ?? UNKNOWN_CHECK_MS;
  const videoProbe = deps.probeVideo ?? probeVideo;
  const now = deps.now ?? (() => Date.now());
  const { store, client, log } = deps;

  /** Consecutive transient errors per row; cleared on any success. */
  const errors = new Map<string, number>();
  /** When each unknown row next asks Comfy Cloud about its job. Empty after a start, so every one is checked at once. */
  const unknownNext = new Map<string, number>();
  /** Lost submits whose search failed and that have said so; cleared when a search works again. */
  const searchWarned = new Set<string>();
  /** Comfy job ids already given to a row, so one job is never claimed by two identical requests. */
  const claimed = (): Set<string> => {
    const ids = new Set<string>();
    for (const status of ["running", "completed", "failed", "cancelled", "unknown"] as const) {
      for (const row of store.byStatus(status)) if (row.comfyPromptId) ids.add(row.comfyPromptId);
    }
    return ids;
  };
  /** Completed rows still waiting for Comfy to settle their charge. */
  const billing = new Map<string, { promptId: string; tries: number; nextAt: number }>();
  /** When the current run of failed billing lookups began, or null while they work. */
  let billingDownSince: number | null = null;
  /** Failed billing lookups in a row, for the outage backoff. */
  let billingFailures = 0;
  let warnedNoKey = false;
  let wake: (() => void) | null = null;
  let ticking = false;

  /**
   * Mark a row failed, but only while it still has the status the caller saw.
   * A row cancelled or deleted during an awaited call must stay that way.
   */
  function fail(asset: Asset, message: string, expected: Asset["status"] = asset.status): void {
    errors.delete(asset.id);
    const text = message.slice(0, 1000);
    const written = store.updateIf(asset.id, expected, { status: "failed", error: text, completedAt: now() });
    if (!written) {
      log.info(`${asset.id} is no longer ${expected}, dropping the failure: ${text}`);
      return;
    }
    log.warn(`${asset.id} failed: ${text}`);
    deps.onChange(asset.id);
  }

  /** Plain sentence for the panel; the raw text stays in the log and the job record. */
  function display(asset: Asset, message: string): string {
    return friendlyError(message, asset.model);
  }

  /**
   * Stop waiting on a row whose outcome the plugin cannot tell yet. Only a
   * submitted row gets here, so its job may well finish and be billed: it is
   * checked again every `unknownCheckMs` rather than marked failed.
   */
  function markUnknown(asset: Asset, reason: string, expected: Asset["status"], detail = ""): void {
    errors.delete(asset.id);
    if (!store.updateIf(asset.id, expected, { status: "unknown", error: reason })) {
      log.info(`${asset.id} is no longer ${expected}, not marking it unknown`);
      return;
    }
    unknownNext.set(asset.id, now() + unknownCheckMs);
    log.warn(`${asset.id} is unknown: ${reason}${detail === "" ? "" : ` (${detail})`}`);
    deps.onChange(asset.id);
  }

  function transient(asset: Asset, cause: unknown, expected: Asset["status"], reason: string = UNKNOWN_REASON.unreachable): void {
    const count = (errors.get(asset.id) ?? 0) + 1;
    errors.set(asset.id, count);
    const message = redact(errorText(cause), deps.getKey());
    if (count >= maxErrors) {
      // A submitted row's job lives on at Comfy Cloud whatever happens to the
      // connection; only a row that was never sent can fail here.
      if (expected === "running") {
        markUnknown(asset, reason, expected, `after ${count} errors: ${message}`);
        return;
      }
      log.warn(`${asset.id} gave up after ${count} errors: ${message}`);
      fail(asset, `${display(asset, message)} (gave up after ${count} tries)`, expected);
      return;
    }
    log.warn(`${asset.id}: ${message} (error ${count} of ${maxErrors}, retrying next tick)`);
  }

  function handleError(asset: Asset, cause: unknown, expected: Asset["status"], signal?: AbortSignal): void {
    // The service is stopping (a reload or a restart): the call was cut off
    // on purpose, the row is untouched and the next start picks it up. It is
    // neither a warning nor one of the row's ten tries.
    if (signal?.aborted) {
      log.info(`${asset.id}: stopped mid call for a shutdown; it resumes at the next start`);
      return;
    }
    // A refused key says nothing about a job that is already running: it may
    // finish and be billed all the same.
    if (expected === "running" && cause instanceof ComfyError && (cause.httpStatus === 401 || cause.httpStatus === 403)) {
      markUnknown(asset, UNKNOWN_REASON.refused, expected, redact(cause.message, deps.getKey()));
      return;
    }
    if (cause instanceof ComfyError && cause.permanent) {
      const message = redact(cause.message, deps.getKey());
      log.warn(`${asset.id} permanent error: ${message}`);
      fail(asset, display(asset, message), expected);
    } else {
      transient(asset, cause, expected);
    }
  }

  // ---------- billing ----------

  /**
   * Write one settled charge onto its asset and remember it as a price sample.
   * Only ever touches a row that is still completed, so a row cancelled or
   * deleted in the meantime is left alone.
   */
  function applyCost(assetId: string, event: BillingEvent): boolean {
    const asset = store.get(assetId);
    if (!asset || asset.status !== "completed" || typeof event.credits !== "number" || event.credits <= 0) return false;
    store.update(assetId, { actualCredits: event.credits, billedModel: event.model, outputTier: event.outputTier });
    store.addCostSample({
      signature: assetCostSignature(asset),
      kind: asset.kind,
      model: priceKeyOf(asset.model),
      credits: event.credits,
      assetId,
      createdAt: asset.completedAt ?? asset.createdAt,
    });
    const estimated = asset.estimatedCredits;
    const gap = typeof estimated === "number" ? `, estimated ${estimated}` : "";
    log.info(`${assetId} billed ${event.credits} credits${event.model ? ` as ${event.model}` : ""}${gap}`);
    deps.onChange(assetId);
    return true;
  }

  /** Queue a finished row for its charge. Called once, right after it completes. */
  function watchBilling(asset: Asset, promptId: string): void {
    billing.set(asset.id, { promptId, tries: 0, nextAt: now() });
  }

  /**
   * Look every waiting row up in one pass over the newest billing pages.
   * Never throws: a completed generation must not be disturbed because the
   * bill was slow.
   *
   * Only a lookup that worked uses up a try. A row gets BILLING_TRIES looks at
   * the events because a few models never publish one, not because the
   * endpoint may be down: a lookup that failed
   * says nothing about the row, so during a billing outage the rows wait on
   * the outage backoff and their charges are recorded when billing answers
   * again.
   */
  async function settleBilling(key: string, signal?: AbortSignal): Promise<void> {
    const due = [...billing.entries()].filter(([, entry]) => entry.nextAt <= now());
    if (due.length === 0) return;
    const waiting = new Map(due);
    let looked = false;
    try {
      for (let page = 1; page <= BILLING_PAGES && waiting.size > 0; page += 1) {
        const result = await client.billingEvents(key, { page, limit: 100, signal });
        for (const [id, entry] of [...waiting]) {
          const event = findBillingEvent(result.events, entry.promptId);
          if (!event) continue;
          waiting.delete(id);
          billing.delete(id);
          applyCost(id, event);
        }
        if (page >= result.totalPages) break;
      }
      looked = true;
    } catch (cause) {
      if (signal?.aborted) {
        log.info("billing lookup stopped for a shutdown");
        return;
      }
      billingFailures += 1;
      // Once per outage, the way the balance warns: every waiting row retries
      // on the backoff, and a warning per attempt says nothing new.
      if (billingDownSince === null) {
        billingDownSince = now();
        log.warn(`billing lookup failed: ${redact(errorText(cause), deps.getKey())} (the generations are fine; their charges are recorded when billing answers again)`);
      }
    }
    if (looked && billingDownSince !== null) {
      log.info(`billing lookups work again after ${Math.round((now() - billingDownSince) / 60_000)} min`);
      billingDownSince = null;
      billingFailures = 0;
    }
    for (const [id, entry] of waiting) {
      if (store.get(id)?.status !== "completed") {
        billing.delete(id);
        continue;
      }
      if (!looked) {
        entry.nextAt = now() + (BILLING_OUTAGE_BACKOFF_MS[Math.min(billingFailures - 1, BILLING_OUTAGE_BACKOFF_MS.length - 1)] as number);
        continue;
      }
      entry.tries += 1;
      if (entry.tries >= BILLING_TRIES) {
        billing.delete(id);
        log.info(`${id}: no billing event after ${entry.tries} tries; its actual cost stays unknown`);
        continue;
      }
      entry.nextAt = now() + (BILLING_BACKOFF_MS[Math.min(entry.tries - 1, BILLING_BACKOFF_MS.length - 1)] as number);
    }
  }

  /**
   * Derivatives for rows that predate them, or that were made at an older
   * DERIVATIVE_REVISION (thumbs.ts), run once at start the way `backfillCosts`
   * is. Sequential on purpose: a burst of ffmpeg processes on the server
   * would be felt by everything else on it. Bounded by
   * `limit` and it stops between rows when the service shuts down.
   *
   * A regeneration writes the new copy under the same name (through a `.part`
   * file and a rename), so a copy that fails to regenerate leaves the old one
   * and its column in place rather than blanking a tile that was working.
   */
  async function backfillDerivatives(limit = 500, signal?: AbortSignal): Promise<number> {
    let made = 0;
    for (const asset of store.needsDerivatives(limit, DERIVATIVE_REVISION)) {
      if (signal?.aborted) break;
      if (asset.path === null || !fs.existsSync(asset.path)) continue;
      const derivatives = await makeDerivatives(asset.path, asset.kind, deps.assetDir(), (message) => log.warn(`${asset.id}: ${message}`));
      if (signal?.aborted) break;
      if (derivatives.thumbPath === null && derivatives.mediumPath === null) continue;
      const patch = {
        thumbPath: derivatives.thumbPath ?? asset.thumbPath ?? null,
        mediumPath: derivatives.mediumPath ?? asset.mediumPath ?? null,
      };
      if (store.update(asset.id, patch)) {
        // Only a complete set counts as done at this revision; a half made
        // pair is picked up again at the next start.
        if (completeSet(asset.kind, derivatives)) store.setDerivativeRevision(asset.id, DERIVATIVE_REVISION);
        made += 1;
        deps.onChange(asset.id);
      }
    }
    if (made > 0) log.info(`made small copies for ${made} asset(s)`);
    return made;
  }

  /**
   * One pass over completed assets that never got a charge, for the rows that
   * predate the cost columns. Bounded to the newest BILLING_PAGES pages of
   * events, so it prices the recent history and leaves the rest alone.
   */
  async function backfillCosts(limit = 200, signal?: AbortSignal): Promise<number> {
    const key = deps.getKey();
    if (!key) return 0;
    const waiting = new Map<string, string>();
    for (const asset of store.needsCost(limit)) {
      if (asset.comfyPromptId) waiting.set(asset.comfyPromptId, asset.id);
    }
    if (waiting.size === 0) return 0;
    let filled = 0;
    try {
      for (let page = 1; page <= BILLING_PAGES && waiting.size > 0; page += 1) {
        const result = await client.billingEvents(key, { page, limit: 100, signal });
        for (const event of result.events) {
          // A job can also have a GPU time row, which carries the same job_id
          // and no charge. Only a row with credits settles an asset.
          if (event.jobId === null || typeof event.credits !== "number" || event.credits <= 0) continue;
          const assetId = waiting.get(event.jobId);
          if (assetId === undefined) continue;
          waiting.delete(event.jobId);
          if (applyCost(assetId, event)) filled += 1;
        }
        if (page >= result.totalPages) break;
      }
    } catch (cause) {
      if (signal?.aborted) log.info("cost backfill stopped for a shutdown");
      else {
        // Billing can be down right after a start. The rows it did not reach join the loop's billing
        // queue, which waits the outage out, instead of waiting for the next
        // start to be looked at again.
        let handed = 0;
        for (const [promptId, assetId] of waiting) {
          if (billing.has(assetId)) continue;
          billing.set(assetId, { promptId, tries: 0, nextAt: now() + (BILLING_OUTAGE_BACKOFF_MS[0] as number) });
          handed += 1;
        }
        log.warn(`cost backfill stopped: ${redact(errorText(cause), deps.getKey())} (${handed} asset(s) will be looked up when billing answers again)`);
      }
    }
    if (filled > 0) log.info(`cost backfill: filled ${filled} asset(s) from the billing events`);
    return filled;
  }

  /**
   * Send one queued row, at most once. A submit is a paid request: when it
   * fails in a way that says Comfy Cloud did not take it (the name did not
   * resolve, the connection was refused, Comfy answered with a refusal) it is
   * safe to try again, and the row stays queued. When it fails any other way
   * (a timeout, a reset, a 5xx, a cut connection) the request may have
   * started a job whose answer was lost, and sending it again could pay
   * twice. Then the row is marked unknown, stamped with when it was sent, and
   * `findLostJob` looks for it in Comfy Cloud's job list instead.
   */
  async function submitRow(asset: Asset, key: string, signal?: AbortSignal): Promise<void> {
    let workflow: Workflow;
    try {
      workflow = readWorkflowFile(asset.workflowPath);
    } catch (cause) {
      fail(asset, `The workflow file could not be read: ${errorText(cause)}`, "queued");
      return;
    }
    const sentAt = now();
    try {
      const { promptId } = await client.submit(key, workflow, { signal });
      errors.delete(asset.id);
      const written = store.updateIf(asset.id, "queued", { status: "running", comfyPromptId: promptId, startedAt: sentAt, error: null });
      if (!written) {
        log.info(`${asset.id} was cancelled or deleted while submitting; Comfy job ${promptId} may still finish`);
        return;
      }
      log.info(`${asset.id} submitted as ${promptId}`);
      deps.onChange(asset.id);
    } catch (cause) {
      if (cause instanceof ComfyError && !cause.notAccepted && !cause.permanent) {
        // A cut off shutdown is the same case: the request may be at Comfy.
        const detail = redact(errorText(cause), deps.getKey());
        errors.delete(asset.id);
        if (!store.updateIf(asset.id, "queued", { status: "unknown", startedAt: sentAt, error: UNKNOWN_REASON.submit })) {
          log.info(`${asset.id} is no longer queued, not marking it unknown`);
          return;
        }
        // Looked for on the next tick, not in a minute: a job that did start
        // is already in the list, and the sooner it is found the sooner it runs.
        unknownNext.delete(asset.id);
        log.warn(`${asset.id}: the submit may have reached Comfy Cloud but no answer came back (${detail}); looking for the job rather than sending it again`);
        deps.onChange(asset.id);
        return;
      }
      handleError(asset, cause, "queued", signal);
    }
  }

  /**
   * Find the job a lost submit started, by what it is: a job created within
   * `SUBMIT_MATCH_SLACK_MS` of the send whose stored graph is this row's
   * graph, key for key, and that no other row has claimed. Comfy Cloud takes
   * no client id on a submit and stores the graph as sent, so the graph is
   * the identity, and a stored graph equals the workflow file beside its
   * row. The
   * search reads the list newest first and stops once it is older than the
   * window. Returns the job id, null when there is none, and throws when
   * Comfy Cloud cannot be asked.
   */
  async function findLostJob(asset: Asset, key: string, signal?: AbortSignal): Promise<string | null> {
    const sentAt = asset.startedAt ?? asset.createdAt;
    const from = sentAt - SUBMIT_MATCH_SLACK_MS;
    const to = sentAt + SUBMIT_MATCH_SLACK_MS;
    const mine = canonicalJson(readWorkflowFile(asset.workflowPath));
    const taken = claimed();
    for (let offset = 0; offset < SUBMIT_SEARCH_JOBS; offset += 100) {
      const page = await client.listJobs(key, { limit: 100, offset, signal });
      for (const job of page.jobs) {
        if (job.createdAt < from || job.createdAt > to || taken.has(job.id)) continue;
        const record = await client.job(key, job.id, { signal });
        if (canonicalJson(jobPrompt(record)) === mine) return job.id;
      }
      const oldest = page.jobs.at(-1);
      if (!page.hasMore || oldest === undefined || oldest.createdAt < from) break;
    }
    return null;
  }

  /**
   * An unknown row with no job id is a lost submit. Look for its job; when it
   * turns up, the row takes its id and runs from there. A row whose job is
   * not found in `SUBMIT_SEARCH_MS` stays unknown and says so, and is never
   * sent again by the loop: only a person's Retry pays for it twice.
   */
  async function checkLostSubmit(asset: Asset, key: string, signal?: AbortSignal): Promise<void> {
    const sentAt = asset.startedAt ?? asset.createdAt;
    if (now() - sentAt > SUBMIT_SEARCH_MS) {
      if (asset.error !== UNKNOWN_REASON.unfound && store.updateIf(asset.id, "unknown", { error: UNKNOWN_REASON.unfound })) {
        log.warn(`${asset.id}: no job found for its lost submit after ${Math.round(SUBMIT_SEARCH_MS / 60_000)} minutes; leaving it for the user`);
        deps.onChange(asset.id);
      }
      return;
    }
    // The graph is read first and apart from the search: a file that cannot be
    // read is the server's fault, not Comfy's, and searching on would end in
    // "Comfy has no such job", which reads as an invitation to a paid retry.
    // Such a row fails now, in the same words as a queued row whose file is
    // gone.
    try {
      readWorkflowFile(asset.workflowPath);
    } catch (cause) {
      searchWarned.delete(asset.id);
      unknownNext.delete(asset.id);
      fail(asset, `The workflow file could not be read: ${errorText(cause)}`, "unknown");
      return;
    }
    let found: string | null;
    try {
      found = await findLostJob(asset, key, signal);
    } catch (cause) {
      // Comfy Cloud could not be asked. The row waits and the search goes on;
      // one line per outage says so, rather than silence or a line a minute.
      if (!signal?.aborted && !searchWarned.has(asset.id)) {
        searchWarned.add(asset.id);
        log.warn(`${asset.id}: could not look for the job its lost submit started (${redact(errorText(cause), deps.getKey())}); trying again every minute`);
      }
      return;
    }
    if (searchWarned.delete(asset.id)) log.info(`${asset.id}: Comfy Cloud answers again; the search for its lost submit goes on`);
    if (found === null) return;
    if (!store.updateIf(asset.id, "unknown", { status: "running", comfyPromptId: found, error: null })) return;
    unknownNext.delete(asset.id);
    log.info(`${asset.id}: found the job its lost submit started (${found}); following it instead of sending again`);
    deps.onChange(asset.id);
  }

  /**
   * Delete the files of a row that went away mid flight. The workflow file is
   * only removed when the row is gone for good; a cancelled row keeps it so it
   * can still be retried.
   */
  function removeFiles(asset: Asset, dest: string | null, includeWorkflow: boolean): void {
    const folder = path.dirname(asset.workflowPath);
    // The small copies too: complete() makes them after its last check on the
    // row, so a row cancelled or deleted while they are being made would
    // otherwise leave a thumb and a medium that no row cleans up.
    const derived = dest === null ? [] : (["thumb", "medium"] as const).map((kind) => derivativePath(dest, kind));
    const targets = [dest, ...derived, path.join(folder, `${asset.id}.job.json`), includeWorkflow ? asset.workflowPath : null].filter(
      (f): f is string => typeof f === "string" && f !== "",
    );
    for (const file of targets) {
      try {
        fs.rmSync(file, { force: true });
      } catch (cause) {
        log.warn(`${asset.id}: could not remove ${file}: ${errorText(cause)}`);
      }
    }
  }

  async function complete(asset: Asset, key: string, promptId: string, signal?: AbortSignal): Promise<void> {
    const job = await client.job(key, promptId, { signal });
    const folder = path.dirname(asset.workflowPath);
    const jobPath = path.join(folder, `${asset.id}.job.json`);
    const jobText = JSON.stringify(job, null, 2);
    if (containsSecret(jobText)) throw new ComfyError("refusing to store a job record that still carries the API key", null, true);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(jobPath, jobText);

    const output = pickOutput(job, asset.kind);
    if (!output) {
      const record = job as { status?: unknown; execution_error?: { exception_message?: string } } | null;
      const message = redact(record?.execution_error?.exception_message?.split("\n")[0] ?? "", key);
      throw new ComfyError(message !== "" ? message : `job ${promptId} finished with no output`, null, true);
    }
    const ext = extensionFor(output.filename, null, asset.kind);
    const dest = path.join(folder, `${asset.id}.${ext}`);
    const downloaded = await client.download(key, output, dest, { signal });

    // The row may have been cancelled or deleted while the file was coming down.
    const current = store.get(asset.id);
    if (!current || current.status !== "running") {
      log.info(`${asset.id} is ${current ? current.status : "gone"} after the download; removing the files`);
      removeFiles(asset, dest, current === null);
      return;
    }

    const mime = downloaded.mime ?? mimeFor(ext);
    let width: number | null = null;
    let height: number | null = null;
    let durationS: number | null = null;
    if (asset.kind === "video" || VIDEO_EXTS.has(ext)) {
      const probe = await videoProbe(dest);
      width = probe?.width ?? null;
      height = probe?.height ?? null;
      durationS = probe?.durationS ?? null;
    } else {
      const size = probeImage(dest);
      width = size?.width ?? null;
      height = size?.height ?? null;
    }
    // Small copies for the grid and for the viewer. Sequential
    // and awaited, so the row is written once with everything it knows; a
    // failure leaves the column null and every surface falls back to the
    // original.
    const root = deps.assetDir();
    const derivatives = await makeDerivatives(dest, asset.kind, root, (message) => log.warn(`${asset.id}: ${message}`));

    const written = store.updateIf(asset.id, "running", {
      status: "completed",
      file: relativeToRoot(root, dest),
      path: dest,
      mime,
      width,
      height,
      durationS,
      sizeBytes: downloaded.sizeBytes,
      thumbPath: derivatives.thumbPath,
      mediumPath: derivatives.mediumPath,
      completedAt: now(),
      error: null,
    });
    if (written && completeSet(asset.kind, derivatives)) store.setDerivativeRevision(asset.id, DERIVATIVE_REVISION);
    errors.delete(asset.id);
    if (!written) {
      log.info(`${asset.id} went away while completing; removing the files`);
      removeFiles(asset, dest, store.get(asset.id) === null);
      return;
    }
    log.info(`${asset.id} completed: ${dest}`);
    watchBilling(asset, promptId);
    deps.onChange(asset.id);
  }

  function overdue(asset: Asset): boolean {
    return now() - (asset.startedAt ?? asset.createdAt) > runningTimeoutMs;
  }

  /** Act on what Comfy Cloud said about a running row's job. */
  async function settle(asset: Asset, key: string, promptId: string, status: JobStatus, signal?: AbortSignal): Promise<void> {
    if (status.state === "error") {
      fail(asset, display(asset, status.error ?? "Comfy job failed"), "running");
      return;
    }
    if (status.state === "success") {
      try {
        await complete(asset, key, promptId, signal);
      } catch (cause) {
        // A job with no output, or a record that would store the key, is
        // Comfy's own answer and fails the row. Anything else went wrong
        // fetching a job Comfy Cloud has already finished and billed: a
        // storage 403, a 404 from a view that lags, a timeout. That counts
        // toward unknown like a dropped connection, never straight to failed.
        if (signal?.aborted || (cause instanceof ComfyError && cause.permanent && cause.httpStatus === null)) throw cause;
        transient(asset, cause, "running", UNKNOWN_REASON.fetch);
      }
      return;
    }
    errors.delete(asset.id);
    // Asked before the clock is read: a job that finished at minute 21 is a
    // result, not a timeout. Past the limit a job still running is unknown,
    // never failed, because it may still finish and be billed.
    if (overdue(asset)) markUnknown(asset, UNKNOWN_REASON.slow, "running");
  }

  async function pollRow(asset: Asset, key: string, signal?: AbortSignal): Promise<void> {
    const promptId = asset.comfyPromptId;
    if (!promptId) {
      if (store.updateIf(asset.id, "running", { status: "queued" })) deps.onChange(asset.id);
      return;
    }
    try {
      const status = await client.status(key, promptId, { signal });
      await settle(asset, key, promptId, status, signal);
    } catch (cause) {
      handleError(asset, cause, "running", signal);
    }
  }

  /**
   * Ask Comfy Cloud about an unknown row's job, at most once per
   * `unknownCheckMs`. A job it can see again goes back to running and is
   * settled on the spot; one still running past the limit stays unknown; a
   * check that cannot get an answer changes nothing and says nothing.
   */
  async function checkUnknown(asset: Asset, key: string, signal?: AbortSignal): Promise<void> {
    if ((unknownNext.get(asset.id) ?? 0) > now()) return;
    unknownNext.set(asset.id, now() + unknownCheckMs);
    const promptId = asset.comfyPromptId;
    if (!promptId) {
      await checkLostSubmit(asset, key, signal);
      return;
    }
    let status: JobStatus;
    try {
      status = await client.status(key, promptId, { signal });
    } catch (cause) {
      // Comfy Cloud answering that it has no such job is an answer: nothing
      // ran, so nothing can be billed.
      if (!signal?.aborted && cause instanceof ComfyError && cause.httpStatus === 404) {
        fail(asset, "Comfy Cloud has no record of this job, so nothing was made and nothing was charged.", "unknown");
      }
      return;
    }
    if (status.state === "executing" && overdue(asset)) return;
    if (!store.updateIf(asset.id, "unknown", { status: "running", error: null })) return;
    unknownNext.delete(asset.id);
    log.info(`${asset.id}: Comfy Cloud answered for job ${promptId} (${status.state}); picking it up again`);
    deps.onChange(asset.id);
    const running = store.get(asset.id);
    if (!running) return;
    try {
      await settle(running, key, promptId, status, signal);
    } catch (cause) {
      handleError(running, cause, "running", signal);
    }
  }

  /**
   * Before a Retry pays for a new job, ask Comfy Cloud about the row's own.
   * A job that finished with a result, or is still running, is taken back:
   * the row goes to running and the loop downloads it and records its bill,
   * so a Retry never pays twice for a picture that was already made. Returns
   * the row when it was taken back and null when a new job is the right
   * answer (Comfy reported an error, has no such job, or the job made
   * nothing). Throws when Comfy Cloud cannot be asked, because then nobody
   * knows, and sending a new job on a guess is the double charge this exists
   * to prevent.
   */
  async function recover(asset: Asset, signal?: AbortSignal): Promise<Asset | null> {
    if (asset.status !== "failed" && asset.status !== "unknown" && asset.status !== "cancelled") return null;
    const key = deps.getKey();
    const cannotTell = (cause: unknown): Error =>
      new Error(
        `Could not ask Comfy Cloud whether ${asset.id}'s job already finished, so nothing was sent and nothing was charged. Try again in a moment. (${redact(errorText(cause), key)})`,
      );
    let promptId = asset.comfyPromptId;
    // A lost submit has no job id: look for its job the way the loop does.
    // Retry on one the search has given up on is the person deciding to pay
    // again, and gets a new job.
    if (!promptId && asset.status === "unknown" && asset.error !== UNKNOWN_REASON.unfound) {
      if (!key) throw cannotTell(new Error("no Comfy Cloud API key is configured"));
      try {
        promptId = await findLostJob(asset, key, signal);
      } catch (cause) {
        throw cannotTell(cause);
      }
      if (promptId === null) {
        throw new Error(
          `${asset.id}'s request may have reached Comfy Cloud and its job is not in the job list yet, so nothing was sent. The plugin keeps looking for ${Math.round(SUBMIT_SEARCH_MS / 60_000)} minutes after the send; after that, Retry sends a new one.`,
        );
      }
      if (!store.updateIf(asset.id, "unknown", { comfyPromptId: promptId })) {
        throw new Error(`${asset.id} changed while Comfy Cloud was being asked about it, so nothing was sent. Try again.`);
      }
      asset = { ...asset, comfyPromptId: promptId };
    }
    if (!promptId) return null;
    if (!key) throw cannotTell(new Error("no Comfy Cloud API key is configured"));
    let status: JobStatus;
    try {
      status = await client.status(key, promptId, { signal });
    } catch (cause) {
      if (cause instanceof ComfyError && cause.httpStatus === 404) return null;
      throw cannotTell(cause);
    }
    if (status.state === "error") return null;
    if (status.state === "success") {
      let job: unknown;
      try {
        job = await client.job(key, promptId, { signal });
      } catch (cause) {
        throw cannotTell(cause);
      }
      if (!pickOutput(job, asset.kind)) return null;
    }
    if (!store.updateIf(asset.id, asset.status, { status: "running", error: null, completedAt: null })) {
      throw new Error(`${asset.id} changed while Comfy Cloud was being asked about it, so nothing was sent. Try again.`);
    }
    errors.delete(asset.id);
    unknownNext.delete(asset.id);
    log.info(
      `${asset.id}: Comfy Cloud ${status.state === "success" ? "already finished" : "is still running"} job ${promptId}; fetching it instead of paying for a new one`,
    );
    deps.onChange(asset.id);
    kick();
    return store.get(asset.id);
  }

  async function tick(signal?: AbortSignal): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const running = store.byStatus("running");
      const queued = store.byStatus("queued");
      const unknown = store.byStatus("unknown");
      if (running.length === 0 && queued.length === 0 && unknown.length === 0 && billing.size === 0) return;
      const key = deps.getKey();
      if (!key) {
        if (!warnedNoKey) {
          log.warn(`${running.length + queued.length} job(s) waiting: no Comfy Cloud API key configured`);
          warnedNoKey = true;
        }
        return;
      }
      warnedNoKey = false;
      await settleBilling(key, signal);
      if (signal?.aborted) return;
      for (const asset of running) {
        if (signal?.aborted) return;
        const fresh = store.get(asset.id);
        if (!fresh || fresh.status !== "running") continue;
        await pollRow(fresh, key, signal);
      }
      for (const asset of unknown) {
        if (signal?.aborted) return;
        const fresh = store.get(asset.id);
        if (!fresh || fresh.status !== "unknown") continue;
        await checkUnknown(fresh, key, signal);
      }
      let inFlight = store.byStatus("running").length;
      for (const asset of queued) {
        if (signal?.aborted) return;
        if (inFlight >= maxInFlight) break;
        const fresh = store.get(asset.id);
        if (!fresh || fresh.status !== "queued") continue;
        await submitRow(fresh, key, signal);
        if (store.get(asset.id)?.status === "running") inFlight += 1;
      }
    } finally {
      ticking = false;
    }
  }

  function sleep(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, tickMs);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        if (wake === done) wake = null;
        resolve();
      }
      wake = done;
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** Wake the loop early (a row was just queued). */
  function kick(): void {
    const w = wake;
    if (w) w();
  }

  async function run(signal: AbortSignal): Promise<void> {
    log.info(`job runner started (tick ${tickMs} ms)`);
    while (!signal.aborted) {
      try {
        await tick(signal);
      } catch (cause) {
        log.error(`job tick failed: ${errorText(cause)}`);
      }
      if (signal.aborted) break;
      await sleep(signal);
    }
    log.info("job runner stopped");
  }

  /**
   * Poll the store until the asset reaches a terminal status or the timeout
   * passes. Unknown is not terminal: a lost submit is usually found on the
   * next tick and a dropped connection may come back inside the wait, so the
   * caller is told "not known yet" only at its deadline.
   */
  async function waitFor(id: string, timeoutMs: number, signal?: AbortSignal): Promise<Asset> {
    const deadline = now() + timeoutMs;
    for (;;) {
      const asset = store.get(id);
      if (!asset) throw new Error(`Asset ${id} not found`);
      if (isTerminal(asset.status) || signal?.aborted || now() >= deadline) return asset;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 250);
        function done(): void {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  return {
    tick,
    run,
    kick,
    waitFor,
    recover,
    backfillCosts,
    backfillDerivatives,
    pendingBilling: () => billing.size,
    awaitingBill: (id: string) => billing.has(id),
  };
}

export type Runner = ReturnType<typeof createRunner>;
