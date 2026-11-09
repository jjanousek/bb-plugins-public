import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  compressedHostJsonCollectorScript,
  extractHostJsonScan,
  type HostJsonAgentId,
} from "./host-json-collector";

function localDay(timestamp: string): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Files a test writes carry today's mtime, which the collector compares with
// the window start, so the window starts a month before the test clock.
const SINCE_DAY = localDay(new Date(Date.now() - 30 * 86_400_000).toISOString());

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "bb-usage-host-scan-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function scan(agentId: HostJsonAgentId, root: string | string[], cachePath: string) {
  const script = compressedHostJsonCollectorScript({
    agentId,
    roots: Array.isArray(root) ? root : [root],
    cachePath,
    sinceDay: SINCE_DAY,
  });
  expect(script.length).toBeLessThan(9_000);
  const { stdout } = await execFileAsync(process.execPath, ["-e", script], { maxBuffer: 2 * 1024 * 1024 });
  return extractHostJsonScan(stdout.replace(/\n/g, "\r\n"));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("host JSON usage collector", () => {
  it("streams Codex logs and reuses metadata-only per-file aggregates", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "sessions");
    const cachePath = join(directory, "cache", "codex.json");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "rollout-test.jsonl"), [
      { timestamp: "2031-04-22T12:00:00Z", type: "session_meta", payload: { id: "session-1", prompt: "must not be cached" } },
      { timestamp: "2031-04-22T12:00:00Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      { timestamp: "2031-04-22T12:01:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 5, output_tokens: 20 } } } },
    ].map((value) => JSON.stringify(value)).join("\n"));

    const first = await scan("codex", root, cachePath);
    expect(first).toMatchObject({ fileCount: 1, changedFileCount: 1, reusedFileCount: 0, failureCount: 0 });
    expect(first.rows).toEqual([expect.objectContaining({
      day: localDay("2031-04-22T12:00:00Z"),
      modelProviderId: "openai",
      model: "gpt-5.6-sol",
      uncachedInputTokens: 40,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 20,
    })]);

    const cache = await readFile(cachePath, "utf8");
    expect(cache).not.toContain("must not be cached");
    expect(cache).not.toContain(root);

    const second = await scan("codex", root, cachePath);
    expect(second).toMatchObject({ fileCount: 1, changedFileCount: 0, reusedFileCount: 1, failureCount: 0 });
    expect(second.rows).toEqual(first.rows);

    await rm(root, { recursive: true, force: true });
    await writeFile(root, "not a directory");
    const partial = await scan("codex", root, cachePath);
    expect(partial).toMatchObject({ fileCount: 0, failureCount: 1 });
    expect(partial.rows).toEqual(first.rows);
  });

  it.each([
    ["claude", "session.jsonl", {
      type: "assistant", timestamp: "2031-04-22T00:00:00Z",
      message: { id: "message-private", model: "claude-sonnet-5", content: "private", usage: { input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 5, output_tokens: 20 } },
    }, { modelProviderId: "anthropic", uncachedInputTokens: 40, cachedInputTokens: 60, outputTokens: 20 }],
    ["grok", "unified.jsonl", {
      ts: "2031-04-22T00:00:00Z", msg: "shell.turn.inference_done",
      ctx: { model: "grok-4", prompt_tokens: 100, cached_prompt_tokens: 60, completion_tokens: 15, reasoning_tokens: 5 },
    }, { modelProviderId: "xai", uncachedInputTokens: 40, cachedInputTokens: 60, outputTokens: 20 }],
    ["pi", "session.jsonl", {
      type: "message", timestamp: "2031-04-22T00:00:00Z",
      message: { role: "assistant", provider: "google", model: "gemini-2.5-pro", content: "private", usage: { input: 40, cacheRead: 60, cacheWrite: 5, output: 20, cost: { total: 0.01 } } },
    }, { modelProviderId: "google", uncachedInputTokens: 40, cachedInputTokens: 60, outputTokens: 20, loggedCostUsd: 0.01 }],
    ["prime", "session.jsonl", {
      type: "message", timestamp: "2031-04-22T00:00:00Z",
      message: { role: "assistant", provider: "prime-inference", model: "openai/gpt-5.5", content: "private", usage: { input: 40, cacheRead: 60, cacheWrite: 5, output: 20, cost: { total: 0.01 } } },
    }, { modelProviderId: "prime-inference", model: "openai/gpt-5.5", uncachedInputTokens: 40, cachedInputTokens: 60, outputTokens: 20, loggedCostUsd: 0.01 }],
  ] as const)("extracts %s usage without retaining message content", async (agentId, filename, event, expected) => {
    const directory = await temporaryDirectory();
    const root = join(directory, "logs");
    const cachePath = join(directory, "cache", `${agentId}.json`);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, filename), JSON.stringify(event));

    const result = await scan(agentId, root, cachePath);
    expect(result.failureCount).toBe(0);
    expect(result.rows).toEqual([expect.objectContaining(expected)]);
    const cache = await readFile(cachePath, "utf8");
    expect(cache).not.toContain("private");
    expect(cache).not.toContain("message-private");
  });

  it("reads only FX's usage ledger and aggregates its recorded tokens and spend", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "usage.jsonl");
    const cachePath = join(directory, "cache", "fx.json");
    await writeFile(root, [
      { schema_version: 1, kind: "coverage", status: "partial" },
      { schema_version: 1, kind: "generation", fact: {
        id: "generation-private",
        created_at_ms: Date.parse("2031-04-22T00:00:00Z"),
        model: "zai/glm-5.2",
        input_tokens: 100,
        output_tokens: 15,
        cache_read_tokens: 60,
        cache_write_tokens: 5,
        reasoning_tokens: 5,
        total_cost: 0.015,
      } },
    ].map((value) => JSON.stringify(value)).join("\n"));

    const first = await scan("fx", root, cachePath);
    expect(first).toMatchObject({ fileCount: 1, changedFileCount: 1, reusedFileCount: 0, failureCount: 0 });
    expect(first.rows).toEqual([expect.objectContaining({
      day: localDay("2031-04-22T00:00:00Z"),
      modelProviderId: "zai",
      model: "zai/glm-5.2",
      uncachedInputTokens: 35,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 15,
      loggedCostUsd: 0.015,
    })]);
    const cache = await readFile(cachePath, "utf8");
    expect(cache).not.toContain("generation-private");
    expect(cache).not.toContain(root);

    const second = await scan("fx", root, cachePath);
    expect(second).toMatchObject({ fileCount: 1, changedFileCount: 0, reusedFileCount: 1, failureCount: 0 });
    expect(second.rows).toEqual(first.rows);
  });

  it("streams Antigravity's provider-bridge usage log", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "usage.jsonl");
    const cachePath = join(directory, "cache", "antigravity.json");
    await writeFile(root, [
      { kind: "coverage", status: "partial" },
      { kind: "generation", fact: {
        created_at_ms: Date.parse("2031-04-22T00:00:00Z"),
        provider: "google",
        model: "gemini-4-ultra-preview",
        input_tokens: 10000,
        output_tokens: 500,
        thinking_tokens: 600,
        cache_read_tokens: 8000,
        total_cost: null,
      } },
    ].map((value) => JSON.stringify(value)).join("\n"));

    const first = await scan("antigravity", root, cachePath);
    expect(first).toMatchObject({ fileCount: 1, changedFileCount: 1, reusedFileCount: 0, failureCount: 0 });
    expect(first.rows).toEqual([expect.objectContaining({
      day: localDay("2031-04-22T00:00:00Z"),
      modelProviderId: "google",
      model: "gemini-4-ultra-preview",
      uncachedInputTokens: 2000,
      cachedInputTokens: 8000,
      cacheWriteTokens: 0,
      outputTokens: 500,
      loggedCostUsd: null,
    })]);

    const second = await scan("antigravity", root, cachePath);
    expect(second).toMatchObject({ fileCount: 1, changedFileCount: 0, reusedFileCount: 1, failureCount: 0 });
    expect(second.rows).toEqual(first.rows);
  });

  it("scans Antigravity CLI brain transcripts and uses settings.json for the configured model", async () => {
    const directory = await temporaryDirectory();
    const cliRoot = join(directory, ".gemini", "antigravity-cli");
    const brainRoot = join(cliRoot, "brain");
    const logsDir = join(brainRoot, "conv-1", ".system_generated", "logs");
    const chunksDir = join(logsDir, "chunks", "transcript");
    const stepsDir = join(brainRoot, "conv-1", ".system_generated", "steps", "1");
    const cachePath = join(directory, "cache", "antigravity.json");
    await mkdir(chunksDir, { recursive: true });
    await mkdir(stepsDir, { recursive: true });
    await writeFile(join(cliRoot, "settings.json"), JSON.stringify({ model: "Gemini 4 Argon (High)" }));
    const lines = [
      {
        step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE",
        created_at: "2031-04-22T00:00:00Z", input_tokens: 12000, cache_read_tokens: 0, output_tokens: 300,
        tool_calls: [{ name: "view_file", args: { AbsolutePath: '"/home/user/projects/CLAUDE.md"' } }],
      },
      {
        step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE",
        created_at: "2031-04-22T00:01:00Z", input_tokens: 3000, cache_read_tokens: 13000, output_tokens: 200,
        tool_calls: [{ name: "run_command", args: { Cwd: '"/home/user/projects/demo-app"' } }],
      },
    ].map((value) => JSON.stringify(value)).join("\n");
    await writeFile(join(logsDir, "transcript.jsonl"), lines);
    await writeFile(join(logsDir, "transcript_full.jsonl"), lines);
    await writeFile(join(chunksDir, "chunk-0.jsonl"), lines);
    await writeFile(join(stepsDir, "output.txt"), "ignored");

    const result = await scan("antigravity", brainRoot, cachePath);
    expect(result).toMatchObject({ fileCount: 1, changedFileCount: 1, reusedFileCount: 0, failureCount: 0 });
    expect(result.rows).toEqual([expect.objectContaining({
      day: localDay("2031-04-22T00:00:00Z"),
      modelProviderId: "google",
      model: "gemini-4-argon",
      project: "demo-app",
      uncachedInputTokens: 15000,
      cachedInputTokens: 13000,
      cacheWriteTokens: 0,
      outputTokens: 500,
      loggedCostUsd: null,
    })]);
  });

  it("counts each Claude API response once across repeated rows, files, and cached scans", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "projects");
    const cachePath = join(directory, "cache", "claude.json");
    await mkdir(root, { recursive: true });
    const repeated = {
      type: "assistant", timestamp: "2031-04-22T00:00:00Z", requestId: "request-1",
      message: { id: "message-1", model: "claude-sonnet-5", content: "private", usage: {
        input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 5, output_tokens: 20,
      } },
    };
    const distinct = {
      type: "assistant", timestamp: "2031-04-22T00:01:00Z", requestId: "request-2",
      message: { id: "message-2", model: "claude-sonnet-5", usage: {
        input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 2, output_tokens: 8,
      } },
    };
    await writeFile(join(root, "session-a.jsonl"), [repeated, repeated, distinct].map((value) => JSON.stringify(value)).join("\n"));
    await writeFile(join(root, "session-copy.jsonl"), JSON.stringify(repeated));

    const first = await scan("claude", root, cachePath);
    expect(first).toMatchObject({ fileCount: 2, changedFileCount: 2, reusedFileCount: 0, failureCount: 0 });
    expect(first.rows).toEqual([expect.objectContaining({
      day: localDay("2031-04-22T00:00:00Z"),
      modelProviderId: "anthropic",
      model: "claude-sonnet-5",
      uncachedInputTokens: 50,
      cachedInputTokens: 80,
      cacheWriteTokens: 7,
      outputTokens: 28,
    })]);

    const second = await scan("claude", root, cachePath);
    expect(second).toMatchObject({ fileCount: 2, changedFileCount: 0, reusedFileCount: 2, failureCount: 0 });
    expect(second.rows).toEqual(first.rows);
  });

  it("uses the largest counters when repeated Claude rows contain an incremental snapshot", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "projects");
    const cachePath = join(directory, "cache", "claude.json");
    await mkdir(root, { recursive: true });
    const event = (outputTokens: number) => ({
      type: "assistant", timestamp: "2031-04-22T00:00:00Z",
      message: { id: "message-1", model: "claude-sonnet-5", usage: {
        input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 5, output_tokens: outputTokens,
      } },
    });
    await writeFile(join(root, "session.jsonl"), [event(5), event(20)].map((value) => JSON.stringify(value)).join("\n"));

    const result = await scan("claude", root, cachePath);
    expect(result.rows).toEqual([expect.objectContaining({
      uncachedInputTokens: 40,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 20,
    })]);
  });

  it("keeps Claude's 1-hour cache writes apart from the 5-minute ones", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "projects");
    const cachePath = join(directory, "cache", "claude.json");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "session.jsonl"), JSON.stringify({
      type: "assistant", timestamp: "2031-04-22T00:00:00Z",
      message: { id: "message-1", model: "claude-fable-5-1", usage: {
        input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 5,
        cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
      } },
    }));

    const first = await scan("claude", root, cachePath);
    expect(first.rows).toEqual([expect.objectContaining({ cacheWriteTokens: 1000, cacheWrite1hTokens: 600 })]);
    // The split survives a scan served from the per-file cache.
    const second = await scan("claude", root, cachePath);
    expect(second.reusedFileCount).toBe(1);
    expect(second.rows).toEqual(first.rows);
  });

  it("labels rows by the working directory's last segment, never the full path", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "projects");
    const cachePath = join(directory, "cache", "claude.json");
    await mkdir(root, { recursive: true });
    const event = (id: string, cwd?: string) => ({
      type: "assistant", timestamp: "2031-04-22T00:00:00Z", ...(cwd ? { cwd } : {}),
      message: { id, model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 2 } },
    });
    await writeFile(join(root, "labelled.jsonl"), JSON.stringify(event("message-1", "/home/user/projects/example-app/")));
    await writeFile(join(root, "unlabelled.jsonl"), JSON.stringify(event("message-2")));

    const result = await scan("claude", root, cachePath);
    expect(result.rows.map((row) => row.project).sort()).toEqual(["Unknown", "example-app"]);
    expect(JSON.stringify(result.rows)).not.toContain("/home/user/projects");
    expect(await readFile(cachePath, "utf8")).not.toContain("/home/user/projects");
  });

  it("skips zero-token synthetic Claude rows and a truncated final line", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "projects");
    const cachePath = join(directory, "cache", "claude.json");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "session.jsonl"), [
      JSON.stringify({ type: "assistant", timestamp: "2031-04-22T00:00:00Z", message: { id: "status", model: "<synthetic>", usage: {} } }),
      '{"incomplete"',
    ].join("\n"));

    const result = await scan("claude", root, cachePath);
    expect(result.failureCount).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it("counts Prime recursive-agent transcripts once and ignores parent attribution aggregates", async () => {
    const directory = await temporaryDirectory();
    const sessionsRoot = join(directory, "sessions");
    const artifactsRoot = join(directory, "session-artifacts");
    const childRoot = join(artifactsRoot, "root-session", "sub-reviewer");
    const cachePath = join(directory, "cache", "prime.json");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(childRoot, { recursive: true });
    await writeFile(join(sessionsRoot, "root-session.jsonl"), [
      { type: "session", version: 3, id: "root-session", timestamp: "2031-04-22T02:00:00Z" },
      { type: "message", id: "parent-message", timestamp: "2031-04-22T02:15:00Z", message: {
        role: "assistant", provider: "google", model: "gemini-2.5-pro", content: "private parent content",
        usage: { input: 40, cacheRead: 10, cacheWrite: 5, output: 5, cost: { total: 0.01 } },
      } },
      { type: "child_usage_attributed", id: "attribution", parentId: "parent-message", timestamp: "2031-04-22T03:00:00Z",
        targetId: "parent-message",
        childUsage: { input: 30, cacheRead: 0, cacheWrite: 0, output: 15, cost: { total: 0.02 } },
        aggregateUsage: { input: 70, cacheRead: 10, cacheWrite: 5, output: 20, cost: { total: 0.03 } },
      },
    ].map((value) => JSON.stringify(value)).join("\n"));
    await writeFile(join(childRoot, "child-session.jsonl"), [
      { type: "session", version: 3, id: "child-session", timestamp: "2031-04-22T02:30:00Z" },
      { type: "message", id: "child-message", timestamp: "2031-04-22T02:45:00Z", message: {
        role: "assistant", provider: "google", model: "gemini-2.5-pro", content: "private child content",
        usage: { input: 30, cacheRead: 0, cacheWrite: 0, output: 15, cost: { total: 0.02 } },
      } },
    ].map((value) => JSON.stringify(value)).join("\n"));

    const result = await scan("prime", [sessionsRoot, artifactsRoot], cachePath);
    expect(result).toMatchObject({ agentId: "prime", fileCount: 2, failureCount: 0 });
    expect(result.rows).toEqual([expect.objectContaining({
      modelProviderId: "google",
      model: "gemini-2.5-pro",
      uncachedInputTokens: 70,
      cachedInputTokens: 10,
      cacheWriteTokens: 5,
      outputTokens: 20,
      loggedCostUsd: 0.03,
    })]);
    const cache = await readFile(cachePath, "utf8");
    expect(cache).not.toContain("private parent content");
    expect(cache).not.toContain("private child content");
  });

  it("discards a v3 cache so UTC-bucketed rows cannot survive the upgrade", async () => {
    // v3 stored a precomputed UTC `day`. v4 buckets in host-local time, so a
    // reused v3 entry would mix the two silently and forever.
    const directory = await temporaryDirectory();
    const root = join(directory, "sessions");
    const cachePath = join(directory, "cache", "codex.json");
    await mkdir(root, { recursive: true });
    await mkdir(join(directory, "cache"), { recursive: true });
    await writeFile(join(root, "rollout-test.jsonl"), [
      { timestamp: "2031-04-22T12:00:00Z", type: "session_meta", payload: { id: "session-1" } },
      { timestamp: "2031-04-22T12:00:00Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      { timestamp: "2031-04-22T12:01:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 5, output_tokens: 20 } } } },
    ].map((value) => JSON.stringify(value)).join("\n"));

    await writeFile(cachePath, JSON.stringify({
      version: 3,
      agentId: "codex",
      files: { stale: { signature: "stale", rows: [{ day: "1999-01-01", modelProviderId: "openai", model: "poisoned", uncachedInputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, loggedCostUsd: null }] } },
    }));

    const result = await scan("codex", root, cachePath);
    expect(result.reusedFileCount).toBe(0);
    expect(result.rows.map((row) => row.day)).not.toContain("1999-01-01");
    expect(JSON.parse(await readFile(cachePath, "utf8")).version).toBe(5);
  });

  it("keeps host filesystem paths out of failure diagnostics", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "sessions");
    const cachePath = join(directory, "cache", "codex.json");
    await mkdir(root, { recursive: true });
    // Discoverable and stat-able, but unreadable -- so parseFile throws and the
    // failure path runs with a real filePath in scope.
    const secret = join(root, "rollout-secret.jsonl");
    await writeFile(secret, "{}\n");
    await chmod(secret, 0o000);

    const result = await scan("codex", root, cachePath);
    expect(result.failureCount).toBeGreaterThan(0);
    // `error` carries the first failure string off the host verbatim.
    expect(result.error).toBe("A usage log could not be read.");
    await chmod(secret, 0o600);
  });
});
