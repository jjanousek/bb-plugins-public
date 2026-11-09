// The row model for the model and effort panel: what each cell shows, and what
// a batch move will land on before it is confirmed.
//
// No imports except the level rules next door, so `core.test.ts` can exercise
// all of it under `node --test`.
//
// Two rules, and both of them are about the same thing: the one thing this
// surface may never do is show a number it cannot stand behind.
//
// 1. The value shown is the thread's stored override, read at render time,
//    never the roster's cached copy, which can lag the thread. When they
//    disagree, the thread wins and the roster is marked stale rather than
//    quietly corrected.
// 2. A read that FAILED is not a value and is not an absence. `Cell` keeps
//    `unreadable` separate from `unset` for the same reason `lastOutput` keeps
//    `{ok:false}` separate from `{ok:true,value:null}`: a path that cannot tell
//    "nothing there" from "could not look" answers with the reassuring one. A
//    failed read must NOT fall back to the roster, because the roster is
//    exactly the stale source this panel does not trust.
import { levelForModelChange, type EffortDisplay, type WorkerReasoningLevel } from "./execution-levels.ts";

/** The result of reading one field off a thread. Absent and unreadable are different answers. */
export type Read<T> = { ok: true; value: T | null } | { ok: false };

/**
 * What one cell of the panel prints. Three answers, and the third is the point:
 * a thread nobody could read is never rendered as a thread with nothing set.
 *
 * There is no "the roster's own copy is behind" line. The roster keeps no
 * model or level of its own, so both sides of that comparison would be the
 * same live `defaultExecutionOptions` read taken milliseconds apart, and it
 * could only fire on a race. A warning that can only be wrong is worse than no
 * warning.
 */
export type Cell =
  | { kind: "value"; value: string }
  | { kind: "unset" }
  | { kind: "unreadable" };

/** One cell, from the thread's own value. Nothing is ever substituted for a failed read. */
export function cellFor(thread: Read<string>): Cell {
  if (!thread.ok) return { kind: "unreadable" };
  // No override: the thread runs at its provider's default.
  if (thread.value === null || thread.value.trim() === "") return { kind: "unset" };
  return { kind: "value", value: thread.value.trim() };
}

/**
 * What the Effort cell prints, from the thread's own cell and what the provider
 * does with a level.
 *
 * Four answers, and the order matters. "could not read" wins, because a failed
 * read is not a knowable value. Then `opaque`: the provider ignores bb's level
 * and the model id does not name one, so there is no effort to print and
 * the rule is that this must never be rendered as a level. Then
 * `model`, where the effort is legible but comes from the model id rather than
 * from bb, so it is muted and says where it came from. Only then the ordinary
 * path.
 *
 * Pure and here so a test can hold it, and so the Execution tab cannot assert
 * an effort for an acp-cursor worker that the Mission and Worker tabs call not
 * visible.
 */
export function effortCellText(
  cell: Cell,
  effort: EffortDisplay,
  renderLevel: (value: string) => string,
): { text: string; muted: boolean } {
  if (cell.kind === "unreadable") return { text: "could not read", muted: true };
  if (effort.kind === "opaque") return { text: "not visible to bb", muted: true };
  if (effort.kind === "model") {
    return { text: `${effort.level}${effort.fast ? " fast" : ""} (from the model id)`, muted: true };
  }
  if (cell.kind === "unset") return { text: "provider default", muted: true };
  return { text: renderLevel(cell.value), muted: false };
}

/** One selected row, as the batch form sees it. */
export interface MoveRow {
  id: string;
  name: string;
  fromModel: string | null;
  /** The thread's stored level, raw: it may be a level bb has and this plugin does not offer. */
  fromLevel: string | null;
}

/** What one row will look like after the move, computed with the same rule the remodel applies. */
export interface PreviewedMove {
  id: string;
  name: string;
  fromModel: string | null;
  toModel: string;
  fromLevel: string | null;
  toLevel: WorkerReasoningLevel;
  /** Whether the level moves on its own because the model family changed. */
  levelFollows: boolean;
}

/**
 * What a batch model change will land on, per row, before it is confirmed.
 *
 * `requested: null` on purpose: this previews the requested move, which is a
 * model move, and lets `levelForModelChange` decide the level exactly as
 * `cos_remodel` will. Passing a level here would preview a different action
 * from the one about to run.
 *
 * Moving a batch to another family can silently land every row on that
 * family's default level. That is correct, and it is not what someone who
 * selected rows at a higher level expects, so it is shown before it happens
 * rather than reported after.
 */
