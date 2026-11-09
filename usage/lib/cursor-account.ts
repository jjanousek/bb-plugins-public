import { Buffer } from "node:buffer";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { CURSOR_ACCOUNT_COLLECTOR_SOURCE } from "./generated/host-scripts";

export type CursorAccountScanInput = {
  authPath: string;
  endpoint: string;
  sinceDay: string;
  pageSize: number;
  maxPages: number;
};

export type CursorAccountAggregate = {
  day: string;
  model: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cents: number;
};

export type CursorAccountScanResult = {
  eventCount: number;
  pageCount: number;
  totalAvailable: number;
  truncated: boolean;
  error: string | null;
  rows: CursorAccountAggregate[];
};

const SCAN_BEGIN = "__BB_USAGE_SCAN_BEGIN__";
const SCAN_END = "__BB_USAGE_SCAN_END__";

export const CURSOR_ACCOUNT_ENDPOINT =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents";
// One request returns at most CURSOR_ACCOUNT_PAGE_SIZE events; the scan stops after CURSOR_ACCOUNT_MAX_PAGES pages.
export const CURSOR_ACCOUNT_PAGE_SIZE = 1000;
export const CURSOR_ACCOUNT_MAX_PAGES = 40;

const aggregateSchema = z.object({
  day: z.string(),
  model: z.string(),
  events: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cents: z.number(),
});
const scanResultSchema = z.object({
  eventCount: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  totalAvailable: z.number().int().nonnegative(),
  truncated: z.boolean(),
  error: z.string().nullable(),
  rows: z.array(aggregateSchema),
});

// The collector runs from plain JavaScript text (see lib/host/), not from a
// function in this bundle, for the reason given in host-json-collector.ts.
export function cursorAccountCollectorScript(input: CursorAccountScanInput) {
  const encodedInput = Buffer.from(JSON.stringify(input)).toString("base64");
  const dependencies = "{buffer:require('node:buffer').Buffer,fs:require('node:fs'),fetch:globalThis.fetch}";
  return [
    "(()=>{",
    `(${CURSOR_ACCOUNT_COLLECTOR_SOURCE})(${JSON.stringify(encodedInput)},${dependencies}).then((result)=>{`,
    "const encoded=require('node:zlib').gzipSync(JSON.stringify(result)).toString('base64');",
    `process.stdout.write(${JSON.stringify(`${SCAN_BEGIN}\n`)}+encoded+${JSON.stringify(`\n${SCAN_END}\n`)});`,
    "}).catch((error)=>{process.stdout.write('__BB_USAGE_ERROR__:'+String((error&&error.message)||error));});",
    "})()",
  ].join("");
}

export function compressedCursorAccountCollectorScript(input: CursorAccountScanInput) {
  const encodedScript = gzipSync(cursorAccountCollectorScript(input)).toString("base64");
  return `eval(require('node:zlib').gunzipSync(Buffer.from(${JSON.stringify(encodedScript)},'base64')).toString('utf8'))`;
}

export function extractCursorAccountScan(output: string): CursorAccountScanResult {
  const normalized = output.replace(/\r/g, "");
  const start = normalized.lastIndexOf(`${SCAN_BEGIN}\n`);
  const end = normalized.lastIndexOf(`\n${SCAN_END}`);
  if (start < 0 || end < 0 || end <= start) throw new Error("Cursor account scan returned incomplete output.");
  const encoded = normalized.slice(start + SCAN_BEGIN.length + 1, end).trim();
  let value: unknown;
  try {
    value = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
  } catch {
    throw new Error("Cursor account scan returned malformed output.");
  }
  const parsed = scanResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("Cursor account scan returned an unexpected result shape.");
  return parsed.data;
}
