// Execution: what every thread runs at, and the one place to change it.
//
// The whole value of the surface is that the number on it is the number that
// holds. bb's composer picker sets a PER-TURN override, so it can display a
// level the next turn contradicts; when it reverts, it lands on the thread's
// stored value. This panel reads and writes the STORED override,
// `bb.sdk.threads.update`, which is the value every turn uses unless that
// composer overrides it for one turn.
//
// Three rules it does not break.
//
// 1. It reads the thread, never the roster. The thread is the only source of
//    these values; a cached copy would lag it.
// 2. It never writes on its own. No sync, no reconcile, no repairing a level it
//    thinks is wrong. The user changes a value, the panel writes exactly that value
//    and reads it back. A surface that silently corrects its own inputs is a
//    control nobody can trust.
// 3. A thread it could not read is never drawn as a thread with nothing set.
//
// A model change here is a sticky override on the SAME thread, not a remodel:
// no new thread, no handover, nothing archived. That makes it cheap and
// reversible, so the batch form follows the board's own
// shape - apply, then an undo strip holding the previous values - rather than a
// confirm dialog. `cos_remodel`, which does replace a worker's thread, lives
// on the Mission tab; it is a different action and it is not hidden behind a
// picker that looks like a setting.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { ExecutionRowDto } from "@/contract";
import { cn } from "@/lib/utils";
import {
  BAR_WORD_HIT_AREA,
  EmptyState,
  LevelDot,
  NameLine,
  QuietButton,
  Row,
  RowDetail,
  RowList,
  SectionLabel,
  SelectBox,
  StaleNote,
  useIsFingerSurface,
  useRovingRows,
} from "./ui";
import { RowActions } from "./row-actions";
import { TEXT_TERTIARY } from "./tone";
import { errorText, useCosRpc, useExecutionList } from "./use-cos";
import { modelDisplay, reasoningChoices, reasoningLabel } from "./execution-options";
import type { CatalogModel, CatalogProvider, PermissionMode, ReasoningLevel } from "./execution-options";
import { effortDisplay, WORKER_REASONING_LEVELS } from "./execution-levels";
import {
  cellFor,
  contextCell,
  effortCellText,
  groupByManager,
  levelMoveNote,
  matchesFilter,
  permissionCell,
  previewModelChange,
  sharedModels,
  type Cell,
  type ContextCell,
  type MoveRow,
  type PermissionCell,
} from "./execution-rows";

/**
 * What this surface is, printed once, at the foot.
 *
 * It does not say "the level stored on the thread", which is not quite true,
 * and this panel is the wrong place to be not quite true. A thread often has
 * no `model_override` or `reasoning_level_override` at all, yet every row
 * shows a model and a level, because `defaultExecutionOptions` returns the
 * RESOLVED value - the stored override when there is one, and the last
 * requested turn's value when there is not. Writing through this panel sets
 * the override and the resolved value moves with it immediately.
 *
 * So the honest claim is about what happens next, not about where it is kept,
 * and that is also the claim the reader actually needs.
 */
const BOUNDARY_LINE =
  "This is what the next turn will run at. The picker in the composer only lasts one turn.";

/** The levels this plugin will set. `none` and `ultra` are deliberately not here (core.ts). */
const OFFERED = new Set<string>(WORKER_REASONING_LEVELS);

/** The before-values of one batch, enough to put them all back. */
interface Undo {
  label: string;
  /** `undefined` means this write did not touch that field, so undo must not either. */
  restore: { threadId: string; model?: string | null; reasoningLevel?: string | null }[];
}

/** The value a cell prints, and the tone it prints it in. */
function cellText(cell: Cell, render: (value: string) => string): { text: string; muted: boolean } {
  if (cell.kind === "unreadable") return { text: "could not read", muted: true };
  if (cell.kind === "unset") return { text: "provider default", muted: true };
  return { text: render(cell.value), muted: false };
}

