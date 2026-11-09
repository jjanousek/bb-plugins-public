import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { FACE_COUNT, hashString } from "../lib/faces.ts";
import type { FaceRow } from "../lib/contract.ts";
import plugin from "../server.ts";

/** A fake bb that knows these thread ids, with the plugin loaded. */
async function start(threadIds: readonly string[]) {
  const known = new Set(threadIds);
  const { bb, harness } = createFakePluginHost({
    pluginId: "faces",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          if (!known.has(threadId)) throw new Error("thread_not_found");
          return makeThreadResponse({ id: threadId });
        },
        list: async (args) =>
          (args?.threadIds ?? []).filter((id) => known.has(id)).map((id) => makeThreadResponse({ id, title: `Plan for ${id}` })),
      },
    },
  });
  await plugin(bb);
  const faces = async (keys: string[]) => (await harness.behavior.callRpc("faces", { keys })) as Record<string, FaceRow>;
  return { harness, faces };
}

/** A thread id whose first-choice face is the same as `of`'s. */
function sameFirstChoice(of: string): string {
  const start = hashString(of) % FACE_COUNT;
  for (let i = 0; ; i += 1) if (hashString(`thr_twin${i}`) % FACE_COUNT === start) return `thr_twin${i}`;
}

describe("the faces read", () => {
  it("gives every new thread its own face and keeps it", async () => {
    const { faces } = await start([]);
    const first = await faces(["thr_one", "thr_two", "thr_three"]);
    assert.equal(new Set(Object.values(first).map((row) => row.face)).size, 3);
    assert.deepEqual(await faces(["thr_three", "thr_one", "thr_two"]), first);
    assert.ok(Object.values(first).every((row) => !row.hidden));
  });

  it("gives a second thread another face while the first still holds its first choice", async () => {
    const { faces } = await start([]);
    const twin = sameFirstChoice("thr_one");
    const one = (await faces(["thr_one"]))["thr_one"]!;
    assert.notEqual((await faces([twin]))[twin]!.face, one.face);
  });

  it("frees an archived thread's face for the next thread", async () => {
    const { harness, faces } = await start([]);
    const twin = sameFirstChoice("thr_one");
    const one = (await faces(["thr_one"]))["thr_one"]!;
    await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thr_one" }) });
    assert.equal((await faces([twin]))[twin]!.face, one.face);
  });

  it("frees a deleted thread's face too", async () => {
    const { harness, faces } = await start([]);
    const twin = sameFirstChoice("thr_one");
    const one = (await faces(["thr_one"]))["thr_one"]!;
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_one" }) });
    assert.equal((await faces([twin]))[twin]!.face, one.face);
  });
});

describe("the thread menu", () => {
  it("hides and shows a face, keeping it, and refreshes every reader of that thread", async () => {
    const { harness, faces } = await start([]);
    const before = (await faces(["thr_one"]))["thr_one"]!;
    assert.deepEqual(await harness.behavior.callRpc("face_change", { threadId: "thr_one", change: "hide" }), { face: before.face, hidden: true });
    assert.deepEqual(harness.inspection.experimental_rpcInvalidations.at(-1), ["face:thr_one"]);
    assert.equal((await faces(["thr_one"]))["thr_one"]!.hidden, true);
    assert.deepEqual(await harness.behavior.callRpc("face_change", { threadId: "thr_one", change: "show" }), before);
  });

  it("gives a new face that no other live thread has, and shows a hidden face again", async () => {
    const { harness, faces } = await start([]);
    const rows = await faces(["thr_one", "thr_two"]);
    await harness.behavior.callRpc("face_change", { threadId: "thr_one", change: "hide" });
    const after = (await harness.behavior.callRpc("face_change", { threadId: "thr_one", change: "new" })) as FaceRow;
    assert.notEqual(after.face, rows["thr_one"]!.face);
    assert.notEqual(after.face, rows["thr_two"]!.face);
    assert.equal(after.hidden, false);
  });
});

describe("bb faces", () => {
  it("sets a face written as a colour and a shape, on a named thread or the one it runs in", async () => {
    const { harness, faces } = await start(["thr_one", "thr_here"]);
    const named = await harness.behavior.runCli(["set", "thr_one", "teal", "egg"]);
    assert.equal(named.exitCode, 0, named.stderr);
    assert.equal((await faces(["thr_one"]))["thr_one"]!.face, "egg/teal");
    const here = await harness.behavior.runCli(["set", "pink/cloud"], { threadId: "thr_here" });
    assert.equal(here.exitCode, 0, here.stderr);
    assert.equal((await faces(["thr_here"]))["thr_here"]!.face, "cloud/pink");
    assert.deepEqual(harness.inspection.experimental_rpcInvalidations.at(-1), ["face:thr_here"]);
  });

  it("refuses a face it does not have, a thread bb does not know, and a missing thread", async () => {
    const { harness } = await start(["thr_one"]);
    const badFace = await harness.behavior.runCli(["set", "thr_one", "plaid", "egg"]);
    assert.equal(badFace.exitCode, 1);
    assert.match(badFace.stderr, /"plaid egg" is not a face/);
    const badThread = await harness.behavior.runCli(["hide", "thr_nowhere"]);
    assert.equal(badThread.exitCode, 1);
    assert.match(badThread.stderr, /No thread thr_nowhere/);
    const noThread = await harness.behavior.runCli(["new"]);
    assert.equal(noThread.exitCode, 1);
    assert.match(noThread.stderr, /Name a thread/);
  });

  it("lists each live thread's face with its title, and says which are hidden", async () => {
    const { harness, faces } = await start(["thr_one", "thr_two"]);
    await harness.behavior.runCli(["set", "thr_one", "teal", "egg"]);
    await faces(["thr_two"]);
    await harness.behavior.runCli(["hide", "thr_two"]);
    const listed = await harness.behavior.runCli([]);
    assert.equal(listed.exitCode, 0, listed.stderr);
    const lines = listed.stdout.split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines.find((line) => line.startsWith("thr_one")), "thr_one  teal egg  Plan for thr_one");
    assert.match(lines.find((line) => line.startsWith("thr_two")) ?? "", /^thr_two {2}\w+ \w+ \(hidden\) {2}Plan for thr_two$/);
  });

  it("names every shape and colour", async () => {
    const { harness } = await start([]);
    const out = await harness.behavior.runCli(["choices"]);
    assert.match(out.stdout, /^Shapes: teardrop, .*bean\nColours: gray, .*navy$/);
  });
});
