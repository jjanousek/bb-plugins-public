// Eject a dead account, with a 7-day undo, so a dead account can be removed
// from the popup.
//
// No Plugin SDK imports, so node --test loads this directly. The credential
// store's remove and add calls are passed in as a small interface; the folders
// are passed in as paths. Nothing here reads or prints a token: the auth file
// is moved as bytes and only its email and disabled flag are parsed.
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
/** How long an ejected account can be put back. After this it is deleted for good. */
export const UNDO_MS = 7 * 24 * 60 * 60_000;

/** One account as the eject decision needs it. */
export interface EjectCandidate {
  file: string;
  email: string;
  disabled: boolean;
  status?: string;
  provider?: string;
}

/**
 * Why this account must not be ejected, in plain words, or null when it may.
 * The proxy needs an account to send to: ejecting the one in use, or the last
 * one that is enabled, would leave every thread on the box with nothing.
 */
export function ejectRefusal(target: EjectCandidate | undefined, accounts: readonly EjectCandidate[]): string | null {
  if (!target) return "No such account in the proxy. Nothing was ejected.";
  // An account on hold at Anthropic cannot serve requests even if its file on
  // disk still says disabled: false, so it is never in use and may be ejected.
  if (target.status === "on-hold") return null;
  const targetProvider = target.provider ?? "anthropic";
  const peers = accounts.filter((account) => (account.provider ?? "anthropic") === targetProvider);
  const enabled = peers.filter((account) => !account.disabled && account.status !== "on-hold");
  if (target.disabled) {
    if (enabled.length === 0) {
      return `${target.email} is the only account the proxy can use. Switch to another account first. Nothing was ejected.`;
    }
    return null;
  }
  if (enabled.length <= 1) {
    return `${target.email} is the only account the proxy can use. Switch to another account first. Nothing was ejected.`;
  }
  return `${target.email} is in use. Switch to another account first, then eject it. Nothing was ejected.`;
}

/** The credential store calls eject needs: remove a file, and write one back. */
export interface CoreAuthFiles {
  remove(name: string): Promise<void>;
  add(name: string, data: Uint8Array): Promise<void>;
}

/** What is kept beside an ejected file, so the list and the purge need not parse it. */
export interface EjectRecord {
  file: string;
  email: string;
  provider?: string;
  ejectedAt: number;
  /** After this the file is deleted and undo is no longer possible. */
  purgeAt: number;
}

/** A bare file name, or null: refuses anything that could reach outside a folder. */
export function safeAuthFileName(name: string): string | null {
  return /^(?:claude-[A-Za-z0-9._@+-]+|agentdb-[a-z0-9-]+-\d+)\.json$/u.test(name) && !name.includes("..") ? name : null;
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/**
 * Eject: keep a 0600 copy in the 0700 ejected folder, then have the store remove
 * the file. The copy is written first so a failure in between loses nothing;
 * if the store refuses, the copy is taken back out and the account is untouched.
 */
export async function ejectAccount(
  args: { authDir: string; ejectedDir: string; target: EjectCandidate; now: number; data?: Uint8Array | string },
  core: CoreAuthFiles,
): Promise<EjectRecord> {
  const name = safeAuthFileName(args.target.file);
  if (!name) throw new Error("That is not a valid auth file name. Nothing was ejected.");
  await ensurePrivateDir(args.ejectedDir);
  const data =
    args.data !== undefined
      ? typeof args.data === "string"
        ? Buffer.from(args.data, "utf8")
        : Buffer.from(args.data)
      : await readFile(join(args.authDir, name));
  const copy = join(args.ejectedDir, name);
  const record: EjectRecord = {
    file: name,
    email: args.target.email,
    ...(args.target.provider ? { provider: args.target.provider } : {}),
    ejectedAt: args.now,
    purgeAt: args.now + UNDO_MS,
  };
  await writeFile(copy, data, { mode: 0o600 });
  await chmod(copy, 0o600);
  await writeFile(`${copy}.eject`, JSON.stringify(record), { mode: 0o600 });
  await chmod(`${copy}.eject`, 0o600);
  try {
    await core.remove(name);
  } catch (error) {
    await rm(copy, { force: true });
    await rm(`${copy}.eject`, { force: true });
    throw error;
  }
  return record;
}

/** Ejected accounts still within their 7 days, oldest first. */
export async function listEjected(ejectedDir: string): Promise<EjectRecord[]> {
  let names: string[];
  try {
    names = await readdir(ejectedDir);
  } catch {
    return [];
  }
  const records: EjectRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json.eject")) continue;
    try {
      const record = JSON.parse(await readFile(join(ejectedDir, name), "utf8")) as EjectRecord;
      if (safeAuthFileName(record.file)) records.push(record);
    } catch {
      // A half-written record; the purge leaves it alone and so does the list.
    }
  }
  return records.sort((a, b) => a.ejectedAt - b.ejectedAt);
}

