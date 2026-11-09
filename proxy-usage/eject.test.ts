// Tests for eject.ts. Run with: npm test. Every file here is fake: invented
// addresses, a placeholder token string, folders under a fresh temp dir.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";

process.umask(0o077);
import {
  ejectAccount,
  EjectIntents,
  EJECT_INTENT_MS,
  hasBrowserOrigin,
  ejectedListText,
  writeEjectedList,
  ejectRefusal,
  listEjected,
  purgeEjected,
  safeAuthFileName,
  undoEject,
  UNDO_MS,
  agentDbFileName,
  openAgentDb,
  readAgentDbCredentials,
  switchAgentDbAccount,
  exportAgentDbEjectPayload,
  agentDbCoreAuthFiles,
  type CoreAuthFiles,
  type EjectCandidate,
} from "./eject.ts";

const HELD: EjectCandidate = { file: "claude-held@example.com.json", email: "held@example.com", disabled: true };
const SPARE: EjectCandidate = { file: "claude-spare@example.org.json", email: "spare@example.org", disabled: true };
const LIVE: EjectCandidate = { file: "claude-live@example.net.json", email: "live@example.net", disabled: false };
const T0 = Date.parse("2031-03-26T12:00:00Z");

describe("ejectRefusal", () => {
  it("allows a disabled account while another is in use", () => {
    assert.equal(ejectRefusal(HELD, [HELD, SPARE, LIVE]), null);
  });
  it("refuses the account in use", () => {
    const second = { ...SPARE, disabled: false };
    assert.match(ejectRefusal(LIVE, [HELD, second, LIVE]) ?? "", /is in use\. Switch to another account first/);
  });
  it("refuses the last enabled account", () => {
    assert.match(ejectRefusal(LIVE, [HELD, SPARE, LIVE]) ?? "", /only account the proxy can use/);
  });
  it("refuses an unknown account", () => {
    assert.match(ejectRefusal(undefined, [LIVE]) ?? "", /No such account/);
  });
  it("allows ejecting an on-hold account even when its file on disk still says disabled: false", () => {
    const heldEnabled: EjectCandidate = { ...HELD, disabled: false, status: "on-hold" };
    assert.equal(ejectRefusal(heldEnabled, [heldEnabled, LIVE]), null);
  });
  it("treats the remaining live account as the only usable one when the other enabled file is on hold", () => {
    const heldEnabled: EjectCandidate = { ...HELD, disabled: false, status: "on-hold" };
    assert.match(ejectRefusal(LIVE, [heldEnabled, LIVE]) ?? "", /only account the proxy can use/);
  });
  it("checks the last working account per provider so a working Antigravity account does not let the last Anthropic one be ejected", () => {
    const agLive: EjectCandidate = { file: "agentdb-google-antigravity-12.json", email: "user@example.com", disabled: false, provider: "google-antigravity" };
    const claudeLive: EjectCandidate = { file: "agentdb-anthropic-14.json", email: "user@example.com", disabled: false, provider: "anthropic" };
    assert.match(ejectRefusal(claudeLive, [agLive, claudeLive]) ?? "", /only account the proxy can use/);
    assert.match(ejectRefusal(agLive, [agLive, claudeLive]) ?? "", /only account the proxy can use/);
  });
});

describe("safeAuthFileName", () => {
  it("takes a Claude auth file name and nothing that leaves the folder", () => {
    assert.equal(safeAuthFileName(HELD.file), HELD.file);
    assert.equal(safeAuthFileName("agentdb-anthropic-14.json"), "agentdb-anthropic-14.json");
    assert.equal(safeAuthFileName("agentdb-google-antigravity-12.json"), "agentdb-google-antigravity-12.json");
    for (const bad of ["../claude-x.json", "claude-../x.json", "claude-a/b.json", "codex-a.json", "claude-a.json.bak"]) {
      assert.equal(safeAuthFileName(bad), null, bad);
    }
  });
});

