// The Superhuman Mail MCP client: the authorization code login with PKCE, the
// token file, the JSON-RPC transport over Streamable HTTP, and a typed facade
// over the tools this plugin uses.
//
// The client names it registers under and the reconnect sentence live in
// `superhuman-identity.ts`. This plugin holds its own token; another app's
// login to the same mailbox is separate and correct. A few methods are not
// called by this plugin and stay as part of the client.
//
// The login is the authorization code flow with PKCE, not the device-code
// flow; see the comment in `registerClient` below for why.
//
// Superhuman publishes tool
// names and one line descriptions and does NOT publish parameter schemas, so
// this client asks the server for them with `tools/list` on connect and checks
// every call against what came back. Where the server disagrees with what this
// file assumes, the call fails with the tool name and the field names we sent
// in the message. A wrong call that went through quietly would put a message in
// front of a stranger, so there is no quiet path here.
//
// No token value is ever logged, returned, put in a status object, or put in an
// error message. `scrub` below is the last line of that promise: it removes any
// token the client has seen from text the server sent back, in case the server
// ever echoes one.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import { CLIENT_NAME, RECONNECT_SENTENCE, REGISTRATION_CLIENT_NAME } from "./superhuman-identity.ts";

export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The MCP protocol version this client speaks. The server may negotiate another. */
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_VERSION = "0.1.0";
const DEFAULT_SCOPE = "openid email profile offline_access";

// Defaults only. `discover` reads the real values from the two well-known
// documents every time, because an endpoint that moved and a default that did
// not is a failure nobody would see until a send.
const DEFAULT_MCP_ENDPOINT = "https://mcp.mail.superhuman.com/mcp";
const DEFAULT_RESOURCE_METADATA_URL = "https://mcp.mail.superhuman.com/.well-known/oauth-protected-resource";
const DEFAULT_AUTH_SERVER = "https://mcp.auth.mail.superhuman.com";

/** The one sentence the owner needs when a login is dead. Only the owner can fix it. Set per plugin. */
export { RECONNECT_SENTENCE };

// ---------------------------------------------------------------------------
// Tools that make something leave
//
// This list is a tripwire, not a permission system. Nothing here blocks a call.
// The tests assert that only the human-triggered send path ever reaches the
// one tool used here (`sendMailDraft` in server.ts), so that a future edit
// which reaches a send from a sync loop or an agent tool fails a test instead
// of mailing a stranger.

const SEND_TOOLS: readonly string[] = Object.freeze([
  "send_draft",
  "add_account",
  "remove_account",
  "set_default_account",
  "update_personalization",
  "unsubscribe",
  "trash_thread",
  "mark_spam",
]);

export function callIsSend(name: string): boolean {
  return SEND_TOOLS.includes(name);
}

// ---------------------------------------------------------------------------
// Small helpers over unknown JSON

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** "draft_id", "draftId" and "DraftID" are the same key as far as this file cares. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}...`;
}

function sameId(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return String(left) === String(right);
}

/**
 * Read one value out of a server payload, trying several names for it.
 *
 * This exists because Superhuman publishes no parameter or result schemas. The
 * name a field comes back under is a guess until `tools/list` and a call say
 * otherwise, so every read tries the plausible names and fails loudly
 * with the names it tried when none of them is there. Matching ignores case,
 * underscores and dashes, so listing `draftId` also covers `draft_id`.
 */
export function pick(source: unknown, ...keys: string[]): unknown {
  const found = pickOptional(source, ...keys);
  if (found === null) {
    const record = asRecord(source);
    const present = record === null ? "the value was not an object" : Object.keys(record).join(", ") || "none";
    throw new Error(
      `Superhuman returned no value under any of: ${keys.join(", ")}. Fields present: ${present}. ` +
        "Superhuman publishes no result schemas, so this is a finding to record in SUPERHUMAN-TOOLS.md.",
    );
  }
  return found;
}

/** Same lookup as `pick`, but a missing field is null rather than an error. */
export function pickOptional(source: unknown, ...keys: string[]): unknown {
  const record = asRecord(source);
  if (record === null) return null;
  const byNormal = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    const normal = normalizeKey(key);
    if (!byNormal.has(normal)) byNormal.set(normal, value);
  }
  for (const key of keys) {
    const value = byNormal.get(normalizeKey(key));
    if (value !== undefined) return value;
  }
  return null;
}

function pickString(source: unknown, ...keys: string[]): string {
  const value = pick(source, ...keys);
  return valueToString(value);
}

function pickOptionalString(source: unknown, ...keys: string[]): string | null {
  const value = pickOptional(source, ...keys);
  return value === null ? null : valueToString(value);
}

export function valueToString(value: unknown): string {
  if (isString(value)) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const record = asRecord(value);
  if (record !== null) {
    // An address often arrives as { name, email } rather than a string.
    const email = pickOptional(record, "email", "address", "emailAddress", "account");
    if (isString(email)) {
      const name = pickOptional(record, "name", "displayName");
      return isString(name) && name !== "" ? `${name} <${email}>` : email;
    }
    const id = pickOptional(record, "id", "value");
    if (isString(id)) return id;
  }
  return JSON.stringify(value) ?? "";
}

/** Descend one level when the payload wraps everything under a single key. */
function unwrap(json: unknown, ...wrappers: string[]): unknown {
  const record = asRecord(json);
  if (record === null) return json;
  for (const wrapper of wrappers) {
    const inner = pickOptional(record, wrapper);
    if (isRecord(inner)) return inner;
  }
  return record;
}

/** Epoch milliseconds, epoch seconds or an ISO string, all to an ISO string. */
export function toIsoString(value: unknown, what: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (isString(value)) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return toIsoString(Number(trimmed), what);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  throw new Error(`Superhuman returned ${what} as a value this client cannot read as a date: ${clip(String(value), 60)}.`);
}

// ---------------------------------------------------------------------------
// Secret hygiene

/**
 * Strike secrets out of anything the server echoed back before it reaches a
 * log or an error.
 *
 * The eight character floor is deliberate. Redacting a short string would
 * match innocent text all over the message and hand back something unreadable,
 * which is worse than useless when somebody is trying to see why a sign-in
 * failed. Every real token, code and verifier here is far longer: an OAuth
 * code verifier is at least 43 characters by RFC 7636, and the access tokens
 * this server issues are longer still.
 */
function redact(text: string, secrets: Array<string | null>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === null || secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
}

// ---------------------------------------------------------------------------
// OAuth: discovery, registration, the authorization-code sign-in, refresh

export interface OAuthEndpoints {
  /** The MCP endpoint the resource document points at. */
  mcpEndpoint: string;
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
}

async function getJson(fetchImpl: FetchImpl, url: string, what: string): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Reading ${what} at ${url} returned HTTP ${res.status}: ${clip(text, 200)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Reading ${what} at ${url} returned something that is not JSON: ${clip(text, 200)}`);
  }
  const record = asRecord(parsed);
  if (record === null) throw new Error(`Reading ${what} at ${url} returned JSON that is not an object.`);
  return record;
}

