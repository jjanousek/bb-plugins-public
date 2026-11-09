// Data layer for the Comfy surfaces: fetch on mount, refetch on the server's
// "comfy-changed" signal, poll slowly as a fallback. Every surface reads
// through these hooks so the grid, the viewer, the tabs and the header agree.
//
// Realtime signals are coalesced: a signal schedules one trailing refetch and
// a signal that lands while a fetch is in flight queues exactly one follow-up.
// The status and the preview base are module-level stores because the header,
// the sidebar accessory and the fixed tabs are separate host-mounted roots
// that a React context cannot join.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { experimental_useAppPanel, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { BbNavigate, ExperimentalAppPanel, ExperimentalPluginFixedTabReference } from "@get-bb/plugin-sdk/app";
import { COMFY_CHANNEL } from "../../contract";
import type { Asset, AssetKind, Costs, JsonValue, ModelPrefs, ModelsResult, NodeInfo, Params, RpcContract, Status, Workflow } from "../../contract";
import { setModelLabels } from "./format";
import { referenceRequestSnapshot, subscribeReferenceRequest } from "./form-session";
import type { ReferenceRequest } from "./form-session";

export { requestReference } from "./form-session";
import { GENERATE_TAB, JOBS_TAB } from "./tabs";

export type ComfyRpc = ReturnType<typeof useRpc<RpcContract>>;

const POLL_MS = 15_000;
const STATUS_POLL_MS = 20_000;
/** Trailing window a realtime signal waits in, so a burst costs one refetch. */
const SIGNAL_DEBOUNCE_MS = 400;
/** Refresh the preview base this long before it expires. */
const PREVIEW_MARGIN_MS = 10 * 60 * 1000;
const PREVIEW_MIN_REFRESH_MS = 30 * 1000;
const PREVIEW_MAX_REFRESH_MS = 40 * 60 * 1000;

export function useComfyRpc(): ComfyRpc {
  return useRpc<RpcContract>();
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface Live<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

interface LiveOptions {
  pollMs?: number;
  realtime?: boolean;
  /** Clears the data when it changes, so a new query never shows stale rows. */
  resetKey?: string;
  /** Keeps the previous data while the next resetKey loads (no "Loading" flash). */
  keepPrevious?: boolean;
  /** false parks the hook: no fetch, no poll, no signal handling. */
  enabled?: boolean;
}

function useLive<T>(run: (rpc: ComfyRpc) => Promise<T>, options: LiveOptions = {}): Live<T> {
  const rpc = useComfyRpc();
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  const enabled = options.enabled ?? true;
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const generation = useRef(0);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchRef = useRef<() => void>(() => undefined);

  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: enabled,
  });

  const refetch = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!enabledRef.current) return;
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    const mine = generation.current;
    inFlight.current = true;
    setState((previous) => ({ ...previous, loading: true }));
    void runRef.current(rpc)
      .then(
        (data) => {
          if (generation.current === mine) setState({ data, error: null, loading: false });
        },
        (cause: unknown) => {
          console.error("[comfy-cloud] rpc failed", cause);
          if (generation.current === mine) {
            setState((previous) => ({ data: previous.data, error: errorText(cause), loading: false }));
          }
        },
      )
      .finally(() => {
        inFlight.current = false;
        if (!queued.current) return;
        queued.current = false;
        timer.current = setTimeout(() => {
          timer.current = null;
          refetchRef.current();
        }, SIGNAL_DEBOUNCE_MS);
      });
  }, [rpc]);

  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  const resetKey = options.resetKey ?? "";
  const keepPrevious = options.keepPrevious ?? false;
  const lastKey = useRef<string | null>(null);
  const pollMs = options.pollMs ?? POLL_MS;
  useEffect(() => {
    generation.current += 1;
    queued.current = false;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const changedKey = lastKey.current !== null && lastKey.current !== resetKey;
    lastKey.current = resetKey;
    if (!enabled) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    if (changedKey) {
      if (keepPrevious) setState((previous) => ({ ...previous, error: null, loading: true }));
      else setState({ data: null, error: null, loading: true });
    }
    refetch();
    const poll = setInterval(() => refetchRef.current(), pollMs);
    return () => clearInterval(poll);
  }, [refetch, resetKey, pollMs, enabled, keepPrevious]);

  // One timer per hook; drop it with the component.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  const realtime = options.realtime ?? true;
  useRealtime(COMFY_CHANNEL, () => {
    if (!realtime || !enabledRef.current) return;
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      refetchRef.current();
    }, SIGNAL_DEBOUNCE_MS);
  });

  return { ...state, refetch };
}

