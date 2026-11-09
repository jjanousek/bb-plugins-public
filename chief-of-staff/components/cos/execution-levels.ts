// The level rules: which reasoning level a worker runs at, and what happens to
// it when the worker moves between model families.
//
// No imports, for the same reason `execution-options.ts` has none: `core.ts`
// re-exports all of this, so the server and the app share one copy, and
// `core.test.ts` can exercise it under `node --test`, which cannot load a
// `.tsx` file at all.
//
// It lives here rather than in `core.ts` because the model and effort panel has
// to show the level a batch move will land on BEFORE it is confirmed. A second
// copy of the table in the frontend would be free to drift from the one
// `cos_remodel` actually applies, and a preview that disagrees with the action
// is worse than no preview. One table, both callers.

/**
 * The levels this plugin will set, in bb's own order.
 *
 * `ultracode` is included so that the tool schemas are no narrower than bb
 * and this repo's own `reasoningLevelSchema`; without it the chief could not
 * set that level without dropping to `bb thread update`.
 *
 * Two of bb's levels are deliberately not here. `none` would let a judgement
 * worker be set to no reasoning at all, which is strictly worse than `low` and
 * is the one value that could quietly ruin a worker. `ultra` is not offered:
 * its semantics are undocumented, so offering it to the chief would be
 * offering a level nobody could pick informedly. Add either the day there is
 * a reason.
 */
export const WORKER_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "ultracode", "max"] as const;

export type WorkerReasoningLevel = (typeof WORKER_REASONING_LEVELS)[number];

function isWorkerReasoningLevel(value: string): value is WorkerReasoningLevel {
  return (WORKER_REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * A reasoning level a caller asked for. Blank and absent both mean "not asked
 * for" (level null), so a caller can pass a flag through without checking it;
 * anything else must be one of `WORKER_REASONING_LEVELS`.
 *
 * Examples:
 *   parseReasoningLevel("xhigh")  -> { ok: true, level: "xhigh" }
 *   parseReasoningLevel(" HIGH ") -> { ok: true, level: "high" }
 *   parseReasoningLevel(undefined)-> { ok: true, level: null }
 *   parseReasoningLevel("ultra")  -> { ok: false, error: 'Unknown reasoning level "ultra". ...' }
 */
export function parseReasoningLevel(
  value: string | null | undefined,
): { ok: true; level: WorkerReasoningLevel | null } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, level: null };
  const wanted = value.trim().toLowerCase();
  if (wanted === "") return { ok: true, level: null };
  if (!isWorkerReasoningLevel(wanted)) {
    return {
      ok: false,
      error: `Unknown reasoning level "${value.trim()}". Use one of: ${WORKER_REASONING_LEVELS.join(", ")}.`,
    };
  }
  return { ok: true, level: wanted };
}

/**
 * The level a spawn runs at: what the caller asked for, else the plugin
 * setting, else the built-in default. A setting that is blank or no longer a
 * valid level falls through to the default rather than failing the spawn: the
 * dispatch is not the place to discover a bad setting.
 */
/**
 * The level a Fable worker spawns at when nobody named one.
 *
 * Fable runs well at low and medium. Medium is the standard; `low` is a
 * choice the chief makes for routine legwork, not something to guess at spawn.
 */
export const FABLE_SPAWN_LEVEL: WorkerReasoningLevel = "medium";

/**
 * Whether a model id names a Fable model.
 *
 * Matched on the id rather than a list, because the ids carry the family
 * (`claude-fable-5`, `claude-fable-5-1`, and whatever comes next) and a list
 * would be one more thing to update when a model ships. A pinned provider with
 * no pinned model resolves to that provider's own default, which the plugin
 * cannot see, so the rule does not fire there and the setting applies.
 */
export function isFableModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model.toLowerCase().includes("fable");
}

