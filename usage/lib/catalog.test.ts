import { afterEach, describe, expect, it, vi } from "vitest";
import { activateCachedCatalog, refreshCatalog } from "./catalog";
import { pricingVersion, resetPricingCatalog, priceFor } from "./pricing";

type Row = { revision?: string; fetchedAt?: string; data?: string };

function fakeDb(initial: Row | undefined, saved: Row[] = []) {
  return {
    saved,
    prepare(_sql: string) {
      return {
        get: () => initial,
        run: (revision: string, fetchedAt: string, data: string) => saved.push({ revision, fetchedAt, data }),
      };
    },
  };
}

const payload = JSON.stringify({ openai: { name: "OpenAI", models: { "gpt-test-model": { id: "gpt-test-model", cost: { input: 1, output: 2 } } } } });
const jsonResponse = { ok: true, text: async () => payload } as unknown as Response;
// A cache row is a day old at most to count as fresh, so a stale one is dated
// from the test clock. A fresh row's revision is only a label.
const FRESH_REVISION = "models.dev@2031-05-20T08:00:00.000Z";
const STALE_AT = new Date(Date.now() - 3 * 86_400_000).toISOString();
const STALE_REVISION = `models.dev@${STALE_AT}`;

afterEach(() => resetPricingCatalog());

describe("models.dev catalog refresh", () => {
  it("reuses a fresh cached catalog without fetching", async () => {
    const db = fakeDb({ revision: FRESH_REVISION, fetchedAt: new Date().toISOString(), data: payload });
    const fetchImpl = vi.fn();
    const revision = await refreshCatalog(db, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(revision).toBe(FRESH_REVISION);
    activateCachedCatalog(db);
    expect(priceFor("openai", "gpt-test-model")).toEqual({ input: 1, cached: 1, cacheWrite: 1, cacheWrite1h: 2, output: 2 });
  });

  it("refetches a stale catalog and prices a newly added model", async () => {
    const oldPayload = JSON.stringify({ openai: { name: "OpenAI", models: {} } });
    const db = fakeDb({ revision: STALE_REVISION, fetchedAt: STALE_AT, data: oldPayload });
    const fetchImpl = vi.fn(async () => jsonResponse);
    const revision = await refreshCatalog(db, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(revision).toMatch(new RegExp(`^models\\.dev@${new Date().toISOString().slice(0, 10)}`));
    expect(db.saved).toHaveLength(1);
    // The refresh activates the new catalog itself; reading it back from the
    // saved row gives the same revision.
    expect(pricingVersion()).toBe(new Date().toISOString().slice(0, 10));
    activateCachedCatalog(fakeDb(db.saved[0]));
    expect(pricingVersion()).toBe(new Date().toISOString().slice(0, 10));
  });

  it("keeps the revision when a stale catalog has not changed", async () => {
    const revision = STALE_REVISION;
    const db = fakeDb({ revision, fetchedAt: STALE_AT, data: payload });
    expect(await refreshCatalog(db, vi.fn(async () => jsonResponse) as unknown as typeof fetch)).toBe(revision);
    expect(db.saved[0]?.revision).toBe(revision);
  });

  it("refetches when a fresh cache row is corrupt", async () => {
    const db = fakeDb({ revision: FRESH_REVISION, fetchedAt: new Date().toISOString(), data: "not-json" });
    const fetchImpl = vi.fn(async () => jsonResponse);
    await refreshCatalog(db, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledOnce();
    activateCachedCatalog(fakeDb(db.saved[0]));
    expect(priceFor("openai", "gpt-test-model")).not.toBeNull();
  });

  it("uses the bundled snapshot when a corrupt cache cannot be refreshed", async () => {
    const db = fakeDb({ revision: STALE_REVISION, fetchedAt: STALE_AT, data: "not-json" });
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    await refreshCatalog(db, fetchImpl as unknown as typeof fetch);
    expect(priceFor("openai", "gpt-5.6-terra")).not.toBeNull();
  });

  it("falls back to the bundled snapshot when fetching fails", async () => {
    const db = fakeDb(undefined);
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    await refreshCatalog(db, fetchImpl as unknown as typeof fetch);
    expect(priceFor("openai", "gpt-test-model")).toBeNull();
    expect(priceFor("openai", "gpt-5.6-terra")).toEqual({ input: 2, cached: 0.2, cacheWrite: 2.5, cacheWrite1h: 4, output: 12 });
  });

  it("prices a newly added model right after a refresh, without a reload", async () => {
    const oldPayload = JSON.stringify({ openai: { name: "OpenAI", models: {} } });
    const db = fakeDb({ revision: STALE_REVISION, fetchedAt: STALE_AT, data: oldPayload });
    await refreshCatalog(db, vi.fn(async () => jsonResponse) as unknown as typeof fetch);
    expect(priceFor("openai", "gpt-test-model")).toEqual({ input: 1, cached: 1, cacheWrite: 1, cacheWrite1h: 2, output: 2 });
  });

  it("activates a refreshed catalog even when it cannot be saved", async () => {
    const db = {
      prepare(sql: string) {
        return {
          get: () => ({ revision: STALE_REVISION, fetchedAt: STALE_AT, data: "{}" }),
          run: () => { if (sql.startsWith("INSERT")) throw new Error("database is locked"); },
        };
      },
    };
    await refreshCatalog(db, vi.fn(async () => jsonResponse) as unknown as typeof fetch);
    expect(priceFor("openai", "gpt-test-model")).not.toBeNull();
  });

  it("does not parse a fresh cache again when it is already the active catalog", async () => {
    const revision = FRESH_REVISION;
    const db = fakeDb({ revision, fetchedAt: new Date().toISOString(), data: payload });
    activateCachedCatalog(db);
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(await refreshCatalog(db, vi.fn() as unknown as typeof fetch)).toBe(revision);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});
