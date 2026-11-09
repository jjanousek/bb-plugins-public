// Presentation helpers shared by the Comfy surfaces: absolute times in
// the viewer's own zone, sizes, durations, aspect ratios, model labels, preview URLs.
import {
  IMAGE_MODEL_INFO,
  VIDEO_MODEL_INFO,
  estimateSeconds,
  parseSizePreset,
} from "../../contract";
import type { Asset, AssetStatus, KeySource, ImageModel, TimeEstimate, VideoModel } from "../../contract";

/** The viewer's own time zone; every absolute time is shown in it. */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The zone's short name at that moment, e.g. "UTC" or "CEST". */
function zoneName(ms: number): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "short" })
    .formatToParts(new Date(ms))
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? ZONE;
}

function dateParts(ms: number): { weekday: string; day: string; month: string; year: string; hour: string; minute: string } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const out = { weekday: "", day: "", month: "", year: "", hour: "", minute: "" };
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type in out) out[part.type as keyof typeof out] = part.value;
  }
  return out;
}

/** "2031-05-20" in the viewer's zone, for grouping by day. */
export function dayKey(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** "Today, 20 May 2031", "Yesterday, 19 May 2031", then "Fri 16 May 2031". */
export function dayLabel(ms: number, nowMs = Date.now()): string {
  const key = dayKey(ms);
  const { weekday, day, month, year } = dateParts(ms);
  const date = `${day} ${month} ${year}`;
  if (key === dayKey(nowMs)) return `Today, ${date}`;
  if (key === dayKey(nowMs - 86_400_000)) return `Yesterday, ${date}`;
  return `${weekday} ${date}`;
}

/** "20 May 2031 14:30", always in the viewer's zone. */
export function shortAbsoluteTime(ms: number): string {
  const { day, month, year, hour, minute } = dateParts(ms);
  return `${day} ${month} ${year} ${hour}:${minute}`;
}

/** "14:30" in the viewer's zone, for rows on the same day. */
export function clockTime(ms: number): string {
  const { hour, minute } = dateParts(ms);
  return `${hour}:${minute}`;
}

/** The same with the zone spelled out, for places without context: "20 May 2031 14:30 UTC". */
export function absoluteTime(ms: number): string {
  return `${shortAbsoluteTime(ms)} ${zoneName(ms)}`;
}

/**
 * Row timestamps: relative for the first hour ("now", "4m"), then the absolute
 * Local clock time ("14:30"), and the date once it is not today
 * ("20 May 14:30"). The full time belongs in a `title`; see `absoluteTime`.
 */
export function shortTime(ms: number | null, nowMs = Date.now()): string {
  if (ms === null) return "";
  const minutes = Math.round((nowMs - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const clock = clockTime(ms);
  if (dayKey(ms) === dayKey(nowMs)) return clock;
  const { day, month } = dateParts(ms);
  return `${day} ${month} ${clock}`;
}

/** Whole seconds since a row started (or was created), never negative. */
export function elapsedSeconds(asset: Asset, nowMs: number): number {
  const from = asset.startedAt ?? asset.createdAt;
  return Math.max(0, Math.floor((nowMs - from) / 1000));
}

export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} min ${rest} s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Every name an asset row can carry, mapped to its registry label. The panel
 * never bundles the 530 KB registry, so this arrives once per load from the
 * `model_labels` RPC (`useModelLabels` in use-comfy.ts owns the fetch). Until
 * it does, and in tests, the contract's own tables answer.
 */
let registryLabels: Readonly<Record<string, string>> = {};

/** Install the map from the `model_labels` RPC. Called once; empty is a valid state. */
export function setModelLabels(labels: Readonly<Record<string, string>>): void {
  registryLabels = labels;
}

/**
 * Human label for a model. The registry map first, then the contract's own
 * tables. A registry key carries the node class in front of the model id
 * ("ByteDanceSeedreamNodeV3/seedream 5.0 pro"), so the id after the slash is
 * tried too, and an id nothing knows stays as it is.
 */
export function modelLabel(model: string): string {
  const known = (id: string): string | null => {
    const fromRegistry = registryLabels[id];
    if (fromRegistry !== undefined && fromRegistry !== "") return fromRegistry;
    const video = (VIDEO_MODEL_INFO as Record<string, { label: string } | undefined>)[id as VideoModel];
    if (video !== undefined) return video.label;
    const image = (IMAGE_MODEL_INFO as Record<string, { label: string } | undefined>)[id as ImageModel];
    return image?.label ?? null;
  };
  const whole = known(model);
  if (whole !== null) return whole;
  const slash = model.indexOf("/");
  if (slash === -1) return model;
  const id = model.slice(slash + 1);
  return known(id) ?? id;
}

// ---------- time estimates ----------

/** The shared estimate from the contract, re-exported so surfaces have one import. */
export { estimateSeconds };

/** Round to a number worth saying out loud: 5 s steps under a minute, whole minutes above. */
function roundSeconds(seconds: number): number {
  if (seconds < 60) return Math.max(5, Math.floor(seconds / 5) * 5);
  return Math.max(1, Math.round(seconds / 60)) * 60;
}

function unitOf(seconds: number): "s" | "min" {
  return seconds < 60 ? "s" : "min";
}

function valueOf(seconds: number): string {
  return seconds < 60 ? String(seconds) : String(Math.round(seconds / 60));
}

/** "about 20 s", "about 1 to 2 min". */
export function estimateLabel(range: TimeEstimate): string {
  const low = roundSeconds(range.low);
  const high = roundSeconds(range.high);
  if (low === high) return `about ${valueOf(low)} ${unitOf(low)}`;
  if (unitOf(low) === unitOf(high)) return `about ${valueOf(low)} to ${valueOf(high)} ${unitOf(high)}`;
  return `about ${valueOf(low)} ${unitOf(low)} to ${valueOf(high)} ${unitOf(high)}`;
}

/** The estimate for a row that already exists. */
export function estimateFor(asset: Asset): TimeEstimate {
  return estimateSeconds(asset.kind, asset.model, {
    sizePreset: typeof asset.params.sizePreset === "string" ? asset.params.sizePreset : null,
    resolution: typeof asset.params.resolution === "string" ? asset.params.resolution : null,
    duration: typeof asset.params.duration === "number" ? asset.params.duration : null,
  });
}

/** "19 s": how long a running row has been going, on its own. */
export function elapsedLabel(asset: Asset, nowMs: number): string {
  return formatSeconds(elapsedSeconds(asset, nowMs));
}

/** " of about 20 to 40 s": the half a narrow row drops, kept here so the wording has one source. */
export function estimateTail(asset: Asset): string {
  return ` of ${estimateLabel(estimateFor(asset))}`;
}

/** "19 s of about 20 to 40 s" for a running row: the same range the Generate button quotes. */
export function elapsedOfEstimate(asset: Asset, nowMs: number): string {
  return `${elapsedLabel(asset, nowMs)}${estimateTail(asset)}`;
}

function paramString(asset: Asset, key: string): string | null {
  const value = asset.params[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function paramNumber(asset: Asset, key: string): number | null {
  const value = asset.params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Pixel size, from the file when probed, otherwise from the requested params. */
export function pixelSize(asset: Asset): { width: number; height: number } | null {
  if (asset.width !== null && asset.height !== null && asset.width > 0 && asset.height > 0) {
    return { width: asset.width, height: asset.height };
  }
  const width = paramNumber(asset, "width");
  const height = paramNumber(asset, "height");
  if (width !== null && height !== null && width > 0 && height > 0) return { width, height };
  const preset = paramString(asset, "sizePreset");
  return preset === null ? null : parseSizePreset(preset);
}

export const MIN_ASPECT = 0.4;
export const MAX_ASPECT = 3;

export function clampAspect(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return 1;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));
}

/** Width divided by height: from the file, else the preset or aspect ratio it was asked for, else 1. */
export function aspectOf(asset: Asset): number {
  const size = pixelSize(asset);
  if (size !== null) return clampAspect(size.width / size.height);
  const ratio = paramString(asset, "aspectRatio");
  if (ratio !== null) {
    const match = /^(\d+):(\d+)$/.exec(ratio);
    if (match !== null) return clampAspect(Number(match[1]) / Number(match[2]));
  }
  return 1;
}

/** "1312x736" for images, "720p 16:9" for videos (or the pixel size when that is all we know). */
export function sizeChip(asset: Asset): string {
  if (asset.kind === "video") {
    const resolution = paramString(asset, "resolution");
    const ratio = paramString(asset, "aspectRatio");
    if (resolution !== null && ratio !== null) return `${resolution} ${ratio}`;
    if (resolution !== null) return resolution;
  }
  const size = pixelSize(asset);
  return size === null ? "" : `${size.width}x${size.height}`;
}

/** Seconds of video, from the file when probed, otherwise the requested duration. */
export function videoSeconds(asset: Asset): number | null {
  if (asset.kind !== "video") return null;
  if (asset.durationS !== null) return asset.durationS;
  return paramNumber(asset, "duration");
}

export function durationChip(asset: Asset): string {
  const seconds = videoSeconds(asset);
  return seconds === null ? "" : `${Math.round(seconds)} s`;
}

/** "Image, 1024x1024" or "Video, 480p 16:9, 3 s". */
export function kindAndSize(asset: Asset): string {
  const parts = [asset.kind === "video" ? "Video" : "Image"];
  const size = sizeChip(asset);
  if (size !== "") parts.push(size);
  const duration = durationChip(asset);
  if (duration !== "") parts.push(duration);
  return parts.join(", ");
}

export function fileName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** The first line of a prompt, cut to `max` characters. */
export function firstLine(text: string, max: number): string {
  const line = text.split("\n").find((part) => part.trim() !== "") ?? "";
  return truncate(line, max);
}

/** First line of an error, kept short enough for a tile. */
export function shortError(error: string | null): string {
  if (error === null) return "";
  return firstLine(error, 120);
}

export const STATUS_LABEL: Record<AssetStatus, string> = {
  queued: "Waiting",
  running: "Running",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Not known yet",
};

export const KEY_SOURCE_LABEL: Record<NonNullable<KeySource>, string> = {
  setting: "the apiKey plugin setting",
  "plugin-env": "the plugin's .env file",
  "key-file": "the keyFile dotenv file",
};

/** Join the preview base with a relative asset file; every path segment is encoded separately. */
export function previewUrl(baseUrl: string, file: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = file
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${path}`;
}

/** Where the plugin's own media route is mounted (media.ts on the server). Same origin, so relative. */
export const MEDIA_ROUTE_URL = "/api/v1/plugins/comfy-cloud/http/media";

/**
 * A URL on the media route, or null when the row carries no version for that
 * file. The version is what lets the browser keep the file for a year (see
 * media.ts), so an unversioned URL is never built here: the caller falls back
 * to the preview base instead, which is what an old server needs anyway.
 */
export function mediaRouteUrl(file: string, version: string | null | undefined, download = false): string | null {
  if (file === "" || version === null || version === undefined || version === "") return null;
  const query = new URLSearchParams({ p: file, v: version });
  if (download) query.set("download", "1");
  return `${MEDIA_ROUTE_URL}?${query.toString()}`;
}

/**
 * Which copy of an asset a surface wants:
 *
 * - `thumb`, 512 px, for anything drawn small: the gallery tile, a video
 *   tile's poster, the Jobs row, the Based on card, the Variants strip and the
 *   delete dialog.
 * - `view`, 2048 px, for the viewer, which opens on it **and settles on it**,
 *   and for its neighbour preload. A phone never pulls a multi megabyte
 *   original just to look at a picture.
 * - `file`, the original, for Download and for a video's own source.
 *
 * Each prefers the media route (cacheable for a year) and falls back to the
 * preview base, then to a larger copy: a row from before the small copies
 * existed, or one whose ffmpeg run failed, still draws. `download` asks the
 * route for an attachment; it is only meaningful with `file`.
 */
export type MediaWhich = "thumb" | "view" | "file";

export function mediaUrl(preview: { baseUrl: string } | null, asset: Asset, which: MediaWhich, options: { download?: boolean } = {}): string | null {
  for (const [file, version] of candidates(asset, which)) {
    if (file === null || file === undefined || file === "") continue;
    const routed = mediaRouteUrl(file, version, options.download === true);
    if (routed !== null) return routed;
    if (preview !== null) return previewUrl(preview.baseUrl, file);
  }
  return null;
}

/**
 * The long edge of the view copy, the same number as DERIVATIVES.medium.edge in
 * thumbs.ts (which the panel cannot import: it runs ffmpeg). A server test
 * holds the two equal.
 */
export const VIEW_EDGE_PX = 2048;

/**
 * The pixel size of the copy the viewer settles on: the view copy when the row
 * has one (the original fitted inside VIEW_EDGE_PX, never enlarged), otherwise
 * the original. Null when the row does not know its size.
 */
export function viewPixels(asset: Asset): { width: number; height: number } | null {
  const size = pixelSize(asset);
  if (size === null) return null;
  const hasView = asset.mediumPath !== null && asset.mediumPath !== undefined && asset.mediumPath !== "";
  if (!hasView) return size;
  const scale = Math.min(1, VIEW_EDGE_PX / Math.max(size.width, size.height));
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}

/**
 * The drawn size of a picture of `natural` pixels inside a box, keeping its
 * aspect. It never enlarges the picture unless `enlarge` is set, which the
 * phone's full bleed stage does: there the picture fills the width whatever its
 * pixels, and a small one is blurred rather than letterboxed. Null when either
 * size is unknown or empty.
 */
export function fitBox(natural: { width: number; height: number } | null, box: { width: number; height: number }, options: { enlarge?: boolean } = {}): { width: number; height: number } | null {
  if (natural === null || natural.width <= 0 || natural.height <= 0 || box.width <= 0 || box.height <= 0) return null;
  const fit = Math.min(box.width / natural.width, box.height / natural.height);
  const scale = options.enlarge === true ? fit : Math.min(1, fit);
  return { width: Math.max(1, Math.floor(natural.width * scale)), height: Math.max(1, Math.floor(natural.height * scale)) };
}

/** True when the row has a poster or thumbnail still, so `mediaUrl(..., "thumb")` is a picture even for a video. */
export function hasStill(asset: Asset): boolean {
  return asset.thumbPath !== null && asset.thumbPath !== undefined && asset.thumbPath !== "";
}

function candidates(asset: Asset, which: MediaWhich): [string | null | undefined, string | null | undefined][] {
  const file: [string | null, string | null | undefined] = [asset.file, asset.fileVersion];
  const thumb: [string | null | undefined, string | null | undefined] = [asset.thumbPath, asset.thumbVersion];
  const medium: [string | null | undefined, string | null | undefined] = [asset.mediumPath, asset.mediumVersion];
  if (which === "file") return [file];
  if (which === "thumb") return [thumb, file];
  // A video has no medium: the viewer plays the clip itself.
  return asset.kind === "video" ? [file] : [medium, file];
}
/** The seed a row ran with, when its params carry one. */
export function seedOf(asset: Asset): number | null {
  const seed = asset.params.seed;
  return typeof seed === "number" ? seed : null;
}

/** True when the row was asked to generate an audio track. */
export function hasAudio(asset: Asset): boolean {
  return asset.params.generateAudio === true;
}

// ---------- image size presets ----------
//
// A tier tagged preset ("(1K) 1312x736 (16:9)") read into its parts. The form
// groups a model's presets by tier and ratio from these.

export interface PresetMeta {
  preset: string;
  tier: string;
  width: number;
  height: number;
  aspect: string;
}

/** "(1K) 1312x736 (16:9)" split into tier, pixels and aspect. */
export function presetMeta(preset: string): PresetMeta | null {
  const match = /^\((\w+)\)\s*(\d+)x(\d+)\s*\(([\d:]+)\)$/.exec(preset);
  if (match === null) return null;
  return { preset, tier: match[1]!, width: Number(match[2]), height: Number(match[3]), aspect: match[4]! };
}

/** "480p to 1080p, 3 to 12 s, audio" under a video model in the select. */
export function videoCapabilities(model: VideoModel): string {
  const info = VIDEO_MODEL_INFO[model];
  const resolutions = info.resolutions;
  const span = resolutions.length > 1 ? `${resolutions[0]} to ${resolutions[resolutions.length - 1]}` : (resolutions[0] ?? "");
  return [span, `${info.durationMin} to ${info.durationMax} s`, info.audio ? "audio" : "no audio"].filter((part) => part !== "").join(", ");
}
