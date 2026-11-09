// The Board as teams.
//
// It opens with one sentence answering "do I need to do anything", then one
// line per team with a roll-up, so the managers are visible, and opens only the
// teams holding something for the user. A member row says what the worker is
// doing, in words; the model lives in the row's title attribute and the
// Execution tab, because it is a setting, not news.
//
// Every rule that decides what shows is in teams.ts, where it is tested. This
// file lays it out and wires the board's actions.
import { useMemo, useState } from "react";
import type { WorkerStatus } from "@/contract";
import { cn } from "@/lib/utils";
import { TEXT_ATTENTION, TEXT_TERTIARY, TEXT_URGENT } from "./tone";
import { WorkerMark } from "./avatar";
import { StatusDot } from "./status-dot";
import { Glyph } from "./glyph";
import { Age, BAR_WORD_HIT_AREA, ChoiceWord, Elapsed, QuietButton, useIsFingerSurface } from "./ui";
import { RowActions, type RowActionItem } from "./row-actions";
import { displayName, executionLabel, rowUrgency, workerStatus } from "./use-cos";
import {
  boardSentence,
  groupTeams,
  isBlocked,
  isWorking,
  memberLine,
  rollLine,
  wantsUser,
  type Team,
  type TeamLevel,
} from "./teams";

const TONE: Record<TeamLevel, string | undefined> = {
  urgent: TEXT_URGENT,
  attention: TEXT_ATTENTION,
  active: undefined,
  neutral: undefined,
};

export interface TeamsActions {
  onOpen: (threadId: string) => void;
  onThread: (threadId: string) => void;
  onAnswer: (worker: WorkerStatus) => void;
  onChoose: (worker: WorkerStatus, label: string) => void;
  onAskChief: (worker: WorkerStatus) => void;
  onDismiss: (worker: WorkerStatus) => void;
  onUndismiss: (worker: WorkerStatus) => void;
  onStop: (worker: WorkerStatus) => void;
  onRetry: (worker: WorkerStatus) => void;
  onRetire: (worker: WorkerStatus) => void;
}

/**
 * The opening sentence. Built from the same rows as the teams, so it cannot
 * disagree with them.
 *
 * `outside` counts the things that need the user and are NOT workers: a thread
 * blocked on a permission prompt, drawn in its own row above. Without it the
 * sentence would say "Nothing needs you." directly under a red "needs
 * approval" row, answering the one question it exists for with the wrong
 * answer.
 */
function Sentence({
  workers,
  outside,
  onOpen,
}: {
  workers: readonly WorkerStatus[];
  outside: number;
  onOpen: (threadId: string) => void;
}) {
  const sentence = boardSentence(workers);
  const total = sentence.needs.length + sentence.moreNeeds + outside;
  const finger = useIsFingerSurface();
  const byId = new Map(workers.map((w) => [w.id, w]));
  const working = sentence.working;
  return (
    <p className="py-3 text-[14px] leading-6 text-foreground">
      {total === 0 ? (
        "Nothing needs you."
      ) : sentence.quiet ? (
        // Only non-worker items: they are named in their own row above.
        outside === 1 ? "One thread above needs you." : `${outside} threads above need you.`
      ) : (
        <>
          {total === 1 ? "One thing needs you: " : `${total} things need you: `}
          {sentence.needs.map((need, i) => {
            const worker = byId.get(need.id);
            return (
              <span key={need.id}>
                {i === 0 ? null : sentence.moreNeeds + outside === 0 && i === sentence.needs.length - 1 ? " and " : ", "}
                <button
                  type="button"
                  className={cn(
                    "underline decoration-current/40 underline-offset-4 hover:decoration-current",
                    // Only the first named need carries colour, one per line.
                    i === 0 ? TONE[need.tone] : "text-foreground",
                    // The hit area grows without moving the text: a button is
                    // inline-block, so plain padding would widen the line box
                    // and push the sentence's wrapped lines far apart.
                    finger && "-my-2.5 inline-block py-2.5",
                  )}
                  onClick={() => worker && onOpen(worker.threadId)}
                >
                  {need.name} {need.what}
                </button>
              </span>
            );
          })}
          {sentence.moreNeeds + outside > 0 ? `, and ${sentence.moreNeeds + outside} more` : null}.
        </>
      )}{" "}
      <span className="text-muted-foreground">
        {working.length === 0
          ? "Nobody is working."
          : working.length <= 3
            ? `${working.join(", ")} ${working.length === 1 ? "is" : "are"} working.`
            : `${working.length} are working.`}
      </span>
    </p>
  );
}

