// Runs on the enrolled host in a bare `node -e`, not inside bb-server. Its
// source is compiled to plain JavaScript by scripts/build-host-scripts.mjs and
// shipped as text from lib/generated/host-scripts.ts, so bb's bundler (which
// rewrites function bodies) never touches it. Keep every runtime dependency
// inside the function or pass it through `dependencies`; only type imports
// are allowed in this file. After editing, run `npm run build:host-scripts`.
import type { Buffer } from "node:buffer";
import type { HostUsageAggregate } from "../../collectors";
import type { HostJsonAgentId, HostJsonScanInput, HostJsonScanResult } from "../host-json-collector";

export type CollectorDependencies = {
  buffer: typeof Buffer;
  fs: typeof import("node:fs");
  path: typeof import("node:path");
  crypto: typeof import("node:crypto");
  readline: typeof import("node:readline");
  zlib: typeof import("node:zlib");
};

export async function hostJsonCollector(encodedInput: string, dependencies: CollectorDependencies) {
  const { buffer, fs, path, crypto, readline, zlib } = dependencies;
  // Cached rows from any other version are discarded, so the version rises
  // whenever what a cached row holds changes. Version 5 rows carry: hashed
  // Claude response identities, so repeated rows and copied transcripts are
  // deduplicated before aggregation; the per-session project label; a `day`
  // bucketed in the host's local timezone, with zero-token / zero-cost rows
  // dropped; and Claude's 1-hour cache writes (cacheWrite1hTokens) split out,
  // since they bill at a higher rate than 5-minute ones.
  const cacheVersion = 5;
  const scanBegin = "__BB_USAGE_SCAN_BEGIN__";
  const scanEnd = "__BB_USAGE_SCAN_END__";
  const input = JSON.parse(buffer.from(encodedInput, "base64").toString("utf8")) as HostJsonScanInput;
  const allowedAgents = new Set<HostJsonAgentId>(["codex", "claude", "fx", "grok", "pi", "prime", "antigravity", "omp"]);
  if (!allowedAgents.has(input.agentId)) throw new Error("Unsupported usage agent.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sinceDay)) throw new Error("Invalid usage history boundary.");

  type CachedUsageRow = HostUsageAggregate & { eventKey?: string };
  type CacheEntry = { signature: string; rows: CachedUsageRow[] };
  type Cache = { version: number; agentId: HostJsonAgentId; files: Record<string, CacheEntry> };
  const failures: string[] = [];
  let discoveryFailed = false;
  const cutoffMs = Date.parse(`${input.sinceDay}T00:00:00Z`);

  function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }

  function finite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
  }

  function count(value: unknown) {
    return Math.max(0, Math.round(finite(value) ?? 0));
  }

  function text(value: unknown, fallback: string) {
    return typeof value === "string" && value.trim() ? value : fallback;
  }

  // Only the working directory's final segment is recorded, so usage can be
  // grouped by project without storing the machine's directory layout.
  function projectName(value: unknown) {
    if (typeof value !== "string" || !value.trim()) return "Unknown";
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    const segment = normalized.slice(normalized.lastIndexOf("/") + 1);
    return segment.trim() ? segment.trim().slice(0, 80) : "Unknown";
  }

  function day(value: unknown) {
    if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) return null;
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return null;
    const parsed = new Date(timestamp);
    const result = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
    return result >= input.sinceDay ? result : null;
  }

  function validRow(value: unknown): value is CachedUsageRow {
    const row = object(value);
    return Boolean(row
      && typeof row.day === "string"
      && typeof row.modelProviderId === "string"
      && typeof row.model === "string"
      && typeof row.project === "string"
      && (row.loggedCostUsd === null || finite(row.loggedCostUsd) !== null)
      && finite(row.uncachedInputTokens) !== null
      && finite(row.cachedInputTokens) !== null
      && finite(row.cacheWriteTokens) !== null
      && finite(row.cacheWrite1hTokens) !== null
      && finite(row.outputTokens) !== null
      && (row.eventKey === undefined || typeof row.eventKey === "string"));
  }

  function validCacheEntry(value: unknown): value is CacheEntry {
    const entry = object(value);
    return Boolean(entry && typeof entry.signature === "string"
      && Array.isArray(entry.rows) && entry.rows.every(validRow));
  }

  function add(target: Map<string, HostUsageAggregate>, raw: HostUsageAggregate) {
    if (raw.day < input.sinceDay) return;
    const row: HostUsageAggregate = {
      day: raw.day,
      modelProviderId: text(raw.modelProviderId, "unknown"),
      model: text(raw.model, "unknown"),
      project: text(raw.project, "Unknown"),
      loggedCostUsd: finite(raw.loggedCostUsd),
      uncachedInputTokens: count(raw.uncachedInputTokens),
      cachedInputTokens: count(raw.cachedInputTokens),
      cacheWriteTokens: count(raw.cacheWriteTokens),
      cacheWrite1hTokens: count(raw.cacheWrite1hTokens),
      outputTokens: count(raw.outputTokens),
    };
    const key = JSON.stringify([row.day, row.modelProviderId, row.model, row.project]);
    const prior = target.get(key);
    if (!prior) {
      target.set(key, row);
      return;
    }
    prior.uncachedInputTokens += row.uncachedInputTokens;
    prior.cachedInputTokens += row.cachedInputTokens;
    prior.cacheWriteTokens += row.cacheWriteTokens;
    prior.cacheWrite1hTokens = (prior.cacheWrite1hTokens ?? 0) + (row.cacheWrite1hTokens ?? 0);
    prior.outputTokens += row.outputTokens;
    if (row.loggedCostUsd !== null) prior.loggedCostUsd = (prior.loggedCostUsd ?? 0) + row.loggedCostUsd;
  }

  function mergeEvent(target: Map<string, CachedUsageRow>, raw: CachedUsageRow) {
    if (!raw.eventKey) return;
    const prior = target.get(raw.eventKey);
    if (!prior) {
      target.set(raw.eventKey, raw);
      return;
    }
    // Claude currently repeats the same final counters on every content-block
    // row. Maxima also handle a partially-written/incremental row safely
    // without multiplying one API response's usage.
    prior.uncachedInputTokens = Math.max(prior.uncachedInputTokens, raw.uncachedInputTokens);
    prior.cachedInputTokens = Math.max(prior.cachedInputTokens, raw.cachedInputTokens);
    prior.cacheWriteTokens = Math.max(prior.cacheWriteTokens, raw.cacheWriteTokens);
    prior.cacheWrite1hTokens = Math.max(prior.cacheWrite1hTokens ?? 0, raw.cacheWrite1hTokens ?? 0);
    prior.outputTokens = Math.max(prior.outputTokens, raw.outputTokens);
    if (raw.loggedCostUsd !== null) prior.loggedCostUsd = Math.max(prior.loggedCostUsd ?? 0, raw.loggedCostUsd);
  }

  function matches(filePath: string) {
    const name = path.basename(filePath);
    if (input.agentId === "codex") return name.startsWith("rollout-") && name.endsWith(".jsonl");
    if (input.agentId === "fx") return name === "usage.jsonl";
    if (input.agentId === "antigravity") return name === "usage.jsonl" || name === "transcript.jsonl";
    if (input.agentId === "grok") return name === "unified.jsonl";
    return name.endsWith(".jsonl");
  }

  async function walk(directory: string, files: string[]) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") {
        try {
          const stat = await fs.promises.stat(directory);
          if (stat.isFile() && matches(directory)) {
            files.push(directory);
            return;
          }
        } catch {
          // The standard discovery error below is sufficient.
        }
      }
      if (code !== "ENOENT") {
        discoveryFailed = true;
        failures.push("A usage directory could not be read.");
      }
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (input.agentId === "antigravity" && (entry.name === "steps" || entry.name === "chunks")) continue;
        await walk(entryPath, files);
      } else if (entry.isFile() && matches(entryPath)) files.push(entryPath);
    }
  }

  function normalizeAntigravityModel(raw: unknown, fallback = "gemini-4-argon") {
    if (typeof raw !== "string" || !raw.trim()) return fallback;
    const withoutEffort = raw.trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
    const slug = withoutEffort.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) return fallback;
    return slug.startsWith("claude-") ? slug.replace(/(\d)\.(\d)/g, "$1-$2") : slug;
  }

  let antigravityModel = "gemini-4-argon";
  if (input.agentId === "antigravity") {
    for (const root of input.roots) {
      try {
        const settings = object(JSON.parse(await fs.promises.readFile(path.join(path.dirname(root), "settings.json"), "utf8")));
        if (typeof settings?.model === "string" && settings.model.trim()) {
          antigravityModel = normalizeAntigravityModel(settings.model, antigravityModel);
          break;
        }
      } catch {
        // Use the default Antigravity model when settings.json is absent.
      }
    }
  }

  async function parseFile(filePath: string): Promise<CachedUsageRow[]> {
    const rows = new Map<string, HostUsageAggregate>();
    const events = new Map<string, CachedUsageRow>();
    let codexModel = "codex-unknown";
    // Session-scoped project, learned from the first record that carries a
    // working directory and reused for later rows in the same file.
    let sessionProject = "Unknown";
    const stream = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 1024 * 1024 });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { continue; }
      const value = object(raw);
      if (!value) continue;

      if (input.agentId === "codex") {
        const payload = object(value.payload);
        if ((value.type === "turn_context" || value.type === "session_meta") && payload) {
          codexModel = text(payload.model, codexModel);
          if (typeof payload.cwd === "string") sessionProject = projectName(payload.cwd);
        }
        if (value.type !== "event_msg" || payload?.type !== "token_count") continue;
        const usage = object(object(payload.info)?.last_token_usage);
        const usageDay = day(value.timestamp);
        if (!usage || !usageDay) continue;
        const inputTokens = count(usage.input_tokens);
        const cached = Math.min(inputTokens, count(usage.cached_input_tokens));
        add(rows, {
          day: usageDay, modelProviderId: "openai", model: codexModel, project: sessionProject, loggedCostUsd: null,
          uncachedInputTokens: inputTokens - cached, cachedInputTokens: cached,
          cacheWriteTokens: count(usage.cache_write_input_tokens), outputTokens: count(usage.output_tokens),
        });
        continue;
      }

      if (input.agentId === "claude") {
        if (value.type !== "assistant") continue;
        const message = object(value.message);
        const usage = object(message?.usage);
        const usageDay = day(value.timestamp);
        if (!message || !usage || !usageDay) continue;
        const model = text(message.model, "claude-unknown");
        const uncached = count(usage.input_tokens);
        const cached = count(usage.cache_read_input_tokens);
        const writes = count(usage.cache_creation_input_tokens);
        // `cache_creation` splits the writes by cache lifetime; the 1-hour
        // ones bill at a higher rate. Clamped so the part never exceeds the whole.
        const writes1h = Math.min(writes, count(object(usage.cache_creation)?.ephemeral_1h_input_tokens));
        const output = count(usage.output_tokens);
        if (model === "<synthetic>" && uncached + cached + writes + output === 0) continue;
        const rawIdentity = typeof message.id === "string" && message.id
          ? `message:${message.id}`
          : typeof value.requestId === "string" && value.requestId ? `request:${value.requestId}` : null;
        if (typeof value.cwd === "string") sessionProject = projectName(value.cwd);
        const row: CachedUsageRow = {
          day: usageDay, modelProviderId: "anthropic", model, project: sessionProject, loggedCostUsd: null,
          uncachedInputTokens: uncached, cachedInputTokens: cached, cacheWriteTokens: writes, cacheWrite1hTokens: writes1h,
          outputTokens: output,
          eventKey: rawIdentity ? crypto.createHash("sha256").update(rawIdentity).digest("hex") : undefined,
        };
        if (row.eventKey) mergeEvent(events, row);
        else add(rows, row);
        continue;
      }

      if (input.agentId === "grok") {
        if (value.msg !== "shell.turn.inference_done") continue;
        const usage = object(value.ctx);
        const usageDay = day(value.ts);
        if (!usage || usage.prompt_tokens === undefined || !usageDay) continue;
        const prompt = count(usage.prompt_tokens);
        const cached = Math.min(prompt, count(usage.cached_prompt_tokens));
        if (typeof value.cwd === "string") sessionProject = projectName(value.cwd);
        add(rows, {
          day: usageDay, modelProviderId: "xai", model: text(usage.model, "grok-build-0.1"), project: sessionProject, loggedCostUsd: null,
          uncachedInputTokens: prompt - cached, cachedInputTokens: cached, cacheWriteTokens: 0,
          outputTokens: count(usage.completion_tokens) + count(usage.reasoning_tokens),
        });
        continue;
      }

      if (input.agentId === "fx") {
        if (value.kind !== "generation") continue;
        const fact = object(value.fact);
        const usageDay = day(fact?.created_at_ms);
        if (!fact || !usageDay) continue;
        const model = text(fact.model, "unknown");
        const separator = model.indexOf("/");
        const inputTokens = count(fact.input_tokens);
        const cached = Math.min(inputTokens, count(fact.cache_read_tokens));
        const cacheWrite = Math.min(inputTokens - cached, count(fact.cache_write_tokens));
        add(rows, {
          day: usageDay,
          modelProviderId: separator > 0 ? model.slice(0, separator) : "unknown",
          model,
          project: projectName(fact.cwd ?? fact.workspace ?? value.cwd),
          loggedCostUsd: finite(fact.total_cost),
          uncachedInputTokens: inputTokens - cached - cacheWrite,
          cachedInputTokens: cached,
          cacheWriteTokens: cacheWrite,
          outputTokens: count(fact.output_tokens),
        });
        continue;
      }

      if (input.agentId === "antigravity") {
        if (value.type === "PLANNER_RESPONSE") {
          if (sessionProject === "Unknown" && Array.isArray(value.tool_calls)) {
            for (const call of value.tool_calls) {
              const args = object(object(call)?.args);
              const rawCwd = args?.Cwd ?? args?.cwd ?? args?.DirectoryPath ?? args?.SearchPath;
              if (typeof rawCwd === "string") {
                const cleaned = rawCwd.trim().replace(/^"+|"+$/g, "");
                if (cleaned) {
                  sessionProject = projectName(cleaned);
                  if (sessionProject !== "Unknown") break;
                }
              }
            }
          }
          const usageDay = day(value.created_at);
          const uncached = count(value.input_tokens);
          const cached = count(value.cache_read_tokens);
          const output = count(value.output_tokens);
          if (!usageDay || uncached + cached + output === 0) continue;
          const model = normalizeAntigravityModel(value.model, antigravityModel);
          const modelProviderId = model.startsWith("claude-") ? "anthropic" : text(value.provider, "google");
          add(rows, {
            day: usageDay,
            modelProviderId,
            model,
            project: sessionProject,
            loggedCostUsd: finite(value.total_cost),
            uncachedInputTokens: uncached,
            cachedInputTokens: cached,
            cacheWriteTokens: 0,
            outputTokens: output,
          });
          continue;
        }
        // Also reads ~/.antigravity-acp/usage.jsonl when written by the bridge.
        if (value.kind !== "generation") continue;
        const fact = object(value.fact);
        const usageDay = day(fact?.created_at_ms);
        if (!fact || !usageDay) continue;
        const inputTokens = count(fact.input_tokens);
        const cached = Math.min(inputTokens, count(fact.cache_read_tokens));
        add(rows, {
          day: usageDay,
          modelProviderId: text(fact.provider, "google"),
          model: text(fact.model, "unknown"),
          project: projectName(fact.cwd ?? fact.workspace ?? value.cwd),
          loggedCostUsd: finite(fact.total_cost),
          uncachedInputTokens: inputTokens - cached,
          cachedInputTokens: cached,
          cacheWriteTokens: 0,
          outputTokens: count(fact.output_tokens),
        });
        continue;
      }

      // omp writes Pi's session shape.
      if (input.agentId === "pi" || input.agentId === "prime" || input.agentId === "omp") {
        const directory = value.cwd ?? value.directory ?? object(value.session)?.cwd;
        if (typeof directory === "string") sessionProject = projectName(directory);
        if (value.type !== "message") continue;
        const message = object(value.message);
        const usage = object(message?.usage);
        const usageDay = day(value.timestamp ?? message?.timestamp);
        if (!message || message.role !== "assistant" || !usage || !usageDay) continue;
        const loggedCostUsd = finite(object(usage.cost)?.total);
        const hasTokens = count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite) + count(usage.output) > 0;
        if (!hasTokens && !(loggedCostUsd !== null && loggedCostUsd > 0)) continue;
        add(rows, {
          day: usageDay,
          modelProviderId: text(message.provider, "unknown"),
          model: text(message.responseModel, text(message.model, "unknown")),
          project: sessionProject,
          loggedCostUsd,
          uncachedInputTokens: count(usage.input), cachedInputTokens: count(usage.cacheRead),
          cacheWriteTokens: count(usage.cacheWrite), outputTokens: count(usage.output),
        });
      }
    }
    if (sessionProject !== "Unknown") {
      for (const [key, row] of [...rows.entries()]) {
        if (row.project === "Unknown") {
          rows.delete(key);
          add(rows, { ...row, project: sessionProject });
        }
      }
    }
    return input.agentId === "claude" ? [...events.values(), ...rows.values()] : [...rows.values()];
  }

  let cache: Cache = { version: cacheVersion, agentId: input.agentId, files: {} };
  try {
    const parsed = object(JSON.parse(await fs.promises.readFile(input.cachePath, "utf8")));
    const parsedFiles = object(parsed?.files);
    if (parsed?.version === cacheVersion && parsed.agentId === input.agentId && parsedFiles) {
      const files: Record<string, CacheEntry> = {};
      for (const [sourceId, entry] of Object.entries(parsedFiles)) {
        if (validCacheEntry(entry)) files[sourceId] = entry;
      }
      cache = { version: cacheVersion, agentId: input.agentId, files };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push("The prior metadata cache could not be read.");
  }

  const discovered: string[] = [];
  for (const root of [...new Set(input.roots)]) await walk(root, discovered);
  discovered.sort();
  const nextFiles: Record<string, CacheEntry> = {};
  const allRows = new Map<string, HostUsageAggregate>();
  const allEvents = new Map<string, CachedUsageRow>();
  let fileCount = 0;
  let changedFileCount = 0;
  let reusedFileCount = 0;

  for (const filePath of discovered) {
    const sourceId = crypto.createHash("sha256").update(filePath).digest("hex");
    const prior = cache.files[sourceId];
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs < cutoffMs) continue;
      fileCount += 1;
      const signature = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
      if (prior?.signature === signature && Array.isArray(prior.rows) && prior.rows.every(validRow)) {
        nextFiles[sourceId] = prior;
        for (const row of prior.rows) row.eventKey ? mergeEvent(allEvents, row) : add(allRows, row);
        reusedFileCount += 1;
        continue;
      }
      const rows = await parseFile(filePath);
      nextFiles[sourceId] = { signature, rows };
      for (const row of rows) row.eventKey ? mergeEvent(allEvents, row) : add(allRows, row);
      changedFileCount += 1;
    } catch {
      // Absolute host paths and raw errors must not cross the host boundary;
      // this string is persisted in sync state and shown in the dashboard.
      failures.push("A usage log could not be read.");
      if (prior && Array.isArray(prior.rows) && prior.rows.every(validRow)) {
        nextFiles[sourceId] = prior;
        for (const row of prior.rows) row.eventKey ? mergeEvent(allEvents, row) : add(allRows, row);
      }
    }
  }

  if (discoveryFailed) {
    for (const [sourceId, prior] of Object.entries(cache.files)) {
      if (nextFiles[sourceId] || !Array.isArray(prior.rows) || !prior.rows.every(validRow)) continue;
      nextFiles[sourceId] = prior;
      for (const row of prior.rows) row.eventKey ? mergeEvent(allEvents, row) : add(allRows, row);
    }
  }

  try {
    await fs.promises.mkdir(path.dirname(input.cachePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${input.cachePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(temporaryPath, JSON.stringify({
      version: cacheVersion,
      agentId: input.agentId,
      files: nextFiles,
    }), { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporaryPath, input.cachePath);
  } catch {
    failures.push("The metadata-only usage cache could not be updated.");
  }

  for (const row of allEvents.values()) add(allRows, row);
  const rows = [...allRows.values()].sort((a, b) => a.day.localeCompare(b.day)
    || a.modelProviderId.localeCompare(b.modelProviderId) || a.model.localeCompare(b.model)
    || a.project.localeCompare(b.project));
  const result: HostJsonScanResult = {
    agentId: input.agentId,
    fileCount,
    changedFileCount,
    reusedFileCount,
    failureCount: failures.length,
    error: failures[0]?.replace(/[\r\n]+/g, " ").slice(0, 200) ?? null,
    rows,
  };
  const encoded = zlib.gzipSync(JSON.stringify(result)).toString("base64");
  process.stdout.write(`${scanBegin}\n${encoded}\n${scanEnd}\n`);
}
