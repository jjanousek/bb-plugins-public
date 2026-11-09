// Shared RPC contract between server.ts (handlers) and app.tsx (type-only import).
// Keep this file free of server-only imports: app.tsx bundles it.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * The input of a method that takes none. Any body is accepted and read as null.
 *
 * A page still running a previous bundle can send `{}` or an empty body to a
 * method that takes none. Refusing a no-input call has no value, so it is not
 * refused.
 */
const noInput = z.null().catch(null);

export const boardAreaSchema = z.enum(["clients", "consulting", "operations"]);

export const boardStateSchema = z.enum(["open", "addressed", "resolved", "dismissed"]);
export type BoardStateDto = z.infer<typeof boardStateSchema>;

export const boardLinkSchema = z.object({ label: z.string(), href: z.string() });

/** How soon an item needs the user. Set by the chief; never guessed from prose. */
export const boardPrioritySchema = z.enum(["now", "soon", "whenever"]);

/** One thing the user can decide, in the chief's words. Under about 40 characters. */
export const boardChoiceSchema = z.object({ label: z.string().min(1) });

/** One item on the decision board. See core.ts for what each state means. */
export const boardItemSchema = z.object({
  id: z.string(),
  headline: z.string(),
  context: z.string(),
  area: boardAreaSchema,
  links: z.array(boardLinkSchema),
  createdAt: z.number(),
  state: boardStateSchema,
  /** When Address last put this item in the user's composer. Not a send. */
  draftedAt: z.number().nullable(),
  addressedAt: z.number().nullable(),
  resolvedAt: z.number().nullable(),
  dismissedAt: z.number().nullable(),
  note: z.string().nullable(),
  /** Who last moved it, named for the log. Null when no mover is recorded. */
  movedBy: z.string().nullable(),
  /**
   * Where the item came from, in the chief's words: a worker's name, "your
   * inbox", "an email". Null when the chief did not say or no source is
   * stored.
   */
  sourceLabel: z.string().nullable().default(null),
  /** The thread behind `sourceLabel`, when it is one the panel can open. */
  sourceThreadId: z.string().nullable().default(null),
  /**
   * How soon it needs the user. An item with no stored priority reads "soon",
   * which is the honest answer: the chief never said.
   */
  priority: boardPrioritySchema.default("soon"),
  /** What the user can decide, in the chief's words. Empty when it is not a choice. */
  choices: z.array(boardChoiceSchema).default([]),
  /**
   * When it closes itself (epoch ms): the start of the day after the event it
   * is about, in the home zone (HOME_TIME_ZONE). Null when the chief gave it no day.
   */
  expiresAt: z.number().nullable().default(null),
  /** The worker questions it carries, by Need id ("n" and six hex digits). `board_close` takes one. */
  needIds: z.array(z.string()).default([]),
});
export type BoardItemDto = z.infer<typeof boardItemSchema>;

export const projectRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["personal", "standard"]),
});
export type ProjectRefDto = z.infer<typeof projectRefSchema>;

/** A worker's avatar: a shape id and a colour id from avatars.ts. */
export const avatarSchema = z.object({ shape: z.string(), color: z.string() });
export type AvatarDto = z.infer<typeof avatarSchema>;

