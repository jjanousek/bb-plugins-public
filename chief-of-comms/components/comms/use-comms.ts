// Data layer for the Comms surfaces: fetch on mount, refetch on the server's
// "comms-changed" signal, poll slowly as a fallback. Every surface reads
// through these hooks so the inbox, the tabs and the header agree.
//
// Realtime signals are coalesced: a signal schedules one trailing refetch,
// a signal that lands while a fetch is in flight queues exactly one follow-up,
// and a hook whose own read makes the server publish (conversation_get) ignores
// the echo of its own fetch so it can never drive itself in a loop.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { COMMS_CHANNEL } from "../../contract";
import { startVisiblePoll } from "./visible-poll";
import type { rpcContract } from "../../contract";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { useMediaQuery } from "@/components/ui/hooks/use-media-query";
import type {
  Activity,
  ChannelKey,
  Conversation,
  DiscardedDraft,
  Draft,
  InboxFilter,
  Message,
  MutedSender,
  RpcContract,
  Summary,
  ThreadExecution,
} from "../../contract";

export type CommsRpc = ReturnType<typeof useRpc<RpcContract>>;

const POLL_MS = 20_000;
const ACTIVITY_POLL_MS = 30_000;
const ABOUT_POLL_MS = 60_000;
/** Trailing window a realtime signal waits in, so a burst costs one refetch. */
const SIGNAL_DEBOUNCE_MS = 400;
/** A signal this soon after our own fetch settled is the echo of that fetch. */
const SELF_ECHO_MS = 1_500;

export const CHANNEL_KEYS: readonly ChannelKey[] = ["mail:work", "mail:personal", "whatsapp"];

export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  "mail:work": "Work mail",
  "mail:personal": "Personal mail",
  whatsapp: "WhatsApp",
};

export function useCommsRpc(): CommsRpc {
  return useRpc<RpcContract>();
}

/**
 * The one-time send code for this conversation, from the plugin's
 * browser-only route. draft_send and send_now refuse without it, so an agent
 * calling the RPC directly cannot send (send-block.ts in the plugin).
 */
export async function fetchSendIntent(key: string): Promise<string> {
  const response = await fetch("/api/v1/plugins/chief-of-comms/http/send-intent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; intent?: string; error?: string } | null;
  if (!response.ok || body === null || body.ok !== true || typeof body.intent !== "string") {
    throw new Error(body?.error ?? `The send code could not be fetched (HTTP ${response.status}). Nothing was sent.`);
  }
  return body.intent;
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function signalAt(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const at = (payload as { at?: unknown }).at;
  return typeof at === "number" ? at : null;
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
  /** Drop signals that arrive within this window after our own fetch settled. */
  selfEchoMs?: number;
}

function useLive<T>(run: (rpc: CommsRpc) => Promise<T>, options: LiveOptions = {}): Live<T> {
  const rpc = useCommsRpc();
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
  const settledAt = useRef(0);
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
          console.error("[chief-of-comms] rpc failed", cause);
          if (generation.current === mine) {
            setState((previous) => ({ data: previous.data, error: errorText(cause), loading: false }));
          }
        },
      )
      .finally(() => {
        inFlight.current = false;
        settledAt.current = Date.now();
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
      // keepPrevious dims the old detail instead of unmounting it.
      if (keepPrevious) setState((previous) => ({ ...previous, error: null, loading: true }));
      else setState({ data: null, error: null, loading: true });
    }
    refetch();
    // Paused while the tab is hidden, one refetch on coming back.
    return startVisiblePoll(typeof document === "undefined" ? null : document, () => refetchRef.current(), pollMs);
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
  const selfEchoMs = options.selfEchoMs ?? 0;
  useRealtime(COMMS_CHANNEL, (payload: unknown) => {
    if (!realtime || !enabledRef.current) return;
    if (selfEchoMs > 0 && settledAt.current > 0) {
      const at = signalAt(payload) ?? Date.now();
      if (at - settledAt.current < selfEchoMs) return;
    }
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      refetchRef.current();
    }, SIGNAL_DEBOUNCE_MS);
  });

  return { ...state, refetch };
}

// ---------- shared summary ----------
//
// The summary is read by the page, the chief drawer, the header pills and the
// sidebar accessory. The header and the accessory are separate host-mounted
// roots, so a React context cannot join them; a module-level store can. Every
// useSummary() reads the same snapshot, one poll and one in-flight request
// serve them all.

interface SummaryState {
  data: Summary | null;
  error: string | null;
  loading: boolean;
}

let summaryState: SummaryState = { data: null, error: null, loading: true };
const summaryListeners = new Set<() => void>();
let summaryRpc: CommsRpc | null = null;
let summaryMounts = 0;
let summaryInFlight = false;
let summaryQueued = false;
let summaryTimer: ReturnType<typeof setTimeout> | null = null;
let summaryPoll: (() => void) | null = null;
let summaryFetchedAt = 0;