function absolute(value: unknown, base: string, field: string, source: string): string {
  if (!isString(value) || value === "") {
    throw new Error(`The Superhuman authorization server document at ${source} has no ${field}.`);
  }
  return new URL(value, base).toString();
}

/**
 * Read the two well-known documents and return the endpoints. Nothing past the
 * starting URL is hard-coded: the DEFAULT_* constants are defaults
 * for the first fetch only.
 */
export async function discover(
  fetchImpl: FetchImpl,
  resourceMetadataUrl: string = DEFAULT_RESOURCE_METADATA_URL,
): Promise<OAuthEndpoints> {
  const resourceDoc = await getJson(fetchImpl, resourceMetadataUrl, "the MCP protected resource document");
  const mcpEndpoint = isString(resourceDoc.resource) && resourceDoc.resource !== "" ? resourceDoc.resource : DEFAULT_MCP_ENDPOINT;
  const servers = asArray(resourceDoc.authorization_servers).filter(isString);
  const authorizationServer = servers.length > 0 ? servers[0] : DEFAULT_AUTH_SERVER;

  const asUrl = new URL("/.well-known/oauth-authorization-server", authorizationServer).toString();
  const asDoc = await getJson(fetchImpl, asUrl, "the Superhuman authorization server document");

  return {
    mcpEndpoint,
    authorizationServer,
    authorizationEndpoint: absolute(asDoc.authorization_endpoint, authorizationServer, "authorization_endpoint", asUrl),
    tokenEndpoint: absolute(asDoc.token_endpoint, authorizationServer, "token_endpoint", asUrl),
    registrationEndpoint: absolute(asDoc.registration_endpoint, authorizationServer, "registration_endpoint", asUrl),
  };
}

/**
 * RFC 7591 dynamic client registration. Superhuman accepts
 * `token_endpoint_auth_method: "none"`, so there is no client secret to store
 * and nothing here ever needs the `secrets` skill.
 */
