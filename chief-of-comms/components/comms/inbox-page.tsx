// The Comms page body: a mail-client layout. Conversation list on the left,
// the open conversation (or the empty page) in the middle, and the chief
// drawer on the right when it is open. The list and conversation split is
// decided by the width left over beside the drawer, not the viewport, because
// both the host's side panel and the drawer take width from it.
import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ChannelKey, InboxFilter } from "../../contract";
import { ActivityTab } from "./activity-tab";
import { ChiefDrawer } from "./chief-drawer";
import { ConnectionsTab } from "./connections-tab";
import { ConversationList } from "./conversation-list";
import { ConversationView } from "./conversation-view";
import { DiscardedTab } from "./discarded-tab";
import { UndoSendStrip } from "./undo-send";
import { Dashboard } from "./dashboard";
import { Glyph } from "./glyph";
import { EmptyState, FINGER_ICON, FINGER_WORD, ICON_BUTTON, SkeletonRows, TEXT_BUTTON } from "./signals";
import {
  COMMS_PANEL_PATH,
  VIEW_TITLES,
  conversationKeyFromSubPath,
  conversationSubPath,
  viewFromSubPath,
  type PanelView,
} from "./tabs";
import {
  CHANNEL_KEYS,
  errorText,
  useCommsBridge,
  useCommsRpc,
  useConversation,
  useConversations,
  useDebounced,
  useElementWidth,
  useIsFingerSurface,
  useSummary,
} from "./use-comms";

/** Below this the plugin's slot holds one column at a time. */
const NARROW_PX = 720;