function publishSummary(next: SummaryState): void {
  summaryState = next;
  for (const listener of summaryListeners) listener();
}

function fetchSummary(): void {
  const rpc = summaryRpc;
  if (rpc === null) return;
  if (summaryInFlight) {
    summaryQueued = true;
    return;
  }
  summaryInFlight = true;
  publishSummary({ ...summaryState, loading: true });
  void rpc
    .call("summary")
    .then(
      (data) => publishSummary({ data, error: null, loading: false }),
      (cause: unknown) => {
        console.error("[chief-of-comms] summary failed", cause);
        publishSummary({ data: summaryState.data, error: errorText(cause), loading: false });
      },
    )
    .finally(() => {
      summaryInFlight = false;
      summaryFetchedAt = Date.now();
      if (!summaryQueued) return;
      summaryQueued = false;
      scheduleSummary();
    });
}

function scheduleSummary(): void {
  if (summaryTimer !== null) return;
  summaryTimer = setTimeout(() => {
    summaryTimer = null;
    fetchSummary();
  }, SIGNAL_DEBOUNCE_MS);
}

function subscribeSummary(listener: () => void): () => void {
  summaryListeners.add(listener);
  return () => {
    summaryListeners.delete(listener);
  };
}

function summarySnapshot(): SummaryState {
  return summaryState;
}

export function useSummary(): Live<Summary> {
  const rpc = useCommsRpc();
  const state = useSyncExternalStore(subscribeSummary, summarySnapshot, summarySnapshot);
  useEffect(() => {
    summaryRpc = rpc;
    summaryMounts += 1;
    if (summaryPoll === null) summaryPoll = startVisiblePoll(typeof document === "undefined" ? null : document, () => fetchSummary(), POLL_MS);
    // A second surface mounting seconds later reuses the fresh snapshot.
    if (summaryState.data === null || Date.now() - summaryFetchedAt > 2_000) fetchSummary();
    return () => {
      summaryMounts -= 1;
      if (summaryMounts > 0) return;
      if (summaryPoll !== null) summaryPoll();
      summaryPoll = null;
      if (summaryTimer !== null) clearTimeout(summaryTimer);
      summaryTimer = null;
    };
  }, [rpc]);
  useRealtime(COMMS_CHANNEL, () => {
    scheduleSummary();
  });
  const refetch = useCallback(() => {
    fetchSummary();
  }, []);
  return { ...state, refetch };
}

export interface ConversationsQuery {
  filter: InboxFilter;
  channels: readonly ChannelKey[];
  query: string;
  /** false parks the hook (used for the ready list when it duplicates the main one). */
  enabled?: boolean;
}

/** One page of the conversation list: the rows inside the limit plus the match count before it cut. */
export interface ConversationsData {
  conversations: Conversation[];
  total: number;
}

/** Stable identity, so a parked hook does not re-run its readers every render. */
const NO_CONVERSATIONS: Conversation[] = [];
const NO_CONVERSATIONS_DATA: ConversationsData = { conversations: NO_CONVERSATIONS, total: 0 };

export function useConversations(args: ConversationsQuery): Live<ConversationsData> {
  const { filter, query } = args;
  const channels = [...args.channels];
  // The server reads an empty `channels` array as "every channel", so with no
  // chip selected the request must not be made at all: the answer is no rows.
  const noChannels = channels.length === 0;
  const enabled = (args.enabled ?? true) && !noChannels;
  const allChannels = channels.length === CHANNEL_KEYS.length;
  const resetKey = JSON.stringify([filter, channels, query]);
  const live = useLive(
    async (rpc): Promise<ConversationsData> => {
      // The rpc client refuses `undefined` values, so optional keys are left out entirely.
      const res = await rpc.call("conversations", {
        filter,
        limit: 200,
        ...(allChannels ? {} : { channels }),
        ...(query === "" ? {} : { query }),
      });
      return { conversations: res.conversations, total: res.total };
    },
    { resetKey, enabled },
  );
  if (!noChannels) return live;
  return { data: NO_CONVERSATIONS_DATA, error: null, loading: false, refetch: live.refetch };
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
  draft: Draft | null;
}

/** One conversation with its messages. Passing null keeps the hook idle. */
export function useConversation(key: string | null): Live<ConversationDetail | null> {
  return useLive<ConversationDetail | null>(
    async (rpc) => {
      if (key === null) return null;
      return await rpc.call("conversation_get", { key });
    },
    // conversation_get is a read that can make the server publish; ignoring the
    // echo of our own fetch is what stops the refetch storm.
    { resetKey: key ?? "", enabled: key !== null, keepPrevious: true, selfEchoMs: SELF_ECHO_MS },
  );
}

/** What the About card in the chief drawer shows for one conversation. */
export type ConversationAbout = z.infer<(typeof rpcContract)["conversation_about"]["output"]>;

