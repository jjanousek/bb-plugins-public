import { describe, expect, it } from "vitest";
import { getEmptyUsageView, getSourceIssueMessage, getUsageStaleness } from "./usage-view-state";

const connected = { id: "machine-a", name: "Workstation", status: "connected" };
const offline = { id: "machine-a", name: "Workstation", status: "offline" };

describe("usage view state", () => {
  it("identifies an offline machine instead of presenting it as no usage", () => {
    expect(getEmptyUsageView({
      machines: [offline],
      sources: [{ machineId: offline.id, status: "offline" }],
      hasRecordsOutsideView: false,
    })).toMatchObject({ kind: "offline", title: "Workstation is offline" });
  });

  it("distinguishes a completed scan with no logs from a collection error", () => {
    expect(getEmptyUsageView({
      machines: [connected],
      sources: [{ machineId: connected.id, status: "no-data" }],
      hasRecordsOutsideView: false,
    }).kind).toBe("no-data");

    expect(getEmptyUsageView({
      machines: [connected],
      sources: [{ machineId: connected.id, status: "unavailable" }],
      hasRecordsOutsideView: false,
    })).toMatchObject({ kind: "error", title: "Usage couldn’t be collected" });
  });

  it("recognizes records excluded only by the current range", () => {
    expect(getEmptyUsageView({
      machines: [connected],
      sources: [{ machineId: connected.id, status: "ready" }],
      hasRecordsOutsideView: true,
    }).kind).toBe("filtered");
  });

  it("builds an actionable partial-history message", () => {
    expect(getSourceIssueMessage(
      [offline],
      [{ machineId: offline.id, status: "offline" }, { machineId: offline.id, status: "partial" }],
    )).toBe("Workstation is offline; 1 agent scan failed or was incomplete. Available records are included.");
  });

  it("flags usage as stale from the last good collection when scans keep failing", () => {
    // When every scan fails, the days after the last good collection must not
    // be drawn as a real $0.
    const now = Date.parse("2031-06-15T03:00:00Z");
    const staleness = getUsageStaleness([
      { machineId: "m", agentId: "claude", status: "unavailable", lastSuccessAt: "2031-06-11T09:00:00Z" },
      { machineId: "m", agentId: "cursor", status: "unavailable", lastSuccessAt: "2031-06-11T09:30:00Z" },
      { machineId: "m", agentId: "codex", status: "no-data", lastSuccessAt: "2031-06-11T09:00:00Z" },
      { machineId: "m", agentId: "opencode", status: "skipped", lastSuccessAt: null },
    ], now);
    expect(staleness).toMatchObject({ since: "2031-06-11T09:00:00.000Z", agentIds: ["claude", "cursor"] });
    expect(staleness?.fromDay).toMatch(/^2031-06-11$/);
  });

  it("flags a source whose last success is more than two sync cycles old even if it reads ready", () => {
    const now = Date.parse("2031-06-15T03:00:00Z");
    expect(getUsageStaleness([{ machineId: "m", agentId: "claude", status: "ready", lastSuccessAt: "2031-06-15T02:00:00Z" }], now))
      .toMatchObject({ agentIds: ["claude"] });
    expect(getUsageStaleness([{ machineId: "m", agentId: "claude", status: "ready", lastSuccessAt: "2031-06-15T02:50:00Z" }], now))
      .toBeNull();
  });

  it("reports an unknown start when a failing source has never collected", () => {
    expect(getUsageStaleness([{ machineId: "m", agentId: "cursor", status: "unavailable", lastSuccessAt: null }]))
      .toEqual({ since: null, fromDay: null, agentIds: ["cursor"] });
  });
});
