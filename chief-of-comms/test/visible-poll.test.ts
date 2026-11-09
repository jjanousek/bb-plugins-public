// The panel's polls pause while the tab is hidden.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { startVisiblePoll, type VisibilitySource } from "../components/comms/visible-poll.ts";

function fakeClock() {
  let now = 0;
  let id = 0;
  const intervals = new Map<number, { fn: () => void; ms: number; next: number }>();
  return {
    timers: {
      setInterval: (fn: () => void, ms: number) => {
        intervals.set(++id, { fn, ms, next: now + ms });
        return id;
      },
      clearInterval: (h: unknown) => void intervals.delete(h as number),
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...intervals.values()].filter((t) => t.next <= end).sort((a, b) => a.next - b.next)[0];
        if (due === undefined) break;
        now = due.next;
        due.next += due.ms;
        due.fn();
      }
      now = end;
    },
  };
}

function fakeDocument(state: string) {
  const listeners = new Set<() => void>();
  const doc: VisibilitySource & { set(next: string): void; listeners: number } = {
    visibilityState: state,
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
    set(next: string) {
      this.visibilityState = next;
      for (const l of [...listeners]) l();
    },
    get listeners() {
      return listeners.size;
    },
  };
  return doc;
}

describe("the comms panel polls only while visible", () => {
  it("hidden for 60 s makes no calls; turning visible makes one; visible polling goes on every 20 s", () => {
    const clock = fakeClock();
    const doc = fakeDocument("hidden");
    let calls = 0;
    const stop = startVisiblePoll(doc, () => (calls += 1), 20_000, clock.timers);
    clock.advance(60_000);
    assert.equal(calls, 0, "hidden: no RPCs");
    doc.set("visible");
    assert.equal(calls, 1, "one refetch on coming back");
    clock.advance(40_000);
    assert.equal(calls, 3, "then every 20 s");
    stop();
    assert.equal(doc.listeners, 0, "the listener is removed on cleanup");
    clock.advance(60_000);
    assert.equal(calls, 3, "and the timer is gone");
  });

  it("useLive and the summary both poll through it, and nothing else polls with setInterval", () => {
    const source = readFileSync(new URL("../components/comms/use-comms.ts", import.meta.url), "utf8");
    assert.equal([...source.matchAll(/startVisiblePoll\(/g)].length, 2);
    assert.doesNotMatch(source, /setInterval\(/);
  });
});
