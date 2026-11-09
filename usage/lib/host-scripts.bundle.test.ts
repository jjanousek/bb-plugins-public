import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURSOR_ACCOUNT_PAGE_SIZE, extractCursorAccountScan } from "./cursor-account";
import { extractHostJsonScan } from "./host-json-collector";
// @ts-expect-error plain .mjs build script with no type declarations
import { renderHostScripts } from "../scripts/build-host-scripts.mjs";
import { readFile } from "node:fs/promises";

// bb builds the plugin server itself, minified with esbuild's keepNames.
// keepNames inserts calls to a bundle-level helper inside every function body,
// so a collector sent to the host as `fn.toString()` would refer to a helper
// that does not exist in a bare `node -e`. These tests bundle the script
// builders with the same flags and run what they produce.
const execFileAsync = promisify(execFile);
const repoRoot = resolve(__dirname, "..");
// The events below are stamped with the test clock; the window starts a week before it.
const SINCE_DAY = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
let directory = "";
let bundle: {
  compressedHostJsonCollectorScript: typeof import("./host-json-collector").compressedHostJsonCollectorScript;
  compressedCursorAccountCollectorScript: typeof import("./cursor-account").compressedCursorAccountCollectorScript;
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bb-usage-bundle-"));
  const outfile = join(directory, "bundle.mjs");
  await build({
    stdin: {
      contents: [
        'export { compressedHostJsonCollectorScript } from "./lib/host-json-collector";',
        'export { compressedCursorAccountCollectorScript } from "./lib/cursor-account";',
      ].join("\n"),
      resolveDir: repoRoot,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    minify: true,
    keepNames: true,
    outfile,
    logLevel: "silent",
  });
  bundle = await import(/* @vite-ignore */ pathToFileURL(outfile).href);
}, 60_000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("host collector scripts from a minified keepNames bundle", () => {
  it("ship the current lib/host sources (run npm run build:host-scripts if this fails)", async () => {
    const generated = await readFile(join(repoRoot, "lib/generated/host-scripts.ts"), "utf8");
    expect(generated).toBe(await renderHostScripts());
  });

  it("scan Claude logs in a bare node process", async () => {
    const root = join(directory, "projects");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "session.jsonl"), JSON.stringify({
      type: "assistant", timestamp: new Date().toISOString(), cwd: "/work/example",
      message: { id: "message-1", model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 2 } },
    }));
    const script = bundle.compressedHostJsonCollectorScript({
      agentId: "claude", roots: [root], cachePath: join(directory, "cache", "claude.json"), sinceDay: SINCE_DAY,
    });

    const { stdout } = await execFileAsync(process.execPath, ["-e", script]);
    const scan = extractHostJsonScan(stdout);
    expect(scan).toMatchObject({ agentId: "claude", fileCount: 1, failureCount: 0 });
    expect(scan.rows).toEqual([expect.objectContaining({ model: "claude-opus-5", uncachedInputTokens: 10, outputTokens: 2 })]);
  });

  it("read the Cursor account in a bare node process", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        totalUsageEventsCount: 1,
        usageEventsDisplay: [{
          timestamp: String(Date.now()), model: "cursor-model-c", chargedCents: 40,
          tokenUsage: { inputTokens: 320, outputTokens: 15, cacheReadTokens: 0, totalCents: 40 },
        }],
      }));
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    try {
      const address = server.address() as { port: number };
      const authPath = join(directory, "auth.json");
      await writeFile(authPath, JSON.stringify({ accessToken: "fake-token" }));
      const script = bundle.compressedCursorAccountCollectorScript({
        authPath, endpoint: `http://127.0.0.1:${address.port}/usage`, sinceDay: SINCE_DAY, pageSize: CURSOR_ACCOUNT_PAGE_SIZE, maxPages: 2,
      });

      const { stdout } = await execFileAsync(process.execPath, ["-e", script]);
      const scan = extractCursorAccountScan(stdout);
      expect(scan).toMatchObject({ error: null, eventCount: 1 });
      expect(scan.rows).toEqual([expect.objectContaining({ model: "cursor-model-c", events: 1, cents: 40 })]);
    } finally {
      await new Promise((closed) => server.close(closed));
    }
  });
});