/**
 * Undo: hand the kept file back to the store, which writes it back and loads
 * it, then drop the copy. It comes back exactly as it left, disabled flag
 * included, so undo never puts an account into use.
 */
export async function undoEject(
  args: { authDir: string; ejectedDir: string; file: string; now: number; skipAuthDirCheck?: boolean },
  core: CoreAuthFiles,
): Promise<EjectRecord> {
  const name = safeAuthFileName(args.file);
  if (!name) throw new Error("That is not a valid auth file name.");
  const copy = join(args.ejectedDir, name);
  let record: EjectRecord;
  try {
    record = JSON.parse(await readFile(`${copy}.eject`, "utf8")) as EjectRecord;
  } catch {
    throw new Error("That account is not in the ejected list, so there is nothing to put back.");
  }
  if (args.now >= record.purgeAt) throw new Error(`${record.email} was ejected more than 7 days ago. Add it again with a fresh login.`);
  if (!args.skipAuthDirCheck && args.authDir) {
    try {
      await stat(join(args.authDir, name));
      throw new Error(`${record.email} is already back in the proxy. Nothing was changed.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let data: Buffer;
  try {
    data = await readFile(copy);
  } catch {
    throw new Error(`The kept copy of ${record.email} is missing, so it cannot be put back. Add it again with a fresh login.`);
  }
  await core.add(name, data);
  await rm(copy, { force: true });
  await rm(`${copy}.eject`, { force: true });
  return record;
}

/** Delete for good every ejected account past its 7 days. Returns what went. */
export async function purgeEjected(ejectedDir: string, now: number): Promise<EjectRecord[]> {
  const gone: EjectRecord[] = [];
  for (const record of await listEjected(ejectedDir)) {
    if (now < record.purgeAt) continue;
    const copy = join(ejectedDir, record.file);
    await rm(copy, { force: true });
    await rm(`${copy}.eject`, { force: true });
    gone.push(record);
  }
  return gone;
}

/**
 * The ejected-accounts list: one auth file name per line, for every account
 * ejected and not yet put back. The plugin itself never reads it; it is there
 * so a tool that checks, syncs or refreshes credentials can skip those
 * accounts instead of reporting them or writing them back.
 */
export function ejectedListText(records: readonly EjectRecord[]): string {
  const header = "# Accounts ejected by proxy-usage. One auth file name per line.\n";
  return header + records.map((record) => `${record.file}\n`).join("");
}

export async function writeEjectedList(path: string, records: readonly EjectRecord[]): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const tmp = `${path}.tmp`;
  await writeFile(tmp, ejectedListText(records), { mode: 0o600 });
  await rename(tmp, path);
}

// ---- the user's click -----------------------------------------------------
// Only the user ejects, from the popup. Same rule as the Comms panel's Send
// (chief-of-comms/send-block.ts): an RPC handler sees no caller, so any agent
// could reach it with `bb plugin rpc call` or curl. A plugin HTTP route does
// see the request: the popup first asks /eject-intent for a one-time code, and
// that route refuses a request with no Origin header, which bb's CLI and curl
// do not send and a browser always does on a POST. /eject and /eject-undo
// refuse without a live code for that account. Codes live in this process
// only and die on reload. There is no agent tool and no CLI command for it.

export const EJECT_INTENT_MS = 2 * 60_000;

export const NOT_USER_CLICK =
  "Not ejected. Only you can eject an account, with the Eject button in the Claude accounts popup. This request did not come from that button.";

export function hasBrowserOrigin(origin: string | null | undefined): boolean {
  return typeof origin === "string" && origin.trim() !== "";
}

/** One-time codes, each for one auth file and one action. */
export class EjectIntents {
  private readonly codes = new Map<string, { key: string; expiresAt: number }>();
  private readonly newCode: () => string;
  private readonly now: () => number;
  constructor(newCode: () => string, now: () => number = Date.now) {
    this.newCode = newCode;
    this.now = now;
  }

  issue(key: string): { intent: string; expiresAt: number } {
    const at = this.now();
    for (const [code, entry] of this.codes) if (entry.expiresAt <= at) this.codes.delete(code);
    const intent = this.newCode();
    const expiresAt = at + EJECT_INTENT_MS;
    this.codes.set(intent, { key, expiresAt });
    return { intent, expiresAt };
  }

  /** True once for a live code issued for this key; the code is spent either way. */
  take(intent: string | undefined, key: string): boolean {
    if (!intent) return false;
    const entry = this.codes.get(intent);
    this.codes.delete(intent);
    return entry !== undefined && entry.key === key && entry.expiresAt > this.now();
  }
}

export interface AgentDbCredentialRow {
  id: number;
  provider: string;
  credentialType: string;
  email: string | null;
  accountId: string | null;
  orgId: string | null;
  projectId: string | null;
  disabledCause: string | null;
  identityKey: string | null;
}

export function agentDbFileName(provider: string, id: number): string {
  const prefix = `agentdb-${provider}`;
  return `${prefix}-${id}.json`;
}

export const AGENT_DB_TIMEOUT_MS = 5_000;

export function openAgentDb(dbPath: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly, timeout: AGENT_DB_TIMEOUT_MS });
  return db;
}

export function readAgentDbCredentials(dbPath: string): AgentDbCredentialRow[] {
  const db = openAgentDb(dbPath, true);
  try {
    const rows = db
      .prepare(
        `SELECT
          id,
          provider,
          credential_type,
          json_extract(data, '$.email') AS email,
          json_extract(data, '$.accountId') AS account_id,
          json_extract(data, '$.orgId') AS org_id,
          json_extract(data, '$.projectId') AS project_id,
          disabled_cause,
          identity_key
        FROM auth_credentials
        WHERE credential_type = 'oauth'
          AND (disabled_cause IS NULL OR disabled_cause IN ('disabled', 'account_on_hold'))
        ORDER BY CASE provider WHEN 'google-antigravity' THEN 0 WHEN 'anthropic' THEN 1 ELSE 2 END, id ASC`,
      )
      .all() as {
      id: number;
      provider: string;
      credential_type: string;
      email: string | null;
      account_id: string | null;
      org_id: string | null;
      project_id: string | null;
      disabled_cause: string | null;
      identity_key: string | null;
    }[];
    return rows.map((r) => ({
      id: Number(r.id),
      provider: String(r.provider),
      credentialType: String(r.credential_type),
      email: typeof r.email === "string" && r.email.length > 0 ? r.email : null,
      accountId: typeof r.account_id === "string" && r.account_id.length > 0 ? r.account_id : null,
      orgId: typeof r.org_id === "string" && r.org_id.length > 0 ? r.org_id : null,
      projectId: typeof r.project_id === "string" && r.project_id.length > 0 ? r.project_id : null,
      disabledCause: r.disabled_cause === null || r.disabled_cause === undefined ? null : String(r.disabled_cause),
      identityKey: r.identity_key === null || r.identity_key === undefined ? null : String(r.identity_key),
    }));
  } finally {
    db.close();
  }
}

export function switchAgentDbAccount(dbPath: string, targetId: number): { provider: string; email: string } {
  const db = openAgentDb(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db
        .prepare("SELECT id, provider, json_extract(data, '$.email') AS email, disabled_cause FROM auth_credentials WHERE id = ?")
        .get(targetId) as { id: number; provider: string; email: string | null; disabled_cause: string | null } | undefined;
      if (!row) {
        throw new Error(`No credential with id ${targetId} in agent.db`);
      }
      const email = typeof row.email === "string" && row.email.length > 0 ? row.email : `${row.provider}:${row.id}`;
      if (row.disabled_cause === "account_on_hold") {
        throw new Error(`${email} is on hold at Anthropic; the proxy cannot use it. Not switched.`);
      }
      if (row.disabled_cause !== null && row.disabled_cause !== "disabled") {
        throw new Error(`${email} was disabled by omp (${row.disabled_cause}); cannot switch to it. Not switched.`);
      }
      const nowSec = Math.floor(Date.now() / 1000);
      db.prepare("UPDATE auth_credentials SET disabled_cause = NULL, updated_at = ? WHERE id = ?").run(nowSec, targetId);
      db.prepare(
        "UPDATE auth_credentials SET disabled_cause = 'disabled', updated_at = ? WHERE provider = ? AND id != ? AND disabled_cause IS NULL",
      ).run(nowSec, row.provider, targetId);
      db.prepare("DELETE FROM auth_credential_blocks WHERE credential_id = ?").run(targetId);
      db.exec("COMMIT");
      return { provider: row.provider, email };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export function exportAgentDbEjectPayload(dbPath: string, id: number): string {
  const db = openAgentDb(dbPath, true);
  try {
    const row = db
      .prepare(
        `SELECT json_object(
          'source', 'agent.db',
          'id', id,
          'provider', provider,
          'credentialType', credential_type,
          'data', json(data),
          'disabledCause', disabled_cause,
          'identityKey', identity_key
        ) AS payload FROM auth_credentials WHERE id = ?`,
      )
      .get(id) as { payload?: string } | undefined;
    if (!row?.payload) throw new Error(`No credential with id ${id} in agent.db`);
    return row.payload;
  } finally {
    db.close();
  }
}
function parseEjectedPayloadForAgentDb(rawText: string): {
  provider: string;
  credentialType: string;
  compactData: string;
  disabledCause: string;
  identityKey: string | null;
  email: string;
} {
  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  if (parsed.source === "agent.db" && typeof parsed.provider === "string") {
    const dataObj = (typeof parsed.data === "string" ? JSON.parse(parsed.data) : parsed.data) as Record<string, unknown>;
    const compactData = JSON.stringify(dataObj);
    const email = typeof dataObj.email === "string" ? dataObj.email : String(parsed.provider);
    const disabledCause =
      typeof parsed.disabledCause === "string" && parsed.disabledCause.length > 0
        ? parsed.disabledCause
        : "disabled";
    const identityKey =
      typeof parsed.identityKey === "string" && parsed.identityKey.length > 0
        ? parsed.identityKey
        : typeof dataObj.email === "string"
          ? typeof dataObj.orgId === "string" && dataObj.orgId.length > 0
            ? `email:${dataObj.email}|org:${dataObj.orgId}`
            : `email:${dataObj.email}`
          : null;
    return {
      provider: parsed.provider,
      credentialType: typeof parsed.credentialType === "string" ? parsed.credentialType : "oauth",
      compactData,
      disabledCause,
      identityKey,
      email,
    };
  }
  // Older per-account claude-*.json format (snake_case token fields, `expired` as an ISO date)
  const expiredStr = typeof parsed.expired === "string" ? parsed.expired : "";
  const parsedExp = expiredStr ? Date.parse(expiredStr) : Number.NaN;
  const expires = Number.isNaN(parsedExp) ? 0 : parsedExp;
  const email = typeof parsed.email === "string" && parsed.email.length > 0 ? parsed.email : "anthropic";
  const accountId = typeof parsed.account_uuid === "string" && parsed.account_uuid.length > 0 ? parsed.account_uuid : undefined;
  const orgId = typeof parsed.organization_uuid === "string" && parsed.organization_uuid.length > 0 ? parsed.organization_uuid : undefined;
  const orgName = typeof parsed.organization_name === "string" && parsed.organization_name.length > 0 ? parsed.organization_name : undefined;
  const dataObj: Record<string, unknown> = {
    refresh: typeof parsed.refresh_token === "string" ? parsed.refresh_token : "",
    access: typeof parsed.access_token === "string" ? parsed.access_token : "",
    expires,
    ...(accountId ? { accountId } : {}),
    email,
    ...(orgId ? { orgId } : {}),
    ...(orgName ? { orgName } : {}),
  };
  const compactData = JSON.stringify(dataObj);
  const identityKey = orgId ? `email:${email}|org:${orgId}` : `email:${email}`;
  return {
    provider: "anthropic",
    credentialType: "oauth",
    compactData,
    disabledCause: "disabled",
    identityKey,
    email,
  };
}

export function agentDbCoreAuthFiles(dbPath: string): CoreAuthFiles {
  return {
    async remove(name: string) {
      const m = name.match(/^agentdb-[a-z0-9-]+-(\d+)\.json$/u);
      if (!m) throw new Error(`Not an agent.db credential name: ${name}`);
      const id = Number(m[1]);
      const db = openAgentDb(dbPath);
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const res = db.prepare("DELETE FROM auth_credentials WHERE id = ?").run(id);
          db.prepare("DELETE FROM auth_credential_blocks WHERE credential_id = ?").run(id);
          if (Number(res.changes) === 0) {
            throw new Error(`Credential ${name} is not in agent.db`);
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } finally {
        db.close();
      }
    },
    async add(_name: string, data: Uint8Array) {
      const row = parseEjectedPayloadForAgentDb(Buffer.from(data).toString("utf8"));
      const db = openAgentDb(dbPath);
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const existing = row.identityKey
            ? db
                .prepare("SELECT id FROM auth_credentials WHERE provider = ? AND identity_key = ?")
                .get(row.provider, row.identityKey)
            : db
                .prepare("SELECT id FROM auth_credentials WHERE provider = ? AND json_extract(data, '$.email') = ?")
                .get(row.provider, row.email);
          if (existing) {
            throw new Error(`${row.email} is already back in the proxy. Nothing was changed.`);
          }
          const nowSec = Math.floor(Date.now() / 1000);
          db.prepare(
            "INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(row.provider, row.credentialType, row.compactData, row.disabledCause, row.identityKey, nowSec, nowSec);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } finally {
        db.close();
      }
    },
  };
}
