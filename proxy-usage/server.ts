// bb-plugin-proxy-usage: backend.
//
// Reads every OAuth credential in ~/.omp/agent/agent.db (Google AI Ultra and
// Anthropic Claude Max) and polls each account's subscription usage endpoints.
// The snapshot lives in memory; every client reads it through RPC, and a
// background service refreshes it every few minutes.
//
// Tokens never leave this process: the RPC output carries emails, percentages
// and reset times only.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  aggregateServerHealth,
  buildServerMetrics,
  cpuPercentFromStatSamples,
  decideAccount,
  isAccountInUse,
  parseProcLoadavg,
  parseProcMeminfo,
  parseProcStat,
  parseSystemctlFailedUnits,
  parseSystemctlShowWatchdog,
  pickAccountToUse,
  RETRY_MAX_MS,
  sleep,
  untilAborted,
  windowsFromOmpReport,
  type AccountResult,
  type OmpUsageLimitItem,
  type ServerHealth,
  type ServerMetrics,
} from "./usage";
import {
  alertActive,
  classifyCompletedTurnError,
  classifyFailure,
  classifyOnce,
  inferCredentialProvider,
  providerChainEnded,
  releaseParked,
  decide,
  modelFromDetail,
  raiseAlert,
  resetFor,
  DEFAULT_TIMING,
  activeTestMode,
  startTestMode,
  dispatchHold,
  onRecovery,
  factsFromRows,
  readTurnEvents,
  type EventRowLike,
  isOtherRetry,
  isOurRetry,
  RETRY_REASON_PREFIX,
  pendingResumeRows,
  STARTUP_HOLD_MS,
  type AuthAlert,
  type FailureFacts,
  type ResumeRecord,
  type TestMode,
} from "./resume";
import {
  agentDbCoreAuthFiles,
  agentDbFileName,
  ejectAccount,
  EjectIntents,
  ejectRefusal,
  hasBrowserOrigin,
  listEjected,
  NOT_USER_CLICK,
  purgeEjected,
  readAgentDbCredentials,
  exportAgentDbEjectPayload,
  switchAgentDbAccount,
  undoEject,
  writeEjectedList,
  type AgentDbCredentialRow,
} from "./eject";

const execFileAsync = promisify(execFile);
const OMP_BIN = join(homedir(), ".local", "bin", "omp");
const OMP_TIMEOUT_MS = 25_000;
const POLL_MS = 5 * 60_000;

/**
 * Ejected accounts wait here for 7 days, in the plugin's own 0700 state
 * folder. It sits outside omp's and bb's config folders, so nothing that
 * syncs or copies those folders brings an ejected account back or keeps it
 * past its purge.
 */
const EJECTED_DIR = join(homedir(), ".local", "state", "proxy-usage", "ejected");
/** One auth file name per ejected account, for any tool that should skip those accounts. */
const EJECTED_LIST = join(homedir(), ".local", "state", "proxy-usage", "ejected-accounts.txt");

/** Default path to omp's multi-account credential database. */
const DEFAULT_AGENT_DB = join(homedir(), ".omp", "agent", "agent.db");
/** A 429 the figures do not explain re-reads them if they are older than this. */
const FRESH_ENOUGH_MS = 30_000;
/** Manual refreshes closer together than this reuse the snapshot. */
const MIN_REFRESH_GAP_MS = 5_000;
/** Server status readings are reused for this long unless a refresh forces them. */
const SERVER_HEALTH_CACHE_MS = 60_000;
/** Each server status probe gives up after this long. */
const SERVER_HEALTH_PROBE_MS = 5_000;
/** CPU and memory strip readings are reused for a few seconds between polls. */
const SERVER_METRICS_CACHE_MS = 5_000;
/** Interval between the two /proc/stat reads for whole-machine CPU busy percent. */
const CPU_SAMPLE_GAP_MS = 200;
const DEFAULT_WATCHDOG_UNIT = "watchdog.service";

const healthLevel = z.enum(["green", "amber", "red", "unknown"]);

const serverMetricRow = z.object({
  level: healthLevel,
  usedPercent: z.number().nullable(),
  text: z.string(),
  tooltip: z.string(),
});

const serverMetricsSchema = z.object({
  checkedAt: z.string().nullable(),
  cpu: serverMetricRow,
  memory: serverMetricRow,
});
const usageWindow = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
});

const accountUsage = z.object({
  id: z.number().optional(),
  provider: z.string().optional(),
  email: z.string(),
  file: z.string(),
  disabled: z.boolean(),
  status: z.enum(["ok", "expired", "error", "stale", "on-hold"]),
  windows: z.array(usageWindow),
  message: z.string().nullable(),
  okAt: z.string().nullable(),
});

const resumeRow = z.object({ threadId: z.string(), kind: z.enum(["quota", "auth", "once"]), sendAt: z.number(), note: z.string() });

const usageState = z.object({
  accounts: z.array(accountUsage),
  authDir: z.string(),
  fetchedAt: z.string().nullable(),
  message: z.string().nullable(),
  /** Failed turns this plugin has queued to resume, soonest first. */
  resumes: z.array(resumeRow).optional(),
  /** Set while the proxy has no usable login and the retry cap was reached. */
  resumeAlert: z.string().nullable().optional(),
  /** Accounts ejected in the last 7 days, which undo can still put back. */
  ejected: z.array(z.object({ file: z.string(), email: z.string(), provider: z.string().optional(), purgeAt: z.number() })).optional(),
  /** Google AI Ultra subscription usage via Antigravity (omp / agy), when configured. */
  antigravity: accountUsage.nullable().optional(),
  /** The footer strip's server status: failed units, machines, disk, watchdog unit. */
  serverHealth: z
    .object({
      level: healthLevel,
      word: z.string(),
      tooltip: z.string(),
      checkedAt: z.string().nullable(),
      checks: z.array(
        z.object({
          id: z.enum(["systemd", "machines", "disk", "watchdog"]),
          label: z.string(),
          level: healthLevel,
          detail: z.string(),
        }),
      ),
    })
    .nullable()
    .optional(),
  /** Live CPU and Memory usage rows for the sidebar footer strip. */
  serverMetrics: serverMetricsSchema.nullable().optional(),
});

export type UsageWindow = z.infer<typeof usageWindow>;
export type AccountUsage = z.infer<typeof accountUsage>;
export type UsageState = z.infer<typeof usageState>;
export type ResumeRow = z.infer<typeof resumeRow>;

