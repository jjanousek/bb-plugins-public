import { canonicalModelId, normalizeProviderId, resolvePricing, type PricingStatus } from "./lib/pricing";

export type AgentId = "codex" | "claude" | "cursor" | "fx" | "grok" | "opencode" | "pi" | "prime" | "antigravity" | "omp";

export type UsageRecord = {
  eventKey: string;
  timestamp: string;
  day: string;
  agentId: AgentId;
  agentName: string;
  modelProviderId: string;
  modelProviderName: string;
  machineId: string;
  machineName: string;
  model: string;
  project: string;
  costUsd: number;
  loggedCostUsd: number | null;
  pricingStatus: PricingStatus;
  cacheSavingsUsd: number;
  processedTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  // Model requests behind the row. Harnesses that log tokens leave this at 0:
  // the row is already legible from its tokens, and counting requests from a
  // token log would double-count a retried request. It exists for a harness
  // that records the request and nothing about its size, which is Cursor.
  turns: number;
};

type UsageInput = {
  eventKey: string;
  timestamp: string;
  day: string;
  agentId: AgentId;
  agentName: string;
  modelProviderId: string;
  model: string;
  project?: string;
  loggedCostUsd?: number | null;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
  outputTokens: number;
  turns?: number;
  costMode?: "logged-only" | "positive-logged-only";
};

type ParseContext = { machineId: string; machineName: string };

export type HostUsageAggregate = {
  day: string;
  modelProviderId: string;
  model: string;
  project: string;
  loggedCostUsd: number | null;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  // The part of cacheWriteTokens written to the 1-hour cache. Only Claude Code
  // logs the split; every other harness leaves it 0 or absent.
  cacheWrite1hTokens?: number;
  outputTokens: number;
};

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
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function usageRecord(input: UsageInput, context: ParseContext): UsageRecord {
  // Every record is stored under the canonical id, so one model is one row in
  // the model breakdown whichever agent reported it.
  const model = canonicalModelId(input.modelProviderId, input.model);
  const pricing = resolvePricing(input.modelProviderId, model);
  const uncached = count(input.uncachedInputTokens);
  const cached = count(input.cachedInputTokens);
  const writes = count(input.cacheWriteTokens);
  const writes1h = Math.min(writes, count(input.cacheWrite1hTokens));
  const output = count(input.outputTokens);
  const logged = finite(input.loggedCostUsd);
  const positiveLogged = logged !== null && logged > 0 ? logged : null;
  const loggedOnly = input.costMode === "logged-only";
  const recordedOnly = loggedOnly || input.costMode === "positive-logged-only";
  const estimated = !recordedOnly && pricing.price
    ? ((uncached * pricing.price.input) + (cached * pricing.price.cached) + ((writes - writes1h) * pricing.price.cacheWrite)
      + (writes1h * pricing.price.cacheWrite1h) + (output * pricing.price.output)) / 1_000_000
    : null;
  const effectiveLogged = input.costMode === "positive-logged-only"
    ? positiveLogged
    : loggedOnly && logged !== null ? Math.max(0, logged) : logged;
  const timestamp = isoTimestamp(input.timestamp) ?? input.timestamp;
  return {
    eventKey: input.eventKey,
    timestamp,
    day: input.day,
    agentId: input.agentId,
    agentName: input.agentName,
    modelProviderId: pricing.modelProviderId,
    modelProviderName: pricing.modelProviderName,
    machineId: context.machineId,
    machineName: context.machineName,
    model,
    project: text(input.project, "Unknown"),
    costUsd: Number((estimated ?? effectiveLogged ?? 0).toFixed(6)),
    loggedCostUsd: effectiveLogged === null ? null : Number(Math.max(0, effectiveLogged).toFixed(6)),
    pricingStatus: estimated !== null ? pricing.status : effectiveLogged !== null ? "logged" : "unknown",
    cacheSavingsUsd: pricing.price ? Number(((cached * Math.max(0, pricing.price.input - pricing.price.cached)) / 1_000_000).toFixed(6)) : 0,
    processedTokens: uncached + cached + writes + output,
    cachedInputTokens: cached,
    cacheWriteTokens: writes,
    uncachedInputTokens: uncached,
    outputTokens: output,
    turns: count(input.turns),
  };
}

