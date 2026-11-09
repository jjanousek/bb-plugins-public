// store.ts: the SQLite assets table. Pure data access (no bb API) so the
// server file stays wiring and tests can use a throwaway database.
import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { FAILED_WINDOW_MS } from "./contract";
import type { Asset, AssetKind, AssetStatus, ObservedCost, Params, Status } from "./contract";

export type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

/** Append-only. Never edit or reorder shipped statements. */
export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt TEXT NOT NULL,
    model TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    file TEXT,
    path TEXT,
    workflow_path TEXT NOT NULL,
    mime TEXT,
    width INTEGER,
    height INTEGER,
    duration_s REAL,
    size_bytes INTEGER,
    comfy_prompt_id TEXT,
    parent_id TEXT,
    thread_id TEXT,
    source TEXT NOT NULL DEFAULT 'unknown',
    starred INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS assets_created ON assets (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS assets_status ON assets (status, created_at)`,
  // What a generation was expected to cost and what it was billed.
  `ALTER TABLE assets ADD COLUMN estimated_credits REAL`,
  `ALTER TABLE assets ADD COLUMN actual_credits REAL`,
  `ALTER TABLE assets ADD COLUMN billed_model TEXT`,
  `ALTER TABLE assets ADD COLUMN output_tier TEXT`,
  // One row per bill this plugin has seen, so the estimate can learn. The
  // unique index on asset_id keeps a backfill from counting a job twice.
  `CREATE TABLE IF NOT EXISTS cost_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signature TEXT NOT NULL,
    kind TEXT NOT NULL,
    model TEXT NOT NULL,
    credits REAL NOT NULL,
    asset_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cost_samples_signature ON cost_samples (signature, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cost_samples_asset ON cost_samples (asset_id)`,
  // A tiny key-value table, for the picker's favourites and the
  // last models used. Small, plain JSON, never anything secret.
  `CREATE TABLE IF NOT EXISTS prefs (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // Small copies of the asset, so the grid does not put a full size original
  // in a small tile. Null on every row that predates them and on any row whose
  // ffmpeg run failed, and every surface falls back to the original, so this
  // column is an optimisation and never the only way to draw a picture.
  `ALTER TABLE assets ADD COLUMN thumb_path TEXT`,
  `ALTER TABLE assets ADD COLUMN medium_path TEXT`,
  // Which DERIVATIVE_REVISION (thumbs.ts) the small copies were
  // made at, so the backfill can redo rows made at an older size. Null on every
  // row from before, which is revision one. Internal to the store: no surface
  // reads it, so it is not on the Asset contract.
  `ALTER TABLE assets ADD COLUMN derivative_rev INTEGER`,
];

/** Model keys the picker pins. */
export const FAVOURITES_KEY = "model.favourites";
/** Model keys most recently generated with, newest first. */
export const RECENT_KEY = "model.recent";
/** The model key the panel's Generate tab is on, per kind. */
export function chosenKey(kind: AssetKind): string {
  return `model.chosen.${kind}`;
}
/** How many entries the Recent list keeps. */
export const RECENT_LIMIT = 5;

/** How many recent samples of one shape `observedCredits` takes the median of. */
export const OBSERVED_WINDOW = 10;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `img_` or `vid_` plus 8 lowercase alphanumerics. */
export function newAssetId(kind: AssetKind): string {
  const bytes = randomBytes(8);
  let suffix = "";
  for (const byte of bytes) suffix += ALPHABET[byte % ALPHABET.length];
  return `${kind === "image" ? "img" : "vid"}_${suffix}`;
}

export const TERMINAL_STATUSES: readonly AssetStatus[] = ["completed", "failed", "cancelled"];

export function isTerminal(status: AssetStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

interface AssetRow {
  id: string;
  kind: string;
  status: string;
  prompt: string;
  model: string;
  params: string;
  file: string | null;
  path: string | null;
  workflow_path: string;
  thumb_path: string | null;
  medium_path: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  size_bytes: number | null;
  comfy_prompt_id: string | null;
  parent_id: string | null;
  thread_id: string | null;
  source: string;
  starred: number;
  error: string | null;
  estimated_credits: number | null;
  actual_credits: number | null;
  billed_model: string | null;
  output_tier: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

/**
 * The Asset fields that live in a column. The media version tokens are
 * computed from the files as a row leaves through the RPC (server.ts), never
 * stored, because the backfill can rewrite a small copy in place.
 */
type StoredKey = Exclude<keyof Asset, "fileVersion" | "thumbVersion" | "mediumVersion">;
type StoredPatch = Partial<Omit<Pick<Asset, StoredKey>, "id">>;

const COLUMNS: Record<StoredKey, string> = {
  id: "id",
  kind: "kind",
  status: "status",
  prompt: "prompt",
  model: "model",
  params: "params",
  file: "file",
  path: "path",
  workflowPath: "workflow_path",
  thumbPath: "thumb_path",
  mediumPath: "medium_path",
  mime: "mime",
  width: "width",
  height: "height",
  durationS: "duration_s",
  sizeBytes: "size_bytes",
  comfyPromptId: "comfy_prompt_id",
  parentId: "parent_id",
  threadId: "thread_id",
  source: "source",
  starred: "starred",
  error: "error",
  estimatedCredits: "estimated_credits",
  actualCredits: "actual_credits",
  billedModel: "billed_model",
  outputTier: "output_tier",
  createdAt: "created_at",
  startedAt: "started_at",
  completedAt: "completed_at",
};

function parseParams(text: string): Params {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Params = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    kind: row.kind as AssetKind,
    status: row.status as AssetStatus,
    prompt: row.prompt,
    model: row.model,
    params: parseParams(row.params),
    file: row.file,
    path: row.path,
    workflowPath: row.workflow_path,
    thumbPath: row.thumb_path,
    mediumPath: row.medium_path,
    mime: row.mime,
    width: row.width,
    height: row.height,
    durationS: row.duration_s,
    sizeBytes: row.size_bytes,
    comfyPromptId: row.comfy_prompt_id,
    parentId: row.parent_id,
    threadId: row.thread_id,
    source: row.source as Asset["source"],
    starred: row.starred === 1,
    error: row.error,
    estimatedCredits: row.estimated_credits,
    actualCredits: row.actual_credits,
    billedModel: row.billed_model,
    outputTier: row.output_tier,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function toColumnValue(key: StoredKey, value: Asset[StoredKey]): string | number | null {
  if (key === "params") return JSON.stringify(value ?? {});
  if (key === "starred") return value ? 1 : 0;
  if (value === undefined) return null;
  return value as string | number | null;
}

export interface ListFilter {
  kind?: AssetKind;
  status?: AssetStatus;
  starred?: boolean;
  query?: string;
  limit?: number;
  before?: number;
}

export const DEFAULT_LIST_LIMIT = 100;
/** The Library's "Show older" grows to this (LIBRARY_MAX in components/comfy/library-paging.ts). */
export const MAX_LIST_LIMIT = 2000;

export function createStore(db: PluginDatabase) {
  const insertStmt = db.prepare(
    `INSERT INTO assets (${Object.values(COLUMNS).join(", ")}) VALUES (${Object.keys(COLUMNS)
      .map((k) => `@${k}`)
      .join(", ")})`,
  );
  const getStmt = db.prepare(`SELECT * FROM assets WHERE id = ?`);
  const deleteStmt = db.prepare(`DELETE FROM assets WHERE id = ?`);
  const byStatusStmt = db.prepare(`SELECT * FROM assets WHERE status = ? ORDER BY created_at ASC, id ASC`);

  function insert(asset: Asset): Asset {
    const values: Record<string, string | number | null> = {};
    for (const key of Object.keys(COLUMNS) as StoredKey[]) values[key] = toColumnValue(key, asset[key]);
    insertStmt.run(values);
    return asset;
  }

  function get(id: string): Asset | null {
    const row = getStmt.get(id) as AssetRow | undefined;
    return row ? toAsset(row) : null;
  }

  function update(id: string, patch: StoredPatch): Asset | null {
    const keys = Object.keys(patch) as (keyof StoredPatch)[];
    if (keys.length === 0) return get(id);
    const sets = keys.map((key) => `${COLUMNS[key]} = @${key}`);
    const values: Record<string, string | number | null> = { id };
    for (const key of keys) values[key] = toColumnValue(key, patch[key] as Asset[StoredKey]);
    db.prepare(`UPDATE assets SET ${sets.join(", ")} WHERE id = @id`).run(values);
    return get(id);
  }

  /**
   * Conditional update: only writes when the row still exists and still has
   * `expectedStatus`. Returns false when the row was cancelled or deleted
   * while a network call was in flight, so the caller can back off instead of
   * resurrecting it.
   */
  function updateIf(id: string, expectedStatus: AssetStatus, patch: StoredPatch): boolean {
    const keys = Object.keys(patch) as (keyof StoredPatch)[];
    if (keys.length === 0) return get(id)?.status === expectedStatus;
    const sets = keys.map((key) => `${COLUMNS[key]} = @${key}`);
    const values: Record<string, string | number | null> = { rowId: id, expectedStatus };
    for (const key of keys) values[key] = toColumnValue(key, patch[key] as Asset[StoredKey]);
    const result = db.prepare(`UPDATE assets SET ${sets.join(", ")} WHERE id = @rowId AND status = @expectedStatus`).run(values);
    return result.changes > 0;
  }

  function remove(id: string): boolean {
    return deleteStmt.run(id).changes > 0;
  }

  function byStatus(status: AssetStatus): Asset[] {
    return (byStatusStmt.all(status) as AssetRow[]).map(toAsset);
  }

  function list(filter: ListFilter = {}): Asset[] {
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (filter.kind) {
      where.push("kind = ?");
      values.push(filter.kind);
    }
    if (filter.status) {
      where.push("status = ?");
      values.push(filter.status);
    }
    if (filter.starred) where.push("starred = 1");
    const query = (filter.query ?? "").trim();
    if (query !== "") {
      where.push("(prompt LIKE ? OR model LIKE ? OR id = ? OR error LIKE ?)");
      const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      values.push(like, like, query, like);
    }
    if (typeof filter.before === "number" && Number.isFinite(filter.before)) {
      where.push("created_at < ?");
      values.push(filter.before);
    }
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(filter.limit ?? DEFAULT_LIST_LIMIT)));
    const sql = `SELECT * FROM assets${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
    const escape = query !== "" ? " ESCAPE '\\'" : "";
    const finalSql = escape ? sql.replace(/LIKE \?/g, `LIKE ?${escape}`) : sql;
    return (db.prepare(finalSql).all(...values, limit) as AssetRow[]).map(toAsset);
  }

  /**
   * `failed` is every failed row in the library; `failedRecent` is the ones
   * that failed inside `FAILED_WINDOW_MS`, which is what the sidebar badge
   * shows so a red badge can go back to nothing on its own.
   *
   * It reads `completed_at`, the moment the row actually failed, and falls back
   * to `created_at` for a row with no completion time. The two are usually
   * close, but a row that waits hours for a key and then fails is recent when
   * it fails, not when it was asked for.
   */
  function counts(nowMs = Date.now()): Status["counts"] {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
          SUM(CASE WHEN kind = 'image' THEN 1 ELSE 0 END) AS images,
          SUM(CASE WHEN kind = 'video' THEN 1 ELSE 0 END) AS videos,
          SUM(CASE WHEN status IN ('queued', 'running', 'unknown') THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'failed' AND COALESCE(completed_at, created_at) >= ? THEN 1 ELSE 0 END) AS failed_recent
        FROM assets`,
      )
      .get(nowMs - FAILED_WINDOW_MS) as {
      total: number;
      images: number | null;
      videos: number | null;
      running: number | null;
      failed: number | null;
      failed_recent: number | null;
    };
    return {
      total: row.total,
      images: row.images ?? 0,
      videos: row.videos ?? 0,
      running: row.running ?? 0,
      failed: row.failed ?? 0,
      failedRecent: row.failed_recent ?? 0,
    };
  }

  // ---------- cost ----------

  const sampleStmt = db.prepare(
    `INSERT OR IGNORE INTO cost_samples (signature, kind, model, credits, asset_id, created_at) VALUES (@signature, @kind, @model, @credits, @assetId, @createdAt)`,
  );
  const sampleReadStmt = db.prepare(`SELECT credits FROM cost_samples WHERE signature = ? ORDER BY created_at DESC, id DESC LIMIT ?`);

  /**
   * Record one bill. `assetId` is unique, so replaying the backfill over an
   * asset that already has a sample changes nothing.
   */
  function addCostSample(sample: { signature: string; kind: AssetKind; model: string; credits: number; assetId?: string | null; createdAt?: number }): void {
    if (!Number.isFinite(sample.credits) || sample.credits <= 0) return;
    sampleStmt.run({
      signature: sample.signature,
      kind: sample.kind,
      model: sample.model,
      credits: sample.credits,
      assetId: sample.assetId ?? null,
      createdAt: sample.createdAt ?? Date.now(),
    });
  }

  /**
   * Re-key the samples whose asset row is still on file. A sample is keyed by
   * the shape it was billed for, and that key has to follow the plugin: when
   * the same model can arrive under a bare id and under a registry key, or when
   * a new field joins the shape, the samples already learned would otherwise be
   * stranded under names nothing asks for again. Idempotent, so it can run at
   * every start; returns how many rows moved.
   */
  function resignCostSamples(compute: (asset: Asset) => { signature: string; model: string } | null): number {
    // `a.*` first and the sample's own columns under names of their own, so the
    // asset's `id` and `model` are not shadowed by the sample's.
    const rows = db
      .prepare(
        `SELECT a.*, s.id AS sample_id, s.signature AS sample_signature, s.model AS sample_model FROM cost_samples s
         JOIN assets a ON a.id = s.asset_id`,
      )
      .all() as (AssetRow & { sample_id: number; sample_signature: string; sample_model: string })[];
    const write = db.prepare(`UPDATE cost_samples SET signature = ?, model = ? WHERE id = ?`);
    let moved = 0;
    const run = db.transaction(() => {
      for (const row of rows) {
        const next = compute(toAsset(row));
        if (next === null || (next.signature === row.sample_signature && next.model === row.sample_model)) continue;
        write.run(next.signature, next.model, row.sample_id);
        moved += 1;
      }
    });
    run();
    return moved;
  }

  /** Median of the most recent samples of one shape, or null when there are none. */
  function observedCredits(signature: string): ObservedCost | null {
    const rows = sampleReadStmt.all(signature, OBSERVED_WINDOW) as { credits: number }[];
    if (rows.length === 0) return null;
    const values = rows.map((row) => row.credits).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 === 1 ? (values[middle] as number) : (((values[middle - 1] as number) + (values[middle] as number)) / 2);
    return { credits: median, samples: values.length };
  }

  /** Every shape the plugin has been billed for, most sampled first. */
  function observedShapes(): { signature: string; kind: AssetKind; model: string; credits: number; samples: number }[] {
    const rows = db.prepare(`SELECT DISTINCT signature, kind, model FROM cost_samples ORDER BY signature`).all() as { signature: string; kind: string; model: string }[];
    const out: { signature: string; kind: AssetKind; model: string; credits: number; samples: number }[] = [];
    for (const row of rows) {
      const seen = observedCredits(row.signature);
      if (seen) out.push({ signature: row.signature, kind: row.kind as AssetKind, model: row.model, credits: seen.credits, samples: seen.samples });
    }
    return out.sort((a, b) => b.samples - a.samples || b.credits - a.credits);
  }

  /** Credits this plugin's own generations were billed, since `sinceMs` (0 for all time). */
  function spendSince(sinceMs: number): number {
    const row = db.prepare(`SELECT COALESCE(SUM(actual_credits), 0) AS credits FROM assets WHERE actual_credits IS NOT NULL AND created_at >= ?`).get(sinceMs) as {
      credits: number;
    };
    return Math.round(row.credits * 100) / 100;
  }

  function creditsByModel(sinceMs: number): { model: string; kind: AssetKind; credits: number; count: number }[] {
    const rows = db
      .prepare(
        `SELECT model, kind, SUM(actual_credits) AS credits, COUNT(*) AS count FROM assets
         WHERE actual_credits IS NOT NULL AND created_at >= ?
         GROUP BY model, kind ORDER BY credits DESC`,
      )
      .all(sinceMs) as { model: string; kind: string; credits: number; count: number }[];
    return rows.map((row) => ({ model: row.model, kind: row.kind as AssetKind, credits: Math.round(row.credits * 100) / 100, count: row.count }));
  }

  /** Newest generations that carry a cost of either sort. */
  function recentCosts(sinceMs: number, limit: number): Asset[] {
    return (
      db
        .prepare(
          `SELECT * FROM assets WHERE created_at >= ? AND (actual_credits IS NOT NULL OR estimated_credits IS NOT NULL)
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(sinceMs, Math.max(1, Math.floor(limit))) as AssetRow[]
    ).map(toAsset);
  }

  /** Completed assets that ran but never got a bill, newest first. The backfill works through these. */
  function needsCost(limit: number): Asset[] {
    return (
      db
        .prepare(
          `SELECT * FROM assets WHERE status = 'completed' AND comfy_prompt_id IS NOT NULL AND actual_credits IS NULL
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(Math.max(1, Math.floor(limit))) as AssetRow[]
    ).map(toAsset);
  }

  /**
   * Completed rows with a file on disk whose small copies are missing or were
   * made at a revision older than `revision`. Newest first, because those are
   * the ones somebody is about to look at.
   */
  function needsDerivatives(limit: number, revision: number): Asset[] {
    return (
      db
        .prepare(
          `SELECT * FROM assets WHERE status = 'completed' AND path IS NOT NULL
             AND (thumb_path IS NULL OR (kind = 'image' AND medium_path IS NULL)
                  OR derivative_rev IS NULL OR derivative_rev < ?)
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(revision, Math.max(1, Math.floor(limit))) as AssetRow[]
    ).map(toAsset);
  }

  /** Record the revision a row's small copies were made at. */
  function setDerivativeRevision(id: string, revision: number): void {
    db.prepare(`UPDATE assets SET derivative_rev = ? WHERE id = ?`).run(revision, id);
  }

  // ---------- preferences ----------

  const getPrefStmt = db.prepare(`SELECT value FROM prefs WHERE key = ?`);
  const setPrefStmt = db.prepare(`INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);

  /** A list of strings kept under one key. Anything unparsable reads as empty. */
  function getList(key: string): string[] {
    const row = getPrefStmt.get(key) as { value: string } | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  /** One stored string, or null when nothing has been written under this key. */
  function getText(key: string): string | null {
    const row = getPrefStmt.get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return typeof parsed === "string" && parsed !== "" ? parsed : null;
    } catch {
      return null;
    }
  }

  function setText(key: string, value: string): void {
    setPrefStmt.run(key, JSON.stringify(value), Date.now());
  }

  function setList(key: string, values: readonly string[], limit = 200): string[] {
    const unique: string[] = [];
    for (const value of values) {
      if (typeof value !== "string" || value.trim() === "" || unique.includes(value)) continue;
      unique.push(value);
      if (unique.length >= limit) break;
    }
    setPrefStmt.run(key, JSON.stringify(unique), Date.now());
    return unique;
  }

  /** Move a model key to the front of the recent list. */
  function noteRecent(key: string): string[] {
    return setList(RECENT_KEY, [key, ...getList(RECENT_KEY)], RECENT_LIMIT);
  }

  return {
    insert,
    get,
    update,
    updateIf,
    remove,
    byStatus,
    list,
    counts,
    addCostSample,
    resignCostSamples,
    observedCredits,
    observedShapes,
    spendSince,
    creditsByModel,
    recentCosts,
    needsCost,
    needsDerivatives,
    setDerivativeRevision,
    getList,
    setList,
    getText,
    setText,
    noteRecent,
  };
}

export type Store = ReturnType<typeof createStore>;