function MemberRow({
  worker,
  actions,
  now,
}: {
  worker: WorkerStatus;
  actions: TeamsActions;
  now: number;
}) {
  const finger = useIsFingerSurface();
  const line = memberLine(worker, now);
  // A worker stopped on a prompt is answered the same way as one with a Need,
  // but Ask chief and Dismiss need a Need line to carry: on a prompt with none,
  // Ask chief would send "Decision on X: " with nothing after it.
  const needy = wantsUser(worker) || isBlocked(worker);
  const hasNeed = wantsUser(worker);
  const working = isWorking(worker);
  const items: RowActionItem[] = [
    ...(needy ? [{ id: "answer", label: "Answer", run: () => actions.onAnswer(worker) }] : []),
    { id: "thread", label: "Open thread", run: () => actions.onThread(worker.threadId) },
    ...(hasNeed
      ? [
          { id: "ask-chief", label: "Ask chief", run: () => actions.onAskChief(worker) },
          { id: "dismiss", label: "Dismiss need", run: () => actions.onDismiss(worker) },
        ]
      : []),
    ...(worker.needDismissed ? [{ id: "undismiss", label: "Restore need", run: () => actions.onUndismiss(worker) }] : []),
    ...(working ? [{ id: "stop", label: "Stop turn", run: () => actions.onStop(worker) }] : []),
    ...(!working && worker.retryable ? [{ id: "retry", label: "Retry brief", run: () => actions.onRetry(worker) }] : []),
    { id: "retire", label: "Retire", run: () => actions.onRetire(worker), tone: "urgent" as const },
  ];
  return (
    <li className="group/member relative grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2.5 py-1.5 pl-6">
      <span className="flex h-5 items-center justify-center">
        <StatusDot status={workerStatus(worker)} urgency={rowUrgency(worker)} />
      </span>
      <div className="min-w-0">
        {/*
          Name and what it is doing, side by side where there is room and
          stacked where there is not. Sharing one line at 390 would truncate
          the state word, which is the one word on the row that must never be
          cut. Stacked, the name and state keep a line of their own and only
          the description gives way.
        */}
        <button
          type="button"
          onClick={() => actions.onOpen(worker.threadId)}
          // The model and effort, off the row and onto hover: a setting, not news.
          title={executionLabel(worker)}
          // Two lines at every width: name and state, then what it is doing.
          // Side by side, the description would take the flexible space and
          // the NAME would be the part that truncates, even in a wide panel.
          // The name is how the row is found, so it gets the line.
          className={cn("flex w-full min-w-0 flex-col text-left", finger && "min-h-11 justify-center")}
        >
          {/*
            The NAME gives way, the state word never does. The line is not
            nowrap as a whole, or at 390 a long name plus "waiting on you"
            would run past its cell and paint under the age and Answer.
          */}
          {/*
            Wide: the state word sits after the name. Narrow (under 520): it
            opens the second line instead, because beside the name at 390 it
            would cut a two-word name to its first word while the description
            line below has room. Either way the state word is never cut and the name
            is the first thing on the row.
          */}
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">{displayName(worker)}</span>
            {line.state === null ? null : (
              <span className={cn("hidden shrink-0 whitespace-nowrap text-[12px] @[520px]/cos:inline", TONE[line.tone] ?? "text-foreground")}>
                {line.state}
              </span>
            )}
          </span>
          {line.text === "" && line.state === null ? null : (
            <span
              className={cn(
                "flex min-w-0 items-baseline gap-2 text-[12px] leading-5",
                // A question to the user goes UNDER the state word, so it gets the
                // row's full width: beside "waiting on you" at 390 it would
                // have a column two words wide. At 520 and up the state word
                // on this line is hidden, so stacking changes nothing there
                // and the name keeps its own line.
                needy && "flex-col gap-0",
              )}
            >
              {line.state === null ? null : (
                <span className={cn("shrink-0 whitespace-nowrap @[520px]/cos:hidden", TONE[line.tone] ?? "text-foreground")}>
                  {line.state}
                </span>
              )}
              {line.text === "" ? null : (
                <span
                  className={cn(
                    "min-w-0 text-muted-foreground",
                    // A question to the user gets two lines under 520px: one
                    // line after "waiting on you" leaves only two words of it
                    // at 390. Everything else stays one line, so a quiet row
                    // is no taller than it needs to be.
                    needy ? "line-clamp-2 @[520px]/cos:line-clamp-1" : "truncate",
                  )}
                >
                  {line.text}
                </span>
              )}
            </span>
          )}
        </button>
        {needy && worker.needChoices.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-2">
            {worker.needChoices.map((label) => (
              <ChoiceWord key={label} label={label} tabIndex={0} onChoose={() => actions.onChoose(worker, label)} />
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <span className={cn("text-[11px] tabular-nums", line.tone === "urgent" ? TEXT_URGENT : TEXT_TERTIARY)}>
          {working && worker.turnStartedAt !== null ? (
            <Elapsed since={worker.turnStartedAt} />
          ) : (
            <Age at={worker.lastReportAt ?? worker.lastUsedAt} tone={line.tone === "urgent" ? "urgent" : "tertiary"} />
          )}
        </span>
        {needy ? (
          <QuietButton tone="primary" className={finger ? BAR_WORD_HIT_AREA : undefined} onClick={() => actions.onAnswer(worker)}>
            Answer
          </QuietButton>
        ) : null}
        {/*
          28px under a pointer, 44 under a finger. The default trigger is the
          finger size everywhere, which would make every member row 56px tall
          on a desktop while holding one line of text. A pointer caller
          shrinks it, as the For you list does.
        */}
        <RowActions
          ariaLabel={`Actions for ${displayName(worker)}`}
          items={items}
          triggerClassName={finger ? undefined : "h-7 w-7 -mr-1"}
        />
      </div>
    </li>
  );
}

function TeamBlock({
  team,
  open,
  onToggle,
  actions,
  now,
}: {
  team: Team<WorkerStatus>;
  open: boolean;
  onToggle: () => void;
  actions: TeamsActions;
  now: number;
}) {
  const roll = rollLine(team);
  const finger = useIsFingerSurface();
  return (
    <section className="border-b border-border">
      <div className="flex items-center gap-2">
        {/* The padding is ON the button, so the whole line toggles, and 44px on a finger. */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cn(
            "flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-0.5 py-2.5 text-left",
            finger && "min-h-11",
          )}
        >
          <Glyph name="chevron" rotate={open ? 90 : 0} className={cn("size-2.5 shrink-0", TEXT_TERTIARY)} />
          {team.manager === null ? null : <WorkerMark avatar={team.manager.avatar} />}
          <span className="shrink-0 text-[13px] font-semibold text-foreground">{team.label}</span>
          <span className={cn("min-w-0 text-[12px] leading-5 @[520px]/cos:truncate", TEXT_TERTIARY)}>
            {roll.map((part, i) => (
              <span key={part.text}>
                {i === 0 ? null : " · "}
                {/* rollLine colours only the loudest part. */}
                <span className={TONE[part.tone]}>{part.text}</span>
              </span>
            ))}
          </span>
        </button>
        {/* The manager is a worker too: its own thread is one word away. */}
        {team.manager === null ? null : (
          <QuietButton
            onClick={() => actions.onOpen(team.manager!.threadId)}
            ariaLabel={`Open ${team.label}`}
            className={finger ? BAR_WORD_HIT_AREA : undefined}
          >
            Open
          </QuietButton>
        )}
      </div>
      {open ? (
        <ul className="pb-2" aria-label={team.label}>
          {/*
            The manager's own trouble, shown as the first row of its team. A
            failed manager is the loudest thing on the Board, and burying it in
            the team line alone would make it one word among a roll-up.
          */}
          {team.manager !== null &&
          (wantsUser(team.manager) || isBlocked(team.manager) || team.manager.failed || team.manager.missing) ? (
            <MemberRow worker={team.manager} actions={actions} now={now} />
          ) : null}
          {team.members.map((worker) => (
            <MemberRow key={worker.id} worker={worker} actions={actions} now={now} />
          ))}
          {team.members.length === 0 ? (
            <li className={cn("py-1.5 pl-6 text-[12px]", TEXT_TERTIARY)}>No one on this team yet.</li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}

export function TeamsView({
  workers,
  actions,
  outsideNeeds = 0,
}: {
  workers: readonly WorkerStatus[];
  actions: TeamsActions;
  /** Things above the teams that need the user and are not workers (blocked threads). */
  outsideNeeds?: number;
}) {
  const teams = useMemo(() => groupTeams(workers), [workers]);
  // The user's own open/closed choice beats the default, per team, for this visit.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const now = Date.now();
  const keyOf = (team: Team) => team.id ?? "chief";
  return (
    <div className="@[860px]/cos:max-w-[860px]">
      <Sentence workers={workers.filter((w) => !w.retired)} outside={outsideNeeds} onOpen={actions.onOpen} />
      <div className="border-t border-border">
        {teams.map((team) => {
          const key = keyOf(team);
          const open = overrides.get(key) ?? team.open;
          return (
            <TeamBlock
              key={key}
              team={team}
              open={open}
              onToggle={() => setOverrides((current) => new Map(current).set(key, !open))}
              actions={actions}
              now={now}
            />
          );
        })}
      </div>
    </div>
  );
}