export function parseOpenCode(content: string, context: ParseContext): UsageRecord[] {
  let values: unknown;
  try {
    values = JSON.parse(content.trim() || "[]");
  } catch {
    throw new Error("OpenCode returned malformed JSON.");
  }
  if (!Array.isArray(values)) throw new Error("OpenCode returned an unexpected result shape.");

  return values.map((raw, index) => {
    const row = object(raw);
    const day = text(row?.day, "");
    const timestamp = isoTimestamp(`${day}T00:00:00Z`);
    const modelProvider = text(row?.modelProviderId, "");
    const model = text(row?.model, "");
    const loggedCost = finite(row?.loggedCostUsd);
    const tokenValues = [
      row?.inputTokens,
      row?.cachedInputTokens,
      row?.cacheWriteTokens,
      row?.outputTokens,
      row?.reasoningTokens,
    ].map(finite);
    if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !timestamp || !modelProvider || !model
      || loggedCost === null
      || tokenValues.some((value) => value === null || value < 0 || !Number.isInteger(value))) {
      throw new Error(`OpenCode returned an invalid aggregate row at index ${index}.`);
    }
    const modelProviderId = normalizeProviderId(modelProvider);
    const [input, cached, cacheWrite, output, reasoning] = tokenValues as number[];
    return usageRecord({
      eventKey: `opencode:${context.machineId}:${day}:${encodeURIComponent(modelProviderId)}:${encodeURIComponent(model)}`,
      timestamp, day, agentId: "opencode", agentName: "OpenCode", modelProviderId, model,
      loggedCostUsd: loggedCost, costMode: "positive-logged-only", uncachedInputTokens: input,
      cachedInputTokens: cached, cacheWriteTokens: cacheWrite, outputTokens: output + reasoning,
    }, context);
  });
}

