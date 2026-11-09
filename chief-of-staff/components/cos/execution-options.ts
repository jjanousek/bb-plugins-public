// Pure mapping from what bb reports about a thread (its resolved execution
// options and its provider's catalog) to the choices a picker offers. No
// imports, so core.test.ts exercises it under node and server.ts and the app
// share one copy. The wording is the host's: model display names from the
// catalog, reasoning labels the provider declares (else the host's fallback
// table), permission labels from bb's own picker.

export type ReasoningLevel = "none" | "low" | "medium" | "high" | "xhigh" | "ultracode" | "max" | "ultra";
export type PermissionMode = "accept-edits" | "auto" | "full";

/** One model row of `system.executionOptions`; only the fields the picker reads. */
export interface CatalogModel {
  model: string;
  displayName: string;
  defaultReasoningEffort: ReasoningLevel;
  supportedReasoningEfforts: readonly { reasoningEffort: ReasoningLevel }[];
}

/** The provider row of `system.executionOptions` for the thread's provider. */
export interface CatalogProvider {
  reasoningLevels?: readonly { id: string; label: string }[];
  capabilities: { permissionModes: readonly PermissionMode[] };
}

export interface Choice<T extends string> {
  value: T;
  /** The full name: "Fable 5.1", "Extra High", "Approve for me". */
  label: string;
  /** What the bar prints: "Fable 5.1", "High", "Full". Same as label unless the host shortens it. */
  short: string;
  /** A second line under the label in the sheet; permission modes only. */
  description?: string;
}

/** The host's fallback wording when the provider declares no labels (apps/app/src/lib/reasoning-labels.ts). */
const REASONING_LABELS: Record<ReasoningLevel, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultracode: "Ultracode",
  max: "Max",
  ultra: "Ultra",
};

/** bb's own permission picker copy (packages/client-core prompt/permission-mode-options.ts), compact labels from PermissionModePicker.tsx. */
export const PERMISSION_CHOICES: readonly Choice<PermissionMode>[] = [
  {
    value: "accept-edits",
    label: "Accept Edits",
    short: "Edits",
    description: "Applies edits inside the workspace automatically. Anything beyond the workspace asks you first.",
  },
  {
    value: "auto",
    label: "Approve for me",
    short: "Auto",
    description:
      "Same workspace sandbox, with requests reviewed automatically. High-risk actions can still come back to you.",
  },
  {
    value: "full",
    label: "Full Access",
    short: "Full",
    description: "No sandbox and no approvals. The agent can run anything on your machine.",
  },
];

/** bb's order of permission modes, least to most; the ceiling is compared by index. */
const PERMISSION_RANK: readonly PermissionMode[] = ["accept-edits", "auto", "full"];

const ALL_REASONING: readonly ReasoningLevel[] = ["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"];

/** The catalog's display name for a model id, or the id without its vendor prefix when the catalog does not list it. */
export function modelLabel(model: string, catalog: readonly CatalogModel[]): string {
  const row = catalog.find((m) => m.model === model);
  if (row) return row.displayName;
  // The catalog's own naming for an id it no longer lists, so the bar and the
  // Execution tab name a worker still pinned to it the same way. `[1m]` is
  // kept as the catalog writes it, "(1M)". Ids that do not fit the shape come
  // back bare.
  const window = /\[1m\]$/i.test(model) ? " (1M)" : "";
  return `${familyName(model)}${window}`;
}

/** Every model the provider offers, in catalog order. The current model is listed even when the catalog dropped it, so the bar never shows a value the sheet cannot. */
/**
 * A display name for a model id the catalog does not list.
 *
 * A thread can run a model no catalog offers. `modelLabel` would then fall
 * through to the raw id and print it beside the catalog's display names,
 * which is accurate but reads as a bug.
 *
 * The rule is the catalog's own convention rather than an invention:
 * `claude-sonnet-5` is displayed "Sonnet 5" and `claude-fable-5-1` is displayed
 * "Fable 5.1", so `claude-opus-5` is "Opus 5". It only ever applies to an id the
 * catalog does not have, and it refuses anything that does not fit the shape -
 * a trailing word like `vendor/example-5-free`, or more than two version parts -
 * by handing the bare id back rather than guessing a name for it. The raw id
 * stays one hover or tap away wherever this is shown.
 */