export function previewModelChange(
  rows: readonly MoveRow[],
  toModel: string,
  setting: string | null | undefined,
  fallback: WorkerReasoningLevel,
): PreviewedMove[] {
  return rows.map((row) => {
    const toLevel = levelForModelChange({
      requested: null,
      current: row.fromLevel,
      fromModel: row.fromModel,
      toModel,
      setting,
      fallback,
    });
    const from = (row.fromLevel ?? "").trim().toLowerCase();
    return {
      id: row.id,
      name: row.name,
      fromModel: row.fromModel,
      toModel,
      fromLevel: row.fromLevel,
      toLevel,
      levelFollows: from !== "" && from !== toLevel,
    };
  });
}

/**
 * What a model move does to the effort levels, or null when it does nothing.
 *
 * This is a menu-item suffix rather than a confirm dialog. A model change here
 * is a sticky override on the same thread (`bb.sdk.threads.update`): cheap and
 * reversible, so the surface follows the board's own shape:
 * apply, then offer an undo strip. A confirm would be the wrong weight, and this
 * plugin's `ConfirmDialog` is not phone-safe as written: its footer collapses
 * to a zero-gap reversed column under 640px, and this surface also has to
 * work at phone widths.
 *
 * Putting it on the item means the consequence is read at the moment of
 * choosing, which is the only moment it can change a mind. A batch onto
 * another family can land every row on that family's default level; that is
 * correct, and it is not what the selection looks like it will do.
 */
export function levelMoveNote(moves: readonly PreviewedMove[]): string | null {
  const moving = moves.filter((m) => m.levelFollows);
  if (moving.length === 0) return null;
  const landings = [...new Set(moving.map((m) => m.toLevel))];
  if (landings.length === 1) {
    return moving.length === 1
      ? `effort moves to ${landings[0]}`
      : `${moving.length} effort levels move to ${landings[0]}`;
  }
  return `${moving.length} effort levels move to match the model`;
}


/**
 * The models a batch move may actually offer: the INTERSECTION of the selected
 * rows' catalogs, never the union.
 *
 * bb refuses a model the target thread's catalog does not list ("changing
 * providers requires starting a new thread", HTTP 400). Taking the union would
 * let a claude-code worker and an acp-cursor worker selected together offer
 * every model from both, and any choice would be refused for one of them.
 * That is a batch that silently drops members, which reads as batches not
 * working at all.
 *
 * An empty result is a real answer and the caller must say so rather than
 * showing an empty picker: it means "these threads share no model", which is a
 * fact about the selection, not a failure.
 */
export function sharedModels(
  catalogs: readonly (readonly { model: string; displayName: string }[] | null)[],
): { value: string; label: string }[] {
  if (catalogs.length === 0) return [];
  // A row whose catalog could not be resolved constrains the batch to nothing:
  // offering a model it may not accept is what this prevents, so an unknown
  // catalog is treated as "shares nothing" rather than as "shares everything".
  if (catalogs.some((catalog) => catalog === null)) return [];
  const [first, ...rest] = catalogs as (readonly { model: string; displayName: string }[])[];
  const shared: { value: string; label: string }[] = [];
  for (const candidate of first ?? []) {
    if (rest.every((catalog) => catalog.some((m) => m.model === candidate.model))) {
      shared.push({ value: candidate.model, label: candidate.displayName });
    }
  }
  return shared;
}

/** A group of rows under one heading in the panel. */
export interface ExecutionGroup<Row> {
  /** "Chief of Staff", a manager's name, or "Reporting to the chief". */
  title: string;
  /** Sort key only; not shown. */
  order: number;
  rows: Row[];
}

/**
 * The panel's rows, grouped the way the fleet is actually organised.
 *
 * A long flat list of threads in an order nobody chose is not organised, and
 * the right worker is hard to find in it. The tier already answers it: the chief, then each manager with its
 * own team, then whatever reports to the chief directly.
 *
 * Names sort inside a group so a worker's position is predictable between
 * renders; groups sort by manager name with the chief pinned first, because the
 * chief is the one row that is never a peer of the others.
 */