export function parseHostUsageAggregates(content: string, agentId: Exclude<AgentId, "opencode" | "cursor">, context: ParseContext): UsageRecord[] {
  let values: unknown;
  try {
    values = JSON.parse(content.trim() || "[]");
  } catch {
    throw new Error(`${agentId} host scan returned malformed JSON.`);
  }
  if (!Array.isArray(values)) throw new Error(`${agentId} host scan returned an unexpected result shape.`);

  const agentName = agentId === "codex" ? "Codex"
    : agentId === "claude" ? "Claude Code"
    : agentId === "grok" ? "Grok Agent"
    : agentId === "fx" ? "FX"
    : agentId === "prime" ? "Prime Agent"
    : agentId === "antigravity" ? "Antigravity"
    : agentId === "omp" ? "omp"
    : "Pi";

  const costMode = agentId === "fx" ? "logged-only" as const
    : agentId === "prime" || agentId === "pi" ? "positive-logged-only" as const
    : undefined;

  // Two model ids can canonicalize onto the same one (a short alias such as
  // `fable` and the full `claude-fable-5`), which makes one event key for two rows. Sum them
  // instead of letting the later row overwrite the earlier one.
  const merged = new Map<string, UsageInput & { timestamp: string }>();
  for (const raw of values) {
    const row = object(raw);
    if (!row) continue;
    const day = text(row.day, "");
    const timestamp = isoTimestamp(`${day}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !timestamp) continue;
    const rawProviderId = text(row.modelProviderId, "unknown");
    const model = canonicalModelId(rawProviderId, text(row.model, "unknown"));
    const modelProviderId = resolvePricing(rawProviderId, model).modelProviderId;
    const project = text(row.project, "Unknown");
    const eventKey = `${agentId}:${context.machineId}:${day}:${encodeURIComponent(modelProviderId)}:${encodeURIComponent(model)}:${encodeURIComponent(project)}`;
    const logged = finite(row.loggedCostUsd);
    const current = merged.get(eventKey);
    if (!current) {
      merged.set(eventKey, {
        eventKey, timestamp, day, agentId, agentName, modelProviderId, model, project, costMode,
        loggedCostUsd: logged,
        uncachedInputTokens: count(row.uncachedInputTokens),
        cachedInputTokens: count(row.cachedInputTokens),
        cacheWriteTokens: count(row.cacheWriteTokens),
        cacheWrite1hTokens: count(row.cacheWrite1hTokens),
        outputTokens: count(row.outputTokens),
      });
      continue;
    }
    current.uncachedInputTokens += count(row.uncachedInputTokens);
    current.cachedInputTokens += count(row.cachedInputTokens);
    current.cacheWriteTokens += count(row.cacheWriteTokens);
    current.cacheWrite1hTokens = (current.cacheWrite1hTokens ?? 0) + count(row.cacheWrite1hTokens);
    current.outputTokens += count(row.outputTokens);
    // A null logged cost means "not recorded", so it must not read as a zero.
    if (logged !== null) current.loggedCostUsd = (current.loggedCostUsd ?? 0) + logged;
  }

  return [...merged.values()].map((input) => usageRecord(input, context));
}

// Cursor keeps no token counts or cost on the local machine, and its ACP
// bridge does not forward token usage, so the collector reads the account
// instead: `GetFilteredUsageEvents` returns one row per billed request with its
// tokens and what Cursor charged for it. A Cursor row therefore carries
// Cursor's own tokens and cost. It has no project, because the billing record
// has no working directory and nothing local to join it on.
export function parseCursor(content: string, context: ParseContext): UsageRecord[] {
  let values: unknown;
  try {
    values = JSON.parse(content.trim() || "[]");
  } catch {
    throw new Error("Cursor scan returned malformed JSON.");
  }
  if (!Array.isArray(values)) throw new Error("Cursor scan returned an unexpected result shape.");

  const merged = new Map<string, UsageInput & { timestamp: string }>();
  for (const [index, raw] of values.entries()) {
    const row = object(raw);
    const day = text(row?.day, "");
    const timestamp = isoTimestamp(`${day}T00:00:00Z`);
    const model = text(row?.model, "");
    const events = finite(row?.events);
    const cents = finite(row?.cents);
    if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !timestamp || !model
      || events === null || events < 0 || !Number.isInteger(events) || cents === null) {
      throw new Error(`Cursor scan returned an invalid aggregate row at index ${index}.`);
    }
    // The row keeps Cursor's own model id and is filed under xAI as the model
    // provider; the cost never comes from a rate card, so the provider only
    // groups the row.
    const modelProviderId = normalizeProviderId("xai");
    const eventKey = `cursor:${context.machineId}:${day}:${encodeURIComponent(model)}`;
    const current = merged.get(eventKey);
    if (current) {
      current.turns = (current.turns ?? 0) + events;
      current.loggedCostUsd = (current.loggedCostUsd ?? 0) + cents / 100;
      current.uncachedInputTokens = (current.uncachedInputTokens ?? 0) + count(row.inputTokens);
      current.outputTokens = (current.outputTokens ?? 0) + count(row.outputTokens);
      current.cachedInputTokens = (current.cachedInputTokens ?? 0) + count(row.cacheReadTokens);
      continue;
    }
    merged.set(eventKey, {
      eventKey, timestamp, day, agentId: "cursor", agentName: "Cursor", modelProviderId, model,
      project: "Unknown",
      // Cursor bills the call and reports what it charged, so its own figure is
      // the cost. An API rate card would be a guess about somebody else's
      // pricing, and a zero here is a real zero: some calls are not charged.
      costMode: "logged-only",
      loggedCostUsd: cents / 100,
      turns: events,
      uncachedInputTokens: count(row.inputTokens),
      cachedInputTokens: count(row.cacheReadTokens),
      // Cursor reports no cache-write bucket of its own.
      cacheWriteTokens: 0,
      outputTokens: count(row.outputTokens),
    });
  }
  return [...merged.values()].map((input) => usageRecord(input, context));
}
