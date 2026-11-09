import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { persistLastCompletedSyncAt, readLastCompletedSyncAt, syncMetadataMigration } from "./sync-metadata";

let db: Database.Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function createDatabase() {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE usage_sync_state (
    machine_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    status TEXT NOT NULL,
    last_attempt_at TEXT,
    last_success_at TEXT,
    record_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    PRIMARY KEY (machine_id, provider_id)
  );`);
  return db;
}

describe("sync completion metadata", () => {
  it("leaves a fresh database pending until its first complete sync", () => {
    const database = createDatabase();
    database.exec(syncMetadataMigration);

    expect(readLastCompletedSyncAt(database)).toBeNull();

    persistLastCompletedSyncAt(database, "2031-06-12T14:00:00.000Z");
    expect(readLastCompletedSyncAt(database)).toBe("2031-06-12T14:00:00.000Z");
  });

  it("backfills existing installations so they do not shimmer again after upgrade", () => {
    const database = createDatabase();
    database.prepare(`INSERT INTO usage_sync_state
      (machine_id, provider_id, status, last_attempt_at, last_success_at, record_count, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("machine-a", "codex", "ready", "2031-06-12T13:55:00.000Z", "2031-06-12T14:00:00.000Z", 12, null);

    database.exec(syncMetadataMigration);

    expect(readLastCompletedSyncAt(database)).toBe("2031-06-12T14:00:00.000Z");
  });
});