export function InboxPage({ subPath }: PluginNavPanelProps) {
  useCommsBridge();
  const navigate = useBbNavigate();
  const rpc = useCommsRpc();
  const [filter, setFilter] = useState<InboxFilter>("needs-reply");
  const [channels, setChannels] = useState<readonly ChannelKey[]>(CHANNEL_KEYS);
  const [queryInput, setQueryInput] = useState("");
  const [syncing, setSyncing] = useState(false);
  const query = useDebounced(queryInput, 250);
  const [rootRef, width] = useElementWidth<HTMLDivElement>();
  const narrow = width > 0 && width < NARROW_PX;
  const finger = useIsFingerSurface();

  const selectedKey = conversationKeyFromSubPath(subPath);
  const view = viewFromSubPath(subPath);
  const summary = useSummary();
  const list = useConversations({ filter, channels, query });
  // The pinned "Ready to send" group needs rows the active filter may hide.
  const readyList = useConversations({ filter: "ready", channels, query, enabled: filter !== "ready" });
  const detail = useConversation(selectedKey);

  const summaryRefetch = summary.refetch;
  const listRefetch = list.refetch;
  const readyRefetch = readyList.refetch;
  const detailRefetch = detail.refetch;
  // The loaded detail counts only while it is the conversation selected. The
  // hook keeps the previous one while the next loads, so the view can dim it
  // instead of flashing; but if the next one FAILS, the old one must not stay
  // on screen, undimmed and with a working Send, under the new selection.
  // The server may return a canonical form of the key,
  // so a mismatch means "not this one yet", nothing stronger.
  const detailIsSelected = detail.data !== null && selectedKey !== null && detail.data.conversation.key === selectedKey;
  const shownDetail = detailIsSelected ? detail.data : detail.loading ? detail.data : null;
  // Dim only while switching to another conversation, never on a background
  // refresh of the same one, which would flicker the view on every poll.
  const switching = detail.data !== null && !detailIsSelected;
  const refreshAll = useCallback(() => {
    summaryRefetch();
    listRefetch();
    readyRefetch();
    detailRefetch();
  }, [summaryRefetch, listRefetch, readyRefetch, detailRefetch]);

  const select = (key: string) => {
    navigate.toPluginPanel(COMMS_PANEL_PATH, { subPath: conversationSubPath(key), replace: true });
  };
  // On a wide screen, arriving at the bare Comms page opens a conversation:
  // the top ready draft, else the top row. An empty column saying "N ready to
  // send" reads as broken. It fires on ARRIVAL only, not
  // when the user goes back to the list or closes a view on purpose: those set
  // `leftOnPurpose`, so the page does not jump straight back, which on a
  // conversation that fails to load would leave the user stuck on the error. It waits for
  // the ready rows so a draft wins over the top of the list.
  const leftOnPurpose = useRef(false);
  const deselect = () => {
    leftOnPurpose.current = true;
    navigate.toPluginPanel(COMMS_PANEL_PATH, { subPath: "", replace: true });
  };
  const openView = (next: PanelView) => {
    navigate.toPluginPanel(COMMS_PANEL_PATH, { subPath: next, replace: true });
  };

  useEffect(() => {
    if (selectedKey !== null || view !== null) {
      leftOnPurpose.current = false;
      return;
    }
    if (leftOnPurpose.current || width === 0 || narrow) return;
    if (readyList.data === null && readyList.error === null && filter !== "ready") return;
    const first = readyList.data?.conversations[0] ?? list.data?.conversations[0] ?? null;
    if (first === null) return;
    navigate.toPluginPanel(COMMS_PANEL_PATH, { subPath: conversationSubPath(first.key), replace: true });
  }, [selectedKey, view, width, narrow, readyList.data, readyList.error, list.data, filter, navigate]);

  const mailSyncing = summary.data?.mail.some((account) => account.syncing) ?? false;

  const refresh = async () => {
    setSyncing(true);
    try {
      const result = await rpc.call("mail_sync");
      if (!result.ok) toast.error(result.text);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setSyncing(false);
      refreshAll();
    }
  };

  // The page and the chief side by side; the page narrows beside the drawer.
  // `relative` is the frame the drawer covers on a phone.
  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 bg-background">
      <div ref={rootRef} className="flex h-full min-h-0 min-w-0 flex-1">
        <div
          className={cn(
            "min-h-0 min-w-0 shrink-0",
            narrow ? "w-full" : "w-[300px] border-r border-border 2xl:w-[340px]",
            narrow && (selectedKey !== null || view !== null) ? "hidden" : "block",
          )}
        >
          <ConversationList
            conversations={list.data?.conversations ?? null}
            total={list.data?.total ?? null}
            ready={readyList.data?.conversations ?? null}
            error={list.error}
            summary={summary.data}
            filter={filter}
            onFilterChange={setFilter}
            channels={channels}
            onChannelsChange={setChannels}
            query={queryInput}
            onQueryChange={setQueryInput}
            onRefresh={() => void refresh()}
            refreshing={syncing || mailSyncing}
            selectedKey={selectedKey}
            onSelect={select}
            onChanged={refreshAll}
            view={view}
            onOpenView={openView}
          />
        </div>

        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-hidden",
            narrow && selectedKey === null && view === null ? "hidden" : "flex",
          )}
        >
          {view !== null ? (
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
                <button
                  type="button"
                  aria-label="Back to the inbox"
                  onClick={deselect}
                  className={cn(ICON_BUTTON, finger ? FINGER_ICON : "size-6")}
                >
                  <Glyph name="back" size={14} />
                </button>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{VIEW_TITLES[view]}</span>
              </div>
              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
                {view === "activity" ? <ActivityTab /> : view === "discarded" ? <DiscardedTab /> : <ConnectionsTab />}
              </div>
            </div>
          ) : selectedKey === null ? (
            <Dashboard summary={summary.data} listed={list.data?.conversations.length ?? 0} />
          ) : shownDetail === null ? (
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
              {narrow ? (
                <div className="flex shrink-0 items-center border-b border-border px-4 py-4">
                  <button
                    type="button"
                    aria-label="Back to the conversation list"
                    onClick={deselect}
                    className={cn(ICON_BUTTON, finger ? FINGER_ICON : "size-6")}
                  >
                    <Glyph name="back" size={14} />
                  </button>
                </div>
              ) : null}
              {detail.loading ? (
                <SkeletonRows className="p-5" />
              ) : (
                <EmptyState glyph="dismiss" title={detail.error ?? "Not in the local cache any more, it may be older than the lookback window."}>
                  <button type="button" className={cn(TEXT_BUTTON, finger && FINGER_WORD)} onClick={deselect}>
                    Back to the list
                  </button>
                </EmptyState>
              )}
            </div>
          ) : (
            <ConversationView
              detail={shownDetail}
              waState={summary.data?.wa.state ?? "disconnected"}
              narrow={narrow}
              stale={switching}
              onBack={deselect}
              onChanged={refreshAll}
            />
          )}
        </div>
      </div>
      <ChiefDrawer selectedKey={selectedKey} />
      <UndoSendStrip onChanged={refreshAll} />
    </div>
  );
}