export async function registerClient(
  fetchImpl: FetchImpl,
  endpoints: OAuthEndpoints,
  redirectUri: string,
  clientName: string = REGISTRATION_CLIENT_NAME,
): Promise<string> {
  const body = {
    client_name: clientName,
    // Both of these are load bearing. The authorization server advertises
    // the device-code grant in `grant_types_supported`, but its registration
    // endpoint accepts only authorization_code and refresh_token. So the
    // sign-in is the authorization-code flow with PKCE, and redirect_uris
    // must be an array even for one entry.
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: DEFAULT_SCOPE,
    application_type: "native",
  };
  const res = await fetchImpl(endpoints.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Registering this plugin with Superhuman returned HTTP ${res.status}: ${clip(text, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Registering this plugin with Superhuman returned something that is not JSON: ${clip(text, 200)}`);
  }
  const clientId = pickOptionalString(parsed, "client_id");
  if (clientId === null || clientId === "") {
    throw new Error("Superhuman registered this plugin but returned no client_id.");
  }
  return clientId;
}

interface FormReply {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | null;
  text: string;
}

async function postForm(fetchImpl: FetchImpl, url: string, form: Record<string, string>): Promise<FormReply> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = asRecord(JSON.parse(text));
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

interface Pkce {
  verifier: string;
  challenge: string;
}

/**
 * A PKCE pair. The verifier never leaves this machine and never reaches a log:
 * it is held in memory between the authorize redirect and the code exchange,
 * and it is what stops anybody who intercepts the returned code from using it.
 */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Random, unguessable, and the only thing standing between the callback route and a forged request. */
export function createState(): string {
  return randomBytes(24).toString("base64url");
}

interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scope?: string;
}

/** The URL the owner opens in a browser to sign in. Carries no secret: the verifier stays here. */
export function buildAuthorizeUrl(endpoints: OAuthEndpoints, request: AuthorizeRequest): string {
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("scope", request.scope ?? DEFAULT_SCOPE);
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // The resource this token is for, so the server issues one the MCP endpoint
  // will accept rather than a bare profile token.
  url.searchParams.set("resource", endpoints.mcpEndpoint);
  return url.toString();
}

/**
 * Swap the returned code for tokens. The code and the verifier are both
 * secrets for the length of this call and are redacted out of any error.
 */
export async function exchangeCode(
  fetchImpl: FetchImpl,
  endpoints: OAuthEndpoints,
  input: { clientId: string; code: string; verifier: string; redirectUri: string },
  nowMs: number = Date.now(),
): Promise<TokenSet> {
  const reply = await postForm(fetchImpl, endpoints.tokenEndpoint, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
    resource: endpoints.mcpEndpoint,
  });
  if (!reply.ok || reply.json === null) {
    const detail = reply.json === null ? clip(reply.text, 200) : oauthErrorText(reply.json);
    throw new Error(`Exchanging the Superhuman sign-in code returned HTTP ${reply.status}: ${redact(detail, [input.code, input.verifier])}`);
  }
  return readTokenSet(reply.json, nowMs);
}

function oauthErrorText(json: Record<string, unknown>): string {
  const code = pickOptionalString(json, "error") ?? "unknown_error";
  const description = pickOptionalString(json, "error_description");
  return description === null ? code : `${code}: ${description}`;
}

interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number;
  scope: string;
  tokenType: string;
}

function readTokenSet(json: Record<string, unknown>, nowMs: number): TokenSet {
  const accessToken = pickOptionalString(json, "access_token");
  if (accessToken === null || accessToken === "") {
    throw new Error("Superhuman returned a token response with no access_token.");
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  return {
    accessToken,
    refreshToken: pickOptionalString(json, "refresh_token"),
    expiresAtMs: nowMs + expiresIn * 1000,
    scope: pickOptionalString(json, "scope") ?? DEFAULT_SCOPE,
    tokenType: pickOptionalString(json, "token_type") ?? "Bearer",
  };
}

/**
 * Swap a refresh token for a new access token. A 400 `invalid_grant` means the
 * login is dead, which only the owner can fix, so the message says exactly that.
 * The refresh token is redacted out of anything the server sent back.
 */
export async function refresh(
  fetchImpl: FetchImpl,
  endpoints: OAuthEndpoints,
  clientId: string,
  refreshToken: string,
  nowMs: number = Date.now(),
): Promise<TokenSet> {
  const reply = await postForm(fetchImpl, endpoints.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (reply.ok && reply.json !== null) return readTokenSet(reply.json, nowMs);

  const code = reply.json === null ? null : pickOptionalString(reply.json, "error");
  if (reply.status === 400 && code === "invalid_grant") {
    throw new Error(`The Superhuman login is no longer valid. ${RECONNECT_SENTENCE}`);
  }
  const detail = reply.json === null ? clip(reply.text, 200) : oauthErrorText(reply.json);
  throw new Error(`Refreshing the Superhuman token returned HTTP ${reply.status}: ${redact(detail, [refreshToken])}`);
}

// ---------------------------------------------------------------------------
// Token storage

export interface StoredTokens {
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAtMs: number;
  scope: string;
  tokenType: string;
  obtainedAtMs: number;
}

function tokensExpired(tokens: StoredTokens, nowMs: number, skewMs: number = 60_000): boolean {
  return nowMs + skewMs >= tokens.expiresAtMs;
}

/**
 * The token file. The mode is set at creation and verified straight after, not
 * by a later sweep, which is the house rule. Nothing in this class returns or
 * logs a token value; `read` hands the caller the object and that is the only
 * way a token leaves.
 */
export class TokenStore {
  path: string;

  constructor(path: string) {
    this.path = path;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  read(): StoredTokens | null {
    if (!existsSync(this.path)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      // The file content is a secret, so the error says where, never what.
      throw new Error(`The Superhuman token file at ${this.path} is not readable JSON. ${RECONNECT_SENTENCE}`);
    }
    const record = asRecord(parsed);
    if (record === null) throw new Error(`The Superhuman token file at ${this.path} does not hold an object. ${RECONNECT_SENTENCE}`);
    const clientId = record.clientId;
    const accessToken = record.accessToken;
    if (!isString(clientId) || !isString(accessToken)) {
      throw new Error(`The Superhuman token file at ${this.path} is missing clientId or accessToken. ${RECONNECT_SENTENCE}`);
    }
    return {
      clientId,
      accessToken,
      refreshToken: isString(record.refreshToken) ? record.refreshToken : null,
      expiresAtMs: typeof record.expiresAtMs === "number" ? record.expiresAtMs : 0,
      scope: isString(record.scope) ? record.scope : DEFAULT_SCOPE,
      tokenType: isString(record.tokenType) ? record.tokenType : "Bearer",
      obtainedAtMs: typeof record.obtainedAtMs === "number" ? record.obtainedAtMs : 0,
    };
  }

  write(tokens: StoredTokens): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const directoryMode = statSync(directory).mode & 0o777;
    if (directoryMode !== 0o700) {
      throw new Error(`The Superhuman token directory ${directory} is mode ${directoryMode.toString(8)}, not 700. Refusing to write a token into it.`);
    }
    // writeFileSync only applies `mode` when it creates the file, so the chmod
    // after it is not belt and braces: it is the only thing that fixes an
    // existing file. The stat then proves both, before anything reports success.
    writeFileSync(this.path, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.path, 0o600);
    const fileMode = statSync(this.path).mode & 0o777;
    if (fileMode !== 0o600) {
      throw new Error(`The Superhuman token file ${this.path} came out mode ${fileMode.toString(8)}, not 600.`);
    }
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }

  isExpired(nowMs: number, skewMs: number = 60_000): boolean {
    const tokens = this.read();
    if (tokens === null) return true;
    return tokensExpired(tokens, nowMs, skewMs);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over Streamable HTTP

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/**
 * Find the reply to `id` in a `text/event-stream` body.
 *
 * The server may answer the same POST with JSON or with an SSE stream, and the
 * SSE case is the one that fails silently if it is not handled: a JSON parse of
 * the whole body throws, or worse, half-works. The last matching message wins,
 * because a stream may carry progress notifications before the result.
 */
export function parseSseForResult(text: string, id: string | number): JsonRpcResponse | null {
  let match: JsonRpcResponse | null = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n").trim();
    if (payload === "" || payload === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A keep-alive or a comment is not our answer. Skip it rather than fail.
      continue;
    }
    const record = asRecord(parsed);
    if (record === null) continue;
    if (!sameId(record.id, id)) continue;
    match = record as JsonRpcResponse;
  }
  return match;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
}

interface McpCallResult {
  content: unknown[];
  structuredContent: unknown;
  isError: boolean;
}

/** Everything the server sent as text, joined. */
export function textOf(result: McpCallResult): string {
  const parts: string[] = [];
  for (const block of result.content) {
    const record = asRecord(block);
    if (record === null) continue;
    if (isString(record.text)) parts.push(record.text);
  }
  return parts.join("\n");
}

/**
 * The structured half of a result, or the text parsed as JSON. Unparseable text
 * returns null rather than throwing, so a caller can decide whether that is a
 * failure or just a tool that answers in prose.
 */
export function jsonOf(result: McpCallResult): unknown {
  if (result.structuredContent !== null && result.structuredContent !== undefined) return result.structuredContent;
  const text = textOf(result).trim();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One argument to a tool call, with the names the server might know it by. */
interface ArgField {
  names: string[];
  value: unknown;
}

/**
 * Turn our field names into the names the server advertises.
 *
 * Superhuman publishes no parameter schemas, so the names below are a guess
 * until `tools/list` says otherwise. When the server does advertise a schema,
 * the first candidate name it accepts wins, a field it accepts under none of
 * the candidates is an error naming the tool and what we sent, and a required
 * property we did not send is an error too, so no field on a draft or a send
 * is ever dropped silently.
 */
export function buildArgs(toolName: string, tool: McpTool | null, fields: ArgField[]): Record<string, unknown> {
  const properties = asRecord(tool?.inputSchema?.properties ?? null);
  const out: Record<string, unknown> = {};

  if (properties === null) {
    for (const field of fields) {
      if (field.value === undefined || field.value === null) continue;
      out[field.names[0]] = field.value;
    }
    return out;
  }

  const byNormal = new Map<string, string>();
  for (const key of Object.keys(properties)) byNormal.set(normalizeKey(key), key);

  for (const field of fields) {
    if (field.value === undefined || field.value === null) continue;
    let target: string | null = null;
    for (const name of field.names) {
      const found = byNormal.get(normalizeKey(name));
      if (found !== undefined) {
        target = found;
        break;
      }
    }
    if (target === null) {
      throw new Error(
        `Superhuman's "${toolName}" tool accepts none of the names this client uses for one field (${field.names.join(", ")}). ` +
          `It advertises: ${Object.keys(properties).join(", ")}. Record the real schema in SUPERHUMAN-TOOLS.md and fix this client.`,
      );
    }
    out[target] = coerceToDeclaredType(field.value, asRecord(properties[target]));
  }

  const required = asArray(tool?.inputSchema?.required ?? null).filter(isString);
  const missing = required.filter((name) => !(name in out));
  if (missing.length > 0) {
    const sent = Object.keys(out).join(", ");
    throw new Error(
      `Superhuman's "${toolName}" tool requires ${missing.join(", ")}, which this client did not send. ` +
        `It sent: ${sent === "" ? "nothing" : sent}.`,
    );
  }
  return out;
}