export function reasoningForSpawn(
  requested: WorkerReasoningLevel | null,
  setting: string | null | undefined,
  fallback: WorkerReasoningLevel,
  model?: string | null,
): WorkerReasoningLevel {
  if (requested !== null) return requested;
  // The model rule beats the setting on purpose: the setting is one number for
  // every provider, and Fable at the setting's `high` is the over-pinning this
  // rule exists to stop. An explicit level still wins over both.
  if (isFableModel(model)) return FABLE_SPAWN_LEVEL;
  const fromSetting = parseReasoningLevel(setting);
  if (fromSetting.ok && fromSetting.level !== null) return fromSetting.level;
  return fallback;
}

/**
 * How a level translates when a worker moves between model families.
 *
 * The right effort depends on the model, and a worker can move to another
 * family at any time. The level is a property of the model, not of the
 * worker, so
 * carrying it across a family boundary is wrong in both directions: Fable
 * medium on Opus is under-powered, and Opus xhigh on Fable is a level that
 * family does not want.
 *
 * Keyed by the family being moved TO, and read with the level the worker had on
 * the family it is leaving. A level with no entry is not an error: it falls
 * through to that family's own default, which is what `reasoningForSpawn`
 * already computes. Arriving on Fable, that default is medium, so the entries
 * here and the fallback agree; they are written out anyway because the mapping
 * is the thing being specified and a table nobody can read is not one.
 */
const LEVEL_MOVING_TO: Record<ModelFamily, Readonly<Record<string, WorkerReasoningLevel>>> = {
  other: { low: "high", medium: "high" },
  fable: { high: "medium", xhigh: "medium", ultracode: "medium" },
};

/** The two families the level rules distinguish. Everything that is not Fable is one bucket. */
export type ModelFamily = "fable" | "other";

export function modelFamily(model: string | null | undefined): ModelFamily {
  return isFableModel(model) ? "fable" : "other";
}

/**
 * The level to run at, given where the worker is going.
 *
 * Used by both paths that move a worker onto another model: `cos_remodel`,
 * which moves it for good, and `cos_retry --model`, which moves it for one
 * turn. Both must carry the level across: a path that passes no level runs a
 * Fable-medium worker retried on Opus at medium there.
 *
 * Order: an explicit level always wins; then, if the family changed, the level
 * is mapped; if it did not change, the worker keeps its own; and a worker with
 * no recorded level takes the target family's default. A target model the
 * plugin cannot see (a pinned provider with no pinned model) counts as no
 * change, so nothing is remapped on a guess.
 */
export function levelForModelChange(opts: {
  requested: WorkerReasoningLevel | null;
  /** The level the worker is on now. */
  current: string | null | undefined;
  /** The model it is on now, and the one it is moving to. */
  fromModel: string | null | undefined;
  toModel: string | null | undefined;
  setting: string | null | undefined;
  fallback: WorkerReasoningLevel;
}): WorkerReasoningLevel {
  if (opts.requested !== null) return opts.requested;
  const own = parseReasoningLevel(opts.current);
  const ownLevel = own.ok ? own.level : null;
  const familyDefault = () => reasoningForSpawn(null, opts.setting, opts.fallback, opts.toModel);

  const moving =
    typeof opts.toModel === "string" &&
    opts.toModel !== "" &&
    typeof opts.fromModel === "string" &&
    opts.fromModel !== "" &&
    modelFamily(opts.fromModel) !== modelFamily(opts.toModel);

  if (!moving) return ownLevel ?? familyDefault();
  // `current` is read raw rather than through `parseReasoningLevel`, because
  // the level being mapped may be one bb has and this plugin does not offer on
  // a spawn.
  const key = (opts.current ?? "").trim().toLowerCase();
  return LEVEL_MOVING_TO[modelFamily(opts.toModel)][key] ?? familyDefault();
}

/**
 * Providers whose effective effort this plugin cannot set or read back.
 *
 * `acp-cursor` is the case this covers. bb has a mechanism for passing a
 * level to an ACP provider (`acpReasoningCliSchema`, a launch flag), it is
 * optional, and acp-cursor does not configure it: bb launches cursor-agent in
 * ACP mode with no model flag and no reasoning flag. The effort actually in
 * force comes from Cursor's own CLI config (`modelParameters`), which Cursor
 * itself writes back.
 *
 * So for a Cursor worker the level bb stores is display without effect, and
 * printing it is the same defect as answering "nothing there" for a read that
 * never completed. `cellFor` already refuses that for an unreadable thread;
 * this refuses it for an unhonoured level.
 */