export const workerStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  threadId: z.string(),
  title: z.string().nullable(),
  /** Assigned on spawn or adopt; null only for a worker that has not been branded yet. */
  avatar: avatarSchema.nullable(),
  /** Provider the worker's thread runs on (bb provider id), or null when unknown. */
  providerId: z.string().nullable().default(null),
  /** Model the worker's thread runs on, or null when unknown. */
  model: z.string().nullable().default(null),
  /** Reasoning level the worker's thread was pinned to on spawn, or null when unknown (adopted, or never recorded). */
  reasoningLevel: z.string().nullable().default(null),
  /** bb thread status: active | idle | error | starting | stopping | missing */
  status: z.string(),
  /** bb runtime displayStatus (adds provisioning, waiting-for-host, host-reconnecting) or "missing" */
  displayStatus: z.string(),
  /** The worker is blocked on a permission prompt or a question for the user. */
  pendingInteraction: z.boolean(),
  /** The worker's last turn failed (status === "error"). */
  failed: z.boolean(),
  /** Thread is deleted, archived, or gone. */
  missing: z.boolean(),
  retired: z.boolean(),
  /**
   * The disposition word on this worker's last finished report, or null when it
   * wrote none. `cos_roster` counts the nulls so the chief can chase workers
   * that leave it out.
   */
  lastDisposition: z.string().nullable().default(null),
  /** Whether the turn behind lastDisposition was a dispatch; null when not known. */
  lastReportDispatched: z.boolean().nullable().default(null),
  /** The last brief's one-line task and when. Not the topic. */
  lastTask: z.string().nullable().default(null),
  lastTaskAt: z.number().nullable().default(null),
  lastUsedAt: z.number(),
  /** First ~240 chars of the worker's last assistant message, or null. */
  lastOutputExcerpt: z.string().nullable(),
  /**
   * When reading the thread failed and the fields above came from the report
   * the plugin stored when it routed it: that report's arrival time. Null when
   * they were read from the thread, which is the normal case. It keeps a
   * failed read from blanking the Need line.
   */
  lastOutputStoredAt: z.number().nullable().default(null),
  /** Parsed from the worker's last message status block ("Done:" line), or null. */
  lastDone: z.string().nullable(),
  /** Parsed "Open:" line, or null. */
  lastOpen: z.string().nullable(),
  /** Parsed "Need:" line, or null. Null also when the need is "nothing" / "none" / "-". */
  lastNeed: z.string().nullable(),
  /**
   * The answers the worker offered with its Need, from a trailing
   * `Options: A | B` clause, already stripped out of `lastNeed`. Two to four
   * short labels, or empty. Tapping one drafts it as the answer.
   */
  needChoices: z.array(z.string()).default([]),
  /** When the worker last finished a turn (last report/failed activity), or null. */
  lastReportAt: z.number().nullable(),
  /** Server-computed attention level (see `urgencyFrom` in core.ts). */
  urgency: z.enum(["urgent", "attention", "active", "neutral"]),
  /** Short deadline phrase parsed from the need/open text, e.g. "today 16:00". */
  dueHint: z.string().nullable(),
  /** Epoch ms of the parsed deadline, for sorting. Null when none was found. */
  dueAt: z.number().nullable(),
  /**
   * Who the Need line addresses. Defaults to user; only an explicit addressee or
   * route verb makes it chief. A false "chief" silently drops a real decision, so
   * under-match deliberately.
   */
  needAudience: z.enum(["user", "chief"]).default("user"),
  /** When the chief last read this worker (cos_read, cos_wait, or a full report), or null. */
  chiefLastSeenAt: z.number().nullable().default(null),
  /** Finished turns since chiefLastSeenAt: progress the chief has not read yet. */
  newTurns: z.number().int().nonnegative().default(0),
  /** "worker" or "manager". Defaults to worker, so an older client reads a flat roster rather than breaking. */
  role: z.string().default("worker"),
  /** The manager this worker reports to, or null for the chief. */
  managerId: z.string().nullable().default(null),
  /**
   * For a manager: unread turns from its TEAM, on top of its own `newTurns`.
   * The chief reads a manager instead of its team, so without this a team that
   * has been busy all morning shows as a quiet manager row.
   */
  teamNewTurns: z.number().int().nonnegative().default(0),
  /**
   * Whether a manager's last report carried a `Team:` line. Defaults TRUE so a
   * plain worker and an older client are never flagged: a false nudge about a
   * rule that does not apply is worse than a missed one.
   */
  reportedTeam: z.boolean().default(true),
  /**
   * This worker's current `Need:` line is one the user has not seen. Distinct
   * from `newTurns`, which is the chief's unread count, so that a need that
   * arrived overnight does not look the same as one read days ago.
   */
  needIsNew: z.boolean().default(false),
  /**
   * lastNeed was dismissed by the chief as answered out of band. It still
   * prints, but it is nobody's open question: not a decision, never urgent.
   */
  needDismissed: z.boolean().default(false),
  /** When it was dismissed, or null. Only set while needDismissed is true. */
  needDismissedAt: z.number().nullable().default(null),
  /** The chief's reason, or null. Only set while needDismissed is true. */
  needDismissedNote: z.string().nullable().default(null),
  /**
   * The stable ids of the questions in lastNeed that the plugin has on file
   * ("n" and six hex digits). A reworded repeat keeps its id. Empty when the
   * Need is new since the last report the plugin saw.
   */
  needIds: z.array(z.string()).default([]),
  /**
   * Epoch ms until which the worker's model refuses turns (a 429 with a
   * retry-after), or null. A blocked worker is a muted status, not a failure
   * and not a decision: the plugin retries the turn itself.
   */
  blockedUntil: z.number().nullable().default(null),
  /**
   * The chief has a brief on file for this worker, so Retry can re-send it. It
   * is false for a worker that has only ever been messaged by the user, where
   * there is nothing of the chief's to repeat.
   */
  retryable: z.boolean().default(false),
  /**
   * When the worker's running turn started, or null. Null while it is not
   * running, and also for a turn that began before the plugin last restarted.
   */
  turnStartedAt: z.number().nullable().default(null),
});
export type Urgency = WorkerStatus["urgency"];
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

