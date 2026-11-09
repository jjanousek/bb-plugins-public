import { describe, expect, it } from "vitest";
import { clampPercent, formatLimitReset, formatLimitValue } from "./provider-limits";

describe("provider limit presentation", () => {
  it("clamps percentages to the progress range", () => {
    expect(clampPercent(-4)).toBe(0);
    expect(clampPercent(42.4)).toBe(42.4);
    expect(clampPercent(118)).toBe(100);
  });

  it("formats nearby and multi-day reset times", () => {
    const now = Date.parse("2031-06-15T09:00:00.000Z");
    expect(formatLimitReset("2031-06-15T09:42:00.000Z", now)).toBe("Resets in 42m");
    expect(formatLimitReset("2031-06-15T11:15:00.000Z", now)).toBe("Resets in 2h 15m");
    expect(formatLimitReset("2031-06-17T09:00:00.000Z", now)).toBe("Resets in 2d");
    expect(formatLimitReset(null, now)).toBeNull();
  });

  it("prefers an exact spend limit when a provider reports one", () => {
    expect(formatLimitValue({
      label: "Monthly",
      usedPercent: 41,
      resetsAt: null,
      cost: { usedUsdCents: 1700, limitUsdCents: 4100 },
    })).toBe("$17.00 of $41.00");
    expect(formatLimitValue({ label: "Weekly", usedPercent: 47.6, resetsAt: null })).toBe("48% used");
  });
});