function coerceToDeclaredType(value: unknown, property: Record<string, unknown> | null): unknown {
  if (property === null) return value;
  const declared = isString(property.type) ? property.type : null;
  if (declared === "string" && Array.isArray(value)) return value.map((entry) => valueToString(entry)).join(", ");
  if (declared === "array" && isString(value)) return [value];
  return value;
}

interface SuperhumanClientOptions {
  store: TokenStore;
  fetchImpl?: FetchImpl;
  endpoint?: string;
  /** Pass the endpoints to skip discovery; the client discovers them when it needs a refresh. */
  endpoints?: OAuthEndpoints | null;
  /** The plugin's logger. The default does nothing, because writing to stdout would corrupt CLI output. */
  log?: (line: string) => void;
  now?: () => number;
  /** Deadline for one request, in milliseconds. Generous for these calls; the point is that one exists. */
  timeoutMs?: number;
}

export class SuperhumanClient {
  store: TokenStore;
  endpoint: string;
  fetchImpl: FetchImpl;
  endpoints: OAuthEndpoints | null;
  log: (line: string) => void;
  now: () => number;
  sessionId: string | null;
  protocolVersion: string | null;
  tools: McpTool[] | null;
  /** The in-flight handshake, so concurrent first callers share one. */
  private connecting: Promise<McpTool[]> | null = null;
  /** Deadline for one request. A stalled call would otherwise hold the service loop. */
  readonly timeoutMs: number;
  toolsByName: Map<string, McpTool>;
  /** Token values this client has held, kept only so `scrub` can remove them from server text. */
  seenSecrets: Set<string>;
  /** The schema last logged per tool, so each is logged once rather than on every call. */
  private loggedSchemas = new Map<string, string>();