// ---------- shared status ----------

interface StatusState {
  data: Status | null;
  error: string | null;
  loading: boolean;
}

let statusState: StatusState = { data: null, error: null, loading: true };
const statusListeners = new Set<() => void>();
let statusRpc: ComfyRpc | null = null;
let statusMounts = 0;
let statusInFlight = false;
let statusQueued = false;
let statusTimer: ReturnType<typeof setTimeout> | null = null;
let statusPoll: ReturnType<typeof setInterval> | null = null;
let statusFetchedAt = 0;

function publishStatus(next: StatusState): void {
  statusState = next;
  for (const listener of statusListeners) listener();
}

function fetchStatus(): void {
  const rpc = statusRpc;
  if (rpc === null) return;
  if (statusInFlight) {
    statusQueued = true;
    return;
  }
  statusInFlight = true;
  publishStatus({ ...statusState, loading: true });
  void rpc
    .call("status")
    .then(
      (data) => publishStatus({ data, error: null, loading: false }),
      (cause: unknown) => {
        console.error("[comfy-cloud] status failed", cause);
        publishStatus({ data: statusState.data, error: errorText(cause), loading: false });
      },
    )
    .finally(() => {
      statusInFlight = false;
      statusFetchedAt = Date.now();
      if (!statusQueued) return;
      statusQueued = false;
      scheduleStatus();
    });
}

function scheduleStatus(): void {
  if (statusTimer !== null) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    fetchStatus();
  }, SIGNAL_DEBOUNCE_MS);
}

function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function statusSnapshot(): StatusState {
  return statusState;
}

export function useStatus(): Live<Status> {
  const rpc = useComfyRpc();
  const state = useSyncExternalStore(subscribeStatus, statusSnapshot, statusSnapshot);
  useEffect(() => {
    statusRpc = rpc;
    statusMounts += 1;
    if (statusPoll === null) statusPoll = setInterval(() => fetchStatus(), STATUS_POLL_MS);
    // The first surface always fetches; a second one mounting seconds later reuses the fresh snapshot.
    if (statusMounts === 1 || statusState.data === null || Date.now() - statusFetchedAt > 2_000) fetchStatus();
    return () => {
      statusMounts -= 1;
      if (statusMounts > 0) return;
      if (statusPoll !== null) clearInterval(statusPoll);
      statusPoll = null;
      if (statusTimer !== null) clearTimeout(statusTimer);
      statusTimer = null;
    };
  }, [rpc]);
  useRealtime(COMFY_CHANNEL, () => {
    scheduleStatus();
  });
  const refetch = useCallback(() => {
    fetchStatus();
  }, []);
  return { ...state, refetch };
}

// ---------- shared preview base ----------
//
// One short-lived base URL serves every thumbnail and the viewer. It is
// refreshed well inside its lifetime so an image never 404s mid-scroll.

export interface PreviewBase {
  baseUrl: string;
  expiresAtMs: number;
}

interface PreviewState {
  data: PreviewBase | null;
  error: string | null;
}

let previewState: PreviewState = { data: null, error: null };
const previewListeners = new Set<() => void>();
let previewRpc: ComfyRpc | null = null;
let previewMounts = 0;
let previewInFlight = false;
let previewTimer: ReturnType<typeof setTimeout> | null = null;

function publishPreview(next: PreviewState): void {
  previewState = next;
  for (const listener of previewListeners) listener();
}

