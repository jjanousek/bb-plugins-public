import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COLOURS,
  FACE_COUNT,
  SHAPES,
  faceFromKey,
  faceKey,
  hashString,
  nextFace,
  parseFace,
  pickFace,
  threadState,
} from "../lib/faces.ts";

describe("a face as a person writes it", () => {
  it("takes a colour and a shape in either order, with a space or a slash, in any case", () => {
    for (const text of ["teal egg", "egg teal", "egg/teal", "Teal Egg", "  teal   egg "]) {
      assert.deepEqual(parseFace(text), { shape: "egg", colour: "teal" }, text);
    }
  });

  it("names no face for a missing, unknown or extra word", () => {
    for (const text of ["teal", "teal teal", "egg egg", "teal unicorn", "big teal egg", ""]) {
      assert.equal(parseFace(text), null, text);
    }
  });

  it("reads back only keys it could have written", () => {
    assert.deepEqual(faceFromKey("egg/teal"), { shape: "egg", colour: "teal" });
    for (const key of ["teal/egg", "egg", "egg/teal/x", "egg/plaid"]) assert.equal(faceFromKey(key), null, key);
  });
});

describe("handing out faces", () => {
  it("gives a thread the face its id hashes to when it is free, the same every time", () => {
    const first = pickFace("thr_example01", new Set());
    assert.deepEqual(pickFace("thr_example01", new Set()), first);
  });

  it("never gives a live thread's face to another thread while one is free", () => {
    const taken = new Set<string>();
    for (let i = 0; i < FACE_COUNT; i += 1) {
      const face = faceKey(pickFace(`thr_sample${i}`, taken));
      assert.ok(!taken.has(face), `thread ${i} got a face already in use`);
      taken.add(face);
    }
    assert.equal(taken.size, SHAPES.length * COLOURS.length);
  });

  it("shares the hashed face once every face is in use, rather than fail", () => {
    const all = new Set<string>();
    for (const shape of SHAPES) for (const colour of COLOURS) all.add(`${shape.id}/${colour.id}`);
    assert.equal(faceKey(pickFace("thr_extra", all)), faceKey(pickFace("thr_extra", new Set())));
  });

  it("starts from the hash, so two ids that hash alike part only by the taken set", () => {
    const start = hashString("thr_example01") % FACE_COUNT;
    let twin = "";
    for (let i = 0; twin === ""; i += 1) if (hashString(`thr_twin${i}`) % FACE_COUNT === start) twin = `thr_twin${i}`;
    const owner = pickFace("thr_example01", new Set());
    assert.deepEqual(pickFace(twin, new Set()), owner);
    assert.notDeepEqual(pickFace(twin, new Set([faceKey(owner)])), owner);
  });
});

describe("New face", () => {
  it("changes both the shape and the colour", () => {
    const now = { shape: "egg", colour: "teal" };
    const next = nextFace(now, new Set());
    assert.notEqual(next.shape, now.shape);
    assert.notEqual(next.colour, now.colour);
  });

  it("visits every face once before coming back", () => {
    let face = { shape: SHAPES[0]!.id, colour: COLOURS[0]!.id };
    const seen = new Set<string>([faceKey(face)]);
    for (let i = 1; i < FACE_COUNT; i += 1) {
      face = nextFace(face, new Set());
      seen.add(faceKey(face));
    }
    assert.equal(seen.size, FACE_COUNT);
    assert.equal(faceKey(nextFace(face, new Set())), `${SHAPES[0]!.id}/${COLOURS[0]!.id}`);
  });

  it("skips faces other threads have, and keeps the current one when nothing else is free", () => {
    const now = { shape: "egg", colour: "teal" };
    const firstPick = nextFace(now, new Set());
    assert.notDeepEqual(nextFace(now, new Set([faceKey(firstPick)])), firstPick);
    const allButMine = new Set<string>();
    for (const shape of SHAPES) for (const colour of COLOURS) if (!(shape.id === "egg" && colour.id === "teal")) allButMine.add(`${shape.id}/${colour.id}`);
    assert.deepEqual(nextFace(now, allButMine), now);
  });
});

describe("what a thread is doing", () => {
  const idle = { status: "idle", runtimeStatus: "idle", hasPendingInteraction: false, indicator: "none" };

  it("runs while bb reports a turn under way", () => {
    for (const runtimeStatus of ["starting", "active", "provisioning", "stopping"]) {
      assert.equal(threadState({ ...idle, runtimeStatus }), "running", runtimeStatus);
    }
    assert.equal(threadState({ ...idle, indicator: "runtime" }), "running");
  });

  it("waits when the agent is blocked on the user, even in the middle of a turn", () => {
    assert.equal(threadState({ ...idle, status: "active", runtimeStatus: "active", hasPendingInteraction: true }), "waiting");
    assert.equal(threadState({ ...idle, indicator: "waiting-for-input" }), "waiting");
  });

  it("is idle otherwise, including for a status bb adds later", () => {
    assert.equal(threadState(idle), "idle");
    assert.equal(threadState({ ...idle, status: "error", runtimeStatus: "error", indicator: "unread-error" }), "idle");
    assert.equal(threadState({ ...idle, status: "hibernating", runtimeStatus: "hibernating" }), "idle");
    assert.equal(threadState({ ...idle, runtimeStatus: "waiting-for-host" }), "idle");
  });
});