/** A stand-in for the credential store: remove deletes the file, add writes it. */
function fakeCore(authDir: string, log: string[], failRemove = false): CoreAuthFiles {
  return {
    async remove(name) {
      log.push(`remove ${name}`);
      if (failRemove) throw new Error("core said no");
      await rm(join(authDir, name));
    },
    async add(name, data) {
      log.push(`add ${name}`);
      await writeFile(join(authDir, name), data, { mode: 0o600 });
    },
  };
}

describe("eject, undo and purge on fake folders", () => {
  let root = "";
  let authDir = "";
  let ejectedDir = "";
  const body = JSON.stringify({ type: "claude", email: HELD.email, access_token: "placeholder", disabled: true });
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "pu-eject-"));
    authDir = join(root, "auth");
    ejectedDir = join(root, "ejected");
    await import("node:fs/promises").then((fs) => fs.mkdir(authDir, { mode: 0o700 }));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const reset = async () => {
    await rm(ejectedDir, { recursive: true, force: true });
    await writeFile(join(authDir, HELD.file), body, { mode: 0o600 });
  };

  it("ejects through the core, keeps a 0600 copy in a 0700 folder, and lists it", async () => {
    await reset();
    const log: string[] = [];
    const record = await ejectAccount({ authDir, ejectedDir, target: HELD, now: T0 }, fakeCore(authDir, log));
    assert.deepEqual(log, [`remove ${HELD.file}`]);
    await assert.rejects(stat(join(authDir, HELD.file)), /ENOENT/);
    assert.equal((await stat(ejectedDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(ejectedDir, HELD.file))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(ejectedDir, HELD.file), "utf8"), body);
    assert.equal(record.purgeAt, T0 + UNDO_MS);
    assert.deepEqual((await listEjected(ejectedDir)).map((r) => r.file), [HELD.file]);
  });

  it("loses nothing when the core refuses: the account stays, no copy is left", async () => {
    await reset();
    await assert.rejects(ejectAccount({ authDir, ejectedDir, target: HELD, now: T0 }, fakeCore(authDir, [], true)), /core said no/);
    assert.equal(await readFile(join(authDir, HELD.file), "utf8"), body);
    assert.deepEqual(await readdir(ejectedDir), []);
  });

  it("undo within 7 days puts the same file back through the core", async () => {
    await reset();
    await ejectAccount({ authDir, ejectedDir, target: HELD, now: T0 }, fakeCore(authDir, []));
    const log: string[] = [];
    await undoEject({ authDir, ejectedDir, file: HELD.file, now: T0 + UNDO_MS - 60_000 }, fakeCore(authDir, log));
    assert.deepEqual(log, [`add ${HELD.file}`]);
    assert.equal(await readFile(join(authDir, HELD.file), "utf8"), body, "back exactly as it left, still disabled");
    assert.deepEqual(await listEjected(ejectedDir), []);
  });

  it("undo with the kept copy missing says so plainly and calls nothing", async () => {
    await reset();
    await ejectAccount({ authDir, ejectedDir, target: HELD, now: T0 }, fakeCore(authDir, []));
    await rm(join(ejectedDir, HELD.file));
    const log: string[] = [];
    await assert.rejects(undoEject({ authDir, ejectedDir, file: HELD.file, now: T0 + 1 }, fakeCore(authDir, log)), /kept copy of held@example\.com is missing/);
    assert.deepEqual(log, []);
  });
  it("undo after 7 days is refused", async () => {
    await reset();
    await ejectAccount({ authDir, ejectedDir, target: HELD, now: T0 }, fakeCore(authDir, []));
    await assert.rejects(undoEject({ authDir, ejectedDir, file: HELD.file, now: T0 + UNDO_MS }, fakeCore(authDir, [])), /more than 7 days ago/);
  });

  it("the purge deletes for good only what is past 7 days", async () => {
    await reset();
    await ejectAccount({ authDir, ejectedDir, target: HELD, now: T0 }, fakeCore(authDir, []));
    assert.deepEqual(await purgeEjected(ejectedDir, T0 + UNDO_MS - 1), []);
    assert.deepEqual((await purgeEjected(ejectedDir, T0 + UNDO_MS)).map((r) => r.file), [HELD.file]);
    assert.deepEqual(await readdir(ejectedDir), []);
  });
});