export const EFFORT_OPAQUE_PROVIDERS: readonly string[] = ["acp-cursor"];

/**
 * The effort suffix carried by cursor-agent's own model ids (for example
 * `example-model-xhigh` or `example-model-high-fast`): one of four levels,
 * with `-fast` as an optional trailing variant.
 *
 * This is the one place effort is legible to us for such a provider, because it
 * travels INSIDE the model id rather than beside it.
 */
const MODEL_EFFORT_SUFFIX = /-(low|medium|high|xhigh)(-fast)?$/;

export type EffortDisplay =
  /** bb's stored level is honoured by this provider: print it. */
  | { kind: "level"; level: string; fast: false }
  /** The provider ignores bb's level, but the model id names the effort. */
  | { kind: "model"; level: string; fast: boolean }
  /** The provider ignores bb's level and the model id does not name one. */
  | { kind: "opaque"; level: null; fast: false }
  /** Nothing to show, and nothing hidden. */
  | { kind: "none"; level: null; fast: false };

/**
 * What the effort really is for one worker, and where that answer came from.
 *
 * The `kind` is the point. A caller must be able to tell "bb sets this" from
 * "the model id says so" from "bb cannot know", because the third one must
 * never be rendered as a level.
 */
export function effortDisplay(
  providerId: string | null,
  model: string | null,
  reasoningLevel: string | null,
): EffortDisplay {
  if (providerId === null || !EFFORT_OPAQUE_PROVIDERS.includes(providerId)) {
    // Every other provider, claude-code included, is untouched by this.
    return reasoningLevel
      ? { kind: "level", level: reasoningLevel, fast: false }
      : { kind: "none", level: null, fast: false };
  }
  const match = model === null ? null : MODEL_EFFORT_SUFFIX.exec(model);
  if (match !== null) return { kind: "model", level: match[1], fast: match[2] !== undefined };
  return { kind: "opaque", level: null, fast: false };
}

/**
 * The trailing part of an execution label, including its leading space, or the
 * empty string.
 *
 * `opaque` says so in words rather than printing a plausible level. It is
 * longer than a level and that is deliberate: a roster row must not look
 * authoritative when it is not.
 *
 * It reads "not visible to bb" rather than "set in Cursor". Naming a location
 * would be a POSITIVE claim, and all bb shows is that it passes no model and
 * no reasoning flag on argv; what travels over the ACP socket is not visible
 * here. So the words state only what is known, and the burden sits on the
 * claim rather than on disproving it.
 */
export function effortLabelSuffix(display: EffortDisplay): string {
  switch (display.kind) {
    case "level":
      return ` ${display.level}`;
    case "model":
      return ` ${display.level}${display.fast ? " fast" : ""}`;
    case "opaque":
      return " (effort not visible to bb)";
    case "none":
      return "";
  }
}

/**
 * The "provider model effort" words, or null when there is nothing to say.
 *
 * One body for both callers, `executionLabel` in server.ts for the CLI roster
 * and `executionLabel` in components/cos/naming.ts for the board, so the two
 * cannot drift. What to return when there is nothing to print is the
 * caller's: "" for the server's string, undefined for the board's optional.
 *
 * Two rules live in here and both are the same defect family. A null model
 * prints "?" rather than vanishing, because model and level are read from the
 * thread and null means the read did not land, so dropping it would report
 * "could not look" as "nothing set". And the effort goes through
 * `effortDisplay` rather than being printed from the stored level, because for
 * a provider that ignores that level printing it states as fact something the
 * runtime never sees.
 */
export function executionWords(
  providerId: string | null,
  model: string | null,
  reasoningLevel: string | null,
): string | null {
  if (!providerId && !model) return null;
  const shortModel = model ? model.replace(/^opencode\//, "") : null;
  return `${providerId ?? "?"} ${shortModel ?? "?"}${effortLabelSuffix(effortDisplay(providerId, shortModel, reasoningLevel))}`;
}