function schedulePreviewRefresh(expiresAtMs: number): void {
  if (previewTimer !== null) clearTimeout(previewTimer);
  const wait = Math.min(PREVIEW_MAX_REFRESH_MS, Math.max(PREVIEW_MIN_REFRESH_MS, expiresAtMs - Date.now() - PREVIEW_MARGIN_MS));
  previewTimer = setTimeout(() => {
    previewTimer = null;
    fetchPreview();
  }, wait);
}

function fetchPreview(): void {
  const rpc = previewRpc;
  if (rpc === null || previewInFlight) return;
  previewInFlight = true;
  void rpc
    .call("preview_base")
    .then(
      (data) => {
        publishPreview({ data, error: null });
        if (previewMounts > 0) schedulePreviewRefresh(data.expiresAtMs);
      },
      (cause: unknown) => {
        console.error("[comfy-cloud] preview_base failed", cause);
        publishPreview({ data: previewState.data, error: errorText(cause) });
        // Try again soon; thumbnails are blank until this succeeds.
        if (previewMounts > 0) schedulePreviewRefresh(Date.now() + PREVIEW_MARGIN_MS + PREVIEW_MIN_REFRESH_MS);
      },
    )
    .finally(() => {
      previewInFlight = false;
    });
}

function subscribePreview(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => {
    previewListeners.delete(listener);
  };
}

function previewSnapshot(): PreviewState {
  return previewState;
}

/** True when a base is missing or too close to its expiry to trust. */
function previewStale(data: PreviewBase | null): boolean {
  return data === null || data.expiresAtMs - Date.now() < PREVIEW_MARGIN_MS;
}

export function usePreviewBase(): PreviewState & { refetch: () => void } {
  const rpc = useComfyRpc();
  const state = useSyncExternalStore(subscribePreview, previewSnapshot, previewSnapshot);
  useEffect(() => {
    previewRpc = rpc;
    previewMounts += 1;
    if (previewMounts === 1 || previewStale(previewState.data)) fetchPreview();
    else if (previewTimer === null && previewState.data !== null) schedulePreviewRefresh(previewState.data.expiresAtMs);
    return () => {
      previewMounts -= 1;
      if (previewMounts > 0) return;
      if (previewTimer !== null) clearTimeout(previewTimer);
      previewTimer = null;
    };
  }, [rpc]);
  const refetch = useCallback(() => {
    fetchPreview();
  }, []);
  return { ...state, refetch };
}

// ---------- lists and details ----------

export type KindFilter = "all" | AssetKind;

export interface AssetsQuery {
  kind: KindFilter;
  starred: boolean;
  query: string;
  limit?: number;
}

import { LIBRARY_LIMIT } from "./library-paging";
export { LIBRARY_LIMIT };

function listArgs(args: AssetsQuery, limit: number) {
  // The rpc client refuses `undefined` values, so optional keys are left out entirely.
  return {
    limit,
    ...(args.kind === "all" ? {} : { kind: args.kind }),
    ...(args.starred ? { starred: true } : {}),
    ...(args.query === "" ? {} : { query: args.query }),
  };
}

/** The Library's rows, plus how many of them the filtered page itself returned. */
export interface LibraryRows {
  assets: Asset[];
  /**
   * Rows the main query returned, before the in-progress and failed rows are
   * merged in. "Show older" counts this against the limit, so a filtered page
   * that is already whole offers no older rows.
   */
  pageCount: number;
}

/**
 * The Library rows, newest first. Running, waiting and failed rows are what
 * is happening now, so they are shown whatever the chips say: when a filter
 * is active they are fetched separately and merged in.
 */
export function useAssets(args: AssetsQuery): Live<LibraryRows> {
  const { kind, starred, query } = args;
  const limit = args.limit ?? LIBRARY_LIMIT;
  const filtered = kind !== "all" || starred || query !== "";
  const resetKey = JSON.stringify([kind, starred, query, limit]);
  return useLive(
    async (rpc) => {
      const main = rpc.call("assets_list", listArgs(args, limit));
      if (!filtered) {
        const assets = (await main).assets;
        return { assets, pageCount: assets.length };
      }
      const [list, queued, running, unknown, failed] = await Promise.all([
        main,
        rpc.call("assets_list", { status: "queued", limit: 100 }),
        rpc.call("assets_list", { status: "running", limit: 100 }),
        rpc.call("assets_list", { status: "unknown", limit: 100 }),
        rpc.call("assets_list", { status: "failed", limit: 50 }),
      ]);
      return { assets: mergeNewestFirst([list.assets, queued.assets, running.assets, unknown.assets, failed.assets]), pageCount: list.assets.length };
    },
    { resetKey, keepPrevious: true },
  );
}