export const otherThreadSchema = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  projectId: z.string(),
  projectName: z.string(),
  status: z.string(),
  displayStatus: z.string(),
  pendingInteraction: z.boolean(),
  updatedAt: z.number(),
});
export type OtherThread = z.infer<typeof otherThreadSchema>;

export const activityKindSchema = z.enum([
  "chief-created",
  "delegate",
  "spawn",
  "report",
  "failed",
  "adopt",
  "retire",
  "forward",
  "import",
  "chief-failed",
  /** The chief dismissed (or un-dismissed) a worker's Need line as answered out of band. */
  "dismiss",
  /** A worker was moved to a new thread on another provider or model. */
  "remodel",
  /** A worker row was moved to another project; its thread follows on the next remodel. */
  "move",
  /** A worker turn ended on a model rate limit; the row is blocked until the excerpt's time. */
  "rate-limited",
  /** The plugin re-sent the message a rate limit had refused. */
  "retry",
  /** The chief interrupted a running turn with a correction. */
  "steer",
  /** The chief stopped a running turn and kept the worker. */
  "stop",
  /** The chief answered a permission prompt or question a worker was blocked on. */
  "answer",
  /** The plugin restarted the chief thread after its turn failed. */
  "chief-restart",
  /** The chief put an item on the decision board for the user. */
  "board-add",
  /** An item left the decision board: addressed, resolved, or dismissed. */
  "board-move",
  /** A plugin maintenance job, such as an overnight compaction. */
  "maintenance",
]);
export type ActivityKind = z.infer<typeof activityKindSchema>;

export const activityEventSchema = z.object({
  id: z.number(),
  at: z.number(),
  kind: activityKindSchema,
  workerName: z.string().nullable(),
  projectName: z.string().nullable(),
  threadId: z.string().nullable(),
  /** Short human line, e.g. "Delegated: fix the flaky test…" (<= 300 chars). */
  excerpt: z.string(),
});
export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const summarySchema = z.object({
  chiefThreadId: z.string().nullable(),
  /** chief thread displayStatus or null when no chief */
  chiefStatus: z.string().nullable(),
  busy: z.number(),
  needsYou: z.number(),
  /** Workers whose last Need line asks for something (not blocked, but waiting on a decision). */
  decisions: z.number(),
  idle: z.number(),
  failed: z.number(),
  lastActivityAt: z.number().nullable(),
  externalSessions: z.number(),
  externalUnimported: z.number(),
  /** Workers whose urgency is "urgent". Always <= needsYou + decisions. */
  urgent: z.number(),
  /** Needs addressed to the chief rather than to the user. Not a decision for the user. */
  routing: z.number().int().nonnegative().default(0),
  /** The newest chief-failed excerpt, or null. Only set while chiefStatus is "error". */
  chiefFailure: z.string().nullable().default(null),
  /**
   * Open items on the decision board, so the "For you" switch says when the
   * list about the user has anything on it.
   */
  board: z.number().int().nonnegative().default(0),
});
export type Summary = z.infer<typeof summarySchema>;

/** A Claude Code session running on the bb server machine outside bb (registry: ~/.claude/sessions). */
export const externalSessionSchema = z.object({
  sessionId: z.string(),
  /** Live pids for this session id (a resumed session can have more than one). */
  pids: z.array(z.number()),
  /** Claude's own session name, e.g. "quiet-river-77", or null. */
  name: z.string().nullable(),
  cwd: z.string(),
  /** "cli" = interactive terminal session; "sdk-cli" = driven by a harness such as bb. */
  entrypoint: z.string(),
  startedAt: z.number(),
  /** Transcript mtime, or null when no transcript file exists. */
  lastActivityAt: z.number().nullable(),
  /** Last custom or AI title found in the transcript, or null. */
  title: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  transcriptBytes: z.number(),
  /** tmux "session:window" when known. */
  tmux: z.string().nullable(),
  /** bb project whose source path contains cwd (longest match), or null. */
  matchedProjectId: z.string().nullable(),
  matchedProjectName: z.string().nullable(),
  /** Set when this session is already tracked as a worker (imported before). */
  importedWorkerName: z.string().nullable(),
});
export type ExternalSession = z.infer<typeof externalSessionSchema>;

