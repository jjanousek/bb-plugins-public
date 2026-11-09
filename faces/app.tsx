// Faces, the app half. Three registrations:
// - a content script that draws the faces on bb's sidebar rows
//   (components/paint.ts);
// - an app overlay that draws nothing and feeds that script: what each thread
//   is doing comes live from bb's own thread list, its face from the server;
// - a "Face" entry in every thread menu: a new face, or hide and show it.
import { useEffect, useMemo } from "react";
import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS,
  experimental_useRpcKeyedQuery,
  experimental_useSidebarThreads,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { mountFaces, publishFaces, type PaintedFace } from "./components/paint.ts";
import { rpcContract, type FaceRow } from "./lib/contract.ts";
import { faceFromKey, faceName, threadState } from "./lib/faces.ts";

type Change = "new" | "hide" | "show";

/** What a keyed read holds before its first answer. One object, so effects do not re-run for nothing. */
const NO_FACES: Record<string, FaceRow> = {};

/** The same ids as the same array for as long as they do not change, so reads are not repeated. */
function useStableKeys(ids: readonly string[]): string[] {
  const joined = ids.join("\n");
  return useMemo(() => (joined === "" ? [] : joined.split("\n")), [joined]);
}

function FacesFeed() {
  const { threads } = experimental_useSidebarThreads();
  // Oldest first: when several threads need a face at once, older ones choose first.
  const keys = useStableKeys(
    threads
      .filter((thread) => !thread.isHidden)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((thread) => thread.id),
  );
  const data = experimental_useRpcKeyedQuery({ contract: rpcContract, method: "faces", keys }).data ?? NO_FACES;
  useEffect(() => {
    const faces = new Map<string, PaintedFace>();
    for (const thread of threads) {
      const row = data[thread.id];
      const face = row === undefined || row.hidden ? null : faceFromKey(row.face);
      if (face !== null) faces.set(thread.id, { face, state: threadState(thread) });
    }
    publishFaces(faces);
  }, [threads, data]);
  useEffect(() => () => publishFaces(new Map()), []);
  return null;
}

interface MenuData {
  faces: Record<string, FaceRow>;
  change(threadId: string, change: Change): Promise<unknown>;
}

function useMenuData({ threadIds }: { threadIds: readonly string[] }): MenuData {
  const keys = useStableKeys(threadIds);
  const data = experimental_useRpcKeyedQuery({ contract: rpcContract, method: "faces", keys }).data ?? NO_FACES;
  const rpc = useRpc<typeof rpcContract>();
  return useMemo(
    () => ({ faces: data, change: (threadId: string, change: Change) => rpc.call("face_change", { threadId, change }) }),
    [data, rpc],
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "faces", mount: mountFaces });
  app.slots.experimental_appOverlay({ id: "faces-feed", component: FacesFeed });
  app.slots.experimental_threadAction<MenuData>({
    id: "face",
    title: "Face",
    icon: "faces/face",
    group: experimental_THREAD_ACTION_GROUPS.settings,
    // An entry with choices sits after its group's plain entries.
    order: 90,
    useData: useMenuData,
    item: ({ thread, data }) => {
      const row = data.faces[thread.id];
      if (row === undefined) return null;
      const face = faceFromKey(row.face);
      const name = face === null ? "" : faceName(face);
      return {
        label: "Face",
        detail: row.hidden ? "Hidden" : name.charAt(0).toUpperCase() + name.slice(1),
        icon: "faces/face",
        choices: {
          items: [
            { id: "new", label: "New face", icon: "Repeat" },
            row.hidden ? { id: "show", label: "Show face", icon: "Eye" } : { id: "hide", label: "Hide face", icon: "EyeOff" },
          ],
        },
        run: async ({ value }) => {
          if (value === "new" || value === "hide" || value === "show") await data.change(thread.id, value);
        },
      };
    },
  });
});
