// Discovery and digesting of Claude Code sessions that run on this machine
// outside bb. Pure host-local Node code: nothing here touches the bb API, so
// it can be unit tested and reasoned about on its own.
//
// Two sources of truth:
//   ~/.claude/sessions/<pid>.json      one registry file per live process
//   ~/.claude/projects/<slug>/<id>.jsonl   the transcript, often many MB
//
// Transcripts are always streamed line by line. Nothing here ever reads a
// whole transcript into memory.
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

/** One external Claude Code session, grouped by session id across its live pids. */
export interface ExternalSessionInfo {
  sessionId: string;
  /** Live pids for this session id: a resumed session can have more than one. */
  pids: number[];
  name: string | null;
  cwd: string;
  /** "cli" = a terminal session, "sdk-cli" = harness driven (bb's own sessions look like this). */
  entrypoint: string;
  startedAt: number;
  /** tmux "session:window" when known. */
  tmux: string | null;
  transcriptPath: string | null;
  transcriptBytes: number;
  /** Transcript mtime. */
  lastActivityAt: number | null;
  title: string | null;
}

export interface DigestResult {
  digest: string;
  title: string | null;
  messageCount: number;
  truncated: boolean;
}

export interface ProjectPaths {
  id: string;
  name: string;
  paths: string[];
}

/** Default budget for one digest. Roughly 15k tokens. */
export const DIGEST_MAX_CHARS = 60_000;
/** A compaction summary is the densest thing in a transcript, so it gets a generous cap. */
const COMPACTION_MAX_CHARS = 12_000;
const FIRST_PROMPT_MAX_CHARS = 2_000;
const EXCHANGE_MAX_CHARS = 1_500;
const RECENT_EXCHANGES = 40;
/** Head and tail window used to find a title without reading the whole file. */
const TITLE_WINDOW_BYTES = 64 * 1024;

const COMPACTION_PREFIX = "This session is being continued from a previous conversation";
const NOISE_PREFIXES = ["<local-command-caveat>", "<command-name>", "<local-command-stdout>"];

/**
 * Claude derives the transcript directory from the cwd by replacing every
 * character outside [A-Za-z0-9-] with a dash.
 */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

/** True when `prefix` is `cwd` itself or a parent directory of it. */
function isPathPrefix(prefix: string, cwd: string): boolean {
  const normalizedPrefix = prefix.replace(/\/+$/, "");
  if (normalizedPrefix === "") return false;
  return cwd === normalizedPrefix || cwd.startsWith(`${normalizedPrefix}/`);
}