describe("ejectedListText", () => {
  it("names each ejected auth file on its own line, under a comment", () => {
    const text = ejectedListText([{ file: HELD.file, email: HELD.email, ejectedAt: T0, purgeAt: T0 + UNDO_MS }]);
    const lines = text.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
    assert.deepEqual(lines, [HELD.file]);
  });
});

describe("only the user's click ejects", () => {
  it("a request with no Origin header, as from bb's CLI or curl, gets no code", () => {
    assert.equal(hasBrowserOrigin(undefined), false);
    assert.equal(hasBrowserOrigin(""), false);
    assert.equal(hasBrowserOrigin("http://127.0.0.1:4100"), true);
  });
  it("a code works once, for its own account and action, and not after it lapses", () => {
    let n = 0;
    let clock = T0;
    const intents = new EjectIntents(() => `code-${++n}`, () => clock);
    const { intent } = intents.issue(`eject:${HELD.file}`);
    assert.equal(intents.take(intent, `eject:${SPARE.file}`), false, "another account");
    const second = intents.issue(`eject:${HELD.file}`).intent;
    assert.equal(intents.take(second, `undo:${HELD.file}`), false, "another action");
    const third = intents.issue(`eject:${HELD.file}`).intent;
    assert.equal(intents.take(third, `eject:${HELD.file}`), true);
    assert.equal(intents.take(third, `eject:${HELD.file}`), false, "spent");
    const fourth = intents.issue(`eject:${HELD.file}`).intent;
    clock += EJECT_INTENT_MS;
    assert.equal(intents.take(fourth, `eject:${HELD.file}`), false, "lapsed");
    assert.equal(intents.take(undefined, `eject:${HELD.file}`), false, "no code at all");
  });
});

