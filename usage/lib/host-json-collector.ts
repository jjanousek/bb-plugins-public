import { Buffer } from "node:buffer";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { AgentId, HostUsageAggregate } from "../collectors";
import { HOST_JSON_COLLECTOR_SOURCE } from "./generated/host-scripts";

export type HostJsonAgentId = Exclude<AgentId, "opencode" | "cursor">;

export type HostJsonScanInput = {
  agentId: HostJsonAgentId;
  roots: string[];
  cachePath: string;
  sinceDay: string;
};

export type HostJsonScanResult = {
  agentId: HostJsonAgentId;
  fileCount: number;
  changedFileCount: number;
  reusedFileCount: number;
  failureCount: number;
  error: string | null;
  rows: HostUsageAggregate[];
};

const SCAN_BEGIN = "__BB_USAGE_SCAN_BEGIN__";
const SCAN_END = "__BB_USAGE_SCAN_END__";
const aggregateSchema = z.object({
  day: z.string(),
  modelProviderId: z.string(),
  model: z.string(),
  project: z.string().default("Unknown"),
  loggedCostUsd: z.number().finite().nullable(),
  uncachedInputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  cacheWrite1hTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative(),
});
const scanResultSchema = z.object({
  agentId: z.enum(["codex", "claude", "fx", "grok", "pi", "prime", "antigravity", "omp"]),
  fileCount: z.number().int().nonnegative(),
  changedFileCount: z.number().int().nonnegative(),
  reusedFileCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  rows: z.array(aggregateSchema),
});

// The host-side scanner is plain JavaScript text (see lib/host/), never a
// function from this bundle: bb compiles the plugin with esbuild's keepNames,
// which rewrites every function body to call a bundle-level helper, so
// `fn.toString()` would ship a reference to a name the host process does not have.
export function hostJsonCollectorScript(input: HostJsonScanInput) {
  const encodedInput = Buffer.from(JSON.stringify(input)).toString("base64");
  const dependencies = "{buffer:require('node:buffer').Buffer,fs:require('node:fs'),path:require('node:path'),crypto:require('node:crypto'),readline:require('node:readline'),zlib:require('node:zlib')}";
  return `(${HOST_JSON_COLLECTOR_SOURCE})(${JSON.stringify(encodedInput)},${dependencies}).catch((error)=>{process.stderr.write('__BB_USAGE_ERROR__:'+String(error?.message??error).replace(/[\\r\\n]+/g,' ').slice(0,300)+'\\n');process.exitCode=1;});`;
}

export function compressedHostJsonCollectorScript(input: HostJsonScanInput) {
  const encodedScript = gzipSync(hostJsonCollectorScript(input)).toString("base64");
  return `eval(require('node:zlib').gunzipSync(Buffer.from(${JSON.stringify(encodedScript)},'base64')).toString('utf8'))`;
}

export function extractHostJsonScan(output: string): HostJsonScanResult {
  const normalized = output.replace(/\r/g, "");
  const start = normalized.lastIndexOf(`${SCAN_BEGIN}\n`);
  const end = normalized.lastIndexOf(`\n${SCAN_END}`);
  if (start < 0 || end < 0 || end <= start) throw new Error("Host usage scan returned incomplete output.");
  const encoded = normalized.slice(start + SCAN_BEGIN.length + 1, end).trim();
  let value: unknown;
  try {
    value = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
  } catch {
    throw new Error("Host usage scan returned malformed output.");
  }
  const parsed = scanResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("Host usage scan returned an unexpected result shape.");
  return parsed.data;
}
