// A throw inside a timer body must not reach the process, and the source must
// keep using the wrapper that stops it.
//
// `guarded` passing its own unit tests says nothing about whether server.ts
// calls it, and a tidy-up that inlines the publish would leave the timer body
// bare. So this reads server.ts and fails if the timer body stops being
// wrapped, which is the same idiom test/touch-geometry.test.ts uses for a class list.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { guarded } from "../timers";

const read = (file: string): string => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");

describe("a guarded timer body", () => {
  it("swallows a throw and logs it against its label", () => {
    const log = { warn: vi.fn() };
    const ok = guarded("realtime publish", () => {
      throw new Error("host went away");
    }, log);
    expect(ok, "it reports that the call failed").toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain("realtime publish");
    expect(log.warn.mock.calls[0][0]).toContain("host went away");
  });

  it("runs the body and stays quiet when nothing throws", () => {
    // The positive control. Without it a broken `guarded` that never calls its
    // argument at all would pass the test above.
    const log = { warn: vi.fn() };
    let ran = 0;
    expect(guarded("publish", () => { ran += 1; }, log)).toBe(true);
    expect(ran).toBe(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("survives a logger that throws inside the catch", () => {
    const log = { warn: () => { throw new Error("log sink is gone"); } };
    expect(() => guarded("publish", () => { throw new Error("first"); }, log)).not.toThrow();
  });

  it("keeps the timer on schedule: a throwing tick does not stop the next one", () => {
    // What the wrapper buys, stated as behaviour rather than as a try/catch.
    // Under a bare callback the first throw ends the process and there is no
    // second tick to assert.
    vi.useFakeTimers();
    try {
      const log = { warn: vi.fn() };
      const ticks: number[] = [];
      let n = 0;
      const arm = (): void => {
        setTimeout(() => {
          guarded("tick", () => {
            n += 1;
            ticks.push(n);
            if (n === 1) throw new Error("publish failed");
          }, log);
          if (n < 3) arm();
        }, 300);
      };
      arm();
      vi.advanceTimersByTime(900);
      expect(ticks).toEqual([1, 2, 3]);
      expect(log.warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the publish timer in server.ts", () => {
  it("wraps its body, so a failed publish cannot take the shared process down", () => {
    const server = read("server.ts");
    const body = server.slice(server.indexOf("publishTimer = setTimeout("), server.indexOf("}, PUBLISH_THROTTLE_MS);"));
    expect(body, "the timer body must not call publish bare").toContain("guarded(");
    expect(body).toContain("bb.realtime.publish");
    expect(server).toContain('import { guarded } from "./timers";');
  });

  it("leaves no other bare timer on the server side", () => {
    // Every other setTimeout in the backend is a sleep whose body only clears
    // itself and resolves a promise that something is awaiting, so a throw
    // there has a caller. A new one with a real call in it fails here until it
    // is wrapped.
    for (const file of ["server.ts", "runner.ts"]) {
      const source = read(file);
      for (const body of source.split("setTimeout(").slice(1)) {
        if (body.startsWith("done,")) continue; // a sleep: `setTimeout(done, ms)`
        // Up to the arrow body's closing brace, so the window covers the whole
        // callback including the comment above the call; a fixed number of
        // characters can stop short of the wrapper.
        const end = body.indexOf("\n      }, ");
        const callback = end === -1 ? body : body.slice(0, end);
        expect(callback, `${file}: a timer with a body must call guarded`).toContain("guarded(");
      }
    }
  });
});
