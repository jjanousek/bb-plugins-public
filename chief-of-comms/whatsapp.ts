// WhatsApp bridge: supervises the Baileys worker process (whatsapp-worker.mjs)
// and exposes the same interface the plugin used when Baileys ran in-process.
//
// Baileys runs in a child `node` process because the bb server re-evaluates
// every module under the plugin directory on each plugin load, and Baileys'
// protobuf interop does not survive a second evaluation in one process.
//
// The worker speaks JSON lines on file descriptor 3, not on stdout. Baileys
// bundles libsignal, which prints Signal session state (private keys included)
// to the console; that output must never be parsed as protocol and must never
// be written to a log file. Whatever arrives on stdout or stderr is counted and
// dropped here, never logged verbatim.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { WaStatus } from "./contract";
import type { WaMessage } from "./store";

export interface WhatsAppHooks {
  log: { info(m: string): void; warn(m: string): void; error(m: string): void; debug(m: string): void };
  onStatus(status: WaStatus): void;
  /** A stored message. `fresh` is true for live incoming/outgoing messages (not history sync). */
  onMessage(message: WaMessage, fresh: boolean): void;
  onChat(chat: { jid: string; name: string | null; isGroup: boolean }): void;
  onContact(contact: { jid: string; name: string | null; notify: string | null }): void;
  /** A media file finished downloading for a stored message. `path` is a file name inside mediaDir. */
  onMedia(media: {
    id: string;
    chatJid: string;
    path: string;
    mime: string;
    kind: string;
    fileName: string | null;
    fresh: boolean;
    fromMe: boolean;
  }): void;
  /** WhatsApp addresses one contact as a LID and as a phone number; this pairs them. */
  onAlias(alias: { lid: string; pn: string }): void;
}

export interface WhatsAppOptions {
  authDir: string;
  /** Where downloaded photos and documents are written (mode 0700). */
  mediaDir: string;
  hooks: WhatsAppHooks;
  /** How many QR rounds to show before giving up until the owner asks again. */
  maxQrRounds?: number;
}

type WorkerEvent =
  | { ev: "ready"; hasCredentials: boolean }
  | { ev: "status"; status: WaStatus }
  | { ev: "message"; message: WaMessage; fresh: boolean }
  | { ev: "chat"; chat: { jid: string; name: string | null; isGroup: boolean } }
  | { ev: "contact"; contact: { jid: string; name: string | null; notify: string | null } }
  | {
      ev: "media";
      id: string;
      chatJid: string;
      path: string;
      mime: string;
      kind: string;
      fileName: string | null;
      fresh?: boolean;
      fromMe?: boolean;
    }
  | { ev: "alias"; lid: string; pn: string }
  | { ev: "log"; level: "info" | "warn" | "error" | "debug"; text: string }
  | { ev: "reply"; id: number; ok: boolean; result?: unknown; error?: string };

interface Pending {
  resolve(value: unknown): void;
  reject(cause: Error): void;
}

const WORKER_FILE = "whatsapp-worker.mjs";
const CALL_TIMEOUT_MS = 60_000;

/** Directory of this source file, under the loader bb uses or under a bundler. */
function moduleDir(): string {
  if (typeof __filename === "string" && __filename !== "") return path.dirname(__filename);
  return path.dirname(fileURLToPath(import.meta.url));
}

