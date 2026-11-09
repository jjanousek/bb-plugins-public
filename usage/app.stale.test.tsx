import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@bb/plugin-sdk/app", () => ({
  definePluginApp: () => undefined,
  useRealtime: () => undefined,
  useRealtimeConnectionState: () => "connected",
  useRpc: () => ({}),
}));

const { ProviderLimits, StaleUsageBanner, UsageChart } = await import("./app");

function isoDay(offset: number) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const record = (day: string) => ({
  day, agentId: "claude", agentName: "Claude Code", modelProviderId: "anthropic", modelProviderName: "Anthropic",
  machineId: "m", machineName: "Machine", model: "claude-opus-5", project: "p", costUsd: 8, loggedCostUsd: null,
  pricingStatus: "models-dev-exact", cacheSavingsUsd: 0, processedTokens: 2600, cachedInputTokens: 0,
  cacheWriteTokens: 0, uncachedInputTokens: 2600, outputTokens: 0, turns: 0,
});

describe("usage panel when collection has stopped", () => {
  const chart = (staleFromDay: string | null) => renderToStaticMarkup(
    <UsageChart
      records={[record(isoDay(-6)), record(isoDay(-5))]}
      providers={[{ id: "claude", name: "Claude Code" }]}
      range={7}
      mode="cost"
      groupBy="agent"
      staleFromDay={staleFromDay}
    />,
  );

  it("shades and labels the days after the last good collection", () => {
    const html = chart(isoDay(-4));
    expect(html).toContain('data-testid="usage-chart-stale"');
    expect(html).toContain("Not collected");
  });

  it("draws an up-to-date chart without the stale band", () => {
    expect(chart(null)).not.toContain("Not collected");
  });

  it("names the stalled agents and when collection stopped", () => {
    const html = renderToStaticMarkup(
      <StaleUsageBanner
        staleness={{ since: "2031-06-11T02:00:00Z", fromDay: "2031-06-11", agentIds: ["claude", "cursor"] }}
        agents={[{ id: "claude", name: "Claude Code" }, { id: "cursor", name: "Cursor" }]}
      />,
    );
    expect(html).toContain("Usage has not been collected since");
    expect(html).toContain("Claude Code, Cursor");
    expect(html).toContain("is not real");
  });
});

describe("usage limits strip", () => {
  it("says the limits could not be loaded when the limits call fails", () => {
    const html = renderToStaticMarkup(
      <ProviderLimits limits={[]} contentWidth={1200} loadError="Host list request timed out." />,
    );
    expect(html).toContain("Usage limits could not be loaded: Host list request timed out.");
    expect(html).not.toContain("No provider limits are available");
  });

  it("keeps the no-limits message when the call succeeded with nothing", () => {
    const html = renderToStaticMarkup(<ProviderLimits limits={[]} contentWidth={1200} />);
    expect(html).toContain("No provider limits are available");
  });
});
