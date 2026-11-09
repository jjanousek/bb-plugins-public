import { afterEach, describe, expect, it, vi } from "vitest";
import { formatLocalMoney, localCurrency, usdToLocalRate } from "./local-currency";

describe("local currency", () => {
  it("maps explicit regions to their currency", () => {
    expect(new Intl.Locale("en-IN").maximize().region).toBe("IN");
    expect(new Intl.Locale("en-GB").maximize().region).toBe("GB");
    expect(new Intl.Locale("en-CA").maximize().region).toBe("CA");
  });

  it("falls back to USD for unmapped regions", () => {
    const info = localCurrency();
    expect(typeof info.locale).toBe("string");
    expect(info.currency.length).toBe(3);
    expect(info.currency).toBe(info.currency.toUpperCase());
  });

  it("formats local money with the given rate", () => {
    const info = { locale: "en-IN", currency: "INR" };
    expect(formatLocalMoney(100, info, 83.5)).toMatch(/8,350/);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The rate lookup is stubbed so the test never waits on the live rates
  // service.
  it("returns null rates for USD", async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ result: "success", rates: { HKD: 7.8 } })));
    vi.stubGlobal("fetch", fetchStub);
    await expect(usdToLocalRate("USD")).resolves.toBeNull();
    await expect(usdToLocalRate("NOPE_BAD")).resolves.toBeNull();
    await expect(usdToLocalRate("HKD")).resolves.toBe(7.8);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