/** The worker sits beside this file in source, or one level up from a dist/ bundle. */
function resolveWorkerPath(): string {
  const dir = moduleDir();
  for (const candidate of [path.join(dir, WORKER_FILE), path.join(dir, "..", WORKER_FILE)]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${WORKER_FILE} not found next to ${dir}`);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class WhatsAppClient {
  private child: ChildProcess | null = null;
  private status: WaStatus = { state: "disconnected", qrDataUrl: null, me: null, sinceMs: null, lastError: null };
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /** A connection was requested while no worker was up; replay it once one is. */
  private loginRequested = false;
  /** Lines the worker printed outside the protocol, and when that was last reported. */
  private noiseLines = 0;
  private noiseLoggedAt = 0;

  constructor(private readonly options: WhatsAppOptions) {}

  getStatus(): WaStatus {
    return this.status;
  }

  hasCredentials(): boolean {
    return fs.existsSync(path.join(this.options.authDir, "creds.json"));
  }

  /** Ask for a (re)connection: shows a fresh QR when there is no session. */
  requestLogin(): void {
    this.loginRequested = true;
    if (this.child === null) return;
    this.call("login").catch((cause) => this.options.hooks.log.warn(`whatsapp login: ${String(cause)}`));
  }

  /** Unlink this device and wipe the local session. */
  async logout(): Promise<void> {
    this.loginRequested = false;
    if (this.child === null) {
      this.wipeAuth();
      this.wipeMedia();
      this.setStatus({ state: "logged-out", qrDataUrl: null, me: null, sinceMs: null, lastError: null });
      return;
    }
    await this.call("logout");
  }

  /**
   * Send text under `messageId` when one is given. The caller stores that id
   * before calling, so retrying a send that timed out reuses it and WhatsApp
   * discards the duplicate rather than delivering it twice.
   */
  async sendText(jid: string, text: string, messageId?: string): Promise<WaMessage> {
    if (this.child === null || this.status.state !== "connected") throw new Error("WhatsApp is not connected.");
    const result = await this.call("send", messageId === undefined ? { jid, text } : { jid, text, messageId });
    return result as WaMessage;
  }

  /**
   * Resolve a phone number to a jid, checking it really is on WhatsApp.
   * Throws while disconnected: a guessed jid creates phantom chats and, on a
   * send path, aims a message at a number nobody verified.
   */
  async lookupPhone(phone: string): Promise<string | null> {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 6) return null;
    if (this.child === null || this.status.state !== "connected") {
      throw new Error("WhatsApp is not connected, so a phone number cannot be verified right now.");
    }
    const result = await this.call("lookup", { phone: digits });
    return typeof result === "string" ? result : null;
  }

  /** Supervise the worker for the background service; resolves once `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    fs.mkdirSync(this.options.authDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.options.mediaDir, { recursive: true, mode: 0o700 });
    const workerPath = resolveWorkerPath();
    let backoffMs = 2_000;
    while (!signal.aborted) {
      const startedAt = Date.now();
      try {
        await this.runWorkerOnce(workerPath, signal);
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : String(cause);
        this.options.hooks.log.error(`whatsapp worker: ${text}`);
        this.setStatus({ state: "disconnected", qrDataUrl: null, lastError: text });
      }
      if (signal.aborted) break;
      // A worker that lived a while gets a quick restart; a crash loop backs off.
      if (Date.now() - startedAt > 120_000) backoffMs = 2_000;
      this.options.hooks.log.warn(`whatsapp worker exited, restarting in ${Math.round(backoffMs / 1000)}s`);
      await sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
    this.setStatus({ state: "disconnected", qrDataUrl: null });
  }

  private runWorkerOnce(workerPath: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, this.options.authDir, String(this.options.maxQrRounds ?? 3), this.options.mediaDir], {
        cwd: path.dirname(workerPath),
        // fd 3 is the protocol pipe; stdout and stderr carry library noise only.
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      });
      this.child = child;
      // A write in the moment between the worker dying and its exit event
      // raises EPIPE here as well as in the write callback. Unheard, that is
      // an uncaught exception that ends the host process. The callback
      // already rejects the pending call, so the stream error is dropped.
      child.stdin?.on("error", () => {});
      let settled = false;
      const finish = (error: Error | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (this.child === child) this.child = null;
        for (const [, p] of this.pending) p.reject(new Error("WhatsApp worker exited."));
        this.pending.clear();
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => {
        try {
          child.stdin?.write(`${JSON.stringify({ op: "shutdown" })}\n`);
          child.stdin?.end();
        } catch {
          // ignore
        }
        // Bare timer: a throw here has no caller and would reach the process
        // server as an uncaught exception.
        const killer = setTimeout(() => {
          try {
            if (child.exitCode === null) child.kill("SIGKILL");
          } catch {
            // the child is already gone, which is the outcome we wanted
          }
        }, 3_000);
        child.once("exit", () => clearTimeout(killer));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const protocol = (child.stdio[3] ?? null) as Readable | null;
      if (!protocol) {
        finish(new Error("worker protocol pipe (fd 3) was not created"));
        return;
      }
      const out = readline.createInterface({ input: protocol, crlfDelay: Infinity });
      out.on("line", (line) => {
        if (line.trim() === "") return;
        let event: WorkerEvent;
        try {
          event = JSON.parse(line) as WorkerEvent;
        } catch {
          // Only this worker writes here, so a bad line is a bug, not data
          // worth keeping: never log its content.
          this.noteWorkerNoise();
          return;
        }
        this.handleEvent(event);
      });
      // Anything the libraries print is counted and thrown away.
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
        reader.on("line", (line) => {
          if (line.trim() !== "") this.noteWorkerNoise();
        });
      }

      child.once("error", (cause) => finish(cause));
      child.once("exit", (code, sig) => {
        if (signal.aborted) finish(null);
        else finish(new Error(`worker exited with ${sig ?? `code ${code}`}`));
      });
    });
  }

  private handleEvent(event: WorkerEvent): void {
    const { hooks } = this.options;
    switch (event.ev) {
      case "ready":
        // Replay a login requested before the worker was up. The
        // worker connects on its own when credentials exist.
        if (this.loginRequested && !event.hasCredentials) {
          this.call("login").catch((cause) => hooks.log.warn(`whatsapp login: ${String(cause)}`));
        }
        return;
      case "status":
        this.setStatus(event.status);
        return;
      case "message":
        hooks.onMessage(event.message, event.fresh);
        return;
      case "chat":
        hooks.onChat(event.chat);
        return;
      case "contact":
        hooks.onContact(event.contact);
        return;
      case "media":
        hooks.onMedia({
          id: event.id,
          chatJid: event.chatJid,
          path: event.path,
          mime: event.mime,
          kind: event.kind,
          fileName: event.fileName,
          fresh: event.fresh === true,
          fromMe: event.fromMe === true,
        });
        return;
      case "alias":
        hooks.onAlias({ lid: event.lid, pn: event.pn });
        return;
      case "log":
        hooks.log[event.level](event.text);
        return;
      case "reply": {
        const pending = this.pending.get(event.id);
        if (!pending) return;
        this.pending.delete(event.id);
        if (event.ok) pending.resolve(event.result);
        else pending.reject(new Error(event.error ?? "WhatsApp worker error"));
        return;
      }
      default:
        return;
    }
  }

  private call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const child = this.child;
    if (child === null) return Promise.reject(new Error("WhatsApp worker is not running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WhatsApp worker did not answer "${op}" within ${CALL_TIMEOUT_MS / 1000}s.`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (cause) => {
          clearTimeout(timer);
          reject(cause);
        },
      });
      const stdin = child.stdin;
      if (!stdin) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("WhatsApp worker has no input pipe."));
        return;
      }
      stdin.write(`${JSON.stringify({ op, id, ...args })}\n`, (cause) => {
        if (cause) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(cause);
        }
      });
    });
  }

  /** Count what the worker printed outside the protocol; never log the text. */
  private noteWorkerNoise(): void {
    this.noiseLines += 1;
    const now = Date.now();
    if (now - this.noiseLoggedAt < 60_000) return;
    this.noiseLoggedAt = now;
    const count = this.noiseLines;
    this.noiseLines = 0;
    this.options.hooks.log.debug(`whatsapp worker printed ${count} non-protocol line(s)`);
  }

  private setStatus(patch: Partial<WaStatus>): void {
    this.status = { ...this.status, ...patch };
    this.options.hooks.onStatus(this.status);
  }

  private wipeAuth(): void {
    try {
      fs.rmSync(this.options.authDir, { recursive: true, force: true });
      fs.mkdirSync(this.options.authDir, { recursive: true, mode: 0o700 });
    } catch (cause) {
      this.options.hooks.log.warn(`wipe auth: ${String(cause)}`);
    }
  }

  /** Unlink means unlink: the downloaded photos and voice notes go too. */
  private wipeMedia(): void {
    try {
      fs.rmSync(this.options.mediaDir, { recursive: true, force: true });
      fs.mkdirSync(this.options.mediaDir, { recursive: true, mode: 0o700 });
    } catch (cause) {
      this.options.hooks.log.warn(`wipe media: ${String(cause)}`);
    }
  }
}
