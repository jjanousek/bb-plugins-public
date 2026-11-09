// What the Generate tab remembers between mounts.
//
// Generate is a fixed tab, so the host unmounts it every time the user looks at
// Jobs or the Library and mounts a fresh one on the way back. Plain React state
// would lose the chosen model and the prompt on every such switch. This module
// is the session's memory: one panel, one form, whatever tab is in front of it.
//
// It is deliberately a plain module with no React and no SDK import, so tests
// can reset it between renders and so `tsconfig` can typecheck them.
// `model_prefs.chosen` on the server is the other half: this survives a
// remount, that survives a page reload.
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from "../../contract";
import type { Asset, AssetKind, ModelSummary } from "../../contract";
import { emptyValues } from "./model-form";
import type { FormValues } from "./model-form";

/** What the form holds for one kind: the model key and its wishes. */
export interface KindState {
  key: string;
  values: FormValues;
  /** True once the key has been matched against a real registry entry. */
  ready: boolean;
}

export interface SessionForm {
  kind: AssetKind;
  prompt: string;
  image: KindState;
  video: KindState;
  randomSeed: boolean;
  seedText: string;
  parentId: string | null;
  /**
   * Asset ids attached as reference images, in slot order. Kept like the
   * prompt: a switch to Jobs and back keeps them, a page reload does not. The
   * server resolves each id to the file it already has.
   */
  references: string[];
  /** True once the stored choice has been folded in, so a reload applies it once. */
  restored: boolean;
}

export const MAX_SEED = 2147483647;

export function randomSeedValue(): number {
  return Math.floor(Math.random() * (MAX_SEED + 1));
}

export function startState(key: string): KindState {
  return { key, values: emptyValues(), ready: false };
}

export function startSession(): SessionForm {
  return {
    kind: "image",
    prompt: "",
    image: startState(DEFAULT_IMAGE_MODEL),
    video: startState(DEFAULT_VIDEO_MODEL),
    randomSeed: true,
    seedText: String(randomSeedValue()),
    parentId: null,
    references: [],
    restored: false,
  };
}

let session: SessionForm | null = null;

/** The form as the tab last held it, creating a fresh one on the first mount. */
export function formSession(): SessionForm {
  return (session ??= startSession());
}

export function saveSession(next: SessionForm): void {
  session = next;
}

/** Forget everything. Only a test calls this; one panel never needs it. */
export function resetSession(): void {
  session = null;
}

// ---------- reference images ----------
//
// Pure rules for the References row, kept here beside the state they act on so
// a test can hold them without rendering anything.

/** How many references a model takes; 0 when it takes none. */
export function referenceLimit(model: ModelSummary | null): number {
  const group = model?.capabilities.referenceImages;
  return group === null || group === undefined ? 0 : group.max;
}

/**
 * Whether the Generate tab draws its References row at all: only for a model
 * that takes a reference. The attached ids are not thrown away when a model
 * without the capability is chosen; they come back when one with it is.
 */
export function showsReferences(model: ModelSummary | null): boolean {
  return referenceLimit(model) > 0;
}

/**
 * Attach one more, at the end. An id already attached is not added twice, and
 * a list that is full stays as it is: the caller says so rather than dropping
 * the oldest without a word.
 */
export function attachReference(references: readonly string[], id: string, limit: number): string[] {
  if (id === "" || references.includes(id)) return [...references];
  if (limit > 0 && references.length >= limit) return [...references];
  return [...references, id];
}

export function removeReference(references: readonly string[], id: string): string[] {
  return references.filter((reference) => reference !== id);
}

/**
 * The references a request actually sends: the attached ones up to what the
 * model takes, and none at all for a model that takes none.
 */
export function sentReferences(references: readonly string[], model: ModelSummary | null): string[] {
  const limit = referenceLimit(model);
  return limit === 0 ? [] : references.slice(0, limit);
}

/**
 * The model to move to when a reference arrives for one that cannot take it:
 * the first recommended image model that can, else any image model that can.
 * Null when none of them can, which the caller says in words.
 */
export function referenceModel(models: readonly ModelSummary[]): ModelSummary | null {
  const able = models.filter((model) => model.kind === "image" && model.supported && !model.hidden && showsReferences(model));
  return able.find((model) => model.recommended) ?? able[0] ?? null;
}

/**
 * The ids a finished row was made from, out of its stored params, for a Tweak
 * that should keep them. `specParams` records the origins as one string ("img_a,
 * img_b"); only the ones that are asset ids come back, because a path on the
 * server's disk is not something the panel can show or vouch for.
 */
export function referencesFromParams(params: Readonly<Record<string, unknown>>): string[] {
  const value = params.references;
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^img_[a-z0-9]+$/i.test(part));
}

/**
 * How many of a row's references were files on disk rather than library
 * assets. A Tweak cannot bring those back (the panel does not vouch for a
 * server path), and it should say so rather than drop them silently: an
 * agent usually hands its references over as paths.
 */
export function droppedReferenceCount(params: Readonly<Record<string, unknown>>): number {
  const value = params.references;
  if (typeof value !== "string") return 0;
  const all = value.split(",").map((part) => part.trim()).filter((part) => part !== "");
  return all.length - referencesFromParams(params).length;
}

// ---------- the "Use as reference" request ----------
//
// The viewer hands one asset to the Generate tab through this. Like a tweak,
// the tab may not be mounted when it is pressed, so the request waits here
// until the tab reads it; unlike a tweak it adds to the form rather than
// replacing it, so the prompt somebody was writing survives. The sequence only
// ever grows, so a tab that has applied one request never applies it again.

export interface ReferenceRequest {
  asset: Asset | null;
  sequence: number;
}

let referenceRequest: ReferenceRequest = { asset: null, sequence: 0 };
const referenceListeners = new Set<() => void>();

export function requestReference(asset: Asset): void {
  referenceRequest = { asset, sequence: referenceRequest.sequence + 1 };
  for (const listener of referenceListeners) listener();
}

export function subscribeReferenceRequest(listener: () => void): () => void {
  referenceListeners.add(listener);
  return () => {
    referenceListeners.delete(listener);
  };
}

export function referenceRequestSnapshot(): ReferenceRequest {
  return referenceRequest;
}