/** Union of several lists, deduplicated by id, newest first. */
export function mergeNewestFirst(lists: readonly (readonly Asset[])[]): Asset[] {
  const seen = new Set<string>();
  const rows: Asset[] = [];
  for (const list of lists) {
    for (const asset of list) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      rows.push(asset);
    }
  }
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return rows;
}

export interface AssetDetail {
  asset: Asset;
  workflow: Workflow;
  job: JsonValue | null;
}

/** One asset with its workflow and job record. Passing null keeps the hook idle. */
export function useAssetDetail(id: string | null): Live<AssetDetail | null> {
  return useLive<AssetDetail | null>(
    async (rpc) => {
      if (id === null) return null;
      return await rpc.call("asset_get", { id });
    },
    { resetKey: id ?? "", enabled: id !== null, keepPrevious: false },
  );
}

export interface Jobs {
  /** Queued, running, not known yet and failed rows, newest first. */
  active: Asset[];
  /** The last ten completed rows. */
  recent: Asset[];
}

/** What the Jobs tab shows: what is happening now, then what just finished. */
export function useJobs(): Live<Jobs> {
  return useLive(
    async (rpc) => {
      const [queued, running, unknown, failed, completed] = await Promise.all([
        rpc.call("assets_list", { status: "queued", limit: 100 }),
        rpc.call("assets_list", { status: "running", limit: 100 }),
        rpc.call("assets_list", { status: "unknown", limit: 100 }),
        rpc.call("assets_list", { status: "failed", limit: 50 }),
        rpc.call("assets_list", { status: "completed", limit: 10 }),
      ]);
      return {
        active: mergeNewestFirst([queued.assets, running.assets, unknown.assets, failed.assets]),
        recent: completed.assets,
      };
    },
    { pollMs: 10_000 },
  );
}

// ---------- costs ----------
//
// The spend summary and the per model table behind the Status section. The
// balance and the credit rate every other surface needs already ride on
// `status`, so the full breakdown is fetched only where it is drawn.

export function useCosts(days?: number): Live<Costs> {
  return useLive(async (rpc) => await rpc.call("costs", days === undefined ? {} : { days }), {
    pollMs: 60_000,
    resetKey: String(days ?? ""),
  });
}

// ---------- the model registry ----------
//
// One list per kind, about a hundred rows, and it only moves when the plugin is
// reloaded. It is kept in a module store rather than a per-component hook so
// the Generate tab, which is mounted and unmounted every time the host brings
// it forward, does not refetch (and does not flash an empty model row) on each
// visit. The picker and the form read the same snapshot.

const MODELS_TTL_MS = 5 * 60 * 1000;

interface ModelsState {
  data: ModelsResult | null;
  error: string | null;
  loading: boolean;
}

const MODELS_EMPTY: ModelsState = { data: null, error: null, loading: true };
const modelsStates = new Map<AssetKind, ModelsState>();
const modelsFetchedAt = new Map<AssetKind, number>();
const modelsInFlight = new Set<AssetKind>();
const modelsListeners = new Set<() => void>();
let modelsRpc: ComfyRpc | null = null;

function publishModels(kind: AssetKind, next: ModelsState): void {
  modelsStates.set(kind, next);
  for (const listener of modelsListeners) listener();
}

