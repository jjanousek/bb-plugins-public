// bb-plugin-chief-of-staff - frontend entry.
//
// One nav panel ("Chief of Staff"): the page body is the chief thread's chat,
// and the host panel carries three fixed tabs - Mission (the roster, what needs
// you, and the activity log behind a Board / Activity switch), Worker (one
// worker's chat in place) and Execution (what every thread runs at). The host
// draws the plugin icon for every fixed tab, so the three are told apart by
// their titles only; tabs.ts says why Execution is a tab anyway, and the empty
// Worker tab links to the other two.
// Everything else here is registration plus the page wiring; the surfaces live
// in components/cos.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ThreadChat,
  definePluginApp,
  experimental_useAppPanel,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import type { PluginFixedTabRegistration, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AdoptDialog } from "@/components/cos/adopt-dialog";
import { bridgeNavigate, useCosBridge } from "@/components/cos/bridge";
import { ComposerBoardInsert } from "@/components/cos/composer-board-insert";
import { DelegateDialog } from "@/components/cos/delegate-dialog";
import { HomepageSection } from "@/components/cos/homepage-section";
import { LocalFileLinks } from "@/components/cos/local-file-links";
import { ImportDialog } from "@/components/cos/import-dialog";
import { ExecutionTab } from "@/components/cos/execution-tab";
import { MissionTab } from "@/components/cos/mission-tab";
import { PanelHeaderContent, SidebarAccessory } from "@/components/cos/panel-chrome";
import { mountRowMarks } from "@/components/cos/row-marks";
import { WorkerMark } from "@/components/cos/avatar";
import { StatusDot } from "@/components/cos/status-dot";
import { StatusStrip } from "@/components/cos/status-strip";
import { ThreadHeaderAction } from "@/components/cos/thread-header-action";
import { ThreadExecutionBar } from "@/components/cos/thread-execution-bar";
import {
  Age,
  COMPACT_WORD_HIT_AREA,
  NameLine,
  QuietButton,
  Row,
  RowList,
} from "@/components/cos/ui";
import { Glyph } from "@/components/cos/glyph";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { WorkerPane, WorkerTab } from "@/components/cos/worker-tab";
import {
  ADOPT_SUBPATH_PREFIX,
  CHIEF_PANEL_ID,
  CHIEF_PANEL_PATH,
  DELEGATE_SUBPATH,
  EXECUTION_SUBPATH,
  MISSION_SUBPATH,
  EXECUTION_TAB,
  MISSION_TAB,
  SESSIONS_SUBPATH,
  WORKER_SUBPATH_PREFIX,
  WORKER_TAB,
  type WorkerTarget,
} from "@/components/cos/tabs";
import {
  bucketRoster,
  displayName,
  errorText,
  levelWord,
  needsYouLine,
  needsYouReason,
  plainLine,
  projectLabel,
  rowUrgency,
  unimportedSessions,
  useCosRpc,
  useProjects,
  useRoster,
  useSessions,
  useSummary,
  workerNote,
} from "@/components/cos/use-cos";
import type { ExternalSession, Summary, WorkerStatus } from "@/contract";

/** Up to three rows fit above a conversation before the strip stops being a header. */
const GLANCE_ROWS = 3;

/**
 * The board, compressed to a header for the chat, for the case the panel is
 * closed and the page has room to spare. It renders nothing
 * when nothing is waiting, and the container query means it disappears the
 * moment the panel opens and takes the width back, so the same information is
 * never on screen twice.
 */
