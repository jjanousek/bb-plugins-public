// WhatsApp worker: runs Baileys (WhatsApp Web multi-device protocol) in its
// own Node process and talks to the plugin over JSON lines on stdio.
//
// Why a child process: the bb server loads plugin TypeScript through a loader
// that re-evaluates every module under the plugin directory on each reload.
// Baileys' protobuf interop does not survive a second evaluation in one
// process. Plain `node` here keeps Baileys in a fresh process per plugin load
// and away from the server's event loop.
//
// Protocol (one JSON object per line) on a dedicated pipe, file descriptor 3.
// stdout and stderr carry nothing but library noise and are dropped by the
// supervisor: libsignal prints Signal session state, private keys included,
// with console.info on every session change, so neither stream may ever be
// logged verbatim or parsed as protocol.
//   stdin  <- {op:"login"} | {op:"logout"} | {op:"shutdown"}
//          | {op:"send", id, jid, text} | {op:"lookup", id, phone}
//   fd 3   -> {ev:"status", status} | {ev:"message", message, fresh}
//          | {ev:"chat", chat} | {ev:"contact", contact} | {ev:"alias", lid, pn}
//          | {ev:"media", ...} | {ev:"log", level, text}
//          | {ev:"reply", id, ok, result?, error?}
//
// argv: node whatsapp-worker.mjs <authDir> <maxQrRounds> <mediaDir>
// Media (photos, documents, stickers) is downloaded into <mediaDir> and
// announced with {ev:"media", id, chatJid, path, mime, fileName} once the file
// is on disk.
import { Console } from "node:console";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";

// Before any library is loaded: send every console call into a black hole.
// This is a security boundary, not tidiness. Do not point it at stdout or
// stderr.
const nullSink = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});
globalThis.console = new Console({ stdout: nullSink, stderr: nullSink });

const baileys = await import("@whiskeysockets/baileys");
const makeWASocket = baileys.default;
const {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} = baileys;
const pino = (await import("pino")).default;
const QRCode = (await import("qrcode")).default;

const authDir = process.argv[2];
const maxQrRounds = Number(process.argv[3] ?? "3") || 3;
const mediaDir = process.argv[4] ?? null;
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
/** Only media newer than this is fetched from history sync; older keys are often gone. */
const MEDIA_HISTORY_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
/** One stalled download must not hold up the photo the chief is waiting for. */
const MEDIA_TIMEOUT_MS = 60_000;
const MEDIA_CONCURRENCY = 2;
const MEDIA_QUEUE_MAX = 60;
if (!authDir) {
  process.stderr.write("usage: whatsapp-worker.mjs <authDir> <maxQrRounds> <mediaDir>\n");
  process.exit(2);
}

const STATUS_BROADCAST = "status@broadcast";

/**
 * The protocol pipe. fd 3 is opened by the supervisor; when the worker is run
 * by hand it is not there and stdout stands in.
 */
const protocolStream = (() => {
  try {
    fs.fstatSync(3);
    const stream = fs.createWriteStream(null, { fd: 3 });
    stream.on("error", () => {});
    return stream;
  } catch {
    return process.stdout;
  }
})();

function emit(event) {
  protocolStream.write(`${JSON.stringify(event)}\n`);
}
const log = {
  info: (text) => emit({ ev: "log", level: "info", text }),
  warn: (text) => emit({ ev: "log", level: "warn", text }),
  error: (text) => emit({ ev: "log", level: "error", text }),
  debug: (text) => emit({ ev: "log", level: "debug", text }),
};