function fetchModels(kind: AssetKind, force = false): void {
  const rpc = modelsRpc;
  if (rpc === null || modelsInFlight.has(kind)) return;
  const fresh = Date.now() - (modelsFetchedAt.get(kind) ?? 0) < MODELS_TTL_MS;
  if (!force && fresh && modelsStates.get(kind)?.data != null) return;
  modelsInFlight.add(kind);
  publishModels(kind, { ...(modelsStates.get(kind) ?? MODELS_EMPTY), loading: true });
  void rpc
    .call("models", { kind })
    .then(
      (data) => {
        modelsFetchedAt.set(kind, Date.now());
        publishModels(kind, { data, error: null, loading: false });
      },
      (cause: unknown) => {
        console.error("[comfy-cloud] models failed", cause);
        publishModels(kind, { data: modelsStates.get(kind)?.data ?? null, error: errorText(cause), loading: false });
      },
    )
    .finally(() => {
      modelsInFlight.delete(kind);
    });
}

function subscribeModels(listener: () => void): () => void {
  modelsListeners.add(listener);
  return () => {
    modelsListeners.delete(listener);
  };
}

/** Every model of one kind the picker may show, with the defaults and the credit rate. */
export function useModels(kind: AssetKind): Live<ModelsResult> {
  const rpc = useComfyRpc();
  const snapshot = useCallback(() => modelsStates.get(kind) ?? MODELS_EMPTY, [kind]);
  const state = useSyncExternalStore(subscribeModels, snapshot, snapshot);
  useEffect(() => {
    modelsRpc = rpc;
    fetchModels(kind);
  }, [rpc, kind]);
  const refetch = useCallback(() => {
    fetchModels(kind, true);
  }, [kind]);
  return { ...state, refetch };
}

// ---------- model labels ----------
//
// The Library, the Viewer and the Jobs rows show a model by name, and an asset
// row stores whatever the caller named: a registry key from the panel, a bare
// id from the CLI or an agent. The map is small (about 10 KB), static between
// reloads and shared by every surface, so it is fetched once into format.ts
// rather than pulled per surface.

let labelsState: Readonly<Record<string, string>> = {};
const labelsListeners = new Set<() => void>();
let labelsRpc: ComfyRpc | null = null;
let labelsFetched = false;

function subscribeLabels(listener: () => void): () => void {
  labelsListeners.add(listener);
  return () => {
    labelsListeners.delete(listener);
  };
}

function labelsSnapshot(): Readonly<Record<string, string>> {
  return labelsState;
}

function loadLabels(): void {
  const rpc = labelsRpc;
  if (rpc === null || labelsFetched) return;
  labelsFetched = true;
  void rpc.call("model_labels", {}).then(
    ({ labels }) => {
      labelsState = labels;
      setModelLabels(labels);
      for (const listener of labelsListeners) listener();
    },
    (cause: unknown) => {
      // A missing map only costs the friendly name, so this never surfaces.
      console.error("[comfy-cloud] model_labels failed", cause);
    },
  );
}

/**
 * Make `modelLabel` name every model in the registry. Call it on any surface
 * that renders `asset.model`; the fetch happens once per load.
 */
export function useModelLabels(): Readonly<Record<string, string>> {
  const rpc = useComfyRpc();
  const labels = useSyncExternalStore(subscribeLabels, labelsSnapshot, labelsSnapshot);
  useEffect(() => {
    labelsRpc = rpc;
    loadLabels();
  }, [rpc]);
  return labels;
}

// ---------- favourite and recent models ----------
//
// Both live in the plugin's own kv table through the `model_prefs` RPC, so they
// follow the account rather than one browser. The server pushes the model used
// onto `recent` at every generation; the panel only ever writes favourites.

/** `loaded` is what tells the Generate tab the stored choice has arrived. */
interface PrefsState extends ModelPrefs {
  loaded: boolean;
}

const PREFS_EMPTY: PrefsState = { favourites: [], recent: [], loaded: false };
let prefsState: PrefsState = PREFS_EMPTY;
const prefsListeners = new Set<() => void>();
let prefsRpc: ComfyRpc | null = null;
let prefsFetched = false;
let prefsInFlight = false;

function publishPrefs(next: ModelPrefs): void {
  prefsState = { ...next, loaded: true };
  for (const listener of prefsListeners) listener();
}

function subscribePrefs(listener: () => void): () => void {
  prefsListeners.add(listener);
  return () => {
    prefsListeners.delete(listener);
  };
}

function prefsSnapshot(): PrefsState {
  return prefsState;
}