export function familyName(model: string): string {
  const bare = model.slice(model.lastIndexOf("/") + 1).replace(/\[.*$/, "");
  const parts = bare.split("-").filter((part) => part !== "" && part !== "claude");
  const [family, ...rest] = parts;
  if (family === undefined) return bare;
  if (rest.length > 2 || !rest.every((part) => /^\d+$/.test(part))) return bare;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return rest.length === 0 ? name : `${name} ${rest.join(".")}`;
}

/** The catalog's name for a model, else a name in the catalog's own style. */
export function modelDisplay(model: string, catalog: readonly CatalogModel[]): string {
  const hit = catalog.find((m) => m.model === model);
  return hit ? hit.displayName : familyName(model);
}

export function modelChoices(current: string, catalog: readonly CatalogModel[]): Choice<string>[] {
  const choices = catalog.map((m) => ({ value: m.model, label: m.displayName, short: m.displayName }));
  if (!choices.some((c) => c.value === current)) {
    const label = modelLabel(current, catalog);
    choices.unshift({ value: current, label, short: label });
  }
  return choices;
}

/** A provider's declared label for a level, else the host's fallback. */
export function reasoningLabel(level: ReasoningLevel, provider: CatalogProvider | null): string {
  return provider?.reasoningLevels?.find((l) => l.id === level)?.label ?? REASONING_LABELS[level] ?? level;
}

/**
 * The levels the current model supports, in the model's own order; a model the
 * catalog does not list falls back to the provider's declared levels, then to
 * every level bb knows. The current level is always offered.
 */
export function reasoningChoices(
  current: ReasoningLevel,
  model: string,
  catalog: readonly CatalogModel[],
  provider: CatalogProvider | null,
): Choice<ReasoningLevel>[] {
  const row = catalog.find((m) => m.model === model);
  let levels: ReasoningLevel[];
  if (row && row.supportedReasoningEfforts.length > 0) {
    levels = row.supportedReasoningEfforts.map((e) => e.reasoningEffort);
  } else if (provider?.reasoningLevels && provider.reasoningLevels.length > 0) {
    levels = provider.reasoningLevels
      .map((l) => l.id)
      .filter((id): id is ReasoningLevel => (ALL_REASONING as readonly string[]).includes(id));
  } else {
    levels = [...ALL_REASONING];
  }
  if (!levels.includes(current)) levels.unshift(current);
  return levels.map((value) => {
    const label = reasoningLabel(value, provider);
    return { value, label, short: label };
  });
}

/**
 * The reasoning level to send with a model change: the current one when the
 * new model supports it, else the model's own default, else null (leave it).
 */
export function reasoningForModel(
  current: ReasoningLevel,
  model: string,
  catalog: readonly CatalogModel[],
): ReasoningLevel | null {
  const row = catalog.find((m) => m.model === model);
  if (!row || row.supportedReasoningEfforts.length === 0) return null;
  if (row.supportedReasoningEfforts.some((e) => e.reasoningEffort === current)) return null;
  return row.defaultReasoningEffort;
}

/**
 * Permission modes this thread may run with: the provider's supported modes
 * (every mode when it declares none), capped at the machine ceiling, in bb's
 * order. `withoutAuto` drops "auto" for bridges whose bb adapter does not
 * offer it (acp-omp, acp-cursor); the current mode always stays listed.
 */
export function permissionChoices(
  current: PermissionMode,
  provider: CatalogProvider | null,
  ceiling: PermissionMode,
  withoutAuto = false,
): Choice<PermissionMode>[] {
  const ceilingRank = PERMISSION_RANK.indexOf(ceiling);
  const supported = provider?.capabilities.permissionModes ?? PERMISSION_RANK;
  return PERMISSION_CHOICES.filter(
    (c) =>
      c.value === current ||
      (supported.includes(c.value) && PERMISSION_RANK.indexOf(c.value) <= ceilingRank && !(withoutAuto && c.value === "auto")),
  );
}