/** The card's data with the key it was read for, so a render can never pair one person's card with another's row. */
export interface AboutFor {
  key: string;
  about: ConversationAbout;
}

/**
 * The About card for one conversation. Passing null keeps the hook idle.
 * No keepPrevious: while the next person loads, the card shows a skeleton,
 * never the last person's card. Comms changes refetch it at once.
 */
export function useConversationAbout(key: string | null): Live<AboutFor | null> {
  return useLive<AboutFor | null>(
    async (rpc) => {
      if (key === null) return null;
      return { key, about: await rpc.call("conversation_about", { key }) };
    },
    { resetKey: key ?? "", enabled: key !== null },
  );
}

/** The contact's voice file, for the About card. */
export function useVoiceFile(key: string | null) {
  return useLive(
    async (rpc) => (key === null ? null : { key, voice: await rpc.call("voice_get", { key }) }),
    { resetKey: key ?? "", enabled: key !== null, pollMs: ABOUT_POLL_MS },
  );
}

/** Base URL for WhatsApp media files; refreshed well inside its one-hour lifetime. */
export function useMediaPreview(enabled: boolean): Live<{ baseUrl: string; expiresAtMs: number }> {
  return useLive((rpc) => rpc.call("media_preview"), {
    pollMs: 40 * 60 * 1000,
    realtime: false,
    enabled,
  });
}

export function useActivity(): Live<Activity[]> {
  return useLive(async (rpc) => (await rpc.call("activity_list", { limit: 200 })).events, {
    pollMs: ACTIVITY_POLL_MS,
  });
}

/**
 * Gmail drafts thrown away in the last 24 hours. The panel lists them so a
 * discard is findable the next morning, when the toast that offered the undo
 * is long gone.
 */
export function useDiscardedDrafts(): Live<DiscardedDraft[]> {
  return useLive(async (rpc) => (await rpc.call("draft_trash_list", null)).drafts);
}

/** Work emails that can still be undone, for the "Just sent" list. */
export function useUndoableSends() {
  return useLive(async (rpc) => (await rpc.call("sends_undoable", null)).sends);
}

/** Every muted sender, for the list under Connections. */
export function useMutedSenders(): Live<MutedSender[]> {
  return useLive(async (rpc) => (await rpc.call("muted_list")).senders);
}

/** What a thread runs with next turn, and the choices it could switch to. */
export function useThreadExecution(threadId: string): Live<ThreadExecution | null> {
  return useLive((rpc) => rpc.call("thread_execution_get", { threadId }), { resetKey: threadId });
}

/** Debounce a fast-changing value (the search box) before it hits the server. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export interface ChannelCounts {
  needsReply: number;
  ready: number;
  total: number;
}

const NO_COUNTS: ChannelCounts = { needsReply: 0, ready: 0, total: 0 };

/** Per-channel counts, tolerant of a channel the server left out. */
export function channelCounts(summary: Summary | null, key: ChannelKey): ChannelCounts {
  const table = summary?.counts.byChannel as Partial<Record<ChannelKey, ChannelCounts>> | undefined;
  return table?.[key] ?? NO_COUNTS;
}

/** Counts for exactly the channels the chips have selected. */
export function selectedCounts(summary: Summary | null, channels: readonly ChannelKey[]): ChannelCounts {
  if (summary === null) return NO_COUNTS;
  let needsReply = 0;
  let ready = 0;
  let total = 0;
  for (const key of channels) {
    const counts = channelCounts(summary, key);
    needsReply += counts.needsReply;
    ready += counts.ready;
    total += counts.total;
  }
  return { needsReply, ready, total };
}

/** Width of an element, tracked with a ResizeObserver: the plugin's own slot. */
export function useElementWidth<T extends HTMLElement>(): [(element: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (element === null) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const next = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      setWidth(entry.contentRect.width);
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
  return [ref, width];
}

const POINTER_COARSE_QUERY = "(pointer: coarse)";

/**
 * Is the thing pointing at this panel a finger? A compact viewport (under
 * 768px) or a coarse pointer at any width: a phone in landscape can be wider
 * than 768px and is still a finger. Same test as chief-of-staff.
 * Both hooks run on every render so the hook count never changes.
 */
export function useIsFingerSurface(): boolean {
  const compact = useIsCompactViewport();
  const coarse = useMediaQuery(POINTER_COARSE_QUERY);
  return compact || coarse;
}

// A mounted surface lends its navigator and rpc client to the host-rendered
// palette callbacks, which get neither (they are not React components).
let navigateRef: BbNavigate | null = null;
let rpcRef: CommsRpc | null = null;

export function useCommsBridge(): void {
  const navigate = useBbNavigate();
  const rpc = useCommsRpc();
  useEffect(() => {
    navigateRef = navigate;
    rpcRef = rpc;
  }, [navigate, rpc]);
}

export function bridgeNavigate(): BbNavigate | null {
  return navigateRef;
}

export function bridgeRpc(): CommsRpc | null {
  return rpcRef;
}