function loadPrefs(force = false): void {
  const rpc = prefsRpc;
  if (rpc === null || prefsInFlight || (prefsFetched && !force)) return;
  prefsInFlight = true;
  prefsFetched = true;
  void rpc
    .call("model_prefs", {})
    .then(
      (data) => publishPrefs(data),
      (cause: unknown) => {
        console.error("[comfy-cloud] model_prefs failed", cause);
        // Publish anyway: `loaded` is what releases the Generate tab, and a
        // form that cannot draw its controls because a preference lookup failed
        // would be a far worse failure than a forgotten favourite.
        publishPrefs({ favourites: prefsState.favourites, recent: prefsState.recent, chosen: prefsState.chosen });
      },
    )
    .finally(() => {
      prefsInFlight = false;
    });
}

export interface ModelPrefsHandle extends PrefsState {
  toggleFavourite: (key: string) => void;
  /** Remember the model the Generate tab is on, so a remount or a reload keeps it. */
  setChosen: (kind: AssetKind, key: string) => void;
  refetch: () => void;
}

export function useModelPrefs(): ModelPrefsHandle {
  const rpc = useComfyRpc();
  const prefs = useSyncExternalStore(subscribePrefs, prefsSnapshot, prefsSnapshot);
  useEffect(() => {
    prefsRpc = rpc;
    loadPrefs();
  }, [rpc]);
  const toggleFavourite = useCallback(
    (key: string) => {
      const next = prefsState.favourites.includes(key) ? prefsState.favourites.filter((value) => value !== key) : [...prefsState.favourites, key];
      // Optimistic: the star has to answer the click, and the server replies with the list it stored.
      publishPrefs({ ...prefsState, favourites: next });
      void rpc.call("model_prefs", { favourites: next }).then(
        (data) => publishPrefs(data),
        (cause: unknown) => {
          console.error("[comfy-cloud] model_prefs write failed", cause);
          loadPrefs(true);
        },
      );
    },
    [rpc],
  );
  const setChosen = useCallback(
    (kind: AssetKind, key: string) => {
      const chosen = { image: prefsState.chosen?.image ?? null, video: prefsState.chosen?.video ?? null, [kind]: key };
      publishPrefs({ ...prefsState, chosen });
      void rpc.call("model_prefs", { chosen: { [kind]: key } }).then(
        (data) => publishPrefs(data),
        (cause: unknown) => {
          // Losing this only costs the next remount its starting model, so it
          // never interrupts the person who is trying to generate something.
          console.error("[comfy-cloud] model_prefs chosen write failed", cause);
        },
      );
    },
    [rpc],
  );
  const refetch = useCallback(() => {
    loadPrefs(true);
  }, []);
  return { ...prefs, toggleFavourite, setChosen, refetch };
}

/** Node metadata for the class types of one graph. Cached per class-type set; never realtime. */
export function useNodeCatalog(classTypes: readonly string[]): Live<Record<string, NodeInfo>> {
  const key = [...new Set(classTypes)].sort().join("\n");
  return useLive(
    async (rpc) => {
      if (key === "") return {};
      return (await rpc.call("node_catalog", { classTypes: key.split("\n").slice(0, 200) })).nodes;
    },
    { resetKey: key, enabled: key !== "", realtime: false, pollMs: 24 * 60 * 60 * 1000, keepPrevious: true },
  );
}

// ---------- small utilities ----------

/** Debounce a fast-changing value (the search box) before it hits the server. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** A clock that ticks every `ms` while `enabled`, for elapsed-seconds labels. */
export function useNow(enabled: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [enabled, ms]);
  return now;
}

export interface ElementSize {
  width: number;
  height: number;
}

/** Size of an element, tracked with a ResizeObserver: the plugin's own slot, not the viewport. */
export function useElementSize<T extends HTMLElement>(): [(element: T | null) => void, ElementSize] {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });
    if (typeof ResizeObserver === "undefined") return;
    const next = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    next.observe(element);
    observer.current = next;
  }, []);
  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
    },
    [],
  );
  return [ref, size];
}

