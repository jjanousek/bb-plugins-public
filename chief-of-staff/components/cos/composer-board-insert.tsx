// The other half of Address.
//
// A plugin's composer writes land wherever the plugin's own surface is
// mounted: from the nav panel that is the new-thread draft, not the chief's
// thread. So the board parks the composed text server-side and this component,
// which the host mounts inside the composer of the thread it belongs to, picks
// it up and writes it into that draft.
//
// It never sends. `setText` and `focus` are the whole of what it does, and the
// line it prints says so, because a board that could send on the user's behalf would
// be worse than no board at all.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useBbNavigate,
  useComposer,
  useComposerView,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/contract";
import { relativeTime } from "./format";
import { COS_CHANNEL } from "./use-cos";
import { blocksInText, splitParked, withoutBlocks, type SentDraft } from "./parked-drafts";
import { CHIEF_PANEL_PATH, MISSION_SUBPATH } from "./tabs";
import { TEXT_TERTIARY } from "./tone";
import { QuietButton } from "./ui";
import { cn } from "@/lib/utils";

export function ComposerBoardInsert() {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const view = useComposerView();
  const scope = composer.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const [chief, setChief] = useState<{ read: boolean; threadId: string | null }>({ read: false, threadId: null });
  // How many board items are in a draft right now, from the server, not from
  // what this mount happened to take. Address navigates, which unmounts the
  // composer that took the draft, so local state would lose the line.
  const [drafted, setDrafted] = useState(0);
  // Board text parked for this thread lately, delivered or not, with the state
  // of each item it carried: what lets the line count the blocks really in the
  // text and catch one about an item already closed.
  const [recent, setRecent] = useState<SentDraft[]>([]);
  const busy = useRef(false);
  const navigate = useBbNavigate();

  // A FAILED READ IS NOT "no chief". Setting `chiefThreadId` to null on a
  // failure would look like "there is no chief thread", and the banner below
  // is gated on matching it, so one failed `chief_get` would hide the "items
  // waiting in your draft" line for the life of the mount, with nothing to
  // retry it. That sentence is what this component exists for. `read` stays
  // false on a failure, so the next realtime signal tries again.
  const readChief = useCallback(() => {
    rpc.call("chief_get", null).then(
      (result) => setChief({ read: true, threadId: result.threadId }),
      () => setChief({ read: false, threadId: null }),
    );
  }, [rpc]);
  useEffect(readChief, [readChief]);
  useRealtime(COS_CHANNEL, readChief);

  /** Drafts handed over but not yet seen in this composer's own text. */
  const pending = useRef<{ ids: number[]; body: string } | null>(null);
  // The live draft text, read through a ref so `take` can check it without
  // taking `view.draft.text` as a dependency, which would rebuild the callback
  // on every keystroke and re-poll the server with it.
  const textRef = useRef("");
  textRef.current = view.draft.text;

  const take = useCallback(() => {
    // Any thread this plugin has parked a draft for: the chief's, for a board
    // Address, or a worker's, for one of its own offered answers
    // (`need_answer_draft`). The server hands back nothing for a thread with no
    // draft, so the call is cheap where it does not apply.
    if (threadId === null || busy.current) return;
    busy.current = true;
    rpc.call("board_drafts_recent", { threadId }).then(
      (result) => setRecent(result.drafts),
      // A failed read keeps the last list: it never reads as "nothing closed".
      () => undefined,
    );
    rpc
      .call("board_draft_take", { threadId })
      .then((result) => {
        setDrafted(result.drafted);
        if (result.parts.length === 0) return;
        // ALREADY THERE: do not append it twice. The same thread can be open in
        // more than one surface, and each mount is offered the same parked
        // drafts, because taking does not consume them. Checked one draft at
        // a time: one that landed but was not acked yet must not come back
        // beside a newer one.
        const { present, missing } = splitParked(result.parts, textRef.current);
        if (present.length > 0) {
          void rpc.call("board_draft_ack", { ids: present }).then(
            (acked) => setDrafted(acked.drafted),
            () => undefined,
          );
        }
        if (missing.length === 0) return;
        const body = missing.map((part) => part.body).join("\n\n");
        composer.updateText((current) =>
          current.trim() === "" ? body : `${current.replace(/\s+$/, "")}\n\n${body}`,
        );
        composer.focus();
        // Ack only once the words are visible in this composer's own draft.
        // Until then the draft stays parked, so a write that lands in a
        // composer which is then torn down is retried instead of lost.
        pending.current = { ids: missing.map((part) => part.id), body };
      })
      .catch(() => {
        // A draft that could not be taken stays parked and comes back on the
        // next signal. Nothing is lost and nothing is worth interrupting for.
      })
      .finally(() => {
        busy.current = false;
      });
  }, [composer, rpc, threadId]);

  useEffect(take, [take]);
  useRealtime(COS_CHANNEL, take);

  // RETRY WHEN THE TURN ENDS. Clicking an answer while
  // the chief is already running does not put it in the composer. A write goes
  // to "the draft that is active for this scope", and mid-turn that is not the
  // ordinary thread draft - the composer can be locked, replaced by the running
  // state, or the slot unmounted entirely - so the text has nowhere to land at
  // the exact moment Address navigates there.
  //
  // The draft is not consumed on read, so it is still parked, but the only
  // things that retry are a mount and a realtime signal, and neither is
  // guaranteed to follow the end of a turn. This closes that gap: the moment
  // the composer becomes writable again, ask for the draft.
  const wasRunning = useRef(false);
  useEffect(() => {
    const running = view.run.isRunning || view.run.isSubmitting;
    if (wasRunning.current && !running) take();
    wasRunning.current = running;
  }, [take, view.run.isRunning, view.run.isSubmitting]);

  // THE DELIVERY HALF. `updateText` is a request, not a receipt: the write can
  // land in a composer that is not the one on screen, or in one the navigation
  // after Address is about to replace. Confirming against this composer's own
  // text is the only thing that proves the words arrived, so the ack waits for
  // it and an unacked draft comes back on the next mount or signal.
  useEffect(() => {
    const held = pending.current;
    if (held === null || !view.draft.text.includes(held.body)) return;
    pending.current = null;
    rpc.call("board_draft_ack", { ids: held.ids }).then(
      (result) => setDrafted(result.drafted),
      () => {
        // Not acked, so it stays parked and is offered again. Retrying is the
        // safe direction: a duplicate is visible and deletable, a lost decision
        // is neither.
        pending.current = held;
      },
    );
  }, [rpc, view.draft.text]);

  // The line has TWO jobs.
  //
  // An empty composer has nothing of the board in it, so the "waiting in a
  // draft" wording would be a lie there. But an empty composer with items
  // still drafted is a real failure case: an answer clicked while the chief is
  // running has nowhere to land, and hiding the line would hide the one case
  // that needs telling about.
  //
  // So an empty composer gets its own sentence rather than silence.
  //
  // "waiting in a draft" rather than "in this draft": the count is every open
  // item that has been put in a composer and not yet addressed, which can be
  // one more than this composer holds if some were addressed on another device
  // and never sent. Over-counting is the safe direction here, the same
  // way a missed send match is: it points at the board, it never hides an item.
  // The count is of BOARD items, and only the chief's composer holds those; a
  // worker's composer took a one-line answer and has no line to print for it.
  //
  // CLOSED BLOCKS. Text not yet
  // sent can outlive the decision it carried: a block about an item dismissed
  // earlier, already sent once, could stay in the chief composer, and one Enter
  // would send it again. So a block still in the text whose
  // items are all closed is named with its age, and one tap takes it out. The
  // live count is of blocks actually in the text, not of items on the server.
  const blocks = useMemo(() => blocksInText(recent, view.draft.text), [recent, view.draft.text]);
  if (!chief.read || threadId !== chief.threadId) return null;
  const closed = blocks.closed;
  // Blocks matched in the text when there are any. An edited block no
  // longer matches, so the server's count of drafted items stays the fallback:
  // over-counting points at the board, under-counting would hide the line.
  const line = view.draft.isEmpty
    ? drafted === 0
      ? null
      : `${drafted} item${drafted === 1 ? "" : "s"} from your board ${drafted === 1 ? "is" : "are"} waiting to go in here. Nothing is sent.`
    : blocks.live.length > 0
      ? `${blocks.live.length} board block${blocks.live.length === 1 ? "" : "s"} in this draft. Nothing is sent until you send it.`
      : drafted > 0
        ? `${drafted} item${drafted === 1 ? "" : "s"} from your board ${drafted === 1 ? "is" : "are"} waiting in a draft. Nothing is sent until you send it.`
        : null;
  if (line === null && closed.length === 0) return null;
  // Each age once: several blocks parked the same day read as one age.
  const ages = [...new Set(closed.map((block) => relativeTime(block.createdAt)))].join(", ");
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-1 text-[11px] leading-5", TEXT_TERTIARY)}>
      {line === null ? null : <span>{line}</span>}
      {closed.length === 0 ? null : (
        <>
          <span className="text-foreground">
            {closed.length === 1 ? "One block here is" : `${closed.length} blocks here are`} about{" "}
            {closed.length === 1 ? "an item" : "items"} already closed ({ages}).
          </span>
          <QuietButton
            onClick={() => composer.updateText((current) => withoutBlocks(current, closed))}
          >
            Remove {closed.length === 1 ? "it" : "them"}
          </QuietButton>
        </>
      )}
      <QuietButton
        onClick={() => navigate.toPluginPanel(CHIEF_PANEL_PATH, { subPath: MISSION_SUBPATH })}
      >
        Back to board
      </QuietButton>
    </div>
  );
}
