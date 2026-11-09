// The plugin's own artwork: alpha masks generated with `bb comfy image` and
// flattened by scripts/make-art.mjs. No icon set, no illustration library.
//
// A mask carries only shape, so one file serves light and dark: the div paints
// itself with `background-color: currentColor` and the mask decides where the
// paint lands. Give the caller's element a text colour and a size:
//
//   <Art name="empty-library" className="h-24 w-52 text-muted-foreground/70" />
//
// The base URL is a short-lived host preview of the plugin's assets/art folder
// (RPC `art_base`), kept in a module level store so every empty state on screen
// shares one fetch and one refresh timer, the way use-comfy.ts holds the asset
// preview base. It lives here rather than in use-comfy.ts so the artwork stays
// self contained.
import { useEffect, useSyncExternalStore, type CSSProperties } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../contract";
import { cn } from "@/lib/utils";

/** Every piece in assets/art. Adding one means adding it to PIECES in scripts/make-art.mjs too. */
export const ART_NAMES = ["mark", "empty-library", "empty-search", "idle-jobs", "no-key"] as const;
export type ArtName = (typeof ART_NAMES)[number];

/** Refresh this long before the preview expires. */
const MARGIN_MS = 10 * 60 * 1000;
const MIN_REFRESH_MS = 30 * 1000;
const MAX_REFRESH_MS = 40 * 60 * 1000;

export interface ArtBase {
  baseUrl: string;
  expiresAtMs: number;
}
interface ArtState {
  data: ArtBase | null;
  error: string | null;
}

type ArtRpc = ReturnType<typeof useRpc<RpcContract>>;

let state: ArtState = { data: null, error: null };
const listeners = new Set<() => void>();
let rpcRef: ArtRpc | null = null;
let mounts = 0;
let inFlight = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function publish(next: ArtState): void {
  state = next;
  for (const listener of listeners) listener();
}

function scheduleRefresh(expiresAtMs: number): void {
  if (timer !== null) clearTimeout(timer);
  const wait = Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, expiresAtMs - Date.now() - MARGIN_MS));
  timer = setTimeout(() => {
    timer = null;
    fetchBase();
  }, wait);
}

function fetchBase(): void {
  const rpc = rpcRef;
  if (rpc === null || inFlight) return;
  inFlight = true;
  void rpc
    .call("art_base")
    .then(
      (data) => {
        publish({ data, error: null });
        if (mounts > 0) scheduleRefresh(data.expiresAtMs);
      },
      (cause: unknown) => {
        // The artwork is decoration: log it once and leave the box empty rather
        // than failing the surface that asked for it.
        console.error("[comfy-cloud] art_base failed", cause);
        publish({ data: state.data, error: cause instanceof Error ? cause.message : String(cause) });
        if (mounts > 0) scheduleRefresh(Date.now() + MARGIN_MS + MIN_REFRESH_MS);
      },
    )
    .finally(() => {
      inFlight = false;
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ArtState {
  return state;
}

/** True when the base is too close to its expiry to still be worth using. */
function stale(data: ArtBase): boolean {
  return data.expiresAtMs - Date.now() < MARGIN_MS;
}

/** Short-lived base URL of the artwork folder, shared by every `Art` on screen. */
export function useArtBase(): ArtState {
  const rpc = useRpc<RpcContract>();
  const live = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    rpcRef = rpc;
    mounts += 1;
    const known = state.data;
    if (known === null || stale(known)) fetchBase();
    else scheduleRefresh(known.expiresAtMs);
    return () => {
      mounts -= 1;
      if (mounts === 0 && timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [rpc]);
  return live;
}

/** URL of one piece, or null before the base has arrived. */
export function artUrl(base: ArtBase | null, name: ArtName): string | null {
  if (base === null) return null;
  return `${base.baseUrl.replace(/\/+$/, "")}/${name}.png`;
}

export interface ArtProps {
  name: ArtName;
  /** Size and colour, for example "h-24 w-52 text-muted-foreground/70". Keep the
   * ink above 3:1 against the surface at the size you actually draw it. */
  className?: string;
  /** Names the drawing for assistive tech and as a tooltip. Omit it when the text beside it already says the same thing. */
  title?: string;
}

/**
 * One piece of artwork, painted in the current text colour. Decorative by
 * default (`aria-hidden`), because empty states always carry their own words.
 */
export function Art({ name, className, title }: ArtProps): React.ReactElement {
  const { data } = useArtBase();
  const url = artUrl(data, name);
  const style: CSSProperties | undefined =
    url === null
      ? undefined
      : {
          maskImage: `url("${url}")`,
          WebkitMaskImage: `url("${url}")`,
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
          backgroundColor: "currentColor",
        };
  return (
    <span
      className={cn("block shrink-0", className)}
      style={style}
      title={title}
      role={title === undefined ? undefined : "img"}
      aria-hidden={title === undefined ? true : undefined}
      aria-label={title}
      data-art={name}
    />
  );
}