export const rpcContract = defineRpcContract({
  state: { input: z.null(), output: usageState },
  refresh: { input: z.null(), output: usageState },
  metrics: { input: z.null(), output: serverMetricsSchema },
  /** Enable one credential file and disable every other Claude one. */
  useAccount: { input: z.object({ file: z.string().min(1) }).strict(), output: usageState },
});

// Credential rows are read from auth_credentials in ~/.omp/agent/agent.db.

/** The shape of the usage endpoint we rely on; everything else is ignored. */
// Quota figures are read from `omp usage --no-extensions --json` so proxy-usage
// and omp share one parser, one cache, and one OAuth refresh lease owner.

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    authDir: {
      type: "string",
      label: "omp agent.db path",
      description: "Path to ~/.omp/agent/agent.db holding multi-account OAuth credentials. Leave empty for the default ~/.omp/agent/agent.db.",
      default: "",
    },
    ignoredUnits: {
      type: "string",
      label: "Ignored systemd units",
      description: "Comma-separated systemd unit names to ignore in the footer server status check.",
      default: "",
    },
    watchdogUnit: {
      type: "string",
      label: "Watchdog systemd unit",
      description: "Systemd unit whose last run the server check watches.",
      default: DEFAULT_WATCHDOG_UNIT,
    },
  });

  async function agentDbPath(): Promise<string> {
    const { authDir: configured } = await settings.get();
    const trimmed = configured.trim();
    if (trimmed.length > 0 && trimmed.endsWith(".db")) {
      return trimmed.replace(/^~(?=\/|$)/u, homedir());
    }
    return DEFAULT_AGENT_DB;
  }

  let current: UsageState = { accounts: [], authDir: DEFAULT_AGENT_DB, fetchedAt: null, message: null, antigravity: null };
  let inFlight: Promise<UsageState> | null = null;
  let complaint = "";
  let lastRefreshAt = 0;

  function previousFor(file: string, email: string, provider: string): AccountUsage | undefined {
    return (
      current.accounts.find((account) => account.file === file) ??
      current.accounts.find((account) => account.email === email && (account.provider ?? "anthropic") === provider)
    );
  }

  /**
   * Overlay freshly read `disabled_cause` flags from agent.db onto cached
   * account results so `state` RPC and `/eject` always see current active /
   * standby / on-hold flags without waiting for a network poll.
   */
  function overlayAgentDbFlags(accounts: readonly AccountUsage[], dbPath: string): AccountUsage[] {
    let rows: AgentDbCredentialRow[];
    try {
      rows = readAgentDbCredentials(dbPath);
    } catch {
      return [...accounts];
    }
    const byFile = new Map<string, AgentDbCredentialRow>();
    for (const row of rows) byFile.set(agentDbFileName(row.provider, row.id), row);
    return accounts
      .filter((account) => byFile.has(account.file))
      .map((account) => {
        const row = byFile.get(account.file)!;
        const disabled = row.disabledCause !== null;
        const status = row.disabledCause === "account_on_hold" ? ("on-hold" as const) : account.status;
        if (disabled === account.disabled && status === account.status) return account;
        return { ...account, disabled, status };
      });
  }
  interface OmpUsageReport {
    provider?: string;
    fetchedAt?: number;
    metadata?: {
      email?: string;
      accountId?: string;
      orgId?: string;
      projectId?: string;
    };
    limits?: OmpUsageLimitItem[];
  }

  interface OmpAccountWithoutUsage {
    provider?: string;
    email?: string;
    accountId?: string;
    orgId?: string;
    projectId?: string;
    error?: string;
    reason?: string;
  }

  interface OmpUsageJsonOutput {
    generatedAt?: number;
    reports?: OmpUsageReport[];
    accountsWithoutUsage?: OmpAccountWithoutUsage[];
  }

  async function execOmp(args: readonly string[], signal?: AbortSignal): Promise<string> {
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(OMP_TIMEOUT_MS)]) : AbortSignal.timeout(OMP_TIMEOUT_MS);
    try {
      const { stdout } = await execFileAsync(OMP_BIN, [...args], { timeout: OMP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal: sig });
      return stdout;
    } catch {
      const { stdout } = await execFileAsync("omp", [...args], { timeout: OMP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal: sig });
      return stdout;
    }
  }

  async function fetchOmpUsageJson(_invalidate: boolean, signal?: AbortSignal): Promise<OmpUsageJsonOutput> {
    const raw = await execOmp(["usage", "--no-extensions", "--json"], signal);
    return JSON.parse(raw) as OmpUsageJsonOutput;
  }

  function matchRowReport<T extends { provider?: string; metadata?: OmpUsageReport["metadata"]; email?: string; accountId?: string; orgId?: string; projectId?: string }>(
    row: AgentDbCredentialRow,
    items: readonly T[],
  ): T | undefined {
    const peers = items.filter((item) => (item.provider ?? "").toLowerCase() === row.provider.toLowerCase());
    if (peers.length === 0) return undefined;
    if (row.accountId) {
      const hit = peers.find((item) => (item.metadata ?? item).accountId === row.accountId);
      if (hit) return hit;
    }
    if (row.orgId) {
      const hit = peers.find((item) => (item.metadata ?? item).orgId === row.orgId);
      if (hit) return hit;
    }
    if (row.email) {
      const lower = row.email.toLowerCase();
      const hit = peers.find((item) => (item.metadata ?? item).email?.toLowerCase() === lower);
      if (hit) return hit;
    }
    if (row.projectId) {
      const hit = peers.find((item) => (item.metadata ?? item).projectId === row.projectId);
      if (hit) return hit;
    }
    return peers.length === 1 ? peers[0] : undefined;
  }

  function mapRowFromOmp(
    row: AgentDbCredentialRow,
    ompData: OmpUsageJsonOutput | null,
    ompError: string | null,
    nowIso: string,
  ): AccountUsage {
    const file = agentDbFileName(row.provider, row.id);
    const email = row.email ?? file;
    const disabled = row.disabledCause !== null;
    const base = { email, file, disabled };
    const previous = previousFor(file, email, row.provider);
    const withMeta = (res: AccountResult): AccountUsage => ({
      ...res,
      id: row.id,
      provider: row.provider,
    });
    if (row.disabledCause === "account_on_hold") {
      return withMeta(decideAccount({ ...base, disabled: true }, previous, nowIso, true, null, "on-hold"));
    }
    if (disabled) {
      return withMeta(decideAccount(base, previous, nowIso, true, null, null));
    }
    if (!ompData) {
      return withMeta(decideAccount(base, previous, nowIso, false, { kind: "transport", message: ompError ?? "omp usage failed" }));
    }
    const report = matchRowReport(row, ompData.reports ?? []);
    if (report) {
      const windows = windowsFromOmpReport(row.provider, report.limits ?? []);
      const reportIso =
        typeof report.fetchedAt === "number" && Number.isFinite(report.fetchedAt)
          ? new Date(report.fetchedAt).toISOString()
          : nowIso;
      if (windows.length === 0) {
        return withMeta(decideAccount(base, previous, nowIso, false, { kind: "shape" }));
      }
      return withMeta(decideAccount(base, previous, reportIso, false, { kind: "ok", windows }));
    }
    const missing = matchRowReport(row, ompData.accountsWithoutUsage ?? []);
    const reason = missing?.error ?? missing?.reason ?? "omp usage returned no limits for this account";
    return withMeta(decideAccount(base, previous, nowIso, false, { kind: "transport", message: reason }));
  }

  async function refresh(signal?: AbortSignal, invalidateCache = false): Promise<UsageState> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const dbPath = await agentDbPath();
      const fetchedAt = new Date().toISOString();
      let rows: AgentDbCredentialRow[];
      try {
        rows = readAgentDbCredentials(dbPath);
      } catch (error) {
        const message = `cannot read ${dbPath}: ${error instanceof Error ? error.message : String(error)}`;
        if (message !== complaint) {
          complaint = message;
          bb.log.warn(message);
        }
        current = { accounts: [], antigravity: null, authDir: dbPath, fetchedAt, message };
        lastRefreshAt = Date.now();
        return current;
      }
      let ompData: OmpUsageJsonOutput | null = null;
      let ompError: string | null = null;
      const hasActive = rows.some((row) => row.disabledCause === null);
      if (hasActive) {
        try {
          ompData = await fetchOmpUsageJson(invalidateCache, signal);
        } catch (error) {
          ompError = error instanceof Error ? error.message : String(error);
        }
      }
      const accounts = rows.map((row) => mapRowFromOmp(row, ompData, ompError, fetchedAt));
      const trouble = accounts
        .filter((account) => account.status !== "ok")
        .map((account) => `${account.provider ?? "account"}/${account.email}: ${account.status}${account.message ? ` (${account.message})` : ""}`)
        .join("; ");
      if (trouble !== complaint) {
        complaint = trouble;
        if (trouble) bb.log.info(trouble);
      }
      const antigravity = accounts.find((account) => account.provider === "google-antigravity") ?? null;
      current = { accounts, antigravity, authDir: dbPath, fetchedAt, message: null };
      lastRefreshAt = Date.now();
      return current;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }
  async function useAccount(file: string): Promise<UsageState> {
    const dbPath = await agentDbPath();
    const match = file.match(/^agentdb-[a-z0-9-]+-(\d+)\.json$/u);
    if (!match) throw new Error(`no agent.db credential named ${file}`);
    const id = Number(match[1]);
    const switched = switchAgentDbAccount(dbPath, id);
    const state = await refresh(undefined, true);
    bb.log.info(`switched ${switched.provider} to ${switched.email} (id=${id})`);
    return state;
  }



  // --- auto-resume --------------------------------------------------------
  // A turn that failed on the proxy's 429 is resumed once, after the in-use
  // account's own window reopens; one that failed on its 503 auth_unavailable
  // is retried a few times and then alerts once. Same turn, same thread, same
  // model: bb.sdk.threads.retry re-submits by reference and never touches the
  // proxy's account selection.

  const RESUME_PREFIX = "resume:";
  const ALERT_KEY = "resume-alert";
  let authAlert: AuthAlert | null = (await bb.storage.kv.get<AuthAlert>(ALERT_KEY)) ?? null;
  /** Serialises decisions, so two failures in the same tick cannot take the same slot. */
  let decisionChain: Promise<void> = Promise.resolve();
  /** Test only: override timings and the reset, set through the CLI's `resume-test` command. */
  let testMode: TestMode | null = null;
  /** Test mode as it applies right now; it lapses by itself (startTestMode). */
  const test = (): TestMode | null => activeTestMode(testMode, Date.now());

  async function resumeRecords(): Promise<ResumeRecord[]> {
    const keys = await bb.storage.kv.list(RESUME_PREFIX);
    const rows = await Promise.all(keys.map((key) => bb.storage.kv.get<ResumeRecord>(key)));
    return rows.filter((row): row is ResumeRecord => row !== undefined);
  }

  function resumeRows(records: readonly ResumeRecord[], now: number): ResumeRow[] {
    return pendingResumeRows(records, now).map(({ threadId, kind, sendAt, note }) => ({ threadId, kind, sendAt, note }));
  }

  let serverHealthCache: { key: string; at: number; health: ServerHealth } | null = null;
  let serverHealthInFlight: { key: string; promise: Promise<ServerHealth> } | null = null;

  /** Stdout of a systemctl call, or null when it fails or times out. */
  async function systemctl(args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("systemctl", [...args], {
        timeout: SERVER_HEALTH_PROBE_MS,
        maxBuffer: 1024 * 1024,
        ...(env ? { env } : {}),
      });
      return stdout;
    } catch {
      return null;
    }
  }

  async function probeServerHealth(ignoredUnits: string[], watchdogUnit: string): Promise<ServerHealth> {
    const failedArgs = ["--failed", "--no-legend", "--plain", "--no-pager"];
    const userEnv = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}` };
    const [systemFailed, userFailed, hosts, diskRoot, watchdog] = await Promise.all([
      systemctl(failedArgs).then((out) => (out === null ? null : parseSystemctlFailedUnits(out))),
      systemctl(["--user", ...failedArgs], userEnv).then((out) => (out === null ? null : parseSystemctlFailedUnits(out))),
      bb.sdk.hosts
        .list({ signal: AbortSignal.timeout(SERVER_HEALTH_PROBE_MS) })
        .then((list) => list.map((host) => ({ id: host.id, name: host.name, status: host.status, phase: host.lifecycle.phase })))
        .catch(() => null),
      statfs("/")
        .then((stats) => ({ availBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }))
        .catch(() => null),
      systemctl([
        "show",
        watchdogUnit,
        "--timestamp=unix",
        "--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainExitTimestamp",
        "--no-pager",
      ]).then((out) => (out === null ? null : { unitName: watchdogUnit, ...parseSystemctlShowWatchdog(out) })),
    ]);
    return aggregateServerHealth({
      checkedAt: new Date().toISOString(),
      systemFailedUnits: systemFailed,
      userFailedUnits: userFailed,
      ignoredUnits,
      hosts,
      diskRoot,
      watchdog,
    });
  }

  /**
   * The footer strip's server status, reused for a minute unless forced or the
   * ignored units or watchdog unit settings changed. Never throws: a probe that
   * fails feeds null, which reads as "unknown".
   */
  async function readServerHealth(force = false): Promise<ServerHealth> {
    const { ignoredUnits: ignoredRaw, watchdogUnit: watchdogRaw } = await settings.get();
    const ignoredUnits = ignoredRaw.split(",").map((unit) => unit.trim()).filter((unit) => unit.length > 0);
    const watchdogUnit = watchdogRaw.trim() || DEFAULT_WATCHDOG_UNIT;
    const key = JSON.stringify([ignoredUnits, watchdogUnit]);
    if (!force && serverHealthCache?.key === key && Date.now() - serverHealthCache.at < SERVER_HEALTH_CACHE_MS) {
      return serverHealthCache.health;
    }
    if (serverHealthInFlight?.key === key) return serverHealthInFlight.promise;
    const promise = probeServerHealth(ignoredUnits, watchdogUnit).then((health) => {
      serverHealthCache = { key, at: Date.now(), health };
      return health;
    });
    serverHealthInFlight = { key, promise };
    try {
      return await promise;
    } finally {
      if (serverHealthInFlight?.promise === promise) serverHealthInFlight = null;
    }
  }
  let serverMetricsCache: { at: number; metrics: ServerMetrics } | null = null;
  let serverMetricsInFlight: Promise<ServerMetrics> | null = null;

  async function probeServerMetrics(): Promise<ServerMetrics> {
    const stat1Raw = await readFile("/proc/stat", "utf8").catch(() => null);
    const stat1 = stat1Raw === null ? null : parseProcStat(stat1Raw);
    if (stat1 !== null) await sleep(CPU_SAMPLE_GAP_MS);
    const [stat2Raw, loadRaw, memRaw] = await Promise.all([
      stat1 === null ? Promise.resolve(null) : readFile("/proc/stat", "utf8").catch(() => null),
      readFile("/proc/loadavg", "utf8").catch(() => null),
      readFile("/proc/meminfo", "utf8").catch(() => null),
    ]);
    const stat2 = stat2Raw === null ? null : parseProcStat(stat2Raw);
    return buildServerMetrics({
      checkedAt: new Date().toISOString(),
      cpuPercent: cpuPercentFromStatSamples(stat1, stat2),
      cores: stat2?.cores ?? stat1?.cores ?? null,
      loadavg: loadRaw === null ? null : parseProcLoadavg(loadRaw),
      mem: memRaw === null ? null : parseProcMeminfo(memRaw),
    });
  }

  async function readServerMetrics(force = false): Promise<ServerMetrics> {
    if (!force && serverMetricsCache && Date.now() - serverMetricsCache.at < SERVER_METRICS_CACHE_MS) {
      return serverMetricsCache.metrics;
    }
    if (serverMetricsInFlight) return serverMetricsInFlight;
    const promise = probeServerMetrics().then((metrics) => {
      serverMetricsCache = { at: Date.now(), metrics };
      return metrics;
    });
    serverMetricsInFlight = promise;
    try {
      return await promise;
    } finally {
      if (serverMetricsInFlight === promise) serverMetricsInFlight = null;
    }
  }

  async function withResumes(state: UsageState, force = false): Promise<UsageState> {
    const now = Date.now();
    const [serverHealth, serverMetrics, records, ejected] = await Promise.all([
      readServerHealth(force),
      readServerMetrics(force),
      resumeRecords(),
      listEjected(EJECTED_DIR),
    ]);
    return {
      ...state,
      serverHealth,
      serverMetrics,
      resumes: resumeRows(records, now),
      resumeAlert: alertActive(authAlert, now) ? authAlert!.message : null,
      ejected: ejected
        .filter(
          (record) =>
            record.purgeAt > now &&
            !state.accounts.some(
              (account) =>
                account.email === record.email &&
                (account.provider ?? "anthropic") === (record.provider ?? "anthropic"),
            ),
        )
        .map(({ file, email, provider, purgeAt }) => ({
          file,
          email,
          ...(provider ? { provider } : {}),
          purgeAt,
        })),
    };
  }

  async function failureDetail(threadId: string): Promise<string | null> {
    try {
      const rows = await bb.sdk.threads.events.list({ threadId, types: ["provider/error"], order: "desc", limit: "1" });
      const data = rows[0]?.data as { detail?: unknown } | undefined;
      return typeof data?.detail === "string" ? data.detail : null;
    } catch {
      return null;
    }
  }

  /**
   * What the failed turn left behind, read from its own events: everything
   * after its client/turn/requested row. Only used when the failure is not one
   * of the three this listener already knows.
   */
  async function failureFacts(threadId: string, requestId: string): Promise<FailureFacts | null> {
    try {
      const rows = await readTurnEvents(
        async (args) =>
          (await bb.sdk.threads.events.list({
            threadId,
            types: args.types as unknown as Parameters<typeof bb.sdk.threads.events.list>[0]["types"],
            order: args.order,
            limit: args.limit,
            ...(args.beforeSeq === undefined ? {} : { beforeSeq: args.beforeSeq }),
          })) as unknown as EventRowLike[],
        requestId,
      );
      return rows === null ? null : factsFromRows(rows);
    } catch (error) {
      bb.log.warn(`resume: could not read ${threadId}'s failed turn: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function readThreadModelAndRequest(
    threadId: string,
  ): Promise<{ providerId: string | null; model: string | null; requestId: string | null }> {
    let providerId: string | null = null;
    let model: string | null = null;
    let requestId: string | null = null;
    try {
      const t = (await bb.sdk.threads.get({ threadId })) as {
        providerId?: unknown;
        model?: unknown;
        runtime?: { model?: unknown };
      };
      if (typeof t.providerId === "string") providerId = t.providerId;
      if (typeof t.model === "string") model = t.model;
      else if (typeof t.runtime?.model === "string") model = t.runtime.model;
    } catch {
      // Thread read failed; fall back to turn request event.
    }
    try {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested"],
        order: "desc",
        limit: "1",
      });
      const data = rows[0]?.data as { requestId?: unknown; execution?: { model?: unknown } } | undefined;
      if (typeof data?.requestId === "string") requestId = data.requestId;
      if (!model && typeof data?.execution?.model === "string") model = data.execution.model;
    } catch {
      // Event read failed.
    }
    return { providerId, model, requestId };
  }

  async function queueResumeAttempt(
    record: ResumeRecord,
    turnRequestId: string | undefined,
    reasonText: string,
  ): Promise<void> {
    try {
      await bb.sdk.threads.retry({
        threadId: record.threadId,
        ...(turnRequestId ? { turnRequestId } : {}),
        sendAt: record.sendAt,
        reason: `${RETRY_REASON_PREFIX}${reasonText}`,
      });
    } catch (error) {
      if (!record.completedError) throw error;
      // A turn on an ACP provider that ended `completed` with a raw provider
      // error leaves the thread in `idle` rather than `error`, so
      // `threads.retry` refuses it. Queue a timed agent-only continuation instead.
      await bb.sdk.threads.send({
        threadId: record.threadId,
        input: [
          {
            type: "text",
            text: "[automated message from the proxy-usage plugin, not from the user]\nPlease continue.",
            mentions: [],
            visibility: "agent-only",
          },
        ],
        mode: "queue-if-active",
        sendAt: record.sendAt,
        pluginSubmission: {
          pluginId: "proxy-usage",
          data: { reason: `${RETRY_REASON_PREFIX}${reasonText}` },
        },
      });
    }
  }

  async function scheduleOrAlertFailure(args: {
    threadId: string;
    requestId: string;
    kind: "quota" | "auth" | "once";
    why?: string;
    detail: string | null;
    inputAccepted: boolean;
    completedError?: boolean;
  }): Promise<void> {
    const meta = await readThreadModelAndRequest(args.threadId);
    const model = modelFromDetail(args.detail) ?? meta.model;
    const provider = inferCredentialProvider(meta.providerId, model);
    const now = Date.now();
    const records = await resumeRecords();
    const previous = records.find((record) => record.threadId === args.threadId);
    const taken = pendingResumeRows(records, now)
      .filter((record) => record.sendAt > now && record.threadId !== args.threadId)
      .map((record) => record.sendAt);
    let reset = args.kind === "quota" ? (test()?.reset ?? resetFor(current.accounts, model, now)) : null;
    if (args.kind === "quota" && reset === null && Date.now() - lastRefreshAt > FRESH_ENOUGH_MS) {
      await refresh();
      reset = resetFor(current.accounts, model, Date.now());
    }
    const decision = decide(
      {
        threadId: args.threadId,
        requestId: args.requestId,
        kind: args.kind,
        reset,
        why: args.why,
        provider,
        model,
      },
      previous,
      taken,
      now,
      test()?.timing ?? DEFAULT_TIMING,
    );
    if (decision.kind === "skip") {
      bb.log.info(`resume: ${args.threadId} not resumed: ${decision.reason}`);
      return;
    }
    if (decision.kind === "alert") {
      const { alert, raised } = raiseAlert(authAlert, decision.reason, now);
      authAlert = alert;
      if (!test()) await bb.storage.kv.set(ALERT_KEY, alert);
      if (raised) bb.log.warn(`resume: ALERT ${decision.reason} (first seen on ${args.threadId})`);
      return;
    }
    const record: ResumeRecord = {
      ...decision.record,
      inputAccepted: args.inputAccepted,
      ...(args.completedError ? { completedError: true } : {}),
      ...(test() ? { test: true } : {}),
    };
    const reasonText = record.kind === "quota" ? `resume after ${record.note} resets` : record.note;
    await queueResumeAttempt(record, args.requestId, reasonText);
    await bb.storage.kv.set(`${RESUME_PREFIX}${record.threadId}`, record);
    bb.log.info(`resume: ${record.threadId} queued for ${new Date(record.sendAt).toISOString()} (${record.note})`);
  }

  async function onTurnFailed(event: {
    threadId: string;
    requestId: string;
    errorInfo: { category: string; httpStatusCode: number | null } | null;
    rateLimits: unknown;
    inputAccepted: boolean;
    attemptNumber: number;
  }): Promise<void> {
    if (event.rateLimits !== null && event.errorInfo?.category === "rate-limit") {
      const rows = await bb.sdk.threads.queue.list({ threadId: event.threadId });
      if (rows.some(isOtherRetry)) {
        bb.log.info(`resume: ${event.threadId} left to provider-retry, which already queued it`);
        return;
      }
    }
    const detail = await failureDetail(event.threadId);
    let kind: "quota" | "auth" | "once" | "other" = classifyFailure(event.errorInfo, detail);
    let why: string | undefined;
    if (kind === "other") {
      const facts = await failureFacts(event.threadId, event.requestId);
      const started = test() ? Date.now() - 60_000 : null;
      const once = facts ? classifyOnce(facts, started, Date.now()) : null;
      if (once === null) {
        const info = event.errorInfo;
        bb.log.info(`resume: ${event.threadId} not resumed: ${info?.category ?? "unknown"}/${info?.httpStatusCode ?? "no status"}`);
        return;
      }
      if (once === "529 overloaded") {
        await sleep(2_000);
        const rows = await bb.sdk.threads.queuedMessages.list({ threadId: event.threadId });
        if (!providerChainEnded(event.attemptNumber, rows.some(isOtherRetry))) {
          bb.log.info(`resume: ${event.threadId} 529 left to provider-retry (attempt ${event.attemptNumber}, a retry is queued)`);
          return;
        }
      }
      kind = "once";
      why = once;
    }
    await scheduleOrAlertFailure({
      threadId: event.threadId,
      requestId: event.requestId,
      kind,
      why,
      detail,
      inputAccepted: event.inputAccepted,
    });
  }

  bb.events.on("turn.failed", (event) => {
    decisionChain = decisionChain
      .then(() => onTurnFailed(event))
      .catch((error: unknown) => {
        bb.log.warn(`resume: ${event.threadId}: ${error instanceof Error ? error.message : String(error)}`);
      });
  });

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const rawError = classifyCompletedTurnError(lastAssistantText);
    if (rawError !== null) {
      decisionChain = decisionChain
        .then(async () => {
          const meta = await readThreadModelAndRequest(thread.id);
          await scheduleOrAlertFailure({
            threadId: thread.id,
            requestId: meta.requestId ?? `idle-${Date.now()}`,
            kind: rawError.kind,
            why: rawError.why,
            detail: lastAssistantText,
            inputAccepted: true,
            completedError: true,
          });
        })
        .catch((error: unknown) => {
          bb.log.warn(`resume: ${thread.id} raw provider error on idle: ${error instanceof Error ? error.message : String(error)}`);
        });
      return;
    }
    void (async () => {
      try {
        const record = await bb.storage.kv.get<ResumeRecord>(`${RESUME_PREFIX}${thread.id}`);
        if (!record) return;
        const rows = await bb.sdk.threads.queuedMessages.list({ threadId: thread.id });
        const ours = rows.filter(isOurRetry).map((row) => row.id);
        const plan = onRecovery(record, ours);
        for (const queuedMessageId of plan.cancel) {
          await bb.sdk.threads.queuedMessages.delete({ threadId: thread.id, queuedMessageId });
        }
        if (plan.cancel.length > 0) {
          if (!plan.dropRecord) await bb.storage.kv.set(`${RESUME_PREFIX}${thread.id}`, { ...record, cancelledAt: Date.now() });
          bb.log.info(`resume: ${thread.id} recovered by itself; queued resume cancelled`);
        }
        if (plan.keptBecauseUnaccepted) {
          bb.log.info(`resume: ${thread.id} recovered, but its queued resume carries input the provider never took; kept`);
        }
        if (plan.dropRecord) await bb.storage.kv.delete(`${RESUME_PREFIX}${thread.id}`);
        if (plan.clearAlert && authAlert) {
          authAlert = null;
          await bb.storage.kv.delete(ALERT_KEY);
          bb.log.info("resume: proxy login is back; alert cleared");
        }
      } catch (error) {
        bb.log.warn(`resume: ${thread.id} recovery bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  });
  // Our resumes go out one at a time and not straight after a start. Only
  // rows this plugin queued are ever held; every other dispatch proceeds. The
  // hook is fail-closed in core, so nothing in it may throw or do I/O.
  const startedAt = Date.now();
  let lastOwnDispatchAt = 0;
  bb.experimental_hooks.on("message.dispatch", (context) => {
    try {
      if (!context.queuedMessages.some(isOurRetry)) return { action: "proceed" };
      const now = Date.now();
      const mode = test();
      const timing = mode?.timing ?? DEFAULT_TIMING;
      const until = dispatchHold(now, startedAt, lastOwnDispatchAt, timing.gap, mode ? 0 : STARTUP_HOLD_MS);
      if (until !== null) return { action: "wait", reason: "proxy-usage: spacing resumes", sendAt: until };
      lastOwnDispatchAt = now;
      return { action: "proceed" };
    } catch {
      return { action: "proceed" };
    }
  });

  /**
   * Turns parked for an exhausted account go now if another enabled account
   * has room, rather than waiting for the exhausted account's reset. Our
   * parked row is deleted and the same failed turn is queued again, margin
   * first and then a stagger gap apart; the dispatch hook keeps that spacing.
   * Runs after each poll, so the figures are fresh, and never during test mode.
   */
  async function releaseParkedResumes(): Promise<void> {
    if (test()) return;
    const now = Date.now();
    const moves = releaseParked(await resumeRecords(), current.accounts, now);
    for (const move of moves) {
      try {
        await releaseOne(move, now);
      } catch (error) {
        // One thread's trouble (archived, deleted, moved on) must not hold
        // up the others.
        bb.log.warn(`resume: ${move.threadId} not released: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async function releaseOne(move: { threadId: string; sendAt: number; email: string }, now: number): Promise<void> {
      const record = await bb.storage.kv.get<ResumeRecord>(`${RESUME_PREFIX}${move.threadId}`);
      if (!record) return;
      const info = (await bb.sdk.threads.get({ threadId: move.threadId })) as { status?: string; archivedAt?: number | null };
      if (info.archivedAt) {
        // An archived thread is done with; its parked resume has nothing to do.
        await bb.storage.kv.set(`${RESUME_PREFIX}${move.threadId}`, { ...record, cancelledAt: now });
        bb.log.info(`resume: ${move.threadId} is archived; parked resume dropped`);
        return;
      }
      const queued = await bb.sdk.threads.queuedMessages.list({ threadId: move.threadId });
      const rows = queued.filter(isOurRetry);
      // Someone else's retry is already queued for this thread: leave it.
      if (queued.some(isOtherRetry)) return;
      // Only a thread still sitting on its failed turn is resent. One that
      // went on to finish another turn has recovered: its stale "Please
      // continue." is dropped instead (as on recovery), not sent early.
      if (info.status !== "error" && !(record.completedError && rows.length > 0)) {
        if (rows.length > 0 && record.inputAccepted !== true) return;
        for (const row of rows) await bb.sdk.threads.queuedMessages.delete({ threadId: move.threadId, queuedMessageId: row.id });
        await bb.storage.kv.set(`${RESUME_PREFIX}${move.threadId}`, { ...record, cancelledAt: now });
        bb.log.info(`resume: ${move.threadId} recovered by itself; parked resume cancelled`);
        return;
      }
      for (const row of rows) await bb.sdk.threads.queuedMessages.delete({ threadId: move.threadId, queuedMessageId: row.id });
      const requeue = (sendAt: number, reason: string) =>
        queueResumeAttempt({ ...record, sendAt }, undefined, reason);
      try {
        await requeue(move.sendAt, `resume now, ${move.email} has room`);
      } catch (error) {
        await requeue(record.sendAt, `resume after ${record.note} resets`).catch(() => undefined);
        throw error;
      }
      await bb.storage.kv.set(`${RESUME_PREFIX}${move.threadId}`, { ...record, sendAt: move.sendAt, note: `${move.email} has room` });
      bb.log.info(`resume: ${move.threadId} released, ${move.email} has room; queued for ${new Date(move.sendAt).toISOString()}`);
  }

  // Forget records whose window is long past, so a thread can be resumed again
  // in a later window and the list does not grow.
  async function pruneResumes(): Promise<void> {
    const cutoff = Date.now() - 24 * 60 * 60_000;
    for (const record of await resumeRecords()) {
      if (record.sendAt < cutoff) await bb.storage.kv.delete(`${RESUME_PREFIX}${record.threadId}`);
    }
  }

  // ---- eject -------------------------------------------------------------
  // Remove a dead account from the proxy for good, with 7 days to undo it.
  // Only from the popup's button: see "the user's click" in eject.ts.

  // Eject and undo operate directly on ~/.omp/agent/agent.db via agentDbCoreAuthFiles.
  /** Rewrite the ejected-accounts list, and delete what is past 7 days. */
  async function purgeAndPublishEjected(): Promise<void> {
    const gone = await purgeEjected(EJECTED_DIR, Date.now());
    for (const record of gone) bb.log.info(`eject: ${record.email} deleted for good after 7 days`);
    await writeEjectedList(EJECTED_LIST, await listEjected(EJECTED_DIR));
  }

  const ejectIntents = new EjectIntents(() => randomUUID());
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  async function readBody(context: { req: { json(): Promise<unknown> } }): Promise<{ file?: unknown; intent?: unknown; action?: unknown }> {
    try {
      return ((await context.req.json()) ?? {}) as { file?: unknown; intent?: unknown; action?: unknown };
    } catch {
      return {};
    }
  }

  bb.http.route(
    "POST",
    "/eject-intent",
    async (context) => {
      if (!hasBrowserOrigin(context.req.header("origin"))) return json(403, { ok: false, error: NOT_USER_CLICK });
      const { file, action } = await readBody(context);
      if (typeof file !== "string" || (action !== "eject" && action !== "undo")) return json(400, { ok: false, error: "Not an account." });
      return json(200, { ok: true, ...ejectIntents.issue(`${action}:${file}`) });
    },
    { auth: "local" },
  );

  bb.http.route(
    "POST",
    "/eject",
    async (context) => {
      const { file, intent } = await readBody(context);
      if (typeof file !== "string" || !ejectIntents.take(typeof intent === "string" ? intent : undefined, `eject:${file}`)) {
        return json(403, { ok: false, error: NOT_USER_CLICK });
      }
      try {
        const dbPath = await agentDbPath();
        const state = await refresh();
        const accounts = overlayAgentDbFlags(state.accounts, dbPath);
        const target = accounts.find((account) => account.file === file);
        const refusal = ejectRefusal(target, accounts);
        if (refusal !== null || !target) return json(409, { ok: false, error: refusal });
        const rows = readAgentDbCredentials(dbPath);
        const rawRow = rows.find((r) => agentDbFileName(r.provider, r.id) === file);
        if (!rawRow) return json(409, { ok: false, error: "No such account in agent.db. Nothing was ejected." });
        const record = await ejectAccount(
          {
            authDir: "",
            ejectedDir: EJECTED_DIR,
            target,
            now: Date.now(),
            data: exportAgentDbEjectPayload(dbPath, rawRow.id),
          },
          agentDbCoreAuthFiles(dbPath),
        );
        // Remove any older duplicate legacy eject record for the same email and provider.
        for (const existing of await listEjected(EJECTED_DIR)) {
          if (
            existing.file !== record.file &&
            existing.email === record.email &&
            (existing.provider ?? "anthropic") === (record.provider ?? "anthropic")
          ) {
            const oldCopy = join(EJECTED_DIR, existing.file);
            await rm(oldCopy, { force: true });
            await rm(`${oldCopy}.eject`, { force: true });
          }
        }
        await purgeAndPublishEjected();
        bb.log.info(`eject: ${record.email} (${target.provider ?? "anthropic"}) ejected; undo possible until ${new Date(record.purgeAt).toISOString()}`);
        return json(200, { ok: true, state: await withResumes(await refresh()) });
      } catch (error) {
        return json(500, { ok: false, error: `Not ejected: ${error instanceof Error ? error.message : String(error)}` });
      }
    },
    { auth: "local" },
  );

  bb.http.route(
    "POST",
    "/eject-undo",
    async (context) => {
      const { file, intent } = await readBody(context);
      if (typeof file !== "string" || !ejectIntents.take(typeof intent === "string" ? intent : undefined, `undo:${file}`)) {
        return json(403, { ok: false, error: NOT_USER_CLICK });
      }
      try {
        const dbPath = await agentDbPath();
        const record = await undoEject(
          { authDir: "", ejectedDir: EJECTED_DIR, file, now: Date.now(), skipAuthDirCheck: true },
          agentDbCoreAuthFiles(dbPath),
        );
        await purgeAndPublishEjected();
        bb.log.info(`eject: ${record.email} put back`);
        return json(200, { ok: true, state: await withResumes(await refresh()) });
      } catch (error) {
        return json(409, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
    { auth: "local" },
  );

  bb.rpc.register(rpcContract, {
    // Never hand back a cached copy of the one thing that is free to re-read.
    state: async () => {
      const dbPath = await agentDbPath();
      if (current.fetchedAt === null || current.authDir !== dbPath) return withResumes(await refresh());
      try {
        readAgentDbCredentials(dbPath);
        return withResumes({ ...current, accounts: overlayAgentDbFlags(current.accounts, dbPath) });
      } catch {
        return withResumes(await refresh());
      }
    },
    refresh: async () => {
      const dbPath = await agentDbPath();
      const reuse = Date.now() - lastRefreshAt < MIN_REFRESH_GAP_MS && current.authDir === dbPath;
      return withResumes(reuse ? current : await refresh(undefined, true), true);
    },
    metrics: async () => readServerMetrics(),
    useAccount: async ({ file }) => {
      const pick = pickAccountToUse(current.accounts, (account) => account.file === file, file);
      // An account the poll has not seen yet is left to useAccount's own check.
      if (!pick.ok && current.accounts.some((account) => account.file === file)) throw new Error(pick.error);
      return withResumes(await useAccount(file));
    },
  });

  bb.cli.register({
    name: "proxy-usage",
    summary: "Show subscription usage for every account omp holds",
    commands: [
      { name: "show", summary: "Print usage per account", usage: "bb proxy-usage [show] [--json]" },
      { name: "use", summary: "Send every request to one account and take the others out of use", usage: "bb proxy-usage use <email-substring>" },
      { name: "resumes", summary: "List failed turns queued to resume after a usage limit", usage: "bb proxy-usage resumes [--json]" },
      {
        name: "resume-test",
        summary: "Test only: shorten timings and fake a reset N seconds out; `off` restores",
        usage: "bb proxy-usage resume-test <reset-seconds|off [--clear-alert]>",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, needle, needle2] = argv.filter((arg) => arg !== "--json");
      if (command === "resumes") {
        const rows = resumeRows(await resumeRecords(), Date.now());
        const alert = alertActive(authAlert, Date.now()) ? authAlert!.message : null;
        if (json) return { exitCode: 0, stdout: JSON.stringify({ resumes: rows, alert }) };
        const lines = rows.map((row) => `${row.threadId}  ${new Date(row.sendAt).toLocaleString()}  ${row.kind}  ${row.note}`);
        if (alert) lines.unshift(`ALERT: ${alert}`);
        return { exitCode: 0, stdout: lines.length > 0 ? lines.join("\n") : "No turns waiting to resume." };
      }
      if (command === "resume-test") {
        if (needle === "off") {
          const wasTesting = testMode !== null;
          testMode = null;
          let removed = 0;
          const archived = async (threadId: string): Promise<boolean> => {
            try {
              const thread = (await bb.sdk.threads.get({ threadId })) as { archivedAt?: unknown };
              return thread.archivedAt !== null && thread.archivedAt !== undefined;
            } catch {
              return true;
            }
          };
          for (const record of await resumeRecords()) {
            if (!record.test && !(await archived(record.threadId))) continue;
            await bb.storage.kv.delete(`${RESUME_PREFIX}${record.threadId}`);
            removed += 1;
          }
          // An alert raised under test mode was never stored, so it goes with it.
          if (wasTesting && authAlert && !(await bb.storage.kv.get<AuthAlert>(ALERT_KEY))) authAlert = null;
          if (needle2 === "--clear-alert") {
            authAlert = null;
            await bb.storage.kv.delete(ALERT_KEY);
          }
          return { exitCode: 0, stdout: `resume test mode off; removed ${removed} test record(s)` };
        }
        const seconds = Number(needle);
        if (!Number.isFinite(seconds) || seconds < 0) return { exitCode: 1, stderr: "usage: bb proxy-usage resume-test <reset-seconds|off>" };
        testMode = startTestMode(seconds, Date.now());
        return { exitCode: 0, stdout: `resume test mode on: reset in ${seconds}s, margin 2s, stagger 5s, auth and once 5s, proxy treated as started 1 min ago; ends by itself at ${new Date(testMode.until).toLocaleTimeString()}` };
      }
      let state: UsageState;
      if (command === "use") {
        if (!needle) return { exitCode: 1, stderr: "usage: bb proxy-usage use <[provider:]email-substring>" };
        const before = await refresh();
        const lower = needle.toLowerCase();
        const colonIdx = lower.indexOf(":");
        const providerFilter = colonIdx > 0 ? lower.slice(0, colonIdx) : null;
        const emailFilter = colonIdx > 0 ? lower.slice(colonIdx + 1) : lower;
        let candidates = before.accounts;
        if (providerFilter) {
          candidates = candidates.filter((a) => (a.provider ?? "anthropic").toLowerCase() === providerFilter);
        } else {
          const matchingAll = candidates.filter((a) => a.email.toLowerCase().includes(emailFilter));
          const matchingAnthropic = matchingAll.filter((a) => (a.provider ?? "anthropic") === "anthropic");
          if (matchingAll.length > 1 && matchingAnthropic.length === 1) {
            candidates = candidates.filter((a) => (a.provider ?? "anthropic") === "anthropic");
          }
        }
        const pick = pickAccountToUse(candidates, (account) => account.email.toLowerCase().includes(emailFilter), needle);
        if (!pick.ok) return { exitCode: 1, stderr: pick.error };
        state = await useAccount(pick.account.file);
      } else {
        state = await refresh();
      }
      if (json) return { exitCode: 0, stdout: JSON.stringify(state) };
      const lines: string[] = [];
      if (state.message && state.accounts.length > 0) lines.push(state.message);
      const providers = [...new Set(state.accounts.map((a) => a.provider ?? "anthropic"))];
      for (const provider of providers) {
        const inUse = state.accounts.filter((a) => (a.provider ?? "anthropic") === provider && isAccountInUse(a));
        if (inUse.length > 1) {
          lines.push(`warning (${provider}): ${inUse.length} accounts are in use at once, so requests can land on either one.`);
        }
      }
      const labelWidth = Math.max(0, ...state.accounts.flatMap((account) => account.windows.map((window) => window.label.length)));
      for (const account of state.accounts) {
        const prov = account.provider ?? "anthropic";
        const statusTag =
          account.status === "on-hold"
            ? "on-hold"
            : account.disabled
              ? "not in use"
              : account.status === "ok"
                ? "in use"
                : `in use, ${account.status}`;
        const tag = prov === "anthropic" ? statusTag : `${prov}, ${statusTag}`;
        lines.push(`${account.email} [${tag}]`);
        for (const window of account.windows) {
          const reset = window.resetsAt ? ` resets ${new Date(window.resetsAt).toLocaleString()}` : "";
          lines.push(`  ${window.label.padEnd(labelWidth)} ${String(Math.round(window.usedPercent)).padStart(3)}%${reset}`);
        }
        if (account.message) lines.push(`  ${account.message}`);
      }
      if (lines.length === 0) lines.push(state.message ?? `No OAuth accounts in ${state.authDir}`);
      // A switch that only partly worked must not look like a success to a script.
      if (command === "use" && state.message) return { exitCode: 1, stdout: lines.join("\n") };
      return { exitCode: 0, stdout: lines.join("\n") };
    },
  });

  bb.background.service("poll", {
    async start(signal) {
      let delay = POLL_MS;
      while (!signal.aborted) {
        // refresh() may hand back a fetch another caller started, which does
        // not see this signal; stop waiting for it as soon as we are told to.
        const next = await untilAborted(refresh(signal), signal);
        if (next === null || signal.aborted) break;
        await pruneResumes().catch(() => undefined);
        await releaseParkedResumes().catch((error: unknown) => {
          bb.log.warn(`resume: release failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        await purgeAndPublishEjected().catch((error: unknown) => {
          bb.log.warn(`eject: purge failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        const healthy = next.message === null && next.accounts.every((account) => account.status === "ok" || !isAccountInUse(account));
        delay = healthy ? POLL_MS : Math.min(delay * 2, RETRY_MAX_MS);
        await sleep(delay, signal);
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