function phoneOfJid(jid) {
  if (!jid) return null;
  const at = jid.indexOf("@");
  if (at < 0) return null;
  const domain = jid.slice(at + 1);
  if (domain !== "s.whatsapp.net" && domain !== "c.us") return null;
  const digits = jid.slice(0, at).split(":")[0] ?? "";
  return /^\d{5,}$/.test(digits) ? `+${digits}` : null;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function unwrap(message) {
  let current = message;
  for (let i = 0; i < 6 && current; i += 1) {
    const inner =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.viewOnceMessageV2Extension?.message ??
      current.documentWithCaptionMessage?.message ??
      current.editedMessage?.message?.protocolMessage?.editedMessage ??
      null;
    if (!inner) break;
    current = inner;
  }
  return current ?? null;
}

/** Text rendering of a message body; null for messages without user-facing content. */
function describeMessage(raw) {
  const m = unwrap(raw);
  if (!m) return null;
  if (typeof m.conversation === "string" && m.conversation !== "") return { text: m.conversation, kind: "text" };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, kind: "text" };
  if (m.imageMessage) return { text: `[photo]${m.imageMessage.caption ? ` ${m.imageMessage.caption}` : ""}`, kind: "image" };
  if (m.videoMessage) return { text: `[video]${m.videoMessage.caption ? ` ${m.videoMessage.caption}` : ""}`, kind: "video" };
  if (m.audioMessage) return { text: m.audioMessage.ptt ? "[voice message]" : "[audio]", kind: "audio" };
  if (m.documentMessage) {
    const name = m.documentMessage.fileName ?? m.documentMessage.title ?? "file";
    return { text: `[document: ${name}]${m.documentMessage.caption ? ` ${m.documentMessage.caption}` : ""}`, kind: "document" };
  }
  if (m.stickerMessage) return { text: "[sticker]", kind: "sticker" };
  if (m.locationMessage || m.liveLocationMessage) return { text: "[location]", kind: "location" };
  if (m.contactMessage) return { text: `[contact: ${m.contactMessage.displayName ?? ""}]`, kind: "contact" };
  if (m.contactsArrayMessage) return { text: "[contacts]", kind: "contact" };
  const poll = m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3;
  if (poll) return { text: `[poll: ${poll.name ?? ""}]`, kind: "poll" };
  if (m.eventMessage) return { text: `[event: ${m.eventMessage.name ?? ""}]`, kind: "event" };
  return null;
}

function timestampMs(value) {
  if (value === null || value === undefined) return Date.now();
  const n = typeof value === "number" ? value : Number(value.toString());
  return Number.isFinite(n) && n > 0 ? n * 1000 : Date.now();
}

/** Prefer the phone-number jid when Baileys reports a LID alongside it. */
function chatJidOf(key) {
  const remote = key.remoteJid ?? "";
  const alt = key.remoteJidAlt ?? null;
  const candidates = [remote, alt].filter((v) => typeof v === "string" && v !== "");
  const phoneJid = candidates.find((c) => c.endsWith("@s.whatsapp.net")) ?? null;
  const lidJid = candidates.find((c) => c.endsWith("@lid")) ?? null;
  return { jid: phoneJid ?? remote, phoneJid, lidJid };
}

const MEDIA_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/json": "json",
  "application/rtf": "rtf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
};

/** "audio/ogg; codecs=opus" is one type with a parameter; store and match the type. */
function normalizeMime(value) {
  return String(value ?? "application/octet-stream").split(";")[0].trim().toLowerCase() || "application/octet-stream";
}

function extensionFor(mime, kind, fileName) {
  const known = MEDIA_EXT[mime];
  if (known) return known;
  if (kind === "document" && typeof fileName === "string" && fileName.includes(".")) {
    const tail = fileName.split(".").pop() ?? "";
    if (/^[A-Za-z0-9]{1,5}$/.test(tail)) return tail.toLowerCase();
  }
  return "dat";
}

function safeName(text) {
  return String(text).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

/** The bare user part of a jid, without the device suffix. */
function bareJid(jid) {
  if (typeof jid !== "string") return null;
  const at = jid.indexOf("@");
  if (at < 0) return null;
  const user = jid.slice(0, at).split(":")[0] ?? "";
  return user === "" ? null : `${user}@${jid.slice(at + 1)}`;
}

/** The inner media node of a message, or null. Video is skipped (large, rarely needed). */
function mediaNodeOf(raw) {
  const m = unwrap(raw);
  if (!m) return null;
  if (m.imageMessage) return { node: m.imageMessage, kind: "image" };
  if (m.documentMessage) return { node: m.documentMessage, kind: "document" };
  if (m.stickerMessage) return { node: m.stickerMessage, kind: "sticker" };
  if (m.audioMessage) return { node: m.audioMessage, kind: "audio" };
  return null;
}

/** The version handshake is a network call; once per process is enough. */
let cachedVersion;
async function cachedBaileysVersion() {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    cachedVersion = (await fetchLatestBaileysVersion()).version;
  } catch {
    cachedVersion = undefined;
  }
  return cachedVersion;
}

