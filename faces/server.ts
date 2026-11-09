// Faces, the server half: hands each thread its face, remembers it, and lets
// a person or an agent change it from the thread menu or `bb faces`.
//
// The drawing happens in the app (app.tsx, components/paint.ts). The server
// owns the faces so every window, the menu and the command line agree.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { faceTag, rpcContract } from "./lib/contract.ts";
import { COLOURS, SHAPES, faceFromKey, faceName, parseFace } from "./lib/faces.ts";
import { MIGRATIONS, createStore } from "./lib/store.ts";

const USAGE = [
  "Usage:",
  "  bb faces                      every thread's face",
  "  bb faces set [thread] <face>  give a thread a face, a colour and a shape: bb faces set teal egg",
  "  bb faces new [thread]         give a thread a different face",
  "  bb faces hide [thread]        take a thread's face away",
  "  bb faces show [thread]        put a thread's face back",
  "  bb faces choices              the shapes and colours there are",
  "Leave out [thread] to mean the thread the command runs in.",
].join("\n");

/** At most this many lines from `bb faces`, so an agent's shell never floods. */
const LIST_LIMIT = 200;

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createStore(db);

  bb.rpc.register(rpcContract, {
    faces: ({ keys }) => store.faces(keys),
    face_change: ({ threadId, change }) => {
      const row = change === "new" ? store.newFace(threadId) : store.setHidden(threadId, change === "hide");
      bb.rpc.experimental_invalidate([faceTag(threadId)]);
      return row;
    },
  });

  // An archived thread gives its face back; a deleted one is forgotten.
  const onThread = (what: string, apply: () => void) => {
    try {
      apply();
    } catch (error) {
      bb.log.warn(`could not record a thread being ${what}: ${String(error)}`);
    }
  };
  bb.events.on("thread.archived", ({ thread }) => onThread("archived", () => store.setArchived(thread.id, true)));
  bb.events.on("thread.unarchived", ({ thread }) => onThread("unarchived", () => store.setArchived(thread.id, false)));
  bb.events.on("thread.deleted", ({ thread }) => onThread("deleted", () => store.forget(thread.id)));

  /** The thread named on the command line, or the one the command runs in; null with why when there is none. */
  async function threadFor(given: string | undefined, here: string | undefined): Promise<{ id: string } | { error: string }> {
    const id = given ?? here;
    if (id === undefined || id === "") return { error: `Name a thread: give its id, or run the command inside a thread.\n${USAGE}` };
    try {
      await bb.sdk.threads.get({ threadId: id });
      return { id };
    } catch {
      return { error: `No thread ${id}.` };
    }
  }

  async function list(): Promise<string> {
    const faces = store.list();
    if (faces.length === 0) return "No faces yet. A thread gets one the first time it shows in the sidebar.";
    const shown = faces.slice(0, LIST_LIMIT);
    // Titles are a convenience: if bb cannot list them, the ids still say which thread is which.
    const titles = new Map<string, string>();
    try {
      for (let at = 0; at < shown.length; at += 200) {
        const threads = await bb.sdk.threads.list({ threadIds: shown.slice(at, at + 200).map((face) => face.threadId) });
        for (const thread of threads) titles.set(thread.id, thread.title ?? thread.titleFallback ?? "");
      }
    } catch (error) {
      bb.log.warn(`bb faces: could not read thread titles: ${String(error)}`);
    }
    const lines = shown.map((stored) => {
      const face = faceFromKey(stored.face);
      const what = face === null ? stored.face : faceName(face);
      return `${stored.threadId}  ${what}${stored.hidden ? " (hidden)" : ""}  ${titles.get(stored.threadId) ?? ""}`.trimEnd();
    });
    if (faces.length > shown.length) lines.push(`and ${faces.length - shown.length} more`);
    return lines.join("\n");
  }

  bb.cli.register({
    name: "faces",
    summary: "See and change the face beside each thread in the sidebar",
    commands: [
      { name: "set", summary: "Give a thread a face", usage: "bb faces set [thread] <colour> <shape>" },
      { name: "new", summary: "Give a thread a different face", usage: "bb faces new [thread]" },
      { name: "hide", summary: "Take a thread's face away", usage: "bb faces hide [thread]" },
      { name: "show", summary: "Put a thread's face back", usage: "bb faces show [thread]" },
      { name: "choices", summary: "The shapes and colours there are", usage: "bb faces choices" },
    ],
    async run(argv, ctx) {
      const [command, ...args] = argv;
      const ok = (stdout: string) => ({ exitCode: 0, stdout });
      const fail = (stderr: string) => ({ exitCode: 1, stderr });
      switch (command) {
        case undefined:
        case "list":
          return ok(await list());
        case "help":
        case "--help":
        case "-h":
          return ok(USAGE);
        case "choices":
          return ok(`Shapes: ${SHAPES.map((s) => s.id).join(", ")}\nColours: ${COLOURS.map((c) => c.id).join(", ")}`);
        case "set": {
          // "set teal egg" means this thread; "set <thread> teal egg" names one.
          const here = parseFace(args.join(" "));
          const face = here ?? parseFace(args.slice(1).join(" "));
          if (face === null) {
            const text = (args.length > 2 ? args.slice(1) : args).join(" ");
            return fail(`"${text}" is not a face. Write a colour and a shape, for example: bb faces set teal egg. bb faces choices lists them.`);
          }
          const target = await threadFor(here === null ? args[0] : undefined, ctx.threadId);
          if ("error" in target) return fail(target.error);
          store.setFace(target.id, face);
          bb.rpc.experimental_invalidate([faceTag(target.id)]);
          return ok(`${target.id} now has a ${faceName(face)} face.`);
        }
        case "new":
        case "hide":
        case "show": {
          if (args.length > 1) return fail(USAGE);
          const target = await threadFor(args[0], ctx.threadId);
          if ("error" in target) return fail(target.error);
          const row = command === "new" ? store.newFace(target.id) : store.setHidden(target.id, command === "hide");
          bb.rpc.experimental_invalidate([faceTag(target.id)]);
          const face = faceFromKey(row.face);
          const what = face === null ? row.face : faceName(face);
          if (command === "hide") return ok(`${target.id} has no face now. bb faces show ${target.id} puts its ${what} face back.`);
          return ok(`${target.id} ${command === "new" ? "now has" : "shows its"} ${what} face.`);
        }
      }
      return fail(USAGE);
    },
  });
}