export const reasoningLevelSchema = z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]);
export const permissionModeSchema = z.enum(["accept-edits", "auto", "full"]);
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;
export type PermissionMode = z.infer<typeof permissionModeSchema>;

const choiceSchema = z.object({
  value: z.string(),
  label: z.string(),
  short: z.string(),
  description: z.string().optional(),
});

/** A thread's execution options for its next turn and the choices it may switch to. */
export const threadExecutionSchema = z.object({
  threadId: z.string(),
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema,
  /** The provider's models for this thread's environment, current one first when uncatalogued. */
  models: z.array(choiceSchema),
  /** Levels the current model supports. */
  reasoningLevels: z.array(choiceSchema),
  /** Modes the provider supports, capped at the machine's ceiling. */
  permissionModes: z.array(choiceSchema),
  /** Set when the provider's catalog could not be loaded; the current values still print. */
  catalogError: z.string().nullable(),
});
export type ThreadExecution = z.infer<typeof threadExecutionSchema>;
export type ExecutionChoice = z.infer<typeof choiceSchema>;

/**
 * One model catalog, shared by every row on the same provider and environment.
 *
 * The raw catalog rather than ready-made choice lists, because `modelChoices`
 * and `reasoningChoices` are pure and already in the bundle, and because the
 * reasoning list depends on the row's own current level (it unshifts a level
 * the catalog does not list). Sending the catalog once and deriving per row is
 * both smaller on the wire and the same code the execution bar runs.
 */
export const executionCatalogSchema = z.object({
  key: z.string(),
  models: z.array(
    z.object({
      model: z.string(),
      displayName: z.string(),
      defaultReasoningEffort: reasoningLevelSchema,
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: reasoningLevelSchema })),
    }),
  ),
  providerReasoningLevels: z.array(z.object({ id: z.string(), label: z.string() })).nullable(),
  error: z.string().nullable(),
});
export type ExecutionCatalogDto = z.infer<typeof executionCatalogSchema>;

/**
 * One thread on the model and effort panel.
 *
 * `model` and `reasoningLevel` are read from the THREAD at request time, which
 * is the value the next turn actually uses.
 *
 * There is no roster copy of the model or level to compare against: the
 * thread is the only source.
 *
 * `readOk` false means the thread could not be read, which is not the same as
 * a thread with nothing set. See `cellFor` in components/cos/execution-rows.ts.
 */
export const executionRowSchema = z.object({
  threadId: z.string(),
  workerId: z.string().nullable(),
  name: z.string(),
  project: z.string().nullable(),
  kind: z.enum(["chief", "worker"]),
  /** Where this row sits in the tier, so the panel can group by it. */
  role: z.enum(["worker", "manager"]).nullable().default(null),
  /** The manager this worker reports to, by display name; null means the chief. */
  managerName: z.string().nullable().default(null),
  /**
   * Context use, read from the thread's newest
   * `thread/contextWindowUsage/updated` event AT RENDER TIME.
   *
   * Never stored on the worker row. A cached copy of a value this plugin cannot
   * observe changing is a second source of truth, and it drifts from the
   * thread without anything noticing.
   *
   * Both null means no usage event yet, which the panel renders as unknown
   * rather than as 0%.
   */
  contextUsedTokens: z.number().nullable().default(null),
  contextWindow: z.number().nullable().default(null),
  readOk: z.boolean(),
  /**
   * The thread's provider, because the EFFORT cannot be rendered without it.
   *
   * `effortDisplay` decides on the provider whether bb's stored level is
   * honoured at all, and its `opaque` answer must
   * never be printed as a level. Every surface, the Execution panel included,
   * must route through `effortDisplay` so an opaque provider (acp-cursor, for
   * example) shows "(effort not visible to bb)" rather than a raw stored level.
   *
   * The provider is also inside `catalogKey`, which is
   * `providerId|environmentId`. Do not split that: it is a map key, it is null
   * on the unread branch, and a surface that parsed it would print a raw
   * level for an opaque provider whenever the read failed.
   */
  providerId: z.string().nullable().default(null),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  /**
   * The permission bb resolves for this thread's next turn
   * (`threads.defaultExecutionOptions`), and the mode a plugin dispatch
   * requests (plugin kv). Null when unread or unset. Read at render time,
   * like the model, and never stored. `permissionCell` renders them.
   */
  permissionMode: z.string().nullable().default(null),
  pluginPermissionMode: z.string().nullable().default(null),
  catalogKey: z.string().nullable(),
  /**
   * Where the resolved value came from: a thread start, a requested turn, or a
   * turn's own start. bb reports it; the panel shows it, because "stored on the
   * thread" is true of the effort level and NOT of the model.
   */
  source: z.string().nullable(),
});
export type ExecutionRowDto = z.infer<typeof executionRowSchema>;

