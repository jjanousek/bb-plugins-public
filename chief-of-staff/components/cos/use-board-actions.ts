// The two writes the decision board makes, in one place.
//
// Address parks a draft in the chief thread's composer and navigates there. It
// never sends: the item becomes "addressed" only when the server observes a
// real send. A state move reports what the server said rather than what was
// asked for.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { BoardStateDto } from "@/contract";
import { errorText, useCosRpc } from "./use-cos";

export interface BoardActions {
  /**
   * Compose the numbered draft for the chief's composer and go there.
   *
   * Nothing is sent by this or by the composer that picks the draft up. The
   * item only becomes "addressed" when the server sees a real send.
   */
  address: (
    ids: string[],
    picks?: { id: string; label: string }[],
    answers?: { id: string; text: string }[],
    /** Stay on the current surface instead of going to the chief thread. The draft still lands in its composer. */
    opts?: { stay?: boolean },
  ) => Promise<boolean>;
  /** Move items to a state. Resolves true when the server accepted the move. */
  move: (ids: string[], state: BoardStateDto) => Promise<boolean>;
}

export function useBoardActions(refresh: () => void): BoardActions {
  const rpc = useCosRpc();
  const navigate = useBbNavigate();

  const address = async (
    ids: string[],
    picks?: { id: string; label: string }[],
    answers?: { id: string; text: string }[],
    opts?: { stay?: boolean },
  ): Promise<boolean> => {
    if (ids.length === 0) return false;
    try {
      // `picks` is the choice the user tapped. The server only honours a label the
      // chief actually put on that item, so a wrong one drops out rather than
      // writing words into the chief's composer that read as the user's decision.
      const result = await rpc.call("board_address", {
        ids,
        by: "panel",
        ...(picks === undefined ? {} : { picks }),
        ...(answers === undefined || answers.length === 0 ? {} : { answers }),
      });
      refresh();
      if (!result.ok || result.threadId === null) {
        toast.error(result.text);
        return false;
      }
      if (opts?.stay !== true) navigate.toThread(result.threadId);
      toast.success(opts?.stay === true ? "Answer is in the chief's composer. Nothing is sent until you send it." : result.text);
      return true;
    } catch (cause) {
      toast.error(errorText(cause));
      return false;
    }
  };

  const move = async (ids: string[], state: BoardStateDto) => {
    if (ids.length === 0) return false;
    try {
      const result = await rpc.call("board_set_state", { ids, state, by: "panel" });
      refresh();
      if (!result.ok) {
        toast.error(result.text);
        return false;
      }
      toast.success(result.text);
      return true;
    } catch (cause) {
      toast.error(errorText(cause));
      return false;
    }
  };

  return { address, move };
}
