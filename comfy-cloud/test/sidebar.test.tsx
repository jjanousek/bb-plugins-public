// @vitest-environment jsdom
// The sidebar nav badge: the badge component, the count clamp and this
// plugin's own topSignal.
//
// Two things matter here and neither is visible in the component. Width: the
// host clips the accessory to a fixed box, and a unit test cannot measure
// pixels, so it asserts character budgets, 10 characters for a level that
// carries a dot and 12 for urgent. A longer noun such as "running" would not
// fit beside two digits, which is why this plugin says jobs. And decay: the badge reads
// failedRecent, not failed, because a signal that cannot go away teaches you to
// stop looking at it. The store's own window is tested in server.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SidebarAccessorySignal } from "../components/comfy/sidebar-accessory";
import { clamp99 } from "../components/comfy/sidebar-accessory-format.ts";
import { topSignal } from "../components/comfy/sidebar-signal";
import type { Status } from "../contract";

afterEach(cleanup);

/** Only counts matter to topSignal; the rest of Status is scenery. */
function status(counts: Partial<Status["counts"]>): Status {
  return {
    configured: true,
    keySource: "key-file",
    configureHint: null,
    assetDir: "/assets",
    imageModel: "ByteDanceSeedreamNodeV3/seedream 5.0 pro",
    videoModel: "ByteDanceTextToVideoNode/seedance-1-0-pro-fast-251015",
    counts: { total: 0, images: 0, videos: 0, running: 0, failed: 0, failedRecent: 0, ...counts },
    catalogLoaded: true,
    registry: { generatedAt: "2031-04-10", catalogDate: "2031-04-09", catalogFetched: "2031-04-09" },
  };
}

describe("topSignal", () => {
  it("says nothing before the status has loaded", () => {
    expect(topSignal(null)).toBe(null);
  });

  it("says nothing when there is nothing to say", () => {
    expect(topSignal(status({ total: 42, images: 40, videos: 2 }))).toBe(null);
  });

  it("counts running generations as activity", () => {
    expect(topSignal(status({ running: 3 }))).toEqual({ level: "activity", text: "3 jobs" });
  });

  it("counts a fresh failure as urgent", () => {
    expect(topSignal(status({ failed: 2, failedRecent: 2 }))).toEqual({ level: "urgent", text: "2 failed" });
  });

  it("goes quiet once the failures are old, which is the whole point", () => {
    // The lifetime figure stays 2 and the panel still shows it. The badge is
    // the thing that has to be able to reach zero: a permanently red badge
    // teaches you to stop seeing red, and then the failure that matters lands
    // on a surface you have learned to ignore.
    expect(topSignal(status({ failed: 2, failedRecent: 0 }))).toBe(null);
    // And it does not suppress a running count while it is quiet.
    expect(topSignal(status({ failed: 2, failedRecent: 0, running: 1 }))).toEqual({ level: "activity", text: "1 jobs" });
  });

  it("lets a fresh failure beat running", () => {
    expect(topSignal(status({ running: 5, failed: 1, failedRecent: 1 }))).toEqual({ level: "urgent", text: "1 failed" });
  });

  it("clamps a big count to 99 and never renders 99+", () => {
    // "99+ jobs" would be wider than the box, and "99+" alone does not fit
    // beside a dot either. The clamp is silent on purpose.
    expect(topSignal(status({ running: 1000 }))?.text).toBe("99 jobs");
    expect(topSignal(status({ failed: 1000, failedRecent: 1000 }))?.text).toBe("99 failed");
    for (const [input, out] of [
      [0, "0"],
      [7, "7"],
      [99, "99"],
      [100, "99"],
      [-4, "0"],
      [3.9, "3"],
    ] as const) {
      expect(clamp99(input), String(input)).toBe(out);
    }
  });

  it("fits every branch inside its measured budget", () => {
    const branches = [topSignal(status({ running: 99 })), topSignal(status({ failed: 99, failedRecent: 99 }))];
    for (const signal of branches) {
      expect(signal).not.toBe(null);
      const budget = signal!.level === "urgent" ? 12 : 10;
      expect(signal!.text.length, signal!.text).toBeLessThanOrEqual(budget);
    }
  });
});

describe("SidebarAccessorySignal", () => {
  it("renders nothing for a null signal", () => {
    const { container } = render(<SidebarAccessorySignal signal={null} />);
    expect(container.textContent).toBe("");
  });

  it("carries the level in the dot as well as the colour, so grayscale still reads", () => {
    const activity = render(<SidebarAccessorySignal signal={topSignal(status({ running: 2 }))} />);
    const dot = activity.container.querySelector("span span");
    expect(dot?.className).toContain("bg-foreground/70");
    // motion-safe, so a reduced-motion setting stops the pulse.
    expect(dot?.className).toContain("motion-safe:animate-pulse");
    expect(activity.container.textContent).toBe("2 jobs");
    cleanup();

    const urgent = render(<SidebarAccessorySignal signal={topSignal(status({ failed: 2, failedRecent: 2 }))} />);
    expect(urgent.container.querySelector("span span")).toBe(null);
    expect(urgent.container.firstElementChild?.className).toContain("destructive-text");
    expect(urgent.container.textContent).toBe("2 failed");
  });

  it("puts the text in a title, since the host clips the box", () => {
    const { container } = render(<SidebarAccessorySignal signal={{ level: "attention", text: "9 asks" }} />);
    expect(container.firstElementChild?.getAttribute("title")).toBe("9 asks");
    expect(container.querySelector("span span")?.className).toContain("warning-text");
  });
});