  constructor(options: SuperhumanClientOptions) {
    this.store = options.store;
    this.endpoint = options.endpoint ?? DEFAULT_MCP_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input as RequestInfo, init));
    this.endpoints = options.endpoints ?? null;
    this.log = options.log ?? (() => {});
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
    this.sessionId = null;
    this.protocolVersion = null;
    this.tools = null;
    this.toolsByName = new Map();
    this.seenSecrets = new Set();
  }

  scrub(text: string): string {
    return redact(text, [...this.seenSecrets]);
  }

  remember(tokens: StoredTokens): void {
    this.seenSecrets.add(tokens.accessToken);
    if (tokens.refreshToken !== null) this.seenSecrets.add(tokens.refreshToken);
  }

  requireTokens(): StoredTokens {
    const tokens = this.store.read();
    if (tokens === null) throw new Error(`Superhuman is not connected. ${RECONNECT_SENTENCE}`);
    this.remember(tokens);
    return tokens;
  }

  /**
   * Discovery is the authority on where the MCP endpoint is: what it finds
   * replaces the built-in default, so a moved endpoint is followed rather
   * than posted to at a stale constant.
   */
  async resolveEndpoints(): Promise<OAuthEndpoints> {
    if (this.endpoints === null) this.endpoints = await discover(this.fetchImpl);
    if (this.endpoints.mcpEndpoint !== "" && this.endpoints.mcpEndpoint !== this.endpoint) {
      this.log(`superhuman: endpoint moved from ${this.endpoint} to ${this.endpoints.mcpEndpoint}`);
      this.endpoint = this.endpoints.mcpEndpoint;
    }
    return this.endpoints;
  }

  async refreshNow(): Promise<void> {
    const tokens = this.requireTokens();
    if (tokens.refreshToken === null || tokens.refreshToken === "") {
      throw new Error(`The Superhuman login has no refresh token left. ${RECONNECT_SENTENCE}`);
    }
    const endpoints = await this.resolveEndpoints();
    const next = await refresh(this.fetchImpl, endpoints, tokens.clientId, tokens.refreshToken, this.now());
    const stored: StoredTokens = {
      clientId: tokens.clientId,
      accessToken: next.accessToken,
      // Some servers omit the refresh token on a refresh and mean "keep the old one".
      refreshToken: next.refreshToken ?? tokens.refreshToken,
      expiresAtMs: next.expiresAtMs,
      scope: next.scope,
      tokenType: next.tokenType,
      obtainedAtMs: this.now(),
    };
    this.store.write(stored);
    this.remember(stored);
  }

  async accessToken(): Promise<string> {
    let tokens = this.requireTokens();
    if (tokensExpired(tokens, this.now())) {
      await this.refreshNow();
      tokens = this.requireTokens();
    }
    return tokens.accessToken;
  }

  async send(payload: JsonRpcRequest | JsonRpcNotification, expectReply: boolean): Promise<JsonRpcResponse | null> {
    let refreshedOnce = false;
    for (;;) {
      const token = await this.accessToken();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      if (this.sessionId !== null) headers["mcp-session-id"] = this.sessionId;
      // The protocol version header belongs on every call after initialize, and
      // not on initialize itself, which is what negotiates it.
      if (this.protocolVersion !== null) headers["mcp-protocol-version"] = this.protocolVersion;

      // Without a deadline a stalled request holds the whole service loop, and
      // the loop only re-tests its abort signal between iterations, so a
      // reload lands while the old iteration is still running.
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const session = res.headers.get("mcp-session-id");
      if (session !== null && session !== "") this.sessionId = session;

      if (res.status === 401) {
        if (refreshedOnce) {
          throw new Error(`Superhuman refused the token twice, so the login is dead. ${RECONNECT_SENTENCE}`);
        }
        refreshedOnce = true;
        await this.refreshNow();
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Superhuman returned HTTP ${res.status} for ${payload.method}: ${this.scrub(clip(text, 300))}`);
      }
      if (!expectReply) return null;

      const id = (payload as JsonRpcRequest).id;
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("text/event-stream")) {
        const found = parseSseForResult(text, id);
        if (found === null) {
          throw new Error(`Superhuman's event stream carried no reply to ${payload.method}.`);
        }
        return found;
      }
      if (text.trim() === "") {
        throw new Error(`Superhuman returned an empty body for ${payload.method}.`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Superhuman returned a body for ${payload.method} that is neither JSON nor an event stream: ${this.scrub(clip(text, 200))}`);
      }
      if (Array.isArray(parsed)) {
        const matched = parsed.map(asRecord).find((entry) => entry !== null && sameId(entry.id, id));
        if (matched === undefined || matched === null) {
          throw new Error(`Superhuman's batch reply held no answer to ${payload.method}.`);
        }
        return matched as JsonRpcResponse;
      }
      const record = asRecord(parsed);
      if (record === null) throw new Error(`Superhuman returned JSON that is not an object for ${payload.method}.`);
      return record as JsonRpcResponse;
    }
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    const reply = await this.send({ jsonrpc: "2.0", id, method, params }, true);
    if (reply === null) throw new Error(`Superhuman sent no reply to ${method}.`);
    if (reply.error !== undefined && reply.error !== null) {
      const message = isString(reply.error.message) ? reply.error.message : "no message";
      throw new Error(`Superhuman failed ${method}: ${this.scrub(message)}`);
    }
    return reply.result;
  }

  /** initialize, notifications/initialized, then tools/list, which is kept. */
  /**
   * The handshake, at most once. The `tools !== null` test alone is no guard
   * against two callers that both arrive before either finishes, for example
   * the status surface and the from-address check on a cold account cache.
   * Each duplicate initialize can hand back a new session id that overwrites
   * the shared one.
   */
  async connect(): Promise<McpTool[]> {
    if (this.tools !== null) return this.tools;
    if (this.connecting !== null) return this.connecting;
    this.connecting = this.handshake().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async handshake(): Promise<McpTool[]> {
    const init = await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      capabilities: {},
    });
    const negotiated = pickOptionalString(init, "protocolVersion");
    this.protocolVersion = negotiated ?? PROTOCOL_VERSION;
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
    this.tools = await this.fetchTools();
    this.toolsByName = new Map(this.tools.map((tool) => [tool.name, tool]));
    this.log(`superhuman: connected, ${this.tools.length} tools advertised: ${this.tools.map((tool) => tool.name).join(", ")}`);
    return this.tools;
  }

  async fetchTools(): Promise<McpTool[]> {
    const found: McpTool[] = [];
    let cursor: string | null = null;
    // A page cap, so a server that always returns a cursor cannot spin here.
    for (let page = 0; page < 10; page += 1) {
      const result: unknown = await this.rpc("tools/list", cursor === null ? {} : { cursor });
      for (const entry of asArray(pickOptional(result, "tools"))) {
        const record = asRecord(entry);
        if (record === null || !isString(record.name)) continue;
        found.push({
          name: record.name,
          description: isString(record.description) ? record.description : "",
          inputSchema: asRecord(pickOptional(record, "inputSchema")),
        });
      }
      cursor = pickOptionalString(result, "nextCursor");
      if (cursor === null || cursor === "") break;
    }
    return found;
  }

  /**
   * Call one tool. The tool must be advertised, the argument names are checked
   * against its advertised schema, and the schema is logged so a mismatch is
   * visible in the plugin log rather than only in a failure.
   */
  async callTool(name: string, fields: ArgField[]): Promise<McpCallResult> {
    await this.connect();
    const tool = this.toolsByName.get(name) ?? null;
    if (tool === null) {
      const advertised = [...this.toolsByName.keys()].join(", ");
      throw new Error(`Superhuman does not advertise a tool named "${name}". It advertises: ${advertised}.`);
    }
    // The schema once per tool per connection, and again only if it changes.
    // Logged on every call, it crowded almost everything else out of the
    // plugin logs and shortened the history each log could hold.
    const schema = JSON.stringify(tool.inputSchema);
    if (this.loggedSchemas.get(name) !== schema) {
      this.loggedSchemas.set(name, schema);
      this.log(`superhuman: ${name} advertises input schema ${schema}`);
    }

    const args = buildArgs(name, tool, fields);

    const raw = await this.rpc("tools/call", { name, arguments: args });
    const record = asRecord(raw);
    const result: McpCallResult = {
      content: asArray(record === null ? null : record.content),
      structuredContent: record === null ? null : (record.structuredContent ?? null),
      isError: record !== null && record.isError === true,
    };
    if (result.isError) {
      throw new Error(
        `Superhuman's "${name}" tool returned an error: ${this.scrub(clip(textOf(result), 300))}. Fields sent: ${Object.keys(args).join(", ") || "none"}.`,
      );
    }
    return result;
  }

  async callJson(name: string, fields: ArgField[]): Promise<unknown> {
    const result = await this.callTool(name, fields);
    const json = jsonOf(result);
    if (json === null) {
      throw new Error(
        `Superhuman's "${name}" tool returned text this client cannot read as JSON: ${this.scrub(clip(textOf(result), 200))}`,
      );
    }
    return json;
  }

  // -------------------------------------------------------------------------
  // The facade
  //
  // Every key list below is a guess, because Superhuman publishes tool names and
  // descriptions and no schemas. `pick` throws with the names it tried when the
  // guess is wrong, and the matching ignores case and underscores.

  /**
   * The mailboxes Superhuman has linked.
   *
   * Each entry is shaped like
   * `{"accountEmail":"...","isPrimary":true,"addedAt":"..."}`. Only the
   * address is taken: a stringified record would show a lump of JSON where
   * an address belongs and the from-address comparison could never match.
   * It throws when an entry carries no address it recognises, so a wrong key
   * guess is loud rather than silent.
   *
   * These are ACCOUNTS, not sending identities. An account can also send as an
   * alias, and Superhuman does not list those here, so `accounts` is not the
   * set of addresses mail can go out from.
   */
  async listAccounts(): Promise<{ accounts: string[]; defaultAccount: string | null }> {
    const json = await this.callJson("list_accounts", []);
    const raw = Array.isArray(json) ? json : pick(json, "accounts", "emailAccounts", "items");
    const entries = asArray(raw);
    const addressOf = (entry: unknown): string => {
      if (typeof entry === "string") return entry.trim();
      const record = asRecord(entry);
      if (record === null) return "";
      const address = pickOptionalString(record, "accountEmail", "account_email", "email", "emailAddress", "email_address", "address");
      if (address === null || address.trim() === "") {
        throw new Error(`list_accounts returned an account with no address under any key this client knows. Keys present: ${Object.keys(record).join(", ")}.`);
      }
      return address.trim();
    };
    const accounts = entries.map(addressOf).filter((entry) => entry !== "");

    let defaultAccount = pickOptionalString(json, "defaultAccount", "default_account", "default");
    if (defaultAccount === null) {
      for (const entry of entries) {
        const record = asRecord(entry);
        if (record === null) continue;
        const flag = pickOptional(record, "isDefault", "is_default", "default", "isPrimary", "is_primary", "primary");
        if (flag === true) {
          defaultAccount = addressOf(record);
          break;
        }
      }
    }
    return { accounts, defaultAccount };
  }

  /**
   * Create or revise the draft. Arguments are the ones the live server
   * advertises, recorded in SUPERHUMAN-TOOLS.md, not guesses.
   *
   * Two of them matter. `type` is required and always sent. And `body` is
   * the literal HTML: the tool also takes `instructions`, which asks
   * Superhuman to WRITE the email, and this plugin never uses that. The text
   * is written by the plugin's own drafting path and checked by the guard, so
   * nothing else is allowed to compose it.
   */
  async createOrUpdateDraft(input: {
    draftId?: string | null;
    threadId?: string | null;
    /**
     * `new` unless this is a reply on an existing thread. The server requires
     * it, and it is the field that decides whether the message joins a thread
     * or starts one: passing `thread_id` with `new` is not the same request.
     */
    type?: "new" | "reply" | "reply_all" | "forward";
    from: string;
    to: string[];
    /** Optional; left out when nobody is copied. */
    cc?: string[];
    subject: string;
    bodyHtml: string;
    actingEmail?: string | null;
  }): Promise<{ draftId: string; threadId: string | null }> {
    const json = await this.callJson("create_or_update_draft", [
      { names: ["type"], value: input.type ?? "new" },
      { names: ["draft_id"], value: input.draftId ?? undefined },
      { names: ["thread_id"], value: input.threadId ?? undefined },
      { names: ["from"], value: input.from },
      { names: ["to"], value: input.to },
      { names: ["cc"], value: input.cc !== undefined && input.cc.length > 0 ? input.cc : undefined },
      { names: ["subject"], value: input.subject },
      { names: ["body"], value: input.bodyHtml },
      { names: ["acting_email"], value: input.actingEmail ?? undefined },
    ]);
    const payload = unwrap(json, "draft", "result", "data");
    return {
      draftId: pickString(payload, "draftId", "draft_id", "id"),
      threadId: pickOptionalString(payload, "threadId", "thread_id", "conversationId"),
    };
  }

  /**
   * The one call that makes a message leave. Each plugin reaches it from its
   * own human-triggered send path only; see SEND_TOOLS above.
   *
   * It takes the draft id and nothing else about the message. The from
   * address, the recipient, the subject and the body all live on the draft,
   * which is why `createOrUpdateDraft` is where a wrong identity would be
   * introduced. The server refuses a send that passes any of those here.
   *
   * With no scheduling option the server applies a one minute undo delay of
   * its own, so a message recorded as sent is genuinely cancellable for a
   * minute afterwards through `undo_send`.
   *
   * `undoMinutes` asks for that window explicitly (1 to 10). Only then does
   * the server hand back an `undo_token` and `undo_expires_at`, which is what
   * the panel's Undo countdown is read from: the server's own deadline, not a
   * guess at its default. It is mutually exclusive with `smart_send`, so a
   * smart send carries no undo window of ours.
   */
  async sendDraft(input: { draftId: string; smartSend: boolean; undoMinutes?: number | null; actingEmail?: string | null }): Promise<{
    messageId: string;
    threadId: string | null;
    undoToken: string | null;
    undoExpiresAt: string | null;
  }> {
    const undoMinutes = input.smartSend || input.undoMinutes == null ? undefined : Math.min(10, Math.max(1, Math.round(input.undoMinutes)));
    const json = await this.callJson("send_draft", [
      { names: ["draft_id"], value: input.draftId },
      { names: ["smart_send"], value: input.smartSend ? true : undefined },
      { names: ["undo_timeout"], value: undoMinutes },
      { names: ["acting_email"], value: input.actingEmail ?? undefined },
    ]);
    const payload = unwrap(json, "message", "result", "data");
    return {
      messageId: pickString(payload, "messageId", "message_id", "id"),
      threadId: pickOptionalString(payload, "threadId", "thread_id", "conversationId"),
      // The token and the deadline may sit beside the message rather than in
      // it, so both places are read. A deadline the server did not send stays
      // null: the caller then falls back to its own count, or says the window
      // is unknown rather than inventing one.
      undoToken: pickOptionalString(payload, "undoToken", "undo_token") ?? pickOptionalString(json, "undoToken", "undo_token"),
      undoExpiresAt: this.undoDeadline(payload, json),
    };
  }

  /**
   * The undo deadline, or null. It is read AFTER send_draft has queued the
   * message, so it must never throw: a throw here lands in the send's catch,
   * which records an email that is on its way as uncertain. An unreadable
   * value is logged (clipped) and the caller falls back to its own count,
   * which ends a little early and is therefore safe.
   */
  private undoDeadline(payload: unknown, json: unknown): string | null {
    try {
      return readOptionalDate(payload, "undoExpiresAt", "undo_expires_at") ?? readOptionalDate(json, "undoExpiresAt", "undo_expires_at");
    } catch (error) {
      this.log(`superhuman: send_draft returned an undo deadline this client cannot read, so it is ignored: ${clip(this.scrub(String((error as Error).message)), 160)}`);
      return null;
    }
  }

  /**
   * Read receipts for the last message we sent in a thread.
   *
   * The tool is `get_read_status_feed` and it is a FEED, not a lookup. The
   * server advertises no `get_read_statuses`; a call to a missing tool would
   * fail every sync and leave the mail feed stale, which in turn refuses
   * every send. The real name and arguments are in SUPERHUMAN-TOOLS.md.
   *
   * It defaults to reads from the last 24 hours, so `since` has to be passed
   * for anything older, which for a cold email is almost always.
   */
  async getReadStatusFeed(input: { threadId: string; since?: string | null; actingEmail?: string | null }): Promise<{
    firstReadAt: string | null;
    readCount: number;
    lastDevice: string | null;
  }> {
    const events = await this.readStatusEvents({ ...input, limit: 200 });
    const times: number[] = [];
    let lastDevice: string | null = null;
    for (const entry of events) {
      // `occurred_at` is the field name the feed uses; the other names are
      // fallbacks. Without a match a read event would count toward
      // `readCount` while `firstReadAt` stayed null for ever. That is not
      // cosmetic: `followUpOnlyIfOpened` reads `firstReadAt`, so with that
      // setting on, a follow-up would never be created for a mail that had
      // in fact been opened.
      const at = pickOptionalString(entry, "occurred_at", "occurredAt", "readAt", "read_at", "openedAt", "timestamp", "time", "at");
      // A missing time is loud here, like every other unrecognised field in
      // this client: a quiet skip would make an event with no time look
      // exactly like an event nobody had opened.
      if (at === null) {
        throw new Error("Superhuman returned a read event with no recognisable time field from get_read_status_feed.");
      }
      times.push(Date.parse(toIsoString(at, "a read time")));
      const device = pickOptionalString(entry, "device", "deviceType", "client", "platform");
      if (device !== null) lastDevice = device;
    }
    times.sort((left, right) => left - right);
    return {
      firstReadAt: times.length === 0 ? null : new Date(times[0]).toISOString(),
      readCount: events.length,
      lastDevice,
    };
  }

  /**
   * The same call, unreduced.
   *
   * `getReadStatusFeed` answers "when was this first opened", which is what a
   * touch needs. A question about the feed ITSELF needs the events as the
   * server sent them: whether it returns anything at all over a fortnight is a
   * different question from whether one thread was opened, and a reducer that
   * turns both into `readCount: 0` cannot tell them apart.
   *
   * `threadId` is optional here and required there, because the cross-thread
   * feed is the diagnostic half. Read-only, and it sends nothing.
   */
  async readStatusEvents(input: {
    threadId?: string | null;
    since?: string | null;
    limit?: number;
    actingEmail?: string | null;
  }): Promise<unknown[]> {
    const json = await this.callJson("get_read_status_feed", [
      { names: ["thread_id"], value: input.threadId ?? undefined },
      { names: ["since"], value: input.since ?? undefined },
      { names: ["limit"], value: input.limit ?? 200 },
      { names: ["acting_email"], value: input.actingEmail ?? undefined },
    ]);
    const payload = unwrap(json, "readStatusFeed", "feed", "result", "data");
    return asArray(Array.isArray(json) ? json : pickOptional(payload, "events", "reads", "opens", "statuses", "items"));
  }

  /** Messages come back in the shape `classifyIncoming` in core.ts reads. */
  async getThread(threadId: string, account?: string): Promise<{ threadId: string; subject: string; messages: ThreadMessage[] }> {
    const json = await this.callJson("get_thread", [
      { names: ["thread_id"], value: threadId },
      { names: ["acting_email"], value: account },
    ]);
    const payload = unwrap(json, "thread", "result", "data");
    const messages = asArray(pick(payload, "messages", "emails", "items")).map((entry) => readThreadMessage(entry));
    return {
      threadId: pickOptionalString(payload, "threadId", "thread_id", "id") ?? threadId,
      subject: pickOptionalString(payload, "subject", "title") ?? (messages.length > 0 ? messages[0].subject : ""),
      messages,
    };
  }

  /**
   * Who a Superhuman draft is addressed to, read back after writing it.
   *
   * Used by comms. On a reply, the `to`
   * we pass is merged with the thread's participants, so what the draft ends
   * up addressed to is not simply what we asked for. Comms reads it back
   * before sending and refuses a mismatch. The result field names are guesses, like
   * every result shape here: `found` is false when none of them is present,
   * and the caller treats that as "could not check", never as "nobody".
   */
  async getDraftRecipients(input: { draftId: string; actingEmail?: string | null }): Promise<{
    found: boolean;
    to: string[];
    cc: string[];
    bcc: string[];
    from: string | null;
    fields: string[];
  }> {
    const json = await this.callJson("get_draft", [
      { names: ["draft_id"], value: input.draftId },
      { names: ["acting_email"], value: input.actingEmail ?? undefined },
    ]);
    const payload = unwrap(json, "draft", "result", "data");
    const record = asRecord(payload);
    const fields = record === null ? [] : Object.keys(record);
    const toRaw = pickOptional(payload, "to", "to_addresses", "toRecipients", "to_recipients", "recipients");
    return {
      found: toRaw !== null,
      to: readAddressList(toRaw),
      cc: readAddressList(pickOptional(payload, "cc", "cc_addresses", "ccRecipients", "cc_recipients")),
      bcc: readAddressList(pickOptional(payload, "bcc", "bcc_addresses", "bccRecipients", "bcc_recipients")),
      from: pickOptionalString(payload, "from", "from_address", "fromAddress", "sender"),
      fields,
    };
  }

  /** Throw a Superhuman draft away, for a draft comms wrote and then chose not to send. */
  async discardDraft(input: { draftId: string; actingEmail?: string | null }): Promise<void> {
    await this.callTool("discard_draft", [
      { names: ["draft_id"], value: input.draftId },
      { names: ["acting_email"], value: input.actingEmail ?? undefined },
    ]);
  }

  /**
   * The send state of a draft, in the server's own three words.
   *
   * `idle` means no send is queued, or a previous one failed or was aborted,
   * so the draft is safely sendable again. `pending` means queued with the
   * undo window still open. `closed` covers delivery under way, delivered,
   * AND the draft having been discarded, so it is NOT proof of delivery.
   *
   * It is returned as the state rather than a delivered boolean because that
   * ambiguity matters: the only caller that acts on it is recovering a send
   * that was interrupted, where treating `closed` as delivered would record a
   * message as sent that may never have gone, and treating it as undelivered
   * would send a second copy to somebody who already had the first.
   */
  async getDraftSendStatus(input: { draftId: string; threadId?: string | null; actingEmail?: string | null }): Promise<{
    state: "idle" | "pending" | "closed" | "unknown";
    detail: string;
  }> {
    const result = await this.callTool("get_draft_send_status", [
      { names: ["draft_id"], value: input.draftId },
      { names: ["thread_id"], value: input.threadId ?? undefined },
      { names: ["acting_email"], value: input.actingEmail ?? undefined },
    ]);
    const json = jsonOf(result);
    const text = clip(textOf(result), 200);
    const payload = json === null ? null : unwrap(json, "status", "result", "data");
    const raw = payload === null ? null : pickOptionalString(payload, "status", "state", "sendStatus", "send_status");
    const word = (raw ?? text).toLowerCase();
    const state = /\bidle\b/.test(word) ? "idle" : /\bpending\b/.test(word) ? "pending" : /\bclosed\b/.test(word) ? "closed" : "unknown";
    return { state, detail: raw ?? text };
  }

  /**
   * Threads matching a filter, newest first.
   *
   * The use this exists for is checking a prospect before a first email: `to`
   * each address, so a prospect somebody already wrote to does not get a first
   * email they have already had. Nothing calls it yet; that is a known gap.
   *
   * The argument names here are the ones recorded in SUPERHUMAN-TOOLS.md
   * rather than guesses: the account argument is `acting_email` and not
   * `account`, and the subject and date filters are `subject_contains` and
   * `start_date`, which are substring and range filters rather than exact
   * matches. `to` and `from` are arrays of address substrings matched
   * case-insensitively with OR between them.
   *
   * The server caps `limit` at 50, so a wide filter needs `cursor`. The result
   * field names below are still guesses: Superhuman documents its arguments
   * and not its result shapes.
   */
  async listThreads(input: {
    to?: string[];
    from?: string[];
    subjectContains?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    cursor?: string;
    actingEmail?: string | null;
  }): Promise<{ threads: ThreadSummary[]; nextCursor: string | null }> {
    const json = await this.callJson("list_threads", [
      { names: ["to"], value: input.to },
      { names: ["from"], value: input.from },
      { names: ["subject_contains"], value: input.subjectContains },
      { names: ["start_date"], value: input.startDate },
      { names: ["end_date"], value: input.endDate },
      { names: ["limit"], value: input.limit },
      { names: ["cursor"], value: input.cursor },
      { names: ["acting_email"], value: input.actingEmail ?? undefined },
    ]);
    const payload = unwrap(json, "result", "data");
    const entries = asArray(Array.isArray(json) ? json : pick(payload, "threads", "items", "results"));
    const threads = entries.map((entry) => ({
      threadId: pickString(entry, "threadId", "thread_id", "id"),
      subject: pickOptionalString(entry, "subject", "title") ?? "",
      snippet: pickOptionalString(entry, "snippet", "preview", "bodyPreview", "summary") ?? "",
      lastMessageAt: readOptionalDate(entry, "lastMessageAt", "last_message_at", "updatedAt", "date", "timestamp"),
    }));
    return { threads, nextCursor: pickOptionalString(payload, "nextCursor", "next_cursor") };
  }

  /**
   * Cancel a send that is still inside its undo window.
   *
   * The server has three normal answers and the caller has to tell them
   * apart, so this returns the state rather than a boolean. `cancelled` means
   * the message did not go. `already_sent` means it did and the window has
   * closed, which is the one that must never be reported as a cancellation:
   * the touch is still sent and a second message would follow. `not_found`
   * means there was no queued send, which for a draft nobody sent is correct.
   *
   * The account argument is `acting_email`, not `account`. The outcome is
   * read from the result's state, never as `ok: !result.isError`: `callTool`
   * throws on an error result, so that flag is always false by the time it
   * is read, and every outcome, including a message that had already gone,
   * would look like a successful cancellation.
   *
   * `undo_token` comes back from `send_draft` when `undo_timeout` was set and
   * identifies that queued send specifically, so it is preferred over the
   * message id when we have it. The caller passes both. The caller is the
   * panel Undo, `undoSuperhumanSend`.
   */
  async undoSend(input: { undoToken?: string | null; messageId?: string | null; actingEmail?: string | null }): Promise<{
    state: "cancelled" | "already_sent" | "not_found" | "unknown";
    detail: string;
  }> {
    const undoToken = input.undoToken ?? null;
    const messageId = input.messageId ?? null;
    if (undoToken === null && messageId === null) {
      throw new Error("undo_send needs the undo token from send_draft or the message id, and neither was given.");
    }
    const result = await this.callTool("undo_send", [
      { names: ["undo_token"], value: undoToken ?? undefined },
      { names: ["message_id"], value: messageId ?? undefined },
      { names: ["acting_email"], value: input.actingEmail ?? undefined },
    ]);
    const detail = clip(this.scrub(textOf(result)), 200);
    const word = detail.toLowerCase();
    // Read in this order: "already sent" has to win over any success wording
    // in the same sentence, because calling it cancelled is the one wrong
    // answer that loses a message we have to count as sent.
    const state = /already[\s_-]?sent/.test(word)
      ? "already_sent"
      : /\bnot found\b|\bno (queued )?send\b|nothing to undo/.test(word)
        ? "not_found"
        : /cancel|undone|undid|success/.test(word)
          ? "cancelled"
          : "unknown";
    return { state, detail };
  }
}