/** The bb project whose source path is the longest prefix of `cwd`, or null. */
export function matchProject(cwd: string, projects: ProjectPaths[]): ProjectPaths | null {
  let best: ProjectPaths | null = null;
  let bestLength = -1;
  for (const project of projects) {
    for (const raw of project.paths) {
      const candidate = raw.replace(/\/+$/, "");
      if (!isPathPrefix(candidate, cwd)) continue;
      if (candidate.length > bestLength) {
        bestLength = candidate.length;
        best = project;
      }
    }
  }
  return best;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The registry stores tmux either as a plain "session:@window.%pane" string
 * or as an object with the parts split out. Both are
 * reduced to a "session:window" string; anything else becomes null.
 */
function tmuxLabel(value: unknown): string | null {
  const asText = asString(value);
  if (asText) {
    const pane = asText.indexOf(".%");
    return pane > 0 ? asText.slice(0, pane) : asText;
  }
  const record = asRecord(value);
  if (!record) return null;
  const session = asString(record.session) ?? asString(record.sessionName);
  const window = asString(record.window) ?? asString(record.windowId) ?? asNumber(record.window)?.toString();
  if (!session) return null;
  return window ? `${session}:${window}` : session;
}

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the first and last `TITLE_WINDOW_BYTES` of a file as text. */
async function readEnds(filePath: string, size: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    if (size <= TITLE_WINDOW_BYTES * 2) {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      return buffer.toString("utf8");
    }
    const head = Buffer.alloc(TITLE_WINDOW_BYTES);
    await handle.read(head, 0, TITLE_WINDOW_BYTES, 0);
    const tail = Buffer.alloc(TITLE_WINDOW_BYTES);
    await handle.read(tail, 0, TITLE_WINDOW_BYTES, size - TITLE_WINDOW_BYTES);
    return `${head.toString("utf8")}\n${tail.toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

/**
 * Cheap title lookup. Claude rewrites the "custom-title" / "ai-title" rows
 * many times through a session, so both ends of the file usually carry a copy
 * and reading the two ends is enough. digestTranscript, which streams
 * the whole file anyway, finds the authoritative last one.
 */
async function titleFromEnds(filePath: string, size: number): Promise<string | null> {
  if (size === 0) return null;
  let text: string;
  try {
    text = await readEnds(filePath, size);
  } catch {
    return null;
  }
  let custom: string | null = null;
  let ai: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes("-title")) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      // A window boundary cuts a line in half; skip the fragment.
      continue;
    }
    const record = asRecord(row);
    if (!record) continue;
    if (record.type === "custom-title") custom = asString(record.customTitle) ?? custom;
    else if (record.type === "ai-title") ai = asString(record.aiTitle) ?? ai;
  }
  return custom ?? ai;
}

interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string | null;
  entrypoint: string;
  startedAt: number;
  tmux: string | null;
}

async function readRegistry(sessionsDir: string): Promise<RegistryEntry[]> {
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const entries: RegistryEntry[] = [];
  for (const file of files) {
    // Only the .json files are session records; skip anything else in the folder.
    if (!file.endsWith(".json")) continue;
    let row: unknown;
    try {
      const handle = await open(path.join(sessionsDir, file), "r");
      try {
        const text = await handle.readFile("utf8");
        row = JSON.parse(text);
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }
    const record = asRecord(row);
    if (!record) continue;
    const pid = asNumber(record.pid);
    const sessionId = asString(record.sessionId);
    const cwd = asString(record.cwd);
    if (pid === null || !sessionId || !cwd) continue;
    entries.push({
      pid,
      sessionId,
      cwd,
      name: asString(record.name),
      entrypoint: asString(record.entrypoint) ?? "unknown",
      startedAt: asNumber(record.startedAt) ?? 0,
      tmux: tmuxLabel(record.tmux),
    });
  }
  return entries;
}

/**
 * Entrypoints that count as an importable outside session. "cli" is a terminal
 * session, the only thing this feature is for. "unknown" is here because
 * readRegistry falls back to it when a registry file omits the field, and a
 * strict ["cli"] allowlist would then silently drop a real terminal session.
 * Current Claude versions do write the field, so this is
 * forward-compatibility, not cover for a present bug. Everything else, above
 * all "sdk-cli", is a harness-driven session: that is what bb's own worker
 * threads are, and importing one would seed a new worker from a bb worker's
 * transcript.
 */
const DEFAULT_ENTRYPOINTS = ["cli", "unknown"];

export interface ListSessionsOptions {
  homeDir: string;
  /** Sessions whose cwd is at or below one of these paths are skipped (bb's own workspaces). */
  excludeCwdPrefixes: string[];
  /**
   * Registry entrypoints to keep. Defaults to DEFAULT_ENTRYPOINTS. This is the
   * primary filter for bb's own threads: they run on project-default
   * environments, so their cwd is the project source directory and no cwd
   * prefix can catch them.
   */
  entrypoints?: string[];
}

/**
 * Every live Claude Code session outside bb, grouped by session id. Sessions
 * with a dead pid, a missing transcript, or an empty transcript are dropped,
 * as are sessions whose entrypoint marks them as harness driven.
 */
export async function listExternalSessions(opts: ListSessionsOptions): Promise<ExternalSessionInfo[]> {
  const entries = await readRegistry(path.join(opts.homeDir, ".claude", "sessions"));
  const allowed = new Set(opts.entrypoints ?? DEFAULT_ENTRYPOINTS);
  const grouped = new Map<string, RegistryEntry[]>();
  for (const entry of entries) {
    if (!isLivePid(entry.pid)) continue;
    // First net: a bb thread is harness driven wherever it runs.
    if (!allowed.has(entry.entrypoint)) continue;
    // Second net: anything at all inside a bb-managed workspace.
    if (opts.excludeCwdPrefixes.some((prefix) => isPathPrefix(prefix, entry.cwd))) continue;
    const list = grouped.get(entry.sessionId);
    if (list) list.push(entry);
    else grouped.set(entry.sessionId, [entry]);
  }
  const sessions: ExternalSessionInfo[] = [];
  for (const [sessionId, group] of grouped) {
    // The newest process carries the most current name, tmux window and cwd;
    // the oldest one tells us when the session really started.
    const newest = group.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
    const startedAt = group.reduce((min, e) => (e.startedAt > 0 && e.startedAt < min ? e.startedAt : min), newest.startedAt);
    const transcriptPath = path.join(
      opts.homeDir,
      ".claude",
      "projects",
      slugForCwd(newest.cwd),
      `${sessionId}.jsonl`,
    );
    let size = 0;
    let mtime = 0;
    try {
      const info = await stat(transcriptPath);
      size = info.size;
      mtime = info.mtimeMs;
    } catch {
      continue;
    }
    if (size === 0) continue;
    sessions.push({
      sessionId,
      pids: group.map((e) => e.pid).sort((a, b) => a - b),
      name: newest.name,
      cwd: newest.cwd,
      entrypoint: newest.entrypoint,
      startedAt,
      tmux: newest.tmux,
      transcriptPath,
      transcriptBytes: size,
      lastActivityAt: Math.round(mtime),
      title: await titleFromEnds(transcriptPath, size),
    });
  }
  return sessions;
}

/**
 * Find a transcript by session id anywhere under ~/.claude/projects. Used when
 * the process is gone but its transcript is still on disk.
 */
export async function findTranscriptById(
  homeDir: string,
  sessionId: string,
): Promise<{ transcriptPath: string; bytes: number; lastActivityAt: number } | null> {
  const root = path.join(homeDir, ".claude", "projects");
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`);
    try {
      const info = await stat(candidate);
      if (info.isFile() && info.size > 0) {
        return { transcriptPath: candidate, bytes: info.size, lastActivityAt: Math.round(info.mtimeMs) };
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** The plain text of a transcript message: string content, or its text blocks joined. */
function messageText(content: unknown): { text: string; toolOnly: boolean } {
  if (typeof content === "string") return { text: content, toolOnly: false };
  if (!Array.isArray(content)) return { text: "", toolOnly: false };
  const parts: string[] = [];
  let sawTool = false;
  for (const raw of content) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === "text") {
      const text = asString(block.text);
      if (text) parts.push(text);
    } else if (block.type === "tool_use" || block.type === "tool_result") {
      sawTool = true;
    }
  }
  return { text: parts.join("\n").trim(), toolOnly: parts.length === 0 && sawTool };
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[… ${text.length - max} chars cut]`;
}

/** "2031-08-14 09:30 UTC", or null for an unparsable timestamp. */
function absoluteTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

interface Exchange {
  role: "User" | "Assistant";
  at: string | null;
  text: string;
}

/**
 * Stream a transcript and build a handover digest: title, session facts, the
 * first prompt, every compaction summary in full, and the last ~40 real
 * exchanges. Tool calls and tool results are dropped.
 */
export async function digestTranscript(
  transcriptPath: string,
  opts: { maxChars?: number } = {},
): Promise<DigestResult> {
  const maxChars = opts.maxChars ?? DIGEST_MAX_CHARS;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let firstPrompt: string | null = null;
  let cwd: string | null = null;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let messageCount = 0;
  const compactions: string[] = [];
  const recent: Exchange[] = [];

  const reader = createInterface({ input: createReadStream(transcriptPath, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const row = asRecord(parsed);
      if (!row) continue;
      const type = asString(row.type);
      if (type === "custom-title") {
        customTitle = asString(row.customTitle) ?? customTitle;
        continue;
      }
      if (type === "ai-title") {
        aiTitle = asString(row.aiTitle) ?? aiTitle;
        continue;
      }
      if (type === "summary") {
        const summary = asString(row.summary);
        if (summary) compactions.push(cap(summary, COMPACTION_MAX_CHARS));
        continue;
      }
      if (type !== "user" && type !== "assistant") continue;
      if (row.isSidechain === true) continue;
      const message = asRecord(row.message);
      if (!message) continue;
      const { text, toolOnly } = messageText(message.content);
      if (toolOnly) continue;
      const trimmed = text.trim();
      if (trimmed === "") continue;
      cwd = cwd ?? asString(row.cwd);
      const at = asString(row.timestamp);
      if (at) {
        firstAt = firstAt ?? at;
        lastAt = at;
      }
      if (type === "user") {
        if (trimmed.startsWith(COMPACTION_PREFIX)) {
          compactions.push(cap(trimmed, COMPACTION_MAX_CHARS));
          messageCount += 1;
          continue;
        }
        if (NOISE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) continue;
        if (trimmed.startsWith("/")) continue;
        firstPrompt = firstPrompt ?? cap(trimmed, FIRST_PROMPT_MAX_CHARS);
      }
      messageCount += 1;
      recent.push({
        role: type === "user" ? "User" : "Assistant",
        at: absoluteTime(at),
        text: cap(trimmed, EXCHANGE_MAX_CHARS),
      });
      if (recent.length > RECENT_EXCHANGES) recent.shift();
    }
  } finally {
    reader.close();
  }

  const title = customTitle ?? aiTitle;
  let truncated = false;
  let keptCompactions = compactions.slice();
  let keptRecent = recent.slice();

  const render = (): string => {
    const parts: string[] = [];
    parts.push(`# ${title ?? path.basename(transcriptPath, ".jsonl")}`);
    parts.push(
      [
        "## Session facts",
        `cwd: ${cwd ?? "(unknown)"}`,
        `first message: ${absoluteTime(firstAt) ?? "(unknown)"}`,
        `last message: ${absoluteTime(lastAt) ?? "(unknown)"}`,
        `messages: ${messageCount}`,
        `compaction summaries: ${keptCompactions.length} of ${compactions.length}`,
      ].join("\n"),
    );
    if (firstPrompt) parts.push(`## First user prompt\n${firstPrompt}`);
    keptCompactions.forEach((summary, index) => {
      parts.push(`## Compaction summary ${compactions.length - keptCompactions.length + index + 1} of ${compactions.length}\n${summary}`);
    });
    if (keptRecent.length > 0) {
      const body = keptRecent.map((e) => `${e.at ? `[${e.at}] ` : ""}${e.role}: ${e.text}`).join("\n\n");
      parts.push(`## Recent exchanges (last ${keptRecent.length} of ${recent.length})\n${body}`);
    }
    if (truncated) parts.push("[Digest truncated to fit the size budget: oldest exchanges and summaries were dropped first.]");
    return parts.join("\n\n");
  };

  let digest = render();
  // Drop the oldest recent exchanges first, then the oldest compaction
  // summaries: a summary is worth more than an old exchange in a handover.
  while (digest.length > maxChars && keptRecent.length > 1) {
    truncated = true;
    keptRecent = keptRecent.slice(Math.max(1, Math.ceil(keptRecent.length / 8)));
    digest = render();
  }
  while (digest.length > maxChars && keptCompactions.length > 0) {
    truncated = true;
    keptCompactions = keptCompactions.slice(1);
    digest = render();
  }
  if (digest.length > maxChars) {
    truncated = true;
    digest = `${digest.slice(0, Math.max(1, maxChars - 40))}\n[… digest hard-truncated]`;
  }
  return { digest, title, messageCount, truncated };
}