// ---------- tweak requests ----------
//
// The viewer prefills the Generate tab through this store. The tab may not be
// mounted when Tweak is pressed (it mounts when brought forward), so the
// request is kept until the tab reads it; a mounted tab reacts to `sequence`.

export interface TweakRequest {
  kind: AssetKind;
  prompt: string;
  model: string;
  params: Params;
  /** The asset this prefill came from; null for a plain example prompt. */
  parentId: string | null;
}

interface TweakState {
  request: TweakRequest | null;
  sequence: number;
}

let tweakState: TweakState = { request: null, sequence: 0 };
const tweakListeners = new Set<() => void>();

export function requestTweak(request: TweakRequest): void {
  tweakState = { request, sequence: tweakState.sequence + 1 };
  for (const listener of tweakListeners) listener();
}

function subscribeTweak(listener: () => void): () => void {
  tweakListeners.add(listener);
  return () => {
    tweakListeners.delete(listener);
  };
}

function tweakSnapshot(): TweakState {
  return tweakState;
}

export function useTweakRequest(): TweakState {
  return useSyncExternalStore(subscribeTweak, tweakSnapshot, tweakSnapshot);
}

// ---------- reference requests ----------
//
// "Use as reference" in the viewer hands one asset to the Generate tab. The
// store is in form-session.ts, a plain module a test can drive; this is the
// hook the tab reads it through.

export function useReferenceRequest(): ReferenceRequest {
  return useSyncExternalStore(subscribeReferenceRequest, referenceRequestSnapshot, referenceRequestSnapshot);
}

// ---------- the viewport ----------
//
// Width decisions inside a surface are container queries or measured sizes.
// These three are the exceptions: whether the host is
// in its compact layout (under 768 px, the host's own breakpoint), whether the
// pointer is a finger, and whether the user asked for less motion.

/** The host's own compact breakpoint, `useIsCompactViewport` in the host. */
export const COMPACT_QUERY = "(max-width: 767px)";
export const COARSE_QUERY = "(pointer: coarse)";
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeQuery(query: string, notify: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const list = window.matchMedia(query);
  list.addEventListener?.("change", notify);
  return () => list.removeEventListener?.("change", notify);
}

function queryMatches(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => subscribeQuery(query, notify),
    () => queryMatches(query),
    () => false,
  );
}

/** The phone layout: the host is in its compact drawer layout. */
export function useCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY);
}

/** Compact or a coarse pointer means touch behaviour. */
export function useFinger(): boolean {
  const compact = useMediaQuery(COMPACT_QUERY);
  const coarse = useMediaQuery(COARSE_QUERY);
  return compact || coarse;
}

export function useReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY);
}

// ---------- the Generate tab ----------

const HAS_APP_PANEL = typeof experimental_useAppPanel === "function";

/**
 * Bring one of the plugin's fixed tabs forward on the current surface.
 * Returns false when the host declined or predates the app-panel controller.
 */
export function useOpenFixedTab(tab: ExperimentalPluginFixedTabReference): () => boolean {
  // The availability check is a module constant, so the hook order is stable.
  const panel: ExperimentalAppPanel | null = HAS_APP_PANEL ? experimental_useAppPanel() : null;
  return useCallback(() => {
    if (panel === null) return false;
    try {
      return panel.openFixedTab({ surface: { kind: "current" }, tab });
    } catch (cause) {
      console.warn("[comfy-cloud] openFixedTab failed", cause);
      return false;
    }
  }, [panel, tab]);
}

export function useOpenGenerateTab(): () => boolean {
  return useOpenFixedTab(GENERATE_TAB);
}

export function useOpenJobsTab(): () => boolean {
  return useOpenFixedTab(JOBS_TAB);
}

// ---------- bridge ----------
//
// A mounted surface lends its navigator to the host-rendered palette
// callbacks, which get none (they are not React components).

let navigateRef: BbNavigate | null = null;

export function useComfyBridge(): void {
  const navigate = useBbNavigate();
  useEffect(() => {
    navigateRef = navigate;
  }, [navigate]);
}

export function bridgeNavigate(): BbNavigate | null {
  return navigateRef;
}