function AtAGlance({
  summary,
  workers,
  onOpenWorker,
  onOpenMission,
}: {
  summary: Summary;
  workers: readonly WorkerStatus[];
  onOpenWorker: (threadId: string) => void;
  onOpenMission: () => void;
}) {
  // The rows are their own gate. `summary.needsYou` also counts blocked
  // unmanaged threads and missing workers, which this strip has no row for, so
  // summing the counts would open an empty header; `workers` comes from the
  // same buckets the board uses, so the two can never disagree.
  if (workers.length === 0) return null;
  const shown = workers.slice(0, GLANCE_ROWS);
  const rest = workers.length - shown.length;
  return (
    <div className="hidden shrink-0 px-4 pt-3 @[1280px]/cospage:block">
      <div className="mx-auto w-full max-w-[830px]">
        <StatusStrip summary={summary} onSelect={onOpenMission} />
        <RowList ariaLabel="Waiting on you">
          {shown.map((worker) => {
            const urgency = rowUrgency(worker);
            const line = worker.lastNeed ?? needsYouLine(worker);
            return (
              <Row
                key={worker.id}
                dot={<StatusDot status="idle" urgency={urgency} />}
                lead={<WorkerMark avatar={worker.avatar} />}
                title={
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 shrink-0">
                      <NameLine
                        name={displayName(worker)}
                        slug={worker.name}
                        project={projectLabel(worker)}
                        note={workerNote(worker) ?? levelWord(worker)}
                        noteTone={urgency === "urgent" ? "urgent" : "attention"}
                      />
                    </span>
                    {line === null ? null : (
                      <span className="min-w-0 flex-1 truncate text-[12px] leading-5 text-muted-foreground">
                        {plainLine(line)}
                      </span>
                    )}
                  </span>
                }
                age={
                  <Age
                    at={worker.lastReportAt ?? worker.lastUsedAt}
                    tone={urgency === "urgent" ? "urgent" : "tertiary"}
                  />
                }
                onOpen={() => onOpenWorker(worker.threadId)}
                openLabel={`Open ${displayName(worker)} in the panel`}
              />
            );
          })}
        </RowList>
        {rest === 0 ? null : (
          <div className="pt-1">
            <QuietButton onClick={onOpenMission}>and {rest} more</QuietButton>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A fixed tab shown in the page body instead of the host panel.
 *
 * On a phone the panel is a drawer, and the SDK gives a nav-panel component no
 * way to open it. `openFixedTab` selects the tab, but a fixed tab component
 * "mounts only while its tab is active in a visible pane and the panel is
 * open", so a deep link naming the board would change the URL and leave the
 * user on the chief's transcript with nothing else on screen at phone width:
 * tapping a count and landing nowhere.
 *
 * Nothing else in the SDK reaches that drawer. `useBbNavigate().openThreadPanel`
 * wants a registered `threadPanelAction` and declines on any surface that is
 * not the main thread view, and `isCompactViewport` is handed only to
 * thread-list and thread-header components, so the host will not even tell a
 * page which layout it is in. The page body is the one surface this component
 * owns, so the board goes there.
 */
type InlineSurface =
  | { kind: "mission" }
  | { kind: "execution" }
  | { kind: "worker"; threadId: string; focus: boolean };

/** Where the tab strip would have been: one word back to the chief's chat. */
function InlineBack({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex shrink-0 items-center border-b border-border px-4 py-2">
      <QuietButton onClick={onBack} className={COMPACT_WORD_HIT_AREA}>
        <span className="flex items-center gap-1.5">
          <Glyph name="chevron" rotate={180} aria-hidden className="size-2.5" />
          Chief
        </span>
      </QuietButton>
    </div>
  );
}

function ChiefPage({ subPath }: PluginNavPanelProps) {
  useCosBridge();
  const rpc = useCosRpc();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const summary = useSummary();
  const roster = useRoster();
  const sessions = useSessions();
  const projects = useProjects();
  const [starting, setStarting] = useState(false);
  const [delegateOpen, setDelegateOpen] = useState(false);
  const [adoptThreadId, setAdoptThreadId] = useState<string | null>(null);
  const [importTargets, setImportTargets] = useState<ExternalSession[] | null>(null);
  const [wantsImport, setWantsImport] = useState(false);
  const compact = useIsCompactViewport();
  const [inline, setInline] = useState<InlineSurface | null>(null);

  // `panel` and the width are read through refs so the deep-link effect keys on
  // the sub path alone and cannot re-open a tab on every render.
  const panelRef = useRef(panel);
  const compactRef = useRef(compact);
  useEffect(() => {
    panelRef.current = panel;
    compactRef.current = compact;
  });

  /**
   * The one way this page switches surface.
   *
   * Wide: the host panel takes it. Narrow: there is no panel to
   * reach, so the page body takes it. A host that declines the open for a
   * reason not met here still lands somewhere real, because the boolean
   * `openFixedTab` returns is read rather than dropped.
   */
  const show = useCallback((surface: InlineSurface) => {
    if (!compactRef.current) {
      const accepted =
        surface.kind === "mission"
          ? panelRef.current.openFixedTab({
              surface: { kind: "current" },
              tab: MISSION_TAB,
            })
          : surface.kind === "execution"
          ? panelRef.current.openFixedTab({
              surface: { kind: "current" },
              tab: EXECUTION_TAB,
            })
          : panelRef.current.openFixedTab({
              surface: { kind: "current" },
              tab: WORKER_TAB,
              target: { threadId: surface.threadId, focus: surface.focus },
            });
      if (accepted) {
        setInline(null);
        return;
      }
    }
    setInline(surface);
  }, []);

  // Rotated into landscape, or a window pulled wide: hand the surface back to
  // the panel rather than showing the board in the body and in the panel at
  // once. `show` clears `inline` when the panel accepts, and re-sets the same
  // object when it does not, so this settles in one pass either way.
  useEffect(() => {
    if (inline === null || compact) return;
    show(inline);
  }, [compact, inline, show]);

  /**
   * A deep link's open, from the page's side.
   *
   * This is the whole of it on a phone, where the panel is out of reach and the
   * surface renders in the page body. On a wide window it is a best effort and
   * usually a no-op: `openFixedTab` returns true from here and the panel does
   * not move: arriving on `/chief/mission` with Worker last-active, repeated
   * calls leave the panel on Worker, while the same call from the Worker tab's
   * own button switches it. It is not a race, so there is nothing here to
   * retry.
   *
   * The panel side of the same link lives in `deep-link.ts`: whichever plugin
   * tab is mounted reads the same `subPath` and selects the one the link named.
   */
  const showOnArrival = useCallback(
    (surface: InlineSurface) => {
      show(surface);
    },
    [show],
  );

  // Deep links: /chief/delegate opens the delegate dialog, /chief/adopt/<id>
  // opens the adopt dialog for that thread, /chief/sessions shows the Mission
  // tab and offers the first session that has not been imported yet,
  // /chief/mission shows the board, and /chief/worker/<id> shows that worker.
  //
  // The last two do not clear the sub path afterwards. A second sub path change
  // re-runs the host's `PluginPanelRightPanelHost` effect, which closes the
  // compact drawer, so clearing would shut the drawer the tap just opened.
  useEffect(() => {
    if (subPath === DELEGATE_SUBPATH) {
      setDelegateOpen(true);
      return;
    }
    if (subPath === SESSIONS_SUBPATH) {
      setWantsImport(true);
      showOnArrival({ kind: "mission" });
      return;
    }
    if (subPath === EXECUTION_SUBPATH) {
      showOnArrival({ kind: "execution" });
      return;
    }
    if (subPath === MISSION_SUBPATH) {
      showOnArrival({ kind: "mission" });
      return;
    }
    if (subPath.startsWith(WORKER_SUBPATH_PREFIX)) {
      const threadId = subPath.slice(WORKER_SUBPATH_PREFIX.length);
      // `focus: true` mirrors the board's "Answer": a row that names a decision
      // should land in the composer where the answer gets typed.
      if (threadId === "") return;
      showOnArrival({ kind: "worker", threadId, focus: true });
      return;
    }
    if (subPath.startsWith(ADOPT_SUBPATH_PREFIX)) {
      const threadId = subPath.slice(ADOPT_SUBPATH_PREFIX.length);
      if (threadId !== "") setAdoptThreadId(threadId);
    }
    return;
  }, [showOnArrival, subPath]);

  const clearSubPath = useCallback(() => {
    if (subPath !== "") {
      navigate.toPluginPanel(CHIEF_PANEL_PATH, { subPath: "", replace: true });
    }
  }, [navigate, subPath]);

  // The session list is fetched, so the deep link waits for it before deciding
  // whether there is anything to offer.
  useEffect(() => {
    if (!wantsImport || !sessions.loaded) return;
    setWantsImport(false);
    clearSubPath();
    const next = unimportedSessions(sessions.sessions)[0];
    // The card's "N not yet imported" count and this list are two readings of
    // one rule (an import counts only while its worker is un-retired). They
    // agree, so an empty list here means the queue drained between the tap and
    // the scan. Say so; the Mission tab is already open behind this.
    if (next === undefined) toast("Nothing left to import");
    else setImportTargets([next]);
  }, [clearSubPath, sessions.loaded, sessions.sessions, wantsImport]);

  // Nudge once whenever the number of workers waiting on the user goes up.
  const rosterRef = useRef(roster.data);
  useEffect(() => {
    rosterRef.current = roster.data;
  });
  const needsYou = summary.data?.needsYou ?? null;
  const previousNeedsYou = useRef<number | null>(null);
  useEffect(() => {
    if (needsYou === null) return;
    const previous = previousNeedsYou.current;
    previousNeedsYou.current = needsYou;
    if (previous === null || needsYou <= previous) return;
    // The same predicate the board's "Needs you" section uses, so the nudge
    // names every row the count moved for. `needsYouReason` also covers a
    // missing thread, and `summary.needsYou` counts blocked unmanaged threads,
    // which have no worker name of their own.
    const current = rosterRef.current;
    const names = [
      ...(current?.workers ?? [])
        .filter((worker) => !worker.retired && needsYouReason(worker) !== null)
        .map((worker) => worker.name),
      ...(current?.others ?? [])
        .filter((thread) => thread.pendingInteraction)
        .map((thread) => thread.title ?? thread.projectName),
    ].join(", ");
    toast("A worker needs you", names === "" ? undefined : { description: names });
  }, [needsYou]);

  const start = async () => {
    setStarting(true);
    try {
      await rpc.call("chief_ensure", null);
      summary.refetch();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setStarting(false);
    }
  };

  const dialogs = (
    <>
      <DelegateDialog
        open={delegateOpen}
        onOpenChange={(open) => {
          setDelegateOpen(open);
          if (!open) clearSubPath();
        }}
        onDelegated={(threadId) => {
          summary.refetch();
          roster.refetch();
          if (threadId !== null) show({ kind: "worker", threadId, focus: false });
        }}
      />
      <ImportDialog
        open={importTargets !== null}
        sessions={importTargets ?? []}
        allSessions={sessions.sessions}
        projects={projects.data ?? []}
        onOpenChange={(open) => {
          if (!open) setImportTargets(null);
        }}
        onImported={() => {
          sessions.refetch();
          roster.refetch();
          summary.refetch();
        }}
      />
      <AdoptDialog
        open={adoptThreadId !== null}
        threadId={adoptThreadId}
        onOpenChange={(open) => {
          if (!open) {
            setAdoptThreadId(null);
            clearSubPath();
          }
        }}
        onAdopted={() => {
          summary.refetch();
          roster.refetch();
        }}
      />
    </>
  );

  if (summary.data === null) {
    return (
      <div className="p-6 text-sm text-muted-foreground">{summary.error ?? "Loading"}</div>
    );
  }

  if (summary.data.chiefThreadId === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <p className="text-[13px] text-foreground">No chief of staff yet</p>
          <p className="text-[13px] leading-5 text-muted-foreground">
            The chief is one long-lived thread that delegates every task to reusable worker
            threads across your projects. It never does the work itself.
          </p>
          <Button onClick={() => void start()} disabled={starting}>
            {starting ? "Starting" : "Start chief of staff"}
          </Button>
        </div>
        {dialogs}
      </div>
    );
  }

  // The panel could not be reached, so the surface it was asked for is drawn
  // here instead. Worker sits above Mission: its own Back goes to the board,
  // and the board's goes to the chief, so the way out is always one word.
  if (inline !== null) {
    return (
      <div className="@container/cospage flex h-full min-h-0 flex-col">
        {inline.kind === "worker" ? (
          <WorkerPane
            key={inline.threadId}
            threadId={inline.threadId}
            focusRequest={inline.focus ? 1 : undefined}
            onBack={() => show({ kind: "mission" })}
          />
        ) : (
          <>
            <InlineBack
              onBack={() => {
                setInline(null);
                clearSubPath();
              }}
            />
            {/* The host gives a "padded" fixed tab its padding and its scroll.
                In the body both are ours. */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4">
              {/* An empty sub path on purpose: this copy is in the page body,
                  not in the panel, so it has no tab to select (deep-link.ts). */}
              {inline.kind === "execution" ? <ExecutionTab /> : <MissionTab subPath="" />}
            </div>
          </>
        )}
        {dialogs}
      </div>
    );
  }

  const waiting =
    roster.data === null
      ? []
      : (() => {
          const buckets = bucketRoster(roster.data);
          return [...buckets.needsYou, ...buckets.decisions];
        })();

  return (
    <div className="@container/cospage flex h-full min-h-0 flex-col">
      <AtAGlance
        summary={summary.data}
        workers={waiting}
        onOpenWorker={(threadId) => show({ kind: "worker", threadId, focus: false })}
        onOpenMission={() => show({ kind: "mission" })}
      />
      <ThreadExecutionBar threadId={summary.data.chiefThreadId} />
      <LocalFileLinks threadId={summary.data.chiefThreadId} className="min-h-0 flex-1">
        <ThreadChat
          threadId={summary.data.chiefThreadId}
          variant="full"
          layout="contained"
          // "editable" gives this chat its own permission picker. The SDK
          // default ("inherit") renders the picker as a dimmed label that a
          // plugin surface can never widen, which reads as a dead button.
          permissionPolicy="editable"
          className="h-full"
        />
      </LocalFileLinks>
      {dialogs}
    </div>
  );
}

const MISSION_TAB_REGISTRATION: PluginFixedTabRegistration = {
  ...MISSION_TAB,
  title: "Mission",
  // bb draws this hint, not the plugin mark, and one built-in icon on all three
  // tabs would be three identical glyphs in the tab strip. Mission takes the plugin's own drawn mark, the one on the
  // rail. Worker and Execution take bb's own names for a person and for
  // settings, because the strip takes a bb icon name or a declared glyph and
  // we have drawn neither: bb's vocabulary in bb's chrome, which is allowed
  // for the sidebar status slot.
  icon: "chief-of-staff/rail",
  component: MissionTab,
  layout: "padded",
};

/**
 * What every thread runs at. A settings surface, not a work list, which is why
 * it is its own tab rather than a fourth word in the Mission switch.
 */
const EXECUTION_TAB_REGISTRATION: PluginFixedTabRegistration = {
  ...EXECUTION_TAB,
  title: "Execution",
  icon: "SlidersHorizontal",
  component: ExecutionTab,
  layout: "padded",
};

const WORKER_TAB_REGISTRATION: PluginFixedTabRegistration<WorkerTarget> = {
  ...WORKER_TAB,
  title: "Worker",
  icon: "UserRound",
  component: WorkerTab,
  layout: "flush",
};

function openChiefPage(subPath?: string): void {
  const navigate = bridgeNavigate();
  if (navigate === null) {
    toast.error("Open the Chief of Staff page once, then try again");
    return;
  }
  navigate.toPluginPanel(CHIEF_PANEL_PATH, subPath === undefined ? undefined : { subPath });
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: CHIEF_PANEL_ID,
    title: "Chief of Staff",
    // bb uses this hint first. A built-in name such as "Zap" hides our own SVG, so the hint points at the declared glyph "chief-of-staff/rail" (bb.branding.experimental_icons).
    icon: "chief-of-staff/rail",
    path: CHIEF_PANEL_PATH,
    component: ChiefPage,
    fixedTabs: [MISSION_TAB_REGISTRATION, WORKER_TAB_REGISTRATION, EXECUTION_TAB_REGISTRATION],
    headerContent: PanelHeaderContent,
    experimental_sidebarAccessory: SidebarAccessory,
  });

  // The other half of the board's Address: the composer of the chief thread is
  // the only place a plugin can write into that thread's draft, so the surface
  // that inserts the parked text has to be mounted here. It only ever writes a
  // draft; nothing in this plugin sends a message as the user.
  app.composer.customize({
    id: "board-insert",
    scopes: ["thread"],
    banners: [{ id: "board-draft", chrome: "bare", component: ComposerBoardInsert }],
  });

  app.slots.homepageSection({
    id: "overview",
    title: "Chief of Staff",
    component: HomepageSection,
  });

  app.slots.experimental_threadHeaderAction({
    id: "cos",
    title: "Chief of Staff",
    component: ThreadHeaderAction,
  });

  app.slots.commandPaletteAction({
    id: "cos-open",
    title: "Chief of Staff: open",
    run() {
      openChiefPage();
    },
  });

  app.slots.commandPaletteAction({
    id: "cos-delegate",
    title: "Chief of Staff: delegate a task",
    run() {
      openChiefPage(DELEGATE_SUBPATH);
    },
  });

  app.slots.commandPaletteAction({
    id: "cos-import-session",
    title: "Chief of Staff: import an external Claude session",
    run() {
      openChiefPage(SESSIONS_SUBPATH);
    },
  });

  // One glyph per sidebar row saying what the thread is. The host keeps
  // rendering the list; this only decorates it.
  app.contentScripts.register({
    id: "row-marks",
    mount: mountRowMarks,
  });

  app.slots.commandPaletteAction({
    id: "cos-adopt",
    title: "Chief of Staff: adopt this thread as a worker",
    isAvailable(context) {
      return context.threadId !== null;
    },
    run(context) {
      if (context.threadId === null) return;
      openChiefPage(`${ADOPT_SUBPATH_PREFIX}${context.threadId}`);
    },
  });
});