describe("writeEjectedList", () => {
  it("creates its 0700 folder on first use and writes the list at 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "pu-list-"));
    try {
      const path = join(root, "state", "proxy-usage", "ejected-accounts.txt");
      await writeEjectedList(path, []);
      assert.match(await readFile(path, "utf8"), /^# Accounts ejected by proxy-usage/);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(root, "state", "proxy-usage"))).mode & 0o777, 0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("agent.db multi-account switch, token CAS, eject, and undo (native + legacy claude-*.json)", () => {
  let root = "";
  let dbPath = "";
  let ejectedDir = "";

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "pu-agentdb-"));
    await chmod(root, 0o700);
    dbPath = join(root, "agent.db");
    ejectedDir = join(root, "ejected");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedDb() {
    await rm(dbPath, { force: true });
    await rm(ejectedDir, { recursive: true, force: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        data TEXT NOT NULL,
        disabled_cause TEXT DEFAULT NULL,
        identity_key TEXT DEFAULT NULL,
        created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
        updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
      );
      CREATE TABLE auth_credential_blocks (
        credential_id INTEGER NOT NULL,
        provider_key TEXT NOT NULL,
        block_scope TEXT NOT NULL DEFAULT '',
        blocked_until_ms INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (credential_id, provider_key, block_scope)
      );
      CREATE TABLE auth_credential_refresh_leases (
        credential_id INTEGER PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE auth_change_revision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL
      );
      INSERT INTO auth_change_revision (id, revision) VALUES (1, 10);
      CREATE TRIGGER tr_cred_ins
      AFTER INSERT ON auth_credentials BEGIN
        UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1;
      END;
      CREATE TRIGGER tr_cred_upd
      AFTER UPDATE ON auth_credentials BEGIN
        UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1;
      END;
      CREATE TRIGGER tr_cred_del
      AFTER DELETE ON auth_credentials BEGIN
        UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1;
      END;
    `);
    const ins = db.prepare(
      "INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key) VALUES (?, ?, 'oauth', ?, ?, ?)",
    );
    ins.run(
      3,
      "google-antigravity",
      JSON.stringify({ refresh: "r-ag", access: "a-ag", expires: T0 + 3600_000, projectId: "proj-1", email: "main@example.com" }),
      null,
      "email:main@example.com",
    );
    ins.run(
      4,
      "anthropic",
      JSON.stringify({ refresh: "r-c1", access: "a-c1", expires: T0 + 3600_000, accountId: "u1", email: "main@example.com", orgId: "o1", orgName: "Org 1" }),
      null,
      "email:main@example.com|org:o1",
    );
    ins.run(
      5,
      "anthropic",
      JSON.stringify({ refresh: "r-c2", access: "a-c2", expires: T0 - 3600_000, accountId: "u2", email: "held@example.org", orgId: "o2", orgName: "Org 2" }),
      "account_on_hold",
      "email:held@example.org|org:o2",
    );
    ins.run(
      6,
      "anthropic",
      JSON.stringify({ refresh: "r-c3", access: "a-c3", expires: T0 + 3600_000, accountId: "u3", email: "backup@example.net", orgId: "o3", orgName: "Org 3" }),
      "disabled",
      "email:backup@example.net|org:o3",
    );
    ins.run(
      7,
      "anthropic",
      JSON.stringify({ refresh: "r-c4", access: "a-c4", expires: T0 - 3600_000, accountId: "u4", email: "deleted@example.net", orgId: "o4", orgName: "Org 4" }),
      "deleted by user",
      "email:deleted@example.net|org:o4",
    );
    ins.run(
      8,
      "anthropic",
      JSON.stringify({ refresh: "r-c5", access: "a-c5", expires: T0 - 3600_000, accountId: "u5", email: "failed@example.net", orgId: "o5", orgName: "Org 5" }),
      "oauth refresh failed: invalid_grant",
      "email:failed@example.net|org:o5",
    );
    db.prepare(
      "INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, 'anthropic:oauth', 'shared', ?, ?)",
    ).run(4, T0 + 600_000, 1);
    db.prepare(
      "INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, 'anthropic:oauth', 'shared', ?, ?)",
    ).run(6, T0 + 600_000, 1);
    db.close();
  }

  it("opens agent.db with a 5000 ms busy_timeout so concurrent omp writes do not fail with SQLITE_BUSY", async () => {
    await seedDb();
    const db = openAgentDb(dbPath, true);
    try {
      const row = db.prepare("PRAGMA busy_timeout").get() as { timeout?: number } | undefined;
      assert.equal(row?.timeout, 5_000);
    } finally {
      db.close();
    }
  });

  it("hides and refuses rows disabled by omp, preserves omp causes on switch, and clears blocks only on the target row", async () => {
    await seedDb();
    const visibleBefore = readAgentDbCredentials(dbPath);
    assert.deepEqual(visibleBefore.map((r) => r.id), [3, 4, 5, 6], "omp-deleted and refresh-failed rows are hidden");

    assert.throws(() => switchAgentDbAccount(dbPath, 5), /on hold/);
    assert.throws(() => switchAgentDbAccount(dbPath, 7), /disabled by omp/);
    assert.throws(() => switchAgentDbAccount(dbPath, 8), /disabled by omp/);

    const res = switchAgentDbAccount(dbPath, 6);
    assert.deepEqual(res, { provider: "anthropic", email: "backup@example.net" });
    const rows = readAgentDbCredentials(dbPath);
    assert.deepEqual(
      rows.map((r) => [r.id, r.provider, r.disabledCause]),
      [
        [3, "google-antigravity", null],
        [4, "anthropic", "disabled"],
        [5, "anthropic", "account_on_hold"],
        [6, "anthropic", null],
      ],
    );
    const checkDb = openAgentDb(dbPath, true);
    try {
      const rawCauses = checkDb
        .prepare("SELECT id, disabled_cause FROM auth_credentials WHERE id IN (7, 8) ORDER BY id")
        .all() as { id: number; disabled_cause: string | null }[];
      assert.deepEqual(rawCauses.map((r) => [r.id, r.disabled_cause]), [
        [7, "deleted by user"],
        [8, "oauth refresh failed: invalid_grant"],
      ]);
      const blocks = checkDb
        .prepare("SELECT credential_id FROM auth_credential_blocks ORDER BY credential_id")
        .all() as { credential_id: number }[];
      assert.deepEqual(blocks.map((b) => b.credential_id), [4], "only the newly enabled target row's block is cleared");
    } finally {
      checkDb.close();
    }
  });

  it("ejects an agent.db row to 0600 file and undo preserves its original disabled_cause (account_on_hold stays account_on_hold)", async () => {
    await seedDb();
    const core = agentDbCoreAuthFiles(dbPath);
    const row5 = readAgentDbCredentials(dbPath).find((r) => r.id === 5)!;
    assert.equal("data" in row5, false, "readAgentDbCredentials never exposes auth_credentials.data");
    const file = agentDbFileName(row5.provider, row5.id);
    await ejectAccount(
      {
        authDir: "",
        ejectedDir,
        target: { file, email: "held@example.org", disabled: true, status: "on-hold", provider: "anthropic" },
        now: T0,
        data: exportAgentDbEjectPayload(dbPath, row5.id),
      },
      core,
    );
    assert.equal(readAgentDbCredentials(dbPath).some((r) => r.id === 5), false);
    await undoEject({ authDir: "", ejectedDir, file, now: T0 + 1000, skipAuthDirCheck: true }, core);
    const restored = readAgentDbCredentials(dbPath).find((r) => r.identityKey === "email:held@example.org|org:o2");
    assert.ok(restored);
    assert.equal(restored.disabledCause, "account_on_hold", "on-hold row comes back on-hold, never switchable");
    assert.throws(() => switchAgentDbAccount(dbPath, restored.id), /on hold/);
  });

  it("server.ts does not refresh OAuth tokens, read acp_token.json, or read auth_credentials.data", async () => {
    const serverCode = await readFile(join(process.cwd(), "server.ts"), "utf8");
    assert.doesNotMatch(serverCode, /refreshAnthropicRowToken|refreshAntigravityRowToken|acp_token\.json|row\.data/);
  });

  it("undo imports a legacy claude-*.json ejected file into agent.db as anthropic oauth with compact JSON", async () => {
    await seedDb();
    await mkdir(ejectedDir, { recursive: true, mode: 0o700 });
    const legacyFile = "claude-legacy@example.org.json";
    const legacyBody = JSON.stringify(
      {
        type: "claude",
        email: "legacy@example.org",
        access_token: "legacy-a",
        refresh_token: "legacy-r",
        expired: "2031-04-02T00:00:00Z",
        account_uuid: "uuid-acc",
        organization_uuid: "uuid-org",
        organization_name: "Legacy Org",
        disabled: true,
      },
      null,
      2,
    );
    await writeFile(join(ejectedDir, legacyFile), legacyBody, { mode: 0o600 });
    await writeFile(
      join(ejectedDir, `${legacyFile}.eject`),
      JSON.stringify({ file: legacyFile, email: "legacy@example.org", ejectedAt: T0, purgeAt: T0 + UNDO_MS }),
      { mode: 0o600 },
    );
    const core = agentDbCoreAuthFiles(dbPath);
    await undoEject({ authDir: "", ejectedDir, file: legacyFile, now: T0 + 1000, skipAuthDirCheck: true }, core);
    const imported = readAgentDbCredentials(dbPath).find((r) => r.identityKey === "email:legacy@example.org|org:uuid-org");
    assert.ok(imported);
    assert.equal(imported.provider, "anthropic");
    assert.equal(imported.credentialType, "oauth");
    assert.equal(imported.disabledCause, "disabled");
    assert.equal(imported.email, "legacy@example.org");
    assert.equal(imported.orgId, "uuid-org");
    const checkDb = openAgentDb(dbPath, true);
    try {
      const spacing = checkDb
        .prepare("SELECT instr(data, ': ') AS colon_space, instr(data, ', ') AS comma_space FROM auth_credentials WHERE id = ?")
        .get(imported.id) as { colon_space: number; comma_space: number };
      assert.equal(spacing.colon_space, 0);
      assert.equal(spacing.comma_space, 0);
    } finally {
      checkDb.close();
    }
  });
});