class Client {
  constructor() {
    this.mediaPending = [];
    this.mediaActive = 0;
    this.mediaSeen = new Set();
    this.sock = null;
    this.status = { state: "disconnected", qrDataUrl: null, me: null, sinceMs: null, lastError: null };
    this.wantConnection = false;
    this.wake = null;
    this.qrRounds = 0;
    this.groupNames = new Map();
    /** lid -> pn, so the same pairing is announced once per process. */
    this.aliases = new Map();
    this.lidLookups = new Set();
    /** True once a connection actually opened; only then may the backoff reset. */
    this.opened = false;
    this.abort = new AbortController();
  }

  /** Tell the plugin that one contact is addressed both as a LID and a phone number. */
  noteAlias(lidRaw, pnRaw) {
    const lid = bareJid(lidRaw);
    const pn = bareJid(pnRaw);
    if (!lid || !pn || !lid.endsWith("@lid") || !pn.endsWith("@s.whatsapp.net")) return;
    if (this.aliases.get(lid) === pn) return;
    this.aliases.set(lid, pn);
    emit({ ev: "alias", lid, pn });
  }

  /** Read the LID pairings Baileys already wrote into the auth directory. */
  loadAuthAliases() {
    let files = [];
    try {
      files = fs.readdirSync(authDir);
    } catch {
      return;
    }
    let found = 0;
    for (const file of files) {
      const match = /^lid-mapping-(\d+)_reverse\.json$/.exec(file);
      if (!match) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(authDir, file), "utf8"));
        const digits = String(raw).replace(/\D/g, "");
        if (digits.length < 6) continue;
        this.noteAlias(`${match[1]}@lid`, `${digits}@s.whatsapp.net`);
        found += 1;
      } catch {
        // a half-written mapping file is not worth a log line
      }
    }
    if (found > 0) log.info(`whatsapp: ${found} LID mappings read from the auth directory`);
  }

  /** Ask Baileys for the phone number behind a LID, once per address. */
  resolveLid(jid) {
    const lid = bareJid(jid);
    if (!lid || !lid.endsWith("@lid") || this.aliases.has(lid) || this.lidLookups.has(lid)) return;
    this.lidLookups.add(lid);
    const store = this.sock?.signalRepository?.lidMapping;
    if (!store?.getPNForLID) return;
    Promise.resolve(store.getPNForLID(lid))
      .then((pn) => {
        if (pn) this.noteAlias(lid, pn);
      })
      .catch(() => {
        this.lidLookups.delete(lid);
      });
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    emit({ ev: "status", status: this.status });
  }

  requestLogin() {
    this.qrRounds = 0;
    this.wantConnection = true;
    if (["logged-out", "qr-expired", "disconnected"].includes(this.status.state)) {
      this.setStatus({ state: "connecting", qrDataUrl: null, lastError: null });
    }
    this.wake?.();
  }

  async logout() {
    const sock = this.sock;
    this.wantConnection = false;
    if (sock) {
      try {
        await sock.logout();
      } catch (cause) {
        log.warn(`whatsapp logout: ${String(cause)}`);
      }
    }
    this.closeSocket();
    this.wipeAuth();
    this.wipeMedia();
    this.setStatus({ state: "logged-out", qrDataUrl: null, me: null, sinceMs: null, lastError: null });
    this.wake?.();
  }

  async sendText(jid, text, messageId) {
    const sock = this.sock;
    if (!sock || this.status.state !== "connected") throw new Error("WhatsApp is not connected.");
    // Sending under an id the caller already wrote down is what makes a retry
    // safe: WhatsApp keeps one message per id per chat, so a repeat of an id it
    // already took is dropped instead of delivered again.
    const sent = await sock.sendMessage(jid, { text }, messageId ? { messageId } : undefined);
    if (!sent?.key?.id) throw new Error("WhatsApp did not return a message id.");
    const message = {
      id: sent.key.id,
      chatJid: jid,
      senderJid: this.status.me?.jid ?? null,
      senderName: this.status.me?.name ?? "me",
      fromMe: true,
      text,
      kind: "text",
      timestamp: Date.now(),
    };
    emit({ ev: "message", message, fresh: true });
    return message;
  }

  async lookupPhone(phone) {
    const sock = this.sock;
    const digits = String(phone).replace(/\D/g, "");
    if (digits.length < 6) return null;
    // Never guess a jid: a guessed number produces a phantom chat and, on a
    // send path, a message aimed at somebody who may not be on WhatsApp.
    if (!sock || this.status.state !== "connected") {
      throw new Error("WhatsApp is not connected, so a phone number cannot be verified right now.");
    }
    const results = await sock.onWhatsApp(digits);
    const hit = results?.find((r) => r.exists);
    if (!hit?.jid) return null;
    if (hit.lid) this.noteAlias(hit.lid, hit.jid);
    return hit.jid;
  }

  async groupName(jid) {
    const cached = this.groupNames.get(jid);
    if (cached) return cached;
    const sock = this.sock;
    if (!sock) return null;
    try {
      const meta = await sock.groupMetadata(jid);
      if (meta?.subject) {
        this.groupNames.set(jid, meta.subject);
        return meta.subject;
      }
    } catch (cause) {
      log.debug(`groupMetadata(${jid}): ${String(cause)}`);
    }
    return null;
  }

  async run() {
    const signal = this.abort.signal;
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    let backoffMs = 2_000;
    while (!signal.aborted) {
      if (!this.wantConnection) {
        await this.waitForWake(signal);
        continue;
      }
      let closedCleanly = false;
      this.opened = false;
      try {
        closedCleanly = await this.connectOnce(signal);
        // Only a connection that actually opened earns a quick retry; a DNS
        // outage must back off instead of hammering every two seconds.
        if (this.opened) backoffMs = 2_000;
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : String(cause);
        log.error(`whatsapp connection failed: ${text}`);
        this.setStatus({ state: "disconnected", qrDataUrl: null, lastError: text });
      }
      if (signal.aborted) break;
      if (!this.wantConnection) continue;
      if (!closedCleanly) {
        await sleep(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
    this.closeSocket();
    this.setStatus({ state: "disconnected", qrDataUrl: null });
  }

  waitForWake(signal) {
    return new Promise((resolve) => {
      const done = () => {
        this.wake = null;
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.wake = done;
      signal.addEventListener("abort", done, { once: true });
    });
  }

  async connectOnce(signal) {
    const logger = pino({ level: "silent" });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const version = await cachedBaileysVersion();
    this.setStatus({ state: "connecting", qrDataUrl: null });

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      cachedGroupMetadata: async (jid) => {
        const name = this.groupNames.get(jid);
        return name ? { id: jid, subject: name, owner: undefined, participants: [] } : undefined;
      },
    });
    this.sock = sock;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (clean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (this.sock === sock) this.sock = null;
        resolve(clean);
      };
      const onAbort = () => {
        try {
          sock.end(undefined);
        } catch {
          // ignore
        }
        finish(true);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      sock.ev.on("creds.update", () => {
        saveCreds().catch((cause) => log.warn(`saveCreds: ${String(cause)}`));
      });

      sock.ev.on("connection.update", (update) => {
        try {
          if (update.qr) {
            this.qrRounds += 1;
            if (this.qrRounds > maxQrRounds) {
              log.info("whatsapp: QR not scanned, pausing until login is requested again");
              this.wantConnection = false;
              this.setStatus({ state: "qr-expired", qrDataUrl: null, lastError: null });
              try {
                sock.end(undefined);
              } catch {
                // ignore
              }
              finish(true);
              return;
            }
            QRCode.toDataURL(update.qr, { margin: 1, width: 320 }).then(
              (url) => this.setStatus({ state: "qr", qrDataUrl: url, lastError: null }),
              (cause) => log.warn(`qr render: ${String(cause)}`),
            );
          }
          if (update.connection === "open") {
            this.qrRounds = 0;
            this.opened = true;
            const me = sock.user;
            if (sock.user?.lid && sock.user?.id) this.noteAlias(sock.user.lid, jidNormalizedUser(sock.user.id));
            const jid = me?.id ? jidNormalizedUser(me.id) : "";
            this.setStatus({
              state: "connected",
              qrDataUrl: null,
              me: me ? { jid, name: me.name ?? null, phone: phoneOfJid(jid) } : null,
              sinceMs: Date.now(),
              lastError: null,
            });
            log.info(`whatsapp connected as ${jid}`);
          }
          if (update.connection === "close") {
            const error = update.lastDisconnect?.error;
            const code = error?.output?.statusCode ?? null;
            const reason = error?.message ?? (code !== null ? `status ${code}` : "closed");
            if (code === DisconnectReason.loggedOut) {
              log.warn("whatsapp: logged out on the phone, wiping session");
              this.wipeAuth();
              this.wipeMedia();
              this.wantConnection = false;
              this.setStatus({ state: "logged-out", qrDataUrl: null, me: null, sinceMs: null, lastError: null });
              finish(true);
              return;
            }
            if (this.status.state !== "qr-expired") {
              this.setStatus({ state: "disconnected", qrDataUrl: null, lastError: reason });
            }
            finish(false);
          }
        } catch (cause) {
          log.error(`connection.update handler: ${String(cause)}`);
        }
      });

      sock.ev.on("lid-mapping.update", (mapping) => {
        for (const pair of Array.isArray(mapping) ? mapping : [mapping]) {
          if (pair?.lid && pair?.pn) this.noteAlias(pair.lid, pair.pn);
        }
      });

      sock.ev.on("messaging-history.set", ({ chats, contacts, messages, lidPnMappings }) => {
        try {
          for (const pair of lidPnMappings ?? []) {
            if (pair?.lid && pair?.pn) this.noteAlias(pair.lid, pair.pn);
          }
          for (const contact of contacts ?? []) {
            if (contact.lid && contact.phoneNumber) this.noteAlias(contact.lid, contact.phoneNumber);
            emit({ ev: "contact", contact: { jid: contact.id, name: contact.name ?? contact.verifiedName ?? null, notify: contact.notify ?? null } });
          }
          for (const chat of chats ?? []) {
            const jid = chat.id;
            if (!jid || jid === STATUS_BROADCAST) continue;
            const isGroup = !!isJidGroup(jid);
            if (isGroup && chat.name) this.groupNames.set(jid, chat.name);
            emit({ ev: "chat", chat: { jid, name: chat.name ?? null, isGroup } });
          }
          for (const message of messages ?? []) this.ingest(message, false);
        } catch (cause) {
          log.error(`history handler: ${String(cause)}`);
        }
      });

      const contactEvent = (contacts) => {
        for (const c of contacts) {
          if (c.lid && c.phoneNumber) this.noteAlias(c.lid, c.phoneNumber);
          if (c.id) emit({ ev: "contact", contact: { jid: c.id, name: c.name ?? c.verifiedName ?? null, notify: c.notify ?? null } });
        }
      };
      sock.ev.on("contacts.upsert", contactEvent);
      sock.ev.on("contacts.update", contactEvent);
      sock.ev.on("chats.upsert", (chats) => {
        for (const chat of chats) {
          if (!chat.id || chat.id === STATUS_BROADCAST) continue;
          const isGroup = !!isJidGroup(chat.id);
          if (isGroup && chat.name) this.groupNames.set(chat.id, chat.name);
          emit({ ev: "chat", chat: { jid: chat.id, name: chat.name ?? null, isGroup } });
        }
      });
      const groupEvent = (groups) => {
        for (const g of groups) {
          if (g.id && g.subject) {
            this.groupNames.set(g.id, g.subject);
            emit({ ev: "chat", chat: { jid: g.id, name: g.subject, isGroup: true } });
          }
        }
      };
      sock.ev.on("groups.upsert", groupEvent);
      sock.ev.on("groups.update", groupEvent);

      sock.ev.on("messages.upsert", ({ messages, type }) => {
        try {
          for (const message of messages) this.ingest(message, type === "notify");
        } catch (cause) {
          log.error(`messages.upsert handler: ${String(cause)}`);
        }
      });
    });
  }

  /**
   * Download one message's media to disk and announce it. A small pool, one
   * attempt per message id, and a hard timeout, so a stalled item cannot hold
   * up the photo the chief is waiting on.
   */
  queueMedia(message, chatJid, fresh, fromMe) {
    if (!mediaDir) return;
    const media = mediaNodeOf(message.message);
    if (!media) return;
    const size = Number(media.node.fileLength ?? 0);
    if (size > MEDIA_MAX_BYTES) return;
    if (!fresh && timestampMs(message.messageTimestamp) < Date.now() - MEDIA_HISTORY_MAX_AGE_MS) return;
    const id = message.key?.id;
    if (!id || this.mediaSeen.has(id)) return;
    if (this.mediaPending.length >= MEDIA_QUEUE_MAX) {
      log.warn(`media queue full, skipping ${id}`);
      return;
    }
    this.mediaSeen.add(id);
    this.mediaPending.push({ id, message, media, chatJid, fresh, fromMe });
    this.pumpMedia();
  }

  pumpMedia() {
    while (this.mediaActive < MEDIA_CONCURRENCY && this.mediaPending.length > 0) {
      const item = this.mediaPending.shift();
      this.mediaActive += 1;
      this.downloadMedia(item)
        .catch((cause) => {
          // Let it be retried if the same message shows up again.
          this.mediaSeen.delete(item.id);
          log.warn(`media download ${item.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
        })
        .finally(() => {
          this.mediaActive -= 1;
          this.pumpMedia();
        });
    }
  }

  async downloadMedia(item) {
    const sock = this.sock;
    if (!sock) {
      this.mediaSeen.delete(item.id);
      log.warn(`media ${item.id}: not downloaded, WhatsApp is not connected`);
      return;
    }
    let timer = null;
    const buffer = await Promise.race([
      downloadMediaMessage(
        item.message,
        "buffer",
        {},
        { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage },
      ),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`download timed out after ${MEDIA_TIMEOUT_MS / 1000}s`)), MEDIA_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (!buffer || buffer.length === 0) throw new Error("empty download");
    if (buffer.length > MEDIA_MAX_BYTES) throw new Error(`file is larger than the ${MEDIA_MAX_BYTES} byte limit`);
    const fileName = typeof item.media.node.fileName === "string" ? item.media.node.fileName : null;
    const mime = normalizeMime(item.media.node.mimetype);
    const ext = extensionFor(mime, item.media.kind, fileName);
    fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    const file = `${safeName(item.id)}.${ext}`;
    fs.writeFileSync(path.join(mediaDir, file), buffer, { mode: 0o600 });
    emit({
      ev: "media",
      id: item.id,
      chatJid: item.chatJid,
      path: file,
      mime,
      kind: item.media.kind,
      fileName,
      fresh: item.fresh === true,
      fromMe: item.fromMe === true,
    });
  }

  ingest(message, fresh) {
    const key = message.key;
    if (!key?.id || !key.remoteJid || key.remoteJid === STATUS_BROADCAST) return;
    const described = describeMessage(message.message);
    if (!described) return;
    const { jid, phoneJid, lidJid } = chatJidOf(key);
    // Every message that carries both addresses teaches us one pairing.
    if (lidJid && phoneJid) this.noteAlias(lidJid, phoneJid);
    else if (lidJid) this.resolveLid(lidJid);
    const isGroup = !!isJidGroup(jid);
    const fromMe = key.fromMe === true;
    const participantLid = typeof key.participant === "string" && key.participant.endsWith("@lid") ? key.participant : null;
    const participantPn =
      typeof key.participantAlt === "string" && key.participantAlt.endsWith("@s.whatsapp.net")
        ? key.participantAlt
        : typeof key.participant === "string" && key.participant.endsWith("@s.whatsapp.net")
          ? key.participant
          : null;
    if (participantLid && participantPn) this.noteAlias(participantLid, participantPn);
    else if (participantLid) this.resolveLid(participantLid);
    const participantJid = participantPn ?? key.participant ?? null;
    const senderJid = isGroup ? participantJid : fromMe ? (this.status.me?.jid ?? null) : jid;
    const pushName = message.pushName ?? null;
    if (!fromMe && pushName) {
      if (isGroup) {
        // In a group the push name belongs to the participant. Attaching it to
        // the group jid would name the group after whoever spoke first.
        for (const target of new Set([participantJid, participantLid].filter(Boolean))) {
          emit({ ev: "contact", contact: { jid: target, name: null, notify: pushName } });
        }
      } else {
        emit({ ev: "contact", contact: { jid, name: null, notify: pushName } });
        if (phoneJid && phoneJid !== jid) emit({ ev: "contact", contact: { jid: phoneJid, name: null, notify: pushName } });
      }
    }
    emit({ ev: "chat", chat: { jid, name: isGroup ? (this.groupNames.get(jid) ?? null) : null, isGroup } });
    if (isGroup && !this.groupNames.has(jid)) {
      this.groupName(jid).then((name) => {
        if (name) emit({ ev: "chat", chat: { jid, name, isGroup: true } });
      });
    }
    emit({
      ev: "message",
      fresh,
      message: {
        id: key.id,
        chatJid: jid,
        senderJid,
        senderName: fromMe ? (this.status.me?.name ?? "me") : pushName,
        fromMe,
        text: described.text,
        kind: described.kind,
        timestamp: timestampMs(message.messageTimestamp),
      },
    });
    this.queueMedia(message, jid, fresh, fromMe);
  }

  closeSocket() {
    const sock = this.sock;
    this.sock = null;
    if (!sock) return;
    try {
      sock.ev.removeAllListeners("connection.update");
      sock.end(undefined);
    } catch {
      // ignore
    }
  }

  wipeAuth() {
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
      fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    } catch (cause) {
      log.warn(`wipe auth: ${String(cause)}`);
    }
    this.aliases.clear();
    this.lidLookups.clear();
  }

  /** Unlinking the device must not leave the contacts' photos and voice notes behind. */
  wipeMedia() {
    if (!mediaDir) return;
    try {
      fs.rmSync(mediaDir, { recursive: true, force: true });
      fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    } catch (cause) {
      log.warn(`wipe media: ${String(cause)}`);
    }
    this.mediaSeen.clear();
    this.mediaPending.length = 0;
  }

  shutdown() {
    this.abort.abort();
    this.wake?.();
  }
}

const client = new Client();

async function handle(command) {
  switch (command.op) {
    case "login":
      client.requestLogin();
      return client.status;
    case "logout":
      await client.logout();
      return client.status;
    case "send":
      return client.sendText(command.jid, command.text, command.messageId);
    case "lookup":
      return client.lookupPhone(command.phone);
    case "shutdown":
      client.shutdown();
      return true;
    default:
      throw new Error(`unknown op ${String(command.op)}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    log.warn(`worker: bad command line ${line.slice(0, 120)}`);
    return;
  }
  handle(command).then(
    (result) => {
      if (command.id !== undefined) emit({ ev: "reply", id: command.id, ok: true, result: result ?? null });
    },
    (cause) => {
      if (command.id !== undefined) emit({ ev: "reply", id: command.id, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    },
  );
});
rl.on("close", () => {
  // stdin closed: the plugin is gone, so are we.
  client.shutdown();
  setTimeout(() => process.exit(0), 500).unref();
});
process.on("SIGTERM", () => {
  client.shutdown();
  setTimeout(() => process.exit(0), 500).unref();
});
process.on("uncaughtException", (cause) => {
  log.error(`worker uncaught: ${cause?.stack ?? String(cause)}`);
});
process.on("unhandledRejection", (cause) => {
  log.error(`worker unhandled rejection: ${cause instanceof Error ? cause.stack : String(cause)}`);
});

// The connection is opened on demand by the plugin, which sends "login" when
// credentials exist or the owner asks for a QR code.
client.loadAuthAliases();
if (fs.existsSync(path.join(authDir, "creds.json"))) client.requestLogin();
emit({ ev: "ready", hasCredentials: fs.existsSync(path.join(authDir, "creds.json")) });
client.run().then(() => process.exit(0));