export function groupByManager<Row extends { name: string; kind: string; role?: string | null; managerName?: string | null }>(
  rows: readonly Row[],
): ExecutionGroup<Row>[] {
  const groups = new Map<string, ExecutionGroup<Row>>();
  const put = (title: string, order: number, row: Row) => {
    const existing = groups.get(title);
    if (existing) existing.rows.push(row);
    else groups.set(title, { title, order, rows: [row] });
  };
  for (const row of rows) {
    if (row.kind === "chief") put("Chief of Staff", 0, row);
    else if (row.role === "manager") put("Managers", 1, row);
    else if (row.managerName) put(row.managerName, 2, row);
    else put("Reporting to the chief", 3, row);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, rows: [...group.rows].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

/** Does this row match the typed filter? Name, project and model all count. */
export function matchesFilter(
  row: {
    name: string;
    project?: string | null;
    model?: string | null;
    reasoningLevel?: string | null;
    threadId?: string;
    permissionMode?: string | null;
    pluginPermissionMode?: string | null;
  },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  // Every field the row actually prints, so searching for what is on screen
  // finds it. Searching "cursor" should find the Cursor workers by model even
  // though no name contains it, and "approve" finds every row not on full.
  const permission = permissionCell({
    threadId: row.threadId ?? "",
    resolved: row.permissionMode ?? null,
    plugin: row.pluginPermissionMode ?? null,
  });
  return [row.name, row.project, row.model, row.reasoningLevel, permission.kind === "known" ? permission.text : null]
    .filter((field): field is string => typeof field === "string")
    .some((field) => field.toLowerCase().includes(needle));
}


/**
 * What a row prints for context use, and whether it is a warning.
 *
 * **A thread with no usage event is `unknown`, never 0%.** That distinction is
 * the point of the whole cell: bb's own indicator draws a near-invisible
 * hairline ring at 0%, which reads as "fine", so a thread with no reading
 * would look fine. This is the same rule `cellFor` applies to a value it could
 * not read.
 *
 * The thresholds are bb's own, so the plugin and the host agree about when a
 * thread is in trouble: warning at 75, destructive at 90.
 *
 * The denominator matters as much as the number. A `[1m]` model reports a
 * 1,000,000 window and the others 200,000, so 160,000 tokens is 80% on one
 * thread and 16% on another. Percent is the only comparable figure, which is
 * why the raw count is never shown on its own.
 */
export type ContextCell =
  | { kind: "unknown" }
  | { kind: "known"; percent: number; tone: "normal" | "warning" | "danger" };

export function contextCell(
  usedTokens: number | null | undefined,
  contextWindow: number | null | undefined,
): ContextCell {
  if (typeof usedTokens !== "number" || typeof contextWindow !== "number") return { kind: "unknown" };
  if (!Number.isFinite(usedTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { kind: "unknown" };
  }
  const percent = Math.round(Math.min(Math.max(usedTokens / contextWindow, 0), 1) * 100);
  const tone = percent >= 90 ? "danger" : percent >= 75 ? "warning" : "normal";
  return { kind: "known", percent, tone };
}

/**
 * Threads kept below full permission on purpose. Shown as a known
 * exception, never as a problem. Empty as shipped: add the thread ids you keep
 * on a lower mode on purpose (a thread that should always ask first, for example).
 */
export const PERMISSION_EXCEPTIONS: ReadonlySet<string> = new Set<string>([]);

const PERMISSION_WORD: Record<string, string> = {
  full: "Full",
  auto: "Approve for me",
  "accept-edits": "Accept Edits",
};

/**
 * What a row prints for permission, and whether it is flagged.
 *
 * `resolved` is what bb says the thread runs at next
 * (`threads.defaultExecutionOptions`): what the user's own next turn carries,
 * worked out from the last turn, the parent and the project row. `plugin` is
 * the mode a dispatch from the chief or a manager requests, which overrides
 * that for the dispatched turn. When they differ the row says both, so a row
 * reading "Full" is never half true.
 *
 * Below full is a warning, except for a thread kept there on purpose. A read
 * that failed is unknown, never Full.
 */
export type PermissionCell =
  | { kind: "unknown" }
  | { kind: "known"; text: string; tone: "normal" | "exception" | "warning" };

export function permissionCell(input: {
  threadId: string;
  resolved: string | null;
  plugin: string | null;
}): PermissionCell {
  if (input.resolved === null) return { kind: "unknown" };
  const word = (mode: string) => PERMISSION_WORD[mode] ?? mode;
  const text =
    input.plugin !== null && input.plugin !== input.resolved
      ? `${word(input.resolved)} (dispatches: ${word(input.plugin)})`
      : word(input.resolved);
  const allFull = input.resolved === "full" && (input.plugin === null || input.plugin === "full");
  const tone = allFull ? "normal" : PERMISSION_EXCEPTIONS.has(input.threadId) ? "exception" : "warning";
  return { kind: "known", text, tone };
}