export function ExecutionTab() {
  const live = useExecutionList();
  const rpc = useCosRpc();
  const finger = useIsFingerSurface();

  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [lastPicked, setLastPicked] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [busy, setBusy] = useState(false);
  /** What was typed into the find box. A long roster is too many threads to scan. */
  const [query, setQuery] = useState("");

  const rows = useMemo(() => live.data?.rows ?? [], [live.data]);
  const catalogs = useMemo(() => {
    const map = new Map<string, { models: CatalogModel[]; provider: CatalogProvider | null }>();
    for (const c of live.data?.catalogs ?? []) {
      map.set(c.key, {
        models: c.models as CatalogModel[],
        provider: c.providerReasoningLevels
          ? { reasoningLevels: c.providerReasoningLevels, capabilities: { permissionModes: [] } }
          : null,
      });
    }
    return map;
  }, [live.data]);

  // What the list actually shows. The chief row is never filtered out by a
  // query it does not match: it is the one row that is always relevant, and
  // hiding it makes the panel look like it lost the chief.
  const visible = useMemo(
    () => rows.filter((r) => r.kind === "chief" || matchesFilter(r, query)),
    [rows, query],
  );
  const groups = useMemo(() => groupByManager(visible), [visible]);

  // THE RENDERED ORDER, not the server's. What is drawn is filtered by the
  // find box and regrouped into Chief / Managers / each team / reporting to the
  // chief, so a key from `rows` in roster order could be one the list does not
  // render: `focusRow` would set activeKey and then look for a
  // `[data-cos-row]` that is not there, leaving DOM focus where it was and
  // every rendered row at tabIndex -1, which costs the list its tab stop.
  const navigation = useRovingRows(groups.flatMap((g) => g.rows.map((r) => r.threadId)));

  const chosen = rows.filter((r) => selected.has(r.threadId));

  const toggle = (id: string, next: boolean) => {
    setLastPicked(id);
    setSelected((was) => {
      const copy = new Set(was);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  };

  // Shift-click selects the run between the last box clicked and this one.
  const pickRun = (id: string) => {
    const from = rows.findIndex((r) => r.threadId === (lastPicked ?? id));
    const to = rows.findIndex((r) => r.threadId === id);
    if (from < 0 || to < 0) return;
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    setSelected((was) => {
      const copy = new Set(was);
      for (let i = lo; i <= hi; i += 1) {
        const key = rows[i]?.threadId;
        if (key !== undefined) copy.add(key);
      }
      return copy;
    });
    setLastPicked(id);
  };

  const leaveSelection = () => {
    setSelecting(false);
    setSelected(new Set());
    setLastPicked(null);
  };

  /**
   * Write one field to one thread and read it back.
   *
   * `thread_execution_set` is the same call the per-thread execution bar makes,
   * so there is one write path for the stored override rather than two that can
   * drift.
   */
  const write = async (
    // `permissionMode` is in the type because the batch Permission button
    // passes it. The array comes from a `.map`, so TypeScript's
    // excess-property check never runs on it; without the field here it would
    // travel to the server while `before` below captured nothing for it. See
    // `undoable` at the Permission call site.
    targets: {
      threadId: string;
      model?: string;
      reasoningLevel?: ReasoningLevel;
      permissionMode?: PermissionMode;
    }[],
    label: string,
    { undoable = true }: { undoable?: boolean } = {},
  ) => {
    if (targets.length === 0) return;
    // Capture only the fields this write actually sets. Restoring a field the
    // change never touched is how an undo turns into an edit: putting back a
    // model that a level-only change did not set PINS it where it had been
    // inherited, or fails outright when the thread is running a model its
    // catalog no longer offers.
    const before = targets.map((target) => {
      const row = rows.find((r) => r.threadId === target.threadId);
      return {
        threadId: target.threadId,
        model: target.model === undefined ? undefined : (row?.model ?? null),
        reasoningLevel:
          target.reasoningLevel === undefined ? undefined : (row?.reasoningLevel ?? null),
      };
    });
    setBusy(true);
    let failed = 0;
    for (const target of targets) {
      try {
        await rpc.call("thread_execution_set", target);
      } catch (cause) {
        failed += 1;
        toast.error(errorText(cause));
      }
    }
    setBusy(false);
    live.refetch();
    // Only offer to put back what actually moved. A batch where every write
    // failed has nothing to undo, and saying otherwise would report success
    // without doing the work.
    if (undoable && failed < targets.length) setUndo({ label, restore: before });
    if (failed > 0) toast.error(`${failed} of ${targets.length} did not change.`);
    return failed;
  };

  const runUndo = async () => {
    if (undo === null) return;
    const targets = undo.restore.map((b) => ({
      threadId: b.threadId,
      ...(b.model === undefined || b.model === null ? {} : { model: b.model }),
      ...(b.reasoningLevel === undefined || b.reasoningLevel === null
        ? {}
        : { reasoningLevel: b.reasoningLevel as ReasoningLevel }),
    }));
    const failed = await write(targets, "", { undoable: false });
    // An undo that could not put everything back keeps its strip. When the
    // restore is refused (an HTTP 400, say) the rows stay changed, and the one
    // control that can try again must not have removed itself.
    if (failed === 0) setUndo(null);
    else toast.error("Could not put everything back. The undo is still there.");
  };

  // ---------- batch ----------

  // THE INTERSECTION, not the union. bb refuses a model the target thread's
  // catalog does not offer ("changing providers requires starting a new
  // thread", HTTP 400), so a union would offer choices that cannot be taken:
  // select one claude-code worker and one acp-cursor worker and every model is
  // wrong for one of them. `sharedModels` also treats an unresolved catalog as
  // sharing nothing, because offering a model a thread may refuse is exactly
  // what this prevents.
  const batchModels = useMemo(
    () =>
      sharedModels(
        chosen.map((row) => {
          const catalog = row.catalogKey === null ? undefined : catalogs.get(row.catalogKey);
          return catalog?.models ?? null;
        }),
      ),
    [chosen, catalogs],
  );

  const moveRows: MoveRow[] = chosen.map((r) => ({
    id: r.threadId,
    name: r.name,
    fromModel: r.model,
    fromLevel: r.reasoningLevel,
  }));

  const applyModel = async (model: string) => {
    // The level is computed here and written EXPLICITLY, with the same function
    // `cos_remodel` uses, so what the preview said is what lands. Left implicit,
    // the server would apply its own different rule (`reasoningForModel`) and
    // the preview would be a guess about a second code path.
    const moves = previewModelChange(moveRows, model, null, "high");
    await write(
      moves.map((m) => ({ threadId: m.id, model, reasoningLevel: m.toLevel as ReasoningLevel })),
      `${moves.length} moved to ${labelForModel(model)}`,
    );
    leaveSelection();
  };

  const applyLevel = async (level: string) => {
    await write(
      chosen.map((r) => ({ threadId: r.threadId, reasoningLevel: level as ReasoningLevel })),
      `${chosen.length} set to ${level}`,
    );
    leaveSelection();
  };

  const labelForModel = (model: string): string => {
    for (const catalog of catalogs.values()) {
      const hit = catalog.models.find((m) => m.model === model);
      if (hit) return hit.displayName;
    }
    return modelDisplay(model, []);
  };

  if (live.error !== null && live.data === null) {
    return <EmptyState title="Could not read the threads" detail={live.error} action={<QuietButton onClick={live.refetch}>Retry</QuietButton>} />;
  }
  if (live.data === null) return null;
  if (rows.length === 0) {
    return <EmptyState title="No threads to set" detail="The roster has no live workers and there is no chief thread yet." />;
  }

  return (
    <div className="@container/cos flex flex-col gap-3">
      {live.stale ? <StaleNote error={live.error ?? "The last refresh failed."} onRetry={live.refetch} /> : null}

      <div className="sticky -top-3 z-20 -mx-4 -mt-3 border-b border-border bg-background px-4 pb-2 pt-3">
        <SectionLabel
          label="What each thread runs at"
          action={
            <QuietButton
              onClick={() => (selecting ? leaveSelection() : setSelecting(true))}
              className={finger ? BAR_WORD_HIT_AREA : undefined}
            >
              {selecting ? "Done" : "Select"}
            </QuietButton>
          }
        />
        {/*
          A FIND BOX. In a long list of threads in an order nobody chose, the
          right worker is hard to find. It matches name, project, model and
          effort, so searching for what is on the screen finds it.
        */}
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a worker, project or model"
          aria-label="Filter the list"
          className={cn(
            "mt-2 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5",
            "text-[13px] leading-5 text-foreground placeholder:text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        />
        {selecting || selected.size > 0 ? (
          <div className={cn("mt-1 flex flex-wrap items-center gap-x-3", finger ? "gap-y-4" : "gap-y-1")}>
            <span aria-live="polite" className={cn("text-[12px] leading-5", TEXT_TERTIARY)}>
              {chosen.length} selected
            </span>
            <QuietButton
              // What is on screen, not every row. With a filter applied, "All"
              // meaning "every row, including the ones filtered out" would be
              // a batch larger than what the filter shows.
              onClick={() => setSelected(new Set(visible.map((r) => r.threadId)))}
              className={finger ? BAR_WORD_HIT_AREA : undefined}
            >
              All
            </QuietButton>
            <QuietButton
              onClick={() => setSelected(new Set())}
              className={finger ? BAR_WORD_HIT_AREA : undefined}
            >
              Clear
            </QuietButton>
            <RowActions
              align="left"
              ariaLabel="Set the model for the selected threads"
              triggerContent={<span className="text-[12px] leading-5 text-primary">Model</span>}
              triggerClassName={finger ? BAR_WORD_HIT_AREA : undefined}
              items={
                chosen.length === 0
                  ? []
                  : batchModels.length === 0
                    ? [
                        {
                          id: "none",
                          // A real answer, not an empty menu: these threads are
                          // on different providers and bb refuses a model the
                          // target's catalog does not list.
                          label: "These threads share no model. Select one provider's threads.",
                          run: () => undefined,
                        },
                      ]
                    : batchModels.map((m) => {
                      // The consequence is read at the moment of choosing,
                      // which is the only moment it can change a mind.
                      const note = levelMoveNote(previewModelChange(moveRows, m.value, null, "high"));
                      return {
                        id: m.value,
                        label: note === null ? m.label : `${m.label} · ${note}`,
                        run: () => void applyModel(m.value),
                      };
                    })
              }
            />
            {/*
              PERMISSION, applied to a whole selection in one step, so a thread
              and all its children can share one mode. With the rows grouped by manager, selecting a team and
              picking full here IS "apply to team", and it writes through the
              same `thread_execution_set` the bar already uses rather than
              adding a second path to the same setting.
            */}
            <RowActions
              align="left"
              ariaLabel="Set the permission mode for the selected threads"
              triggerContent={<span className="text-[12px] leading-5 text-primary">Permission</span>}
              triggerClassName={finger ? BAR_WORD_HIT_AREA : undefined}
              items={
                chosen.length === 0
                  ? []
                  : (["full", "auto", "accept-edits"] as const).map((mode) => ({
                      id: mode,
                      label: mode,
                      run: () =>
                        void write(
                          chosen.map((r) => ({ threadId: r.threadId, permissionMode: mode })),
                          `${chosen.length} set to ${mode}`,
                          // NO UNDO, because there is nothing to put back. The
                          // row carries no permission mode, so `before` has no
                          // previous value to capture, and an undo would build
                          // `{threadId}` with no writable field: the calls
                          // would write nothing and the strip would disappear
                          // as though the restore had worked. Offering an undo
                          // that cannot run is the same "reported success
                          // without doing the work" this file guards against
                          // above.
                          { undoable: false },
                        ),
                    }))
              }
            />
            <RowActions
              align="left"
              ariaLabel="Set the effort level for the selected threads"
              triggerContent={<span className="text-[12px] leading-5 text-primary">Effort</span>}
              triggerClassName={finger ? BAR_WORD_HIT_AREA : undefined}
              items={
                chosen.length === 0
                  ? []
                  : WORKER_REASONING_LEVELS.map((l) => ({ id: l, label: l, run: () => void applyLevel(l) }))
              }
            />
          </div>
        ) : null}
        {undo !== null ? (
          <div className={cn("mt-1 flex flex-wrap items-center gap-x-3", finger ? "gap-y-4" : "gap-y-1")}>
            <span className={cn("text-[12px] leading-5", TEXT_TERTIARY)}>{undo.label}</span>
            <QuietButton onClick={() => void runUndo()} className={finger ? BAR_WORD_HIT_AREA : undefined}>
              Undo
            </QuietButton>
            <QuietButton onClick={() => setUndo(null)} className={finger ? BAR_WORD_HIT_AREA : undefined}>
              Keep
            </QuietButton>
          </div>
        ) : null}
      </div>

      <RowList ariaLabel="Threads and what they run at" {...navigation.containerProps}>
        {groups.map((group) => (
          <div key={group.title}>
            {/*
              One heading per group, which is the organisation the fleet already
              has: the chief, the managers, each manager's team, then whatever
              reports to the chief directly, because a flat list in an
              arbitrary order cannot be scanned.
            */}
            <p className={cn("px-1 pb-1 pt-3 text-[11px] uppercase tracking-wide", TEXT_TERTIARY)}>
              {group.title}
            </p>
            {group.rows.map((row) => (
          <ExecutionRow
            key={row.threadId}
            row={row}
            catalog={row.catalogKey === null ? undefined : catalogs.get(row.catalogKey)}
            selecting={selecting}
            anySelected={selected.size > 0}
            selected={selected.has(row.threadId)}
            busy={busy}
            tabIndex={navigation.tabIndexFor(row.threadId)}
            onToggle={(next) => toggle(row.threadId, next)}
            onShiftToggle={() => pickRun(row.threadId)}
            // NO NAVIGATION FROM THIS TAB. The row is a full-bleed hit area
            // sitting under two pickers, so if it opened the worker thread,
            // every near-miss on Model or Effort would leave the panel the
            // user is working down - the most expensive possible outcome for
            // the most likely slip.
            //
            // It toggles the checkbox instead of doing nothing. A dead row
            // would stop the navigation and leave the misclick unexplained;
            // this makes the same slip do the useful thing on a tab whose
            // point is changing several threads at once, and it is undone by
            // clicking again.
            onOpen={() => toggle(row.threadId, !selected.has(row.threadId))}
            onSet={(patch) => void write([{ threadId: row.threadId, ...patch }], `${row.name} changed`)}
          />
            ))}
          </div>
        ))}
        {visible.length === 0 ? (
          <p className={cn("px-1 py-3 text-[13px] leading-5", TEXT_TERTIARY)}>
            Nothing matches “{query}”.
          </p>
        ) : null}
      </RowList>

      <p className={cn("px-1 pb-2 text-[12px] leading-5", TEXT_TERTIARY)}>{BOUNDARY_LINE}</p>
    </div>
  );
}

function ExecutionRow({
  row,
  catalog,
  selecting,
  anySelected,
  selected,
  busy,
  tabIndex,
  onToggle,
  onShiftToggle,
  onOpen,
  onSet,
}: {
  row: ExecutionRowDto;
  catalog?: { models: CatalogModel[]; provider: CatalogProvider | null };
  selecting: boolean;
  /** Anything checked anywhere: keeps every box solid while a batch is built. */
  anySelected: boolean;
  selected: boolean;
  busy: boolean;
  tabIndex: number;
  onToggle: (next: boolean) => void;
  onShiftToggle: () => void;
  onOpen: () => void;
  onSet: (patch: { model?: string; reasoningLevel?: ReasoningLevel }) => void;
}) {
  const finger = useIsFingerSurface();
  const models = catalog?.models ?? [];
  const modelCell = cellFor(row.readOk ? { ok: true, value: row.model } : { ok: false });
  const levelCell = cellFor(row.readOk ? { ok: true, value: row.reasoningLevel } : { ok: false });

  const modelShown = cellText(modelCell, (v) => modelDisplay(v, models));
  // THROUGH `effortDisplay`, the one answer to "what effort is this worker
  // really running at". Its `opaque` must never be printed as a level: for
  // acp-cursor workers that would show bb's stored level as a plain word with
  // a picker under it, while the Mission and Worker tabs, which route through
  // the same function, say "(effort not visible to bb)" about the same
  // workers. Two surfaces of one plugin must not disagree about one worker.
  //
  // `unreadable` still wins, because "could not look" and "looked and cannot
  // know" are different answers and collapsing them is the defect this panel
  // exists to prevent. The picker stays enabled on purpose: bb's stored level
  // is a real stored value, and a later acp-cursor may honour it.
  const levelShown = effortCellText(
    levelCell,
    effortDisplay(row.providerId, row.model, row.reasoningLevel),
    (v) => reasoningLabel(v as ReasoningLevel, catalog?.provider ?? null),
  );

  // The row speaks for itself only when the panel could not read it, which is
  // the case the user has to act on: nothing shown is that thread's real setting and
  // no control on the row will work. A row the panel did read needs no word of
  // its own.
  const level = modelCell.kind === "unreadable" ? "urgent" : "neutral";
  const note =
    modelCell.kind === "unreadable"
      ? "This thread could not be read, so nothing here is its current setting."
      : null;

  const levelOptions = row.readOk
    ? reasoningChoices(
        (row.reasoningLevel ?? "high") as ReasoningLevel,
        row.model ?? "",
        models,
        catalog?.provider ?? null,
      ).filter((c) => OFFERED.has(c.value) || c.value === row.reasoningLevel)
    : [];

  return (
    <Row
      rowKey={row.threadId}
      tabIndex={tabIndex}
      // No dot on a healthy row. A neutral one would put a column of
      // identical grey dots down a surface where nothing was wrong, which is a
      // column of chrome carrying no information.
      dot={level === "urgent" ? <LevelDot level="urgent" /> : undefined}
      lead={
        // PRESENT ON A POINTER, quiet until wanted, so batch changes look
        // possible: a 12px "Select" word in the header alone hides them. Same
        // treatment as the For you rows: transparent at rest,
        // solid on hover, on focus, and whenever anything is checked.
        //
        // On a finger there is no hover, so a transparent box would only be a
        // 44px hole pushing every name right of its heading.
        // There the box takes its space only in selection, which the header's
        // "Select" opens.
        finger && !(selecting || anySelected) ? undefined : (
        <div
          className={cn(
            "transition-opacity",
            selecting || selected || anySelected
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
          )}
        >
          <SelectBox
            checked={selected}
            label={`Select ${row.name}`}
            tabIndex={tabIndex}
            onChange={onToggle}
            onShiftChange={onShiftToggle}
          />
        </div>
        )
      }
      title={
        <NameLine
          name={row.name}
          nameSize={13}
          // The chief's row needs no note: "Chief of Staff" is already the name.
          note={row.kind === "chief" ? undefined : (row.project ?? undefined)}
        />
      }
      body={note === null ? undefined : <RowDetail text={note} clamp="none" size="sm" tone="muted" />}
      extra={
        // The value IS the control: the user reads "Fable 5.1" and taps the same word
        // to change it. Both live in `extra` because it is the only part of the
        // text column that takes a tap; in `title` or `body` they would render,
        // highlight, and do nothing on a finger (ui.tsx).
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <PickWord
            label="Model"
            value={modelShown.text}
            muted={modelShown.muted}
            disabled={busy || !row.readOk || models.length === 0}
            selectedId={row.model ?? undefined}
            title={row.model ?? undefined}
            options={models.map((m) => ({ id: m.model, label: m.displayName }))}
            onPick={(id) => onSet({ model: id })}
            subject={row.name}
          />
          {/*
            CONTEXT, and unknown is a real answer. A thread running out of
            context should be seen coming, and bb's own ring draws nothing at
            0%, so a thread with no reading looks exactly like a thread that
            is fine; this prints the word instead.
            Thresholds are bb's own, 75 and 90, so the panel and the host agree
            about when a thread is in trouble.
          */}
          <ContextWord cell={contextCell(row.contextUsedTokens, row.contextWindow)} />
          <PickWord
            label="Effort"
            value={levelShown.text}
            muted={levelShown.muted}
            disabled={busy || !row.readOk || levelOptions.length === 0}
            selectedId={row.reasoningLevel ?? undefined}
            options={levelOptions.map((c) => ({ id: c.value, label: c.short }))}
            onPick={(id) => onSet({ reasoningLevel: id as ReasoningLevel })}
            subject={row.name}
          />
          {/*
            PERMISSION, read at render time like the model, so the permission
            level of each worker is visible. What bb resolves for the user's next turn, plus the
            dispatch mode when the two differ. Below full is flagged, except a
            thread kept there on purpose. The batch Permission button above
            is how it is changed.
          */}
          <PermissionWord
            cell={permissionCell({
              threadId: row.threadId,
              resolved: row.permissionMode,
              plugin: row.pluginPermissionMode,
            })}
          />
        </div>
      }
      // The full-bleed hit area SELECTS; it does not open the thread. The row
      // carries two pickers, and every near-miss on Model or Effort would
      // otherwise navigate out of the panel the user is working down.
      onOpen={onOpen}
      openLabel={`Select ${row.name}`}
    />
  );
}

/** The permission a thread runs at, flagged when it is below full and not a chosen exception. */
function PermissionWord({ cell }: { cell: PermissionCell }) {
  if (cell.kind === "unknown") {
    return (
      <span title="bb did not say what this thread runs at." className={cn("text-[12px] leading-5", TEXT_TERTIARY)}>
        <span className="sr-only">Permission </span>unknown
      </span>
    );
  }
  const title =
    cell.tone === "exception"
      ? "Kept below full on purpose. The user chose this; it is not a problem."
      : cell.tone === "warning"
        ? "Not full permission. Your own turns here will ask before acting."
        : "Full permission.";
  return (
    <span
      title={title}
      className={cn(
        "text-[12px] leading-5",
        cell.tone === "warning" ? "text-warning-text" : TEXT_TERTIARY,
      )}
    >
      <span className="sr-only">Permission </span>
      {cell.text}
      {cell.tone === "exception" ? <span className={TEXT_TERTIARY}> · by choice</span> : null}
    </span>
  );
}

/**
 * How full a thread's context is, or that nobody knows.
 *
 * The percent is the only comparable figure: a `[1m]` model reports a 1,000,000
 * window and the others 200,000, so the same token count is 80% on one thread
 * and 16% on another. Showing the raw count alone would invite that mistake.
 */
function ContextWord({ cell }: { cell: ContextCell }) {
  if (cell.kind === "unknown") {
    return (
      <span
        title="bb has not reported context use for this thread yet. Not the same as empty."
        className={cn("text-[12px] leading-5", TEXT_TERTIARY)}
      >
        <span className="sr-only">Context </span>unknown
      </span>
    );
  }
  return (
    <span
      title={`Context window ${cell.percent}% used. Warning above 75, critical above 90.`}
      className={cn(
        "text-[12px] leading-5",
        cell.tone === "danger" ? "text-destructive" : cell.tone === "warning" ? "text-warning-text" : TEXT_TERTIARY,
      )}
    >
      <span className="sr-only">Context </span>
      {cell.percent}%
    </span>
  );
}

/** One value that is also its own picker. A word, never a filled control. */
function PickWord({
  label,
  value,
  muted,
  disabled,
  options,
  selectedId,
  onPick,
  subject,
  title,
}: {
  label: string;
  value: string;
  muted: boolean;
  disabled: boolean;
  options: { id: string; label: string }[];
  selectedId?: string;
  onPick: (id: string) => void;
  subject: string;
  /** The raw id behind a derived name, so the truth is one hover away. */
  title?: string;
}) {
  const finger = useIsFingerSurface();
  if (disabled) {
    return (
      <span title={title} className={cn("text-[12px] leading-5", muted ? TEXT_TERTIARY : "text-foreground")}>
        <span className="sr-only">{label} </span>
        {value}
      </span>
    );
  }
  return (
    <RowActions
      align="left"
      ariaLabel={`${label} for ${subject}`}
      selectedId={selectedId}
      triggerClassName={finger ? BAR_WORD_HIT_AREA : undefined}
      triggerContent={
        <span title={title} className="text-[12px] leading-5">
          {/*
            THE WORD IS FOR A SCREEN READER, NOT FOR THE EYE. "Model" and
            "Effort" are not spelled out on every row: two words per row that
            never change would sit where the two values being compared should
            be. The values are distinguishable without them - one is a
            model name and one is a level - and the accessible name still
            carries the label, both here and in `ariaLabel` above.
          */}
          <span className="sr-only">{label} </span>
          <span className={muted ? TEXT_TERTIARY : "text-primary"}>{value}</span>
        </span>
      }
      items={options.map((o) => ({ id: o.id, label: o.label, run: () => onPick(o.id) }))}
    />
  );
}