export const executionListSchema = z.object({
  rows: z.array(executionRowSchema),
  catalogs: z.array(executionCatalogSchema),
});
export type ExecutionListDto = z.infer<typeof executionListSchema>;

export const rpcContract = defineRpcContract({
  /** External Claude Code sessions on the bb server machine (not bb threads). */
  sessions_list: {
    input: noInput,
    output: z.object({ sessions: z.array(externalSessionSchema), note: z.string() }),
  },
  /** Compact text digest of a session transcript: title, first prompt, compaction summaries, recent exchanges. */
  session_digest: {
    input: z.object({ sessionId: z.string(), maxChars: z.number().int().positive().max(200_000).optional() }),
    output: z.object({ digest: z.string(), title: z.string().nullable(), messageCount: z.number(), truncated: z.boolean() }),
  },
  /**
   * Import one or more external sessions into a bb worker: spawns (or reuses) the worker in the matched or
   * given project, seeded with the digests and an instruction to write a very detailed handover summary.
   */
  session_import: {
    input: z.object({
      sessionIds: z.array(z.string()).min(1),
      worker: z.string().min(1),
      project: z.string().optional(),
      description: z.string().optional(),
      /** When no bb project contains the session cwd, create one from that cwd instead of using the personal project. */
      createProject: z.boolean().optional(),
    }),
    output: z.object({ ok: z.boolean(), text: z.string(), threadId: z.string().nullable(), projectId: z.string().nullable() }),
  },
  chief_get: {
    input: noInput,
    output: z.object({ threadId: z.string().nullable() }),
  },
  chief_ensure: {
    input: noInput,
    output: z.object({ threadId: z.string(), created: z.boolean() }),
  },
  /**
   * Recover a failed chief: stop its thread, deliver anything parked in the
   * outbox, and nudge it back to work when there was nothing parked.
   */
  chief_restart: {
    input: noInput,
    output: z.object({ ok: z.boolean(), text: z.string() }),
  },
  projects_list: {
    input: noInput,
    output: z.object({ projects: z.array(projectRefSchema) }),
  },
  roster_list: {
    input: z.object({ includeOthers: z.boolean().optional() }).nullable(),
    output: z.object({
      chiefThreadId: z.string().nullable(),
      workers: z.array(workerStatusSchema),
      others: z.array(otherThreadSchema),
    }),
  },
  summary: {
    input: noInput,
    output: summarySchema,
  },
  activity_list: {
    input: z.object({ limit: z.number().int().positive().max(500).optional() }).nullable(),
    output: z.object({ events: z.array(activityEventSchema) }),
  },
  /**
   * Every event in a time window, for the day view. A window rather than a
   * count, because a busy day can hold more events than `activity_list`'s cap,
   * and a cut-off morning would be drawn as a quiet one. `truncated` is true
   * when the guard cap bit, and the view says so rather than drawing a
   * partial day as a whole one.
   */
  activity_day: {
    input: z.object({ from: z.number(), to: z.number() }),
    output: z.object({ events: z.array(activityEventSchema), truncated: z.boolean() }),
  },
  /**
   * Same code path as the cos_delegate tool. Never waits. Without `spawn` an
   * unknown worker name is refused rather than created, so a typo cannot start
   * a thread; the board sets it when the typed name is new on purpose.
   */
  delegate: {
    input: z.object({
      project: z.string().min(1),
      worker: z.string().min(1),
      message: z.string().min(1),
      description: z.string().optional(),
      spawn: z.boolean().optional(),
    }),
    output: z.object({ text: z.string(), threadId: z.string().nullable(), reused: z.boolean() }),
  },
  adopt: {
    input: z.object({ threadId: z.string(), name: z.string().min(1), description: z.string().optional() }),
    output: z.object({ text: z.string(), ok: z.boolean() }),
  },
  /**
   * ok is false when the worker was retired but its thread could not be stopped
   * or archived; text says which and what to do by hand. A bare `ok: true`
   * would hide that outcome, and the board's toast would claim a clean retirement.
   */
  worker_retire: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean(), text: z.string() }),
  },
  /**
   * Stop the worker's running turn and keep the worker, its thread and its
   * context, so ending runaway work does not need a retire.
   */
  worker_stop: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean(), text: z.string() }),
  },
  /** Re-send the last brief the chief gave this worker, optionally on another model for one turn. */
  worker_retry: {
    input: z.object({ id: z.string(), model: z.string().optional() }),
    output: z.object({ ok: z.boolean(), text: z.string() }),
  },
  /**
   * Dismiss the worker's current Need line as answered out of band, or undo
   * that. ok is false only when the worker does not resolve; a worker with no
   * open need is a no-op whose text says so.
   */
  worker_dismiss_need: {
    input: z.object({ id: z.string(), note: z.string().optional(), undo: z.boolean().optional() }),
    output: z.object({ ok: z.boolean(), text: z.string() }),
  },
  /** Worker registration for a thread id, or null when the thread is not a managed worker. */
  worker_for_thread: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ worker: workerStatusSchema.nullable(), isChief: z.boolean() }),
  },
  /** Forward text to the chief as context: the Mission board's Ask chief. */
  send_to_chief: {
    input: z.object({
      text: z.string().min(1),
      sourceThreadId: z.string(),
      note: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), text: z.string() }),
  },
  /**
   * Every thread the panel lists, with the value each one actually holds.
   *
   * One call for the whole list on purpose. `thread_execution_get` is per
   * thread, and a dozen rows each running their own `useLive` would mount a
   * dozen 20-second polls and reload the provider catalog a dozen times on
   * every realtime signal.
   */
  execution_list: {
    input: z.object({}).optional(),
    output: executionListSchema,
  },

  /**
   * What a thread runs with and what it could run with: the resolved model,
   * reasoning level and permission mode for its next turn, plus the provider's
   * catalog for the picker. Null when the thread is gone.
   */
  thread_execution_get: {
    input: z.object({ threadId: z.string() }),
    output: threadExecutionSchema.nullable(),
  },
  /**
   * Change one field. Model and reasoning level are the thread's sticky
   * overrides (bb PATCH /threads/:id, the same call the host's picker makes).
   * Permission mode is per turn in bb, so it is stored by the plugin and sent
   * with every turn the plugin dispatches to that thread. Returns the new state.
   */
  thread_execution_set: {
    input: z.object({
      threadId: z.string(),
      model: z.string().optional(),
      reasoningLevel: reasoningLevelSchema.optional(),
      permissionMode: permissionModeSchema.optional(),
    }),
    output: threadExecutionSchema,
  },
  /**
   * The decision board: what the chief has put in front of the user. Curated by
   * the chief alone; nothing lands here from a worker Need line, which is what
   * the Mission board already shows.
   */
  board_list: {
    input: z.object({ states: z.array(boardStateSchema).optional(), area: boardAreaSchema.optional() }).nullable(),
    output: z.object({ items: z.array(boardItemSchema) }),
  },
  board_add: {
    input: z.object({
      headline: z.string().min(1),
      context: z.string().default(""),
      area: boardAreaSchema,
      links: z.array(boardLinkSchema).optional(),
      /**
       * Where the item came from: a worker name (resolved to its thread so the
       * row can link to it), free words, or the literal "none". Required, so a
       * source is a decision rather than an omission.
       */
      from: z.string().min(1),
      priority: boardPrioritySchema,
      choices: z.array(boardChoiceSchema).max(4).optional(),
      /**
       * The day (YYYY-MM-DD, home zone) of the event the item is about. It
       * closes itself at the start of the next day. Never a deadline.
       */
      expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    output: z.object({ item: boardItemSchema }),
  },
  /**
   * Change how urgent an item is, its choices, or the day it closes itself
   * after. Only these: the headline and the context are the chief's account of
   * the thing, and rewriting those would change what the user already read.
   */
  board_update: {
    input: z.object({
      id: z.string().min(1),
      priority: boardPrioritySchema.optional(),
      choices: z.array(boardChoiceSchema).max(4).optional(),
      /** The event's day (YYYY-MM-DD), or "none" to take the expiry off. */
      expires: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("none")]).optional(),
      /** "panel" when the call came from the board in front of the user. */
      by: z.literal("panel").optional(),
    }),
    output: z.object({ ok: z.boolean(), text: z.string(), item: boardItemSchema.nullable() }),
  },
  /**
   * Close board items for another plugin (for example an issue tracker's row
   * actions). Exactly one of:
   * - `id`: that item.
   * - `needId`: the item carrying that worker question, and the question is
   *   dismissed, so a reworded repeat does not raise it again.
   * - `match`: what another plugin's row knows. Its refs are marked
   *   done, and every open or addressed item whose headline names one of them,
   *   and all of whose numbers (headline and context) are now done, closes,
   *   stamped automatic so it shows in the For you note with a Put back. Open
   *   questions of the row's worker and its manager close by the same rule.
   *   Words never match.
   *
   *   POST /api/v1/plugins/chief-of-staff/rpc/board_close
   *   {"match": {"refs": ["ISSUE-20417", "PR55021"], "threadId": "thr_example"},
   *    "by": "example-tracker", "state": "resolved", "note": "closed in the tracker"}
   *
   * `ok` is false for an unknown id, a match with no usable ref, or a malformed
   * call; `closed` names what moved, `skipped` what a match touched and left
   * open, and why. An item already closed moves nothing and is not an error.
   */
  board_close: {
    input: z.object({
      /** A board item id, as `board_list` returns it. */
      id: z.string().min(1).optional(),
      /** A Need id ("n" and six hex digits), as `board_list` (needIds) and `roster_list` (needIds) return it. */
      needId: z.string().min(1).optional(),
      match: z
        .object({
          /**
           * The row's refs (two or more capital letters, an optional
           * hyphen and five or more digits: ISSUE-20417). Anything
           * else is ignored and named in `text`.
           */
          refs: z.array(z.string().min(1).max(40)).min(1).max(20),
          /** The row's worker thread, whose open questions, and its manager's, close by the same rule. */
          threadId: z.string().min(1).optional(),
        })
        .optional(),
      /** "resolved" when the thing was done (the default), "dismissed" when it stopped mattering. */
      state: z.enum(["resolved", "dismissed"]).optional(),
      /** Why, in a few words. Kept with the item and in the activity log. */
      note: z.string().max(300).optional(),
      /** The calling plugin's id (for example "example-tracker"), named in the item's history as "the example-tracker plugin". */
      by: z.string().min(1).max(40),
    }),
    output: z.object({
      ok: z.boolean(),
      closed: z.array(z.object({ id: z.string(), headline: z.string() })),
      /** Items a match touched and left open: a number still not done, or named only in the context. */
      skipped: z.array(z.object({ id: z.string(), headline: z.string(), why: z.string() })).default([]),
      /** Worker questions dismissed by this call. */
      needIds: z.array(z.string()).default([]),
      text: z.string(),
    }),
  },
  /** Resolve, dismiss, or put an item back on the board. */
  board_set_state: {
    input: z.object({
      ids: z.array(z.string()).min(1),
      state: boardStateSchema,
      note: z.string().optional(),
      /** "panel" when the call came from the board in front of the user. Anything else is a shell. */
      by: z.literal("panel").optional(),
    }),
    output: z.object({ ok: z.boolean(), changed: z.number(), text: z.string() }),
  },
  /**
   * Compose the numbered draft for these items and park it for the chief
   * thread's composer. Nothing is sent, and no item changes state: they are
   * only stamped as drafted. `threadId` is null when there is no chief thread,
   * and then `body` is still returned so the caller can show it.
   */
  board_address: {
    input: z.object({
      ids: z.array(z.string()).min(1),
      by: z.literal("panel").optional(),
      /** The choice tapped, per item. Written into the block as the user's decision. */
      picks: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
      /** What the user typed on the item itself, per item. Written as the user's answer. */
      answers: z.array(z.object({ id: z.string(), text: z.string().max(4000) })).optional(),
    }),
    output: z.object({ ok: z.boolean(), threadId: z.string().nullable(), body: z.string(), text: z.string() }),
  },
  /**
   * Draft one of a worker's own offered answers into that worker's composer.
   * Never sends. The label must be one the worker actually offered in its
   * current Need line; anything else is refused, so nothing that can call the
   * RPC can put words in the user's mouth.
   */
  need_answer_draft: {
    input: z.object({ workerId: z.string(), label: z.string() }),
    output: z.object({ ok: z.boolean(), threadId: z.string().nullable(), text: z.string() }),
  },
  board_draft_take: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      /**
       * The parked text. NOT consumed by this call: it stays parked until the
       * composer confirms the words are actually in its draft and acks.
       *
       * Handing the text over and marking it consumed in one step would lose
       * it whenever the mount that took it is not the one on screen or is torn
       * down by the navigation that follows.
       */
      draft: z.object({ body: z.string(), itemIds: z.array(z.string()) }).nullable(),
      /** Ids of the drafts handed over, to pass back to `board_draft_ack`. */
      draftIds: z.array(z.number()),
      /**
       * The same drafts one by one, so the composer can tell which are already
       * in its text. Checking the joined body would append a draft a second
       * time whenever it was there and a newer one was not.
       */
      parts: z.array(z.object({ id: z.number(), body: z.string() })),
      /**
       * Items sitting in a composer draft and not yet addressed. The banner's
       * line reads this rather than what it happened to take, so navigating
       * away and back does not lose the line that says nothing was sent.
       */
      drafted: z.number(),
    }),
  },
  /**
   * Items that closed on their own (a passed day, a dismissed Need) since the user last reviewed them.
   *
   * The whole safety of auto-dismissal rests on this being surfaced. A
   * dismissed item is not destroyed - it stays in the database and comes back
   * with `--all` - so the only real risk is that the user never learns it happened.
   */
  board_auto_dismissed: {
    input: noInput,
    output: z.object({ items: z.array(boardItemSchema), since: z.number() }),
  },
  /** Mark the automatic closures as seen, so the review line goes away. */
  board_auto_reviewed: {
    input: noInput,
    output: z.object({ ok: z.boolean() }),
  },
  /**
   * Confirm a parked draft really reached a composer, so it can be retired.
   *
   * Split from `board_draft_take` because a handover is not a delivery. A draft
   * nobody acks stays parked and is offered again on the next mount or signal,
   * which makes a lost insert self-healing rather than silent.
   */
  board_draft_ack: {
    input: z.object({ ids: z.array(z.number()) }),
    output: z.object({ drafted: z.number() }),
  },
  /**
   * Board text parked for this thread in the last 30 days, delivered or not,
   * with the state of each item it carried. The composer banner matches these
   * against its own text, so it can count the blocks actually there and flag a
   * block about an item that has since been closed. Read-only.
   */
  board_drafts_recent: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      drafts: z.array(
        z.object({ id: z.number(), body: z.string(), createdAt: z.number(), itemStates: z.array(z.string()) }),
      ),
    }),
  },
  /**
   * The user has seen these workers' current Need lines. Called by the Board
   * when a decision row is opened or acted on, so "new" means new to the user.
   */
  need_mark_seen: {
    input: z.object({
      /**
       * The need the panel actually rendered, per worker. The id alone is not
       * enough: the roster polls every 20 seconds, so between the render and
       * the click the worker can have finished a turn and asked something
       * different, and marking that as seen buries a question never read.
       */
      workers: z.array(z.object({ id: z.string(), need: z.string() })).min(1),
    }),
    output: z.object({ marked: z.number() }),
  },
  /**
   * Sidebar row glyphs: which threads get a status mark and what it looks like.
   * The frontend content script draws these through
   * `experimental_setThreadRowStatus`; all the deciding happens on the server,
   * so the script stays a painter. Empty when the `threadMarks` setting is off.
   */
  /**
   * The user opened this thread: mark it read in bb so the "finished, not read" dot
   * clears. bb only writes its own read time when the user types in a thread or picks
   * "Mark as read", so opening a nested worker would otherwise leave the dot up for good.
   */
  /**
   * Where bb's file panel should look for a local file a chat links to, the way
   * bb's own thread view resolves it: under the thread's storage, then under its
   * workspace, else the file on bb's machine. The first two matter for a PDF:
   * bb's PDF viewer cannot read a bare host file from a plugin surface, but it
   * can read thread storage and a workspace. `threadId` is the chat the link is
   * in; omitted, the chief's. Null when there is no machine to point at.
   */
  file_target: {
    input: z.object({ threadId: z.string().min(1).nullable(), path: z.string().min(2) }),
    output: z.object({
      target: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("thread-storage"), threadId: z.string(), path: z.string() }),
          z.object({ kind: z.literal("workspace"), environmentId: z.string(), path: z.string() }),
          z.object({ kind: z.literal("host"), hostId: z.string(), path: z.string() }),
        ])
        .nullable(),
    }),
  },
  thread_seen: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ ok: z.boolean() }),
  },
  thread_marks: {
    input: noInput,
    output: z.object({
      marks: z.array(
        z.object({
          threadId: z.string(),
          /** Status, not identity: what the row needs, not what the thread is. */
          kind: z.enum(["failed", "waiting", "limited", "finished"]),
          icon: z.string(),
          label: z.string(),
          // The wire keeps bb's four tones; the plugin only ever emits two.
          tone: z.enum(["default", "error", "running", "success"]).optional(),
        }),
      ),
      /**
       * What to draw at the start of each worker's row, over bb's "in another
       * project" folder: its avatar, or Bloom while it works. Empty when the
       * setting is off.
       */
      faces: z
        .array(
          z.object({
            threadId: z.string(),
            avatar: z.object({ shape: z.string(), color: z.string() }).nullable(),
            working: z.boolean(),
          }),
        )
        .default([]),
    }),
  },
});