interface ThreadMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  receivedAt: string;
  snippet: string;
  autoSubmitted: string | null;
  headerNames: string[];
}

interface ThreadSummary {
  threadId: string;
  subject: string;
  snippet: string;
  lastMessageAt: string | null;
}

function readAddressList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((entry) => valueToString(entry)).filter((entry) => entry !== "");
  const text = valueToString(value);
  return text === "" ? [] : text.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
}

function readOptionalDate(source: unknown, ...keys: string[]): string | null {
  const raw = pickOptional(source, ...keys);
  return raw === null ? null : toIsoString(raw, "a date");
}

/**
 * `from` and `receivedAt` throw when they are missing, because both decide
 * whether something is a human reply, an out of office or a bounce, and a
 * default for either would classify a stranger's mail wrongly and silently.
 */
function readThreadMessage(entry: unknown): ThreadMessage {
  const headers = pickOptional(entry, "headers", "headerMap", "rawHeaders");
  const headerNames: string[] = [];
  const headerRecord = asRecord(headers);
  if (headerRecord !== null) {
    headerNames.push(...Object.keys(headerRecord));
  } else {
    for (const header of asArray(headers)) {
      const name = pickOptionalString(header, "name", "key");
      if (name !== null) headerNames.push(name);
    }
  }

  let autoSubmitted = pickOptionalString(entry, "autoSubmitted", "auto_submitted");
  if (autoSubmitted === null && headerRecord !== null) {
    autoSubmitted = pickOptionalString(headerRecord, "Auto-Submitted", "auto-submitted");
  }
  if (autoSubmitted === null) {
    for (const header of asArray(headers)) {
      const name = pickOptionalString(header, "name", "key");
      if (name !== null && normalizeKey(name) === "autosubmitted") {
        autoSubmitted = pickOptionalString(header, "value");
        break;
      }
    }
  }

  return {
    id: pickOptionalString(entry, "messageId", "message_id", "id") ?? "",
    from: valueToString(pick(entry, "from", "from_address", "sender")),
    to: readAddressList(pickOptional(entry, "to", "to_addresses", "recipients")),
    subject: pickOptionalString(entry, "subject", "title") ?? "",
    receivedAt: toIsoString(pick(entry, "receivedAt", "received_at", "date", "timestamp", "internalDate", "sentAt"), "a message date"),
    snippet: pickOptionalString(entry, "snippet", "preview", "bodyPreview", "summary") ?? "",
    autoSubmitted,
    headerNames,
  };
}
