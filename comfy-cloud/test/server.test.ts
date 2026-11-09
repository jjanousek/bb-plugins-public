// Backend tests: pure modules plus the plugin factory on the fake host with
// a stubbed fetch that replays the synthetic Comfy Cloud fixtures.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ART_FOLDER, createPlugin, resolveArtDir, settingOptions } from "../server";
import { parseDotenv, resolveKey } from "../key";
import { containsSecret, createComfyClient, findBillingEvent, friendlyError, jobErrorMessage, parseBillingPage, parseStatusError, pickOutput, sanitize } from "../comfy";
import { buildWorkflow, clampImageNodes, clampToRange, inspectWorkflow, resolveImageSpec, resolveVideoSpec, specParams, withSeed } from "../workflows";
import { MIGRATIONS, createStore, newAssetId } from "../store";
import { assetCostSignature, getModel, priceForEstimate, priceKeyOf } from "../registry";
import { BILLING_TRIES, createRunner, imageDimensions } from "../runner";
import { mediaVersion, parseRange } from "../media";
import { DERIVATIVE_REVISION } from "../thumbs";
import { LIBRARY_MAX } from "../components/comfy/library-paging";
import {
  CREDITS_PER_USD,
  IMAGE_MODELS,
  IMAGE_MODEL_INFO,
  VIDEO_MODELS,
  costNote,
  costSignature,
  creditsPerSecond,
  estimateCredits,
  estimateParamsOf,
  estimateSeconds,
  FAILED_WINDOW_MS,
  imageTier,
  registryAge,
  registryAgeLine,
  registryAgeText,
  registryStaleNote,
  usdForCredits,
  videoTokens,
  type Asset,
  type AssetStatus,
  type Costs,
  type ModelPrefs,
  type ModelsResult,
  type Status,
  type Workflow,
} from "../contract";

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
const KEY = "placeholder-api-key";

function fixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as T;
}

function tmpDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `comfy-test-${label}-`));
  cleanup.push(dir);
  return dir;
}

const cleanup: string[] = [];
const hosts: { host: FakePluginHost; controller?: AbortController }[] = [];

afterEach(async () => {
  for (const entry of hosts.splice(0)) {
    entry.controller?.abort();
    await entry.host.harness.lifecycle.dispose();
  }
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tinyPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([signature, ihdr, iend]);
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface FakeFetchOptions {
  submit?: unknown;
  status?: unknown;
  /** Consumed first, one per status call. */
  statusSequence?: unknown[];
  statusHttp?: number;
  job?: unknown;
  view?: { bytes: Uint8Array; type: string };
  /**
   * Throw on every call the way Node's fetch does when the name will not
   * resolve: the request never left the box, so a submit is safe to repeat.
   */
  offline?: boolean;
  /** Throw a network error on the status route only, while this is true. */
  statusOffline?: boolean;
  /** Serve /api/view directly instead of the live 302 to signed storage. */
  viewDirect?: boolean;
  /** Runs just before /api/prompt answers, to simulate a user action mid flight. */
  beforeSubmit?: () => void;
  /**
   * Comfy Cloud's own side of a submit. When set, every submit that reaches
   * it adds a job here (id, graph, create time), and /api/jobs and
   * /api/jobs/<id> answer from this list, so a test can see how many paid
   * jobs a flow really started.
   */
  server?: { jobs: { id: string; prompt: unknown; createdAt: number }[]; clock: () => number };
  /**
   * How the submit reply goes. "timeout": the job is made and the reply is
   * lost, as a timeout. "refused": the connection is refused before anything
   * is sent. Consumed one per submit; undefined answers normally.
   */
  submitFate?: ("timeout" | "refused" | undefined)[];
  /** Runs just before /api/view answers, to simulate a user action mid flight. */
  beforeView?: () => void;
  /** Pages of /api/billing/events, page 1 first. Default: the trimmed fixture. */
  billingPages?: unknown[];
  /** /api/billing/balance body. */
  balance?: unknown;
  /** Answer every billing route with this HTTP status instead. */
  billingHttp?: number;
}

/** The charge for the job the submit fixture returns, so a fake run settles like the live one. */
const SUBMITTED_JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaabab";
const DEFAULT_BILLING_PAGE = {
  events: [
    {
      createdAt: "2031-03-12T05:30:30.000000Z",
      event_type: "api_usage_completed",
      params: { job_id: SUBMITTED_JOB_ID, credits_used: 9.5, model: "seedream-5-0-pro-260628", output_tier: "standard" },
    },
  ],
  page: 1,
  totalPages: 1,
};

function makeFetch(options: FakeFetchOptions = {}) {
  const calls: FetchCall[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    // A multipart body is kept as it is: an upload is not JSON.
    const body = init?.body === undefined || init?.body === null ? undefined : init.body instanceof FormData ? (init.body as unknown) : (JSON.parse(String(init.body)) as unknown);
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    if (options.offline) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND cloud.comfy.org"), { code: "ENOTFOUND" }) });
    // The signed storage URL that /api/view redirects to. It must never see a key.
    if (u.hostname === "storage.googleapis.com") {
      const view = options.view ?? { bytes: tinyPng(1024, 1024), type: "image/png" };
      return new Response(new Uint8Array(view.bytes), { status: 200, headers: { "content-type": view.type } });
    }
    if (headers["x-api-key"] !== KEY) return json({ error: "unauthorized" }, 401);
    if (u.pathname === "/api/prompt") {
      options.beforeSubmit?.();
      const fate = options.submitFate?.shift();
      if (fate === "refused") {
        throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 104.18.0.1:443"), { code: "ECONNREFUSED" }) });
      }
      if (options.server) {
        const id = `job-${options.server.jobs.length + 1}`;
        options.server.jobs.unshift({ id, prompt: (body as { prompt?: unknown }).prompt, createdAt: options.server.clock() });
        if (fate === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        return json({ prompt_id: id, number: 1, node_errors: {} });
      }
      if (fate === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return json(options.submit ?? fixture("submit-ok.json"));
    }
    if (u.pathname === "/api/jobs" && options.server) {
      const limit = Number(u.searchParams.get("limit") ?? "100");
      const offset = Number(u.searchParams.get("offset") ?? "0");
      const page = options.server.jobs.slice(offset, offset + limit);
      return json({
        jobs: page.map((job) => ({ id: job.id, status: "completed", create_time: job.createdAt })),
        pagination: { offset, limit, total: options.server.jobs.length, has_more: offset + limit < options.server.jobs.length },
      });
    }
    if (u.pathname.startsWith("/api/jobs/") && options.server) {
      const id = decodeURIComponent(u.pathname.slice("/api/jobs/".length));
      const job = options.server.jobs.find((entry) => entry.id === id);
      if (!job) return json({ error: "not found" }, 404);
      const record = fixture("job-completed.json") as Record<string, unknown>;
      return json({ ...record, id, create_time: job.createdAt, workflow: { prompt: job.prompt, extra_data: { api_key_comfy_org: KEY } } });
    }
    if (/^\/api\/job\/[^/]+\/status$/.test(u.pathname)) {
      if (options.statusOffline) throw new TypeError("fetch failed");
      if (options.statusHttp) return json({ error: "nope" }, options.statusHttp);
      const next = options.statusSequence && options.statusSequence.length > 0 ? options.statusSequence.shift() : (options.status ?? fixture("status-success.json"));
      return json(next);
    }
    if (u.pathname.startsWith("/api/jobs/")) return json(options.job ?? fixture("job-completed.json"));
    if (u.pathname === "/api/view") {
      options.beforeView?.();
      if (options.viewDirect === true) {
        const view = options.view ?? { bytes: tinyPng(1024, 1024), type: "image/png" };
        return new Response(new Uint8Array(view.bytes), { status: 200, headers: { "content-type": view.type } });
      }
      // Live behaviour: 302 to a signed Google Storage URL.
      return new Response(null, { status: 302, headers: { location: `https://storage.googleapis.com/comfy/${encodeURIComponent(u.searchParams.get("filename") ?? "out.png")}?sig=abc` } });
    }
    if (u.pathname === "/api/billing/balance") {
      if (options.billingHttp) return json({ error: "nope" }, options.billingHttp);
      return json(options.balance ?? { effective_balance_micros: 1234.5, currency: "usd" });
    }
    if (u.pathname === "/api/billing/events") {
      if (options.billingHttp) return json({ error: "nope" }, options.billingHttp);
      const page = Number(u.searchParams.get("page") ?? "1");
      const pages = options.billingPages ?? [DEFAULT_BILLING_PAGE];
      const body = pages[page - 1] ?? { events: [], page, totalPages: pages.length };
      return json(body);
    }
    if (u.pathname === "/api/upload/image") {
      // Comfy Cloud stores by content, so the reply is derived from the bytes.
      const form = init?.body instanceof FormData ? init.body : null;
      const file = form?.get("image");
      if (!(file instanceof Blob)) return json({ error: "no image field" }, 400);
      const digest = createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex");
      return json({ name: `${digest}.png`, subfolder: "", type: "input" });
    }
    if (u.pathname === "/api/object_info") return json({});
    return new Response("not found", { status: 404 });
  };
  return { impl, calls };
}

async function waitUntil<T>(probe: () => T | Promise<T>, check: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const IMAGE_GRAPH: Workflow = {
  "1": {
    class_type: "ByteDanceSeedreamNodeV2",
    inputs: {
      prompt: "a brass compass on a folded map, overhead photo",
      model: "seedream 5.0 pro",
      "model.size_preset": "(1K) 1024x1024 (1:1)",
      "model.width": 1024,
      "model.height": 1024,
      "model.max_images": 1,
      "model.fail_on_partial": false,
      seed: 7,
      watermark: false,
    },
  },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "bb" } },
};

/**
 * The same request on the shipped default, which is the **V3** node. V2 is
 * deprecated and hidden, so a default pointing at it forced a duplicate row
 * into the picker; the legacy id `seedream 5.0 pro` still builds IMAGE_GRAPH
 * above, which is the byte identical graph the golden fixtures pin.
 */
const DEFAULT_IMAGE_GRAPH: Workflow = {
  "1": {
    class_type: "ByteDanceSeedreamNodeV3",
    inputs: {
      prompt: "a brass compass on a folded map, overhead photo",
      model: "seedream 5.0 pro",
      "model.size_preset": "(1K) 1024x1024 (1:1)",
      "model.width": 1024,
      "model.height": 1024,
      "model.prompt_optimization": "standard",
      "model.seed": 7,
      "model.watermark": false,
      "model.thinking": true,
    },
  },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "bb" } },
};

const VIDEO_GRAPH_1X: Workflow = {
  "1": {
    class_type: "ByteDanceTextToVideoNode",
    inputs: {
      model: "seedance-1-0-pro-fast-251015",
      prompt: "a windmill turning slowly on a hill at dawn",
      resolution: "480p",
      aspect_ratio: "16:9",
      duration: 3,
      seed: 7,
      camera_fixed: false,
      watermark: false,
      generate_audio: false,
    },
  },
  "2": { class_type: "SaveVideo", inputs: { video: ["1", 0], filename_prefix: "video/bb", format: "mp4", "format.codec": "h264" } },
};

const VIDEO_GRAPH_2X: Workflow = {
  "1": {
    class_type: "ByteDance2TextToVideoNode",
    inputs: {
      model: "Seedance 2.0 Fast",
      "model.prompt": "a windmill turning slowly on a hill at dawn",
      "model.resolution": "480p",
      "model.ratio": "16:9",
      "model.duration": 4,
      "model.generate_audio": false,
      seed: 7,
      watermark: false,
    },
  },
  "2": { class_type: "SaveVideo", inputs: { video: ["1", 0], filename_prefix: "video/bb", format: "mp4", "format.codec": "h264" } },
};

// ---------- key resolution ----------

describe("key resolution", () => {
  it("parses dotenv lines with export, quotes and comments", () => {
    expect(parseDotenv("# c\nexport COMFY_API_KEY=\"abc\" \nOTHER=1", "COMFY_API_KEY")).toBe("abc");
    expect(parseDotenv("COMFY_API_KEY=abc # trailing", "COMFY_API_KEY")).toBe("abc");
    expect(parseDotenv("COMFY_API_KEY=", "COMFY_API_KEY")).toBeNull();
    expect(parseDotenv("NOT_IT=abc", "COMFY_API_KEY")).toBeNull();
  });

  it("prefers the setting, then the plugin .env, then the key file", () => {
    const pluginDir = tmpDir("plugin");
    const keyDir = tmpDir("keyfile");
    const keyFile = path.join(keyDir, ".env");
    fs.writeFileSync(keyFile, "COMFY_API_KEY=file-key\n");
    expect(resolveKey({ settingKey: "", pluginDirs: [pluginDir], keyFile })).toEqual({ key: "file-key", source: "key-file" });
    fs.writeFileSync(path.join(pluginDir, ".env"), "COMFY_API_KEY=env-key\n");
    expect(resolveKey({ settingKey: "", pluginDirs: [pluginDir], keyFile })).toEqual({ key: "env-key", source: "plugin-env" });
    expect(resolveKey({ settingKey: " setting-key ", pluginDirs: [pluginDir], keyFile })).toEqual({ key: "setting-key", source: "setting" });
    expect(resolveKey({ settingKey: "", pluginDirs: [tmpDir("empty")], keyFile: "" })).toEqual({ key: null, source: null });
    expect(resolveKey({ settingKey: "", pluginDirs: [], keyFile: "/nonexistent/.env" })).toEqual({ key: null, source: null });
  });
});

// ---------- artwork folder ----------

describe("artwork folder", () => {
  it("finds assets/art in the module dir, then the parent, and is null without it", () => {
    const root = tmpDir("art-root");
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    expect(resolveArtDir([dist, root])).toBeNull();

    // A dist/ load searches its own folder first, then the plugin root.
    fs.mkdirSync(path.join(root, ART_FOLDER), { recursive: true });
    expect(resolveArtDir([dist, root])).toBe(path.join(root, ART_FOLDER));
    fs.mkdirSync(path.join(dist, ART_FOLDER), { recursive: true });
    expect(resolveArtDir([dist, root])).toBe(path.join(dist, ART_FOLDER));
    expect(resolveArtDir([])).toBeNull();
  });

  it("does not mistake a file named assets/art for the folder", () => {
    const root = tmpDir("art-file");
    fs.mkdirSync(path.join(root, "assets"));
    fs.writeFileSync(path.join(root, ART_FOLDER), "not a folder");
    expect(resolveArtDir([root])).toBeNull();
  });

  it("ships every piece the frontend asks for, as a mask with a transparent background", () => {
    const shipped = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), ART_FOLDER);
    const names = ["mark", "empty-library", "empty-search", "idle-jobs", "no-key"];
    expect(fs.readdirSync(shipped).sort()).toEqual(names.map((n) => `${n}.png`).sort());
    for (const name of names) {
      const png = fs.readFileSync(path.join(shipped, `${name}.png`));
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      // IHDR: width, height, then bit depth and colour type 6 (truecolour with alpha).
      expect(Math.max(png.readUInt32BE(16), png.readUInt32BE(20))).toBe(512);
      expect(png[25]).toBe(6);
      expect(png.length).toBeLessThan(60 * 1024);
    }
  });
});

// ---------- workflow builders ----------

describe("workflow builders", () => {
  it("builds the golden Seedream image graph", () => {
    const spec = resolveImageSpec({ prompt: "a brass compass on a folded map, overhead photo", seed: 7 }, "seedream 5.0 pro");
    expect(buildWorkflow(spec)).toEqual(IMAGE_GRAPH);
    expect(spec.width).toBe(1024);
  });

  it("clamps model.width and model.height into the range Comfy validates; the preset keeps the real size", () => {
    // Comfy validates model.height against a minimum of 1024, below the real height of a wide preset.
    const spec = resolveImageSpec({ prompt: "p", sizePreset: "(1K) 1312x736 (16:9)", seed: 1 }, "seedream 5.0 pro");
    const graph = buildWorkflow(spec);
    expect(graph["1"]?.inputs["model.size_preset"]).toBe("(1K) 1312x736 (16:9)");
    expect(graph["1"]?.inputs["model.width"]).toBe(1312);
    expect(graph["1"]?.inputs["model.height"]).toBe(1024);
    expect(specParams(spec)).toEqual({ sizePreset: "(1K) 1312x736 (16:9)", width: 1312, height: 736, seed: 1 });
    expect(inspectWorkflow(graph).params).toEqual({ sizePreset: "(1K) 1312x736 (16:9)", width: 1312, height: 736, seed: 1 });
    expect(clampToRange(735, { min: 1024, max: 6240, step: 2 })).toBe(1024);
    expect(clampToRange(4705, { min: 1024, max: 4992, step: 2 })).toBe(4706);
    expect(clampToRange(9000, { min: 1024, max: 6240, step: 2 })).toBe(6240);
  });

  it("rejects a preset the model does not offer and picks a default per model", () => {
    expect(() => resolveImageSpec({ prompt: "x", sizePreset: "(9K) 1x1 (1:1)" }, "seedream 5.0 pro")).toThrow(/not available/);
    expect(resolveImageSpec({ prompt: "x" }, "seedream 5.0 lite").sizePreset).toBe("(2K) 2048x2048 (1:1)");
    expect(resolveImageSpec({ prompt: "x" }, "seedream 5.0 pro").sizePreset).toBe("(1K) 1024x1024 (1:1)");
  });

  it("builds the golden Seedance 1.x graph", () => {
    const spec = resolveVideoSpec(
      { prompt: "a windmill turning slowly on a hill at dawn", duration: 3, seed: 7, resolution: "480p" },
      "seedance-1-0-pro-fast-251015",
    );
    expect(buildWorkflow(spec)).toEqual(VIDEO_GRAPH_1X);
  });

  it("builds the golden Seedance 2.x graph and adds output_format for 2.5", () => {
    const spec = resolveVideoSpec(
      { prompt: "a windmill turning slowly on a hill at dawn", duration: 4, seed: 7, model: "Seedance 2.0 Fast" },
      "seedance-1-0-pro-fast-251015",
    );
    expect(buildWorkflow(spec)).toEqual(VIDEO_GRAPH_2X);
    const v25 = buildWorkflow(resolveVideoSpec({ prompt: "p", model: "Seedance 2.5", seed: 1 }, "seedance-1-0-pro-fast-251015"));
    expect(v25["1"]?.inputs["model.output_format"]).toBe("mp4");
  });

  it("clamps duration, drops audio for models without it, rejects bad resolutions", () => {
    const spec = resolveVideoSpec({ prompt: "p", duration: 99, generateAudio: true }, "seedance-1-0-pro-fast-251015");
    expect(spec.duration).toBe(12);
    expect(spec.generateAudio).toBe(false);
    expect(resolveVideoSpec({ prompt: "p" }, "Seedance 2.0 Fast").duration).toBe(5);
    expect(() => resolveVideoSpec({ prompt: "p", resolution: "4k" }, "seedance-1-0-pro-fast-251015")).toThrow(/resolutions/);
  });

  it("inspects graphs and swaps seeds", () => {
    const image = inspectWorkflow(IMAGE_GRAPH);
    expect(image.kind).toBe("image");
    expect(image.prompt).toContain("brass compass");
    expect(image.model).toBe("seedream 5.0 pro");
    expect(image.seed).toBe(7);
    expect(image.params).toEqual({ sizePreset: "(1K) 1024x1024 (1:1)", width: 1024, height: 1024, seed: 7 });
    const video = inspectWorkflow(VIDEO_GRAPH_2X);
    expect(video.kind).toBe("video");
    expect(video.prompt).toContain("turning");
    expect(video.params).toMatchObject({ resolution: "480p", aspectRatio: "16:9", duration: 4, generateAudio: false, seed: 7 });
    const reseeded = withSeed(IMAGE_GRAPH, 99);
    expect(reseeded["1"]?.inputs.seed).toBe(99);
    expect(IMAGE_GRAPH["1"]?.inputs.seed).toBe(7);
  });
});

// ---------- job parsing and sanitization ----------

describe("workflow hygiene", () => {
  it("caps the stored prompt and keeps long strings out of params", () => {
    const long = "a ".repeat(1600).trim(); // 3199 chars
    const graph: Workflow = {
      "1": {
        class_type: "ByteDanceSeedreamNodeV2",
        inputs: { prompt: long, model: "seedream 5.0 pro", "model.size_preset": "(1K) 1024x1024 (1:1)", negative: "b ".repeat(400).trim(), seed: 7 },
      },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
    };
    const info = inspectWorkflow(graph);
    expect(info.prompt?.length).toBeLessThan(2100);
    expect(info.prompt).toMatch(/\[cut, 3199 chars\]$/);
    expect(info.params.negative).toBe("[799 chars]");
  });

  it("ignores very long strings when guessing a prompt", () => {
    const graph: Workflow = {
      "1": { class_type: "Odd", inputs: { blob: "z ".repeat(600).trim(), note: "a quiet harbour at dawn" } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
    };
    expect(inspectWorkflow(graph).prompt).toBe("a quiet harbour at dawn");
  });

  it("clamps model.width and model.height on a hand edited Seedream graph", () => {
    const graph: Workflow = {
      "1": { class_type: "ByteDanceSeedreamNodeV2", inputs: { model: "seedream 5.0 pro", "model.size_preset": "(1K) 1312x736 (16:9)", "model.width": 1312, "model.height": 736 } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
    };
    const clamped = clampImageNodes(graph);
    expect(clamped["1"]?.inputs["model.width"]).toBe(1312);
    expect(clamped["1"]?.inputs["model.height"]).toBe(1024);
    expect(graph["1"]?.inputs["model.height"]).toBe(736);
  });
});

describe("comfy helpers", () => {
  it("strips extra_data and api_key_comfy_org from job records", () => {
    const job = fixture<Record<string, unknown>>("job-completed.json");
    const clean = JSON.stringify(sanitize(job, "REDACTED"));
    expect(containsSecret(clean)).toBe(false);
    expect(clean).not.toContain("REDACTED");
    expect((sanitize(job) as { workflow: { prompt: Workflow } }).workflow.prompt["1"]?.class_type).toBe("ByteDanceSeedreamNodeV2");
    expect(sanitize({ nested: [{ api_key_comfy_org: "k", keep: 1 }] })).toEqual({ nested: [{ keep: 1 }] });
  });

  it("maps errors to the first line of exception_message", () => {
    const status = fixture<{ error_message: string }>("status-error.json");
    expect(parseStatusError(status.error_message)).toMatch(/^API Error: Requested model example-clip-model does not exist/);
    expect(parseStatusError(status.error_message)).not.toContain("\n");
    expect(jobErrorMessage(fixture("job-failed.json"))).toMatch(/^API Error: Requested model example-video-model/);
    expect(parseStatusError("plain text\nsecond")).toBe("plain text");
    expect(parseStatusError(undefined)).toBe("Comfy job failed");
    // A validation failure carries the rejection JSON after a text prefix, as Comfy returns it.
    const rejected =
      'Submit refused with HTTP 400: {"error": {"message": "Graph did not validate", "details": ""}, "node_errors": {"3": {"class_type": "ExampleVideoNode", "errors": [{"message": "Value 2 smaller than min of 4", "details": "model.duration"}]}}}';
    expect(parseStatusError(rejected)).toBe("Workflow rejected: Graph did not validate; node 3 (ExampleVideoNode): Value 2 smaller than min of 4 (model.duration)");
    expect(parseStatusError(JSON.stringify({ exception_message: rejected }))).toContain("node 3 (ExampleVideoNode)");
    expect(jobErrorMessage({ execution_error: { exception_message: rejected } })).toContain("Workflow rejected");
  });

  it("picks outputs for images and videos", () => {
    const image = pickOutput(fixture("job-completed.json"), "image");
    expect(image).toMatchObject({ nodeId: "2", subfolder: "", type: "output", animated: false });
    expect(image?.filename.endsWith(".png")).toBe(true);
    const video = pickOutput(fixture("job-completed-video.json"), "video");
    expect(video).toMatchObject({ subfolder: "video", animated: true });
    expect(video?.filename.endsWith(".mp4")).toBe(true);
    expect(pickOutput(fixture("job-failed.json"), null)).toBeNull();
  });

  it("client: submit sends the key in the header and body, status maps states, job comes back clean", async () => {
    const { impl, calls } = makeFetch({ statusSequence: [fixture("status-executing.json"), fixture("status-success.json"), fixture("status-error.json")] });
    const client = createComfyClient({ fetch: impl });
    const { promptId } = await client.submit(KEY, IMAGE_GRAPH);
    expect(promptId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaabab");
    const submit = calls[0] as FetchCall;
    expect(submit.headers["x-api-key"]).toBe(KEY);
    expect((submit.body as { extra_data: { api_key_comfy_org: string } }).extra_data.api_key_comfy_org).toBe(KEY);
    expect((submit.body as { prompt: Workflow }).prompt).toEqual(IMAGE_GRAPH);
    expect(await client.status(KEY, promptId)).toEqual({ state: "executing", error: null });
    expect(await client.status(KEY, promptId)).toEqual({ state: "success", error: null });
    const failed = await client.status(KEY, promptId);
    expect(failed.state).toBe("error");
    expect(failed.error).toMatch(/^API Error/);
    const job = JSON.stringify(await client.job(KEY, promptId));
    expect(containsSecret(job)).toBe(false);
  });

  it("client: a rejected graph is a permanent error that never echoes the key", async () => {
    const { impl } = makeFetch({
      submit: { error: { message: "Prompt outputs failed validation", details: "" }, node_errors: { "1": { class_type: "X", errors: [{ message: "Value not in list", details: `model: ${KEY}` }] } } },
    });
    const client = createComfyClient({ fetch: impl });
    await expect(client.submit(KEY, IMAGE_GRAPH)).rejects.toMatchObject({ name: "ComfyError", permanent: true });
    await client.submit(KEY, IMAGE_GRAPH).catch((cause: Error) => {
      expect(cause.message).toContain("Value not in list");
      expect(cause.message).not.toContain(KEY);
    });
  });

  it("client: uploadImage posts the bytes under the field name \"image\" and uploads the same file once", async () => {
    const { impl, calls } = makeFetch();
    const client = createComfyClient({ fetch: impl });
    const bytes = tinyPng(64, 64);
    const first = await client.uploadImage(KEY, bytes, "/data/pictures/compass.png");
    expect(first.name).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(first.type).toBe("input");
    const upload = calls[0] as FetchCall;
    expect(new URL(upload.url).pathname).toBe("/api/upload/image");
    expect(upload.method).toBe("POST");
    expect(upload.headers["x-api-key"]).toBe(KEY);
    // No content-type of ours: fetch writes the multipart boundary itself, and
    // setting one by hand makes Comfy read an empty form and store nothing.
    expect(upload.headers["content-type"]).toBeUndefined();
    const form = upload.body as FormData;
    const file = form.get("image");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("compass.png");
    expect(form.get("type")).toBe("input");

    // Storage is content addressed, so the same bytes are never sent twice.
    const again = await client.uploadImage(KEY, bytes, "copy.png");
    expect(again).toEqual(first);
    expect(calls.length).toBe(1);
    // Different bytes are a different upload and a different name.
    const other = await client.uploadImage(KEY, tinyPng(65, 65), "other.png");
    expect(other.name).not.toBe(first.name);
    expect(calls.length).toBe(2);
  });

  it("client: a 404 on the status route falls back to /api/jobs", async () => {
    const { impl, calls } = makeFetch({ statusHttp: 404, job: fixture("job-failed.json") });
    const client = createComfyClient({ fetch: impl });
    const status = await client.status(KEY, "aaaaaaaa");
    expect(status.state).toBe("error");
    expect(status.error).toMatch(/^API Error/);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/job/aaaaaaaa/status", "/api/jobs/aaaaaaaa"]);
  });

  it("reads PNG, JPEG and WebP dimensions", () => {
    expect(imageDimensions(tinyPng(1312, 736))).toEqual({ width: 1312, height: 736 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x00, 0x03, 0x00, 0x03]);
    expect(imageDimensions(jpeg)).toEqual({ width: 768, height: 512 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0);
    webp.write("WEBP", 8);
    webp.write("VP8 ", 12);
    webp.writeUInt16LE(640, 26);
    webp.writeUInt16LE(360, 28);
    expect(imageDimensions(webp)).toEqual({ width: 640, height: 360 });
    expect(imageDimensions(Buffer.from("nope"))).toBeNull();
  });
});

// ---------- runner ----------

interface RunnerFixture {
  store: ReturnType<typeof createStore>;
  assetDir: string;
  changes: string[];
  logs: string[];
}

function runnerFixture(fetchOptions: FakeFetchOptions, extra: Partial<Parameters<typeof createRunner>[0]> = {}) {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const store = createStore(db);
  const assetDir = tmpDir("assets");
  const changes: string[] = [];
  const logs: string[] = [];
  const { impl, calls } = makeFetch(fetchOptions);
  const client = createComfyClient({ fetch: impl });
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const runner = createRunner({
    store,
    client,
    getKey: () => KEY,
    assetDir: () => assetDir,
    log,
    onChange: (id) => changes.push(id),
    probeVideo: async () => ({ width: 864, height: 480, durationS: 3 }),
    ...extra,
  });
  return { runner, store, assetDir, changes, logs, calls, fixture: { store, assetDir, changes, logs } satisfies RunnerFixture };
}

function queueRow(store: ReturnType<typeof createStore>, assetDir: string, kind: "image" | "video", workflow: Workflow, overrides: Partial<Asset> = {}): Asset {
  const id = newAssetId(kind);
  const folder = path.join(assetDir, "2031-06-17");
  fs.mkdirSync(folder, { recursive: true });
  const workflowPath = path.join(folder, `${id}.workflow.json`);
  fs.writeFileSync(workflowPath, JSON.stringify(workflow));
  const asset: Asset = {
    id,
    kind,
    status: "queued",
    prompt: "p",
    model: "m",
    params: { seed: 7 },
    file: null,
    path: null,
    workflowPath,
    mime: null,
    width: null,
    height: null,
    durationS: null,
    sizeBytes: null,
    comfyPromptId: null,
    parentId: null,
    threadId: null,
    source: "unknown",
    starred: false,
    error: null,
    estimatedCredits: null,
    actualCredits: null,
    billedModel: null,
    outputTier: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
  store.insert(asset);
  return asset;
}


// ---------- the sidebar badge's window ----------

describe("counts", () => {
  // The sidebar badge is red while `failedRecent` is above zero, so this is the
  // thing that lets a red badge go out again. `failed` stays a lifetime figure
  // because that is what the panel wants.
  function storeWith(rows: { status: AssetStatus; createdAt: number; completedAt: number | null }[]) {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const store = createStore(db);
    for (const row of rows) {
      store.insert({
        id: newAssetId("image"),
        kind: "image",
        status: row.status,
        prompt: "p",
        model: "m",
        params: {},
        file: null,
        path: null,
        workflowPath: "/tmp/w.json",
        mime: null,
        width: null,
        height: null,
        durationS: null,
        sizeBytes: null,
        comfyPromptId: null,
        parentId: null,
        threadId: null,
        source: "tool",
        starred: false,
        error: null,
        estimatedCredits: null,
        actualCredits: null,
        billedModel: null,
        outputTier: null,
        createdAt: row.createdAt,
        startedAt: null,
        completedAt: row.completedAt,
      });
    }
    return store;
  }

  const NOW = 1_789_000_000_000;
  const hoursAgo = (h: number) => NOW - h * 3600_000;

  it("counts a failure as recent for a day and then stops", () => {
    const store = storeWith([
      { status: "failed", createdAt: hoursAgo(2), completedAt: hoursAgo(2) },
      { status: "failed", createdAt: hoursAgo(40), completedAt: hoursAgo(40) },
      { status: "completed", createdAt: hoursAgo(1), completedAt: hoursAgo(1) },
    ]);
    const counts = store.counts(NOW);
    expect(counts.failed).toBe(2);
    expect(counts.failedRecent).toBe(1);
    // Two days later the badge is silent and the library still remembers both.
    const later = store.counts(NOW + 2 * 86_400_000);
    expect(later.failed).toBe(2);
    expect(later.failedRecent).toBe(0);
  });

  it("dates a failure by when it failed, not by when it was asked for", () => {
    // A row can sit queued for hours waiting for a key. It is news when it
    // fails, so the window reads completed_at and only falls back to created_at.
    const store = storeWith([{ status: "failed", createdAt: hoursAgo(30), completedAt: hoursAgo(1) }]);
    expect(store.counts(NOW).failedRecent).toBe(1);
    const noCompletion = storeWith([{ status: "failed", createdAt: hoursAgo(30), completedAt: null }]);
    expect(noCompletion.counts(NOW).failedRecent).toBe(0);
  });

  it("holds the boundary exactly one window wide", () => {
    const store = storeWith([
      { status: "failed", createdAt: NOW - FAILED_WINDOW_MS, completedAt: NOW - FAILED_WINDOW_MS },
      { status: "failed", createdAt: NOW - FAILED_WINDOW_MS - 1, completedAt: NOW - FAILED_WINDOW_MS - 1 },
    ]);
    expect(store.counts(NOW).failedRecent).toBe(1);
  });
});

// ---------- secrets, friendly text and estimates ----------

describe("download redirect", () => {
  it("follows the /api/view 302 by hand and sends no key to the storage URL", async () => {
    const { impl, calls } = makeFetch({});
    const client = createComfyClient({ fetch: impl });
    const dir = tmpDir("download");
    const dest = path.join(dir, "out.png");
    const result = await client.download(KEY, { nodeId: "2", filename: "out.png", subfolder: "", type: "output", animated: false }, dest);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(fs.existsSync(dest)).toBe(true);

    const view = calls.find((call) => call.url.includes("/api/view"));
    const storage = calls.find((call) => call.url.startsWith("https://storage.googleapis.com/"));
    expect(view?.headers["x-api-key"]).toBe(KEY);
    expect(storage).toBeDefined();
    expect(Object.keys(storage?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain("x-api-key");
    expect(JSON.stringify(storage?.headers ?? {})).not.toContain(KEY);
  });
});

describe("friendlyError", () => {
  it("names the field and the model for a range failure", () => {
    const raw = "Workflow rejected: Graph did not validate; node 3 (ExampleVideoNode): Value 2 smaller than min of 4 (model.duration)";
    expect(friendlyError(raw, "Seedance 2.0 Fast")).toBe("Duration must be at least 4 for Seedance 2.0 Fast.");
    expect(friendlyError(raw)).toBe("Duration must be at least 4.");
  });

  it("explains a model the account cannot use", () => {
    const raw = parseStatusError((fixture("status-error.json") as { error_message: string }).error_message);
    expect(friendlyError(raw)).toBe("example-clip-model is not available to this Comfy Cloud account.");
  });

  it("maps timeouts and network failures", () => {
    expect(friendlyError("Comfy Cloud GET /api/jobs/x: The operation was aborted due to timeout")).toBe("Comfy Cloud did not answer in time. Try again.");
    expect(friendlyError("Comfy Cloud POST /api/prompt: fetch failed (ECONNREFUSED)")).toBe("Could not reach Comfy Cloud. Check the connection and try again.");
  });

  it("passes a provider's own refusal on as its first line", () => {
    const raw = "Upstream image service declined the request\nrequest id 0000";
    expect(friendlyError(raw, "SomeOtherNode/x")).toBe("Upstream image service declined the request");
  });

  it("falls back to one plain line for any other rejection", () => {
    expect(friendlyError("Comfy Cloud rejected the workflow: node 1 (X): Value not in list (model)")).toBe("Comfy rejected the workflow: model: Value not in list");
    expect(friendlyError("something odd\nsecond line")).toBe("something odd");
    expect(friendlyError("")).toBe("The generation failed.");
  });
});

describe("estimateSeconds", () => {
  it("scales images by tier and count", () => {
    expect(estimateSeconds("image", "seedream 5.0 pro", { sizePreset: "(1K) 1024x1024 (1:1)" })).toEqual({ low: 20, high: 40 });
    expect(estimateSeconds("image", "seedream 5.0 pro", { sizePreset: "(2K) 2048x2048 (1:1)" })).toEqual({ low: 40, high: 80 });
    expect(estimateSeconds("image", "seedream 5.0 pro", { sizePreset: "(1K) 1024x1024 (1:1)", count: 3 })).toEqual({ low: 60, high: 120 });
  });

  it("scales videos by generation, clip length and resolution", () => {
    expect(estimateSeconds("video", "seedance-1-0-pro-fast-251015", { duration: 3, resolution: "480p" })).toEqual({ low: 25, high: 50 });
    expect(estimateSeconds("video", "Seedance 2.0 Fast", { duration: 4, resolution: "480p" })).toEqual({ low: 100, high: 200 });
    expect(estimateSeconds("video", "seedance-1-0-pro-fast-251015", { duration: 3, resolution: "1080p" })).toEqual({ low: 50, high: 100 });
  });

  it("uses the model default duration when none is given", () => {
    expect(estimateSeconds("video", "seedance-1-0-pro-fast-251015", {})).toEqual({ low: 35, high: 70 });
  });

  it("never says a bigger clip is faster", () => {
    // The doubling above 720p is compared by height, not by a list of tier
    // names, so a new rung such as 1440 cannot fall through and quote the
    // larger size as the quicker one.
    const sizes = ["1280x720", "1920x1080", "2560x1440", "3840x2160"];
    const at = (sizePreset: string) => estimateSeconds("video", "LTX-2.5 (Fast)", { sizePreset, duration: 5 });
    for (let i = 1; i < sizes.length; i += 1) {
      expect(at(sizes[i]!).low, sizes[i]).toBeGreaterThanOrEqual(at(sizes[i - 1]!).low);
    }
    expect(at("2560x1440").low).toBeGreaterThan(at("1280x720").low);
    // Portrait reads the same tier as its landscape twin.
    expect(at("1440x2560")).toEqual(at("2560x1440"));
    // And a named tier still works where the model uses one.
    const named = (resolution: string) => estimateSeconds("video", "Seedance 2.5", { resolution, duration: 5 }).low;
    expect(named("1080p")).toBeGreaterThan(named("480p"));
  });
});

describe("registry age", () => {
  // The catalog on disk refreshes itself daily and models.generated.ts is
  // regenerated by hand, so the two drift. A registry a few days behind can
  // still offer rows Comfy Cloud has retired; these lines say so.
  const info = { generatedAt: "2031-05-06", catalogDate: "2031-05-06", catalogFetched: "2031-05-10" };

  it("counts the days and calls a newer catalog on disk stale", () => {
    const age = registryAge(info, "2031-05-11");
    expect(age.ageDays).toBe(5);
    expect(age.behindDays).toBe(4);
    expect(age.stale).toBe(true);
  });

  it("is not stale when the registry was built from the catalog on disk", () => {
    const age = registryAge({ generatedAt: "2031-05-11", catalogDate: "2031-05-10", catalogFetched: "2031-05-10" }, "2031-05-11");
    expect(age.stale).toBe(false);
    expect(age.ageDays).toBe(0);
    expect(registryAgeLine(age)).toBe("The model list was built 2031-05-11 (today) from the catalog fetched 2031-05-10.");
    expect(registryAgeText(age)).toBe("Built 2031-05-11 (today) from the catalog fetched 2031-05-10.");
  });

  it("says what to run when it is behind", () => {
    const line = registryAgeLine(registryAge(info, "2031-05-11"));
    expect(line).toContain("built 2031-05-06 (5 days ago)");
    expect(line).toContain("4 days newer");
    expect(line).toContain("node scripts/make-models.mjs");
  });

  it("hands a bare warning to a surface with its own sentence", () => {
    expect(registryStaleNote(registryAge(info, "2031-05-11"))).toMatch(/^The catalog on disk is 4 days newer/);
    expect(registryStaleNote(registryAge({ generatedAt: "2031-05-11", catalogDate: "2031-05-10", catalogFetched: "2031-05-10" }, "2031-05-11"))).toBe("");
  });

  it("says nothing about staleness when no catalog has been fetched", () => {
    const age = registryAge({ ...info, catalogFetched: null }, "2031-05-07");
    expect(age.behindDays).toBe(null);
    expect(age.stale).toBe(false);
    expect(registryAgeLine(age)).toBe("The model list was built 2031-05-06 (yesterday) from the catalog fetched 2031-05-06.");
  });
});

describe("image model labels", () => {
  it("has a friendly label and a group for every image model", () => {
    expect(IMAGE_MODEL_INFO["seedream 5.0 pro"]).toEqual({ label: "Seedream 5.0 Pro", group: "Seedream 5.x" });
    expect(IMAGE_MODEL_INFO["seedream-4-0-250828"]).toEqual({ label: "Seedream 4.0", group: "Seedream 4.x" });
  });
});

describe("runner", () => {
  it("completes an image row: submit, poll, download, probe, job.json", async () => {
    const { runner, store, assetDir, changes } = runnerFixture({ statusSequence: [fixture("status-executing.json")] });
    const row = queueRow(store, assetDir, "image", IMAGE_GRAPH);
    await runner.tick();
    let asset = store.get(row.id) as Asset;
    expect(asset.status).toBe("running");
    expect(asset.comfyPromptId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaabab");
    expect(asset.startedAt).not.toBeNull();
    await runner.tick(); // executing
    expect(store.get(row.id)?.status).toBe("running");
    await runner.tick(); // success
    asset = store.get(row.id) as Asset;
    expect(asset.status).toBe("completed");
    expect(asset.file).toBe(`2031-06-17/${row.id}.png`);
    expect(asset.path).toBe(path.join(assetDir, "2031-06-17", `${row.id}.png`));
    expect(asset.mime).toBe("image/png");
    expect(asset.width).toBe(1024);
    expect(asset.height).toBe(1024);
    expect(asset.sizeBytes).toBeGreaterThan(0);
    expect(fs.existsSync(asset.path as string)).toBe(true);
    expect(fs.existsSync(`${asset.path}.part`)).toBe(false);
    const jobText = fs.readFileSync(path.join(assetDir, "2031-06-17", `${row.id}.job.json`), "utf8");
    expect(containsSecret(jobText)).toBe(false);
    expect(jobText).not.toContain(KEY);
    expect(changes.filter((id) => id === row.id).length).toBeGreaterThanOrEqual(2);
  });

  it("does not resurrect a row that was cancelled while it was being submitted", async () => {
    let store!: ReturnType<typeof createStore>;
    let rowId = "";
    const fixtureRunner = runnerFixture({
      beforeSubmit: () => {
        if (rowId !== "") store.update(rowId, { status: "cancelled" });
      },
    });
    store = fixtureRunner.store;
    const row = queueRow(store, fixtureRunner.assetDir, "image", IMAGE_GRAPH);
    rowId = row.id;
    await fixtureRunner.runner.tick();
    expect(store.get(row.id)?.status).toBe("cancelled");
    expect(store.get(row.id)?.comfyPromptId).toBeNull();
  });

  it("removes the downloaded files when the row was deleted during the download", async () => {
    let store!: ReturnType<typeof createStore>;
    let rowId = "";
    const f = runnerFixture({
      statusSequence: [fixture("status-success.json")],
      beforeView: () => {
        if (rowId !== "") store.remove(rowId);
      },
    });
    store = f.store;
    const row = queueRow(store, f.assetDir, "image", IMAGE_GRAPH);
    rowId = row.id;
    await f.runner.tick(); // submit
    await f.runner.tick(); // status success, job, download, then notice the row is gone
    expect(store.get(row.id)).toBeNull();
    const folder = path.join(f.assetDir, "2031-06-17");
    expect(fs.existsSync(path.join(folder, `${row.id}.png`))).toBe(false);
    expect(fs.existsSync(path.join(folder, `${row.id}.job.json`))).toBe(false);
    expect(fs.existsSync(path.join(folder, `${row.id}.workflow.json`))).toBe(false);
  });

  it("treats a call cut off by a shutdown as neither a warning nor one of the row's tries", async () => {
    // A reload aborts the service signal mid call. That is neither a warning
    // nor an error against a row nothing has gone wrong with.
    const controller = new AbortController();
    const f = runnerFixture({ statusSequence: [fixture("status-executing.json")] });
    const row = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH);
    await f.runner.tick(); // submit
    expect(f.store.get(row.id)?.status).toBe("running");
    // The shutdown lands while the status call is in flight: the fetch sees
    // the signal and rejects the way a real aborted fetch does.
    const cut = runnerFixture({}, {
      store: f.store,
      client: createComfyClient({
        fetch: async () => {
          controller.abort();
          throw new DOMException("This operation was aborted", "AbortError");
        },
      }),
      log: { info: (m: string) => f.logs.push(m), warn: (m: string) => f.logs.push(m), error: (m: string) => f.logs.push(m) },
    });
    await cut.runner.tick(controller.signal);
    expect(f.store.get(row.id)?.status).toBe("running");
    expect(f.logs.some((line) => line.includes("error 1 of"))).toBe(false);
    expect(f.logs.some((line) => line.includes("stopped mid call for a shutdown"))).toBe(true);
  });

  it("removes the small copies too when the row goes away while they are being made", async () => {
    // complete() checks the row once, after the download, then probes and
    // makes the small copies. A delete in that window must not leave a thumb
    // and a medium that no row would ever clean up.
    let store!: ReturnType<typeof createStore>;
    let rowId = "";
    let folder = "";
    const f = runnerFixture(
      { statusSequence: [fixture("status-success.json")], job: fixture("job-completed-video.json") },
      {
        probeVideo: async (file: string) => {
          // Stand in for an ffmpeg run that finished: the copies exist on disk.
          folder = path.dirname(file);
          for (const kind of ["thumb", "medium"]) fs.writeFileSync(path.join(folder, `${rowId}.${kind}.webp`), "x");
          store.remove(rowId);
          return { width: 864, height: 480, durationS: 3 };
        },
      },
    );
    store = f.store;
    const row = queueRow(store, f.assetDir, "video", VIDEO_GRAPH_1X);
    rowId = row.id;
    await f.runner.tick(); // submit
    await f.runner.tick(); // success, download, probe (the row goes), then clean up
    expect(store.get(row.id)).toBeNull();
    expect(folder).not.toBe("");
    const left = fs.readdirSync(folder).filter((name) => name.startsWith(row.id));
    expect(left).toEqual([]);
  });

  it("keeps a cancelled row cancelled and drops the media, but keeps its workflow for a retry", async () => {
    let store!: ReturnType<typeof createStore>;
    let rowId = "";
    const f = runnerFixture({
      statusSequence: [fixture("status-success.json")],
      beforeView: () => {
        if (rowId !== "") store.update(rowId, { status: "cancelled" });
      },
    });
    store = f.store;
    const row = queueRow(store, f.assetDir, "image", IMAGE_GRAPH);
    rowId = row.id;
    await f.runner.tick();
    await f.runner.tick();
    expect(store.get(row.id)?.status).toBe("cancelled");
    expect(store.get(row.id)?.file).toBeNull();
    const folder = path.join(f.assetDir, "2031-06-17");
    expect(fs.existsSync(path.join(folder, `${row.id}.png`))).toBe(false);
    expect(fs.existsSync(path.join(folder, `${row.id}.workflow.json`))).toBe(true);
  });

  it("stops promptly when its signal aborts, even with a request in flight", async () => {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const store = createStore(db);
    const assetDir = tmpDir("abort");
    // A server that never answers; only the abort signal ends the request.
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true });
      });
    const runner = createRunner({
      store,
      client: createComfyClient({ fetch: hanging }),
      getKey: () => KEY,
      assetDir: () => assetDir,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      onChange: () => {},
      tickMs: 20,
    });
    queueRow(store, assetDir, "image", IMAGE_GRAPH);
    const controller = new AbortController();
    const started = Date.now();
    const loop = runner.run(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await loop;
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("completes a video row with the ffprobe result", async () => {
    const { runner, store, assetDir } = runnerFixture({
      job: fixture("job-completed-video.json"),
      view: { bytes: Buffer.from("not really an mp4"), type: "video/mp4" },
    });
    const row = queueRow(store, assetDir, "video", VIDEO_GRAPH_1X);
    await runner.tick();
    await runner.tick();
    const asset = store.get(row.id) as Asset;
    expect(asset.status).toBe("completed");
    expect(asset.file).toBe(`2031-06-17/${row.id}.mp4`);
    expect(asset.mime).toBe("video/mp4");
    expect(asset.width).toBe(864);
    expect(asset.durationS).toBe(3);
    expect(fs.existsSync(path.join(assetDir, "2031-06-17", `${row.id}.job.json`))).toBe(true);
  });

  it("maps a Comfy error to failed with the first line of exception_message", async () => {
    const { runner, store, assetDir } = runnerFixture({ status: fixture("status-error.json") });
    const row = queueRow(store, assetDir, "video", VIDEO_GRAPH_1X);
    await runner.tick();
    await runner.tick();
    const asset = store.get(row.id) as Asset;
    expect(asset.status).toBe("failed");
    expect(asset.error).toBe("example-clip-model is not available to this Comfy Cloud account.");
    expect(asset.error).not.toContain("\n");
  });

  it("retries transient errors and gives up after 10", async () => {
    const { runner, store, assetDir, logs } = runnerFixture({ offline: true }, { maxConsecutiveErrors: 3 });
    const row = queueRow(store, assetDir, "image", IMAGE_GRAPH);
    await runner.tick();
    expect(store.get(row.id)?.status).toBe("queued");
    await runner.tick();
    expect(store.get(row.id)?.status).toBe("queued");
    await runner.tick();
    const asset = store.get(row.id) as Asset;
    expect(asset.status).toBe("failed");
    expect(asset.error).toMatch(/gave up after 3 tries/);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("fails a rejected graph at once, and calls a job still running past the limit unknown, not failed", async () => {
    let now = 1_000_000;
    const { runner, store, assetDir } = runnerFixture(
      { submit: { error: "bad graph", node_errors: {} }, status: fixture("status-executing.json") },
      { now: () => now, runningTimeoutMs: 60_000 },
    );
    const rejected = queueRow(store, assetDir, "image", IMAGE_GRAPH);
    const stale = queueRow(store, assetDir, "image", IMAGE_GRAPH, { status: "running", comfyPromptId: "old", startedAt: now - 120_000 });
    await runner.tick();
    expect(store.get(rejected.id)?.status).toBe("failed");
    expect(store.get(rejected.id)?.error).toContain("bad graph");
    // A job still running after 20 minutes may yet finish and be billed.
    expect(store.get(stale.id)?.status).toBe("unknown");
    expect(store.get(stale.id)?.error).toMatch(/after 20 minutes/);
    now += 1;
  });

  describe("a finished paid job is never marked failed for a network drop or a long run", () => {
    // A paid job's bill lands on the row only when the row completes, so a
    // row is not marked failed for transient errors or a long run without
    // asking Comfy Cloud how its job ended: a failed row drops the picture and
    // its bill, and Retry pays again.
    it("calls a row unknown, not failed, when the network drops mid run, and completes it when Comfy answers", async () => {
      const clock = { at: 1_000_000 };
      const options: FakeFetchOptions = { statusSequence: [fixture("status-executing.json")] };
      const f = runnerFixture(options, { now: () => clock.at, maxConsecutiveErrors: 3, unknownCheckMs: 60_000 });
      const row = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH);
      await f.runner.tick(); // submit
      await f.runner.tick(); // executing
      expect(f.store.get(row.id)?.status).toBe("running");
      options.statusOffline = true;
      for (let i = 0; i < 3; i += 1) await f.runner.tick();
      const lost = f.store.get(row.id) as Asset;
      expect(lost.status).toBe("unknown");
      expect(lost.error).toMatch(/may have finished/);
      // While Comfy Cloud is still out of reach the row just waits.
      clock.at += 60_000;
      await f.runner.tick();
      expect(f.store.get(row.id)?.status).toBe("unknown");
      // Comfy answers: the job had finished, so it is fetched, not repaid.
      options.statusOffline = false;
      clock.at += 60_000;
      await f.runner.tick();
      const done = f.store.get(row.id) as Asset;
      expect(done.status).toBe("completed");
      expect(done.error).toBeNull();
      expect(fs.existsSync(done.path as string)).toBe(true);
      expect(f.calls.filter((call) => call.url.endsWith("/api/prompt")).length).toBe(1);
      expect(f.runner.awaitingBill(row.id)).toBe(true);
    });

    it("checks how a long job ended before it gives up, and keeps a job still running as unknown", async () => {
      const clock = { at: 1_000_000 };
      const options: FakeFetchOptions = { statusSequence: [fixture("status-executing.json"), fixture("status-executing.json")] };
      const f = runnerFixture(options, { now: () => clock.at, runningTimeoutMs: 60_000, unknownCheckMs: 30_000 });
      const finished = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH, { status: "running", comfyPromptId: "finished-late", startedAt: clock.at - 120_000 });
      await f.runner.tick(); // executing past the limit: unknown, not failed
      expect(f.store.get(finished.id)?.status).toBe("unknown");
      await f.runner.tick(); // too soon to ask again
      expect(f.store.get(finished.id)?.status).toBe("unknown");
      clock.at += 30_000;
      await f.runner.tick(); // still executing: still unknown, never failed
      expect(f.store.get(finished.id)?.status).toBe("unknown");
      clock.at += 30_000;
      await f.runner.tick(); // the status fixture now says success
      expect(f.store.get(finished.id)?.status).toBe("completed");
    });

    it("completes a job that finished past the limit rather than timing it out", async () => {
      const clock = { at: 1_000_000 };
      const f = runnerFixture({}, { now: () => clock.at, runningTimeoutMs: 60_000 });
      const late = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH, { status: "running", comfyPromptId: "late", startedAt: clock.at - 120_000 });
      await f.runner.tick();
      expect(f.store.get(late.id)?.status).toBe("completed");
    });

    it("does not fail a finished job whose download keeps failing", async () => {
      const clock = { at: 1_000_000 };
      const f = runnerFixture({ viewDirect: true }, { now: () => clock.at, maxConsecutiveErrors: 2 });
      const row = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH, { status: "running", comfyPromptId: "done", startedAt: clock.at });
      const broken = runnerFixture({}, {
        store: f.store,
        now: () => clock.at,
        maxConsecutiveErrors: 2,
        client: createComfyClient({
          fetch: async (input, init) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (url.includes("/api/view")) return new Response("expired", { status: 403 });
            return makeFetch({}).impl(input, init);
          },
        }),
      });
      await broken.runner.tick();
      await broken.runner.tick();
      const after = f.store.get(row.id) as Asset;
      expect(after.status).toBe("unknown");
      expect(after.error).toMatch(/could not be fetched/);
    });

    it("still fails a job Comfy itself reports as failed", async () => {
      // The positive control: a failure Comfy reports still fails the row.
      const clock = { at: 1_000_000 };
      const options: FakeFetchOptions = { statusSequence: [fixture("status-executing.json")], status: fixture("status-error.json") };
      const f = runnerFixture(options, { now: () => clock.at, maxConsecutiveErrors: 2, unknownCheckMs: 1 });
      const row = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH);
      await f.runner.tick(); // submit
      await f.runner.tick(); // executing
      options.statusOffline = true;
      await f.runner.tick();
      await f.runner.tick();
      expect(f.store.get(row.id)?.status).toBe("unknown");
      options.statusOffline = false;
      clock.at += 1;
      await f.runner.tick();
      expect(f.store.get(row.id)?.status).toBe("failed");
      expect(f.store.get(row.id)?.error).toContain("is not available to this Comfy Cloud account");
    });
  });

  describe("a lost submit reply never sends the job again blindly", () => {
    // A submit whose answer is lost may still have started a paid job, so the
    // runner must not count it as one transient error and send the same graph
    // again on the next tick, each time a new billed job.
    function lostSubmit(fates: ("timeout" | "refused" | undefined)[]) {
      const clock = { at: Date.parse("2031-10-14T06:00:00Z") };
      const server = { jobs: [] as { id: string; prompt: unknown; createdAt: number }[], clock: () => clock.at + 1_500 };
      const options: FakeFetchOptions = { server, submitFate: fates, status: fixture("status-executing.json") };
      const f = runnerFixture(options, { now: () => clock.at, unknownCheckMs: 60_000 });
      const submits = () => f.calls.filter((call) => call.url.endsWith("/api/prompt")).length;
      return { ...f, clock, server, options, submits };
    }

    it("finds the job a lost reply started and follows it, with one paid submit", async () => {
      const f = lostSubmit(["timeout"]);
      const row = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH);
      await f.runner.tick(); // the submit reaches Comfy, the reply is lost
      expect(f.server.jobs).toHaveLength(1);
      const lost = f.store.get(row.id) as Asset;
      expect(lost.status).toBe("unknown");
      expect(lost.comfyPromptId).toBeNull();
      expect(lost.error).toMatch(/not sent again/);
      for (let i = 0; i < 5; i += 1) {
        f.clock.at += 60_000;
        await f.runner.tick();
      }
      const found = f.store.get(row.id) as Asset;
      expect(found.comfyPromptId).toBe("job-1");
      expect(found.status).toBe("running");
      expect(f.submits()).toBe(1);
      expect(f.server.jobs).toHaveLength(1);
    });

    it("does not claim another row's job, even with the same graph", async () => {
      const f = lostSubmit([undefined, "timeout"]);
      const first = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH);
      await f.runner.tick(); // the first is submitted and answered
      expect(f.store.get(first.id)?.comfyPromptId).toBe("job-1");
      const second = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH);
      await f.runner.tick(); // the second's reply is lost
      expect(f.store.get(second.id)?.status).toBe("unknown");
      await f.runner.tick();
      expect(f.store.get(second.id)?.comfyPromptId).toBe("job-2");
      expect(f.submits()).toBe(2);
    });

    it("keeps a row unknown, and never resends it, when its job is not in the list", async () => {
      const f = lostSubmit(["timeout"]);
      const row = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH);
      await f.runner.tick();
      f.server.jobs.length = 0; // the request never became a job after all
      for (let i = 0; i < 40; i += 1) {
        f.clock.at += 60_000;
        await f.runner.tick();
      }
      const after = f.store.get(row.id) as Asset;
      expect(after.status).toBe("unknown");
      expect(after.error).toMatch(/cannot be found/);
      expect(f.submits()).toBe(1);
    });

    it("fails a lost submit whose workflow file is gone, and says so once instead of blaming Comfy", async () => {
      // findLostJob reads the row's workflow file to compare graphs. A read
      // that fails is a local fault: the row fails at once with its own reason,
      // rather than searching on and ending in "Comfy has no such job", which
      // invites a paid retry.
      const f = lostSubmit(["timeout"]);
      const row = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH);
      await f.runner.tick(); // the reply is lost
      expect(f.store.get(row.id)?.status).toBe("unknown");
      fs.rmSync(row.workflowPath);
      f.logs.length = 0;
      for (let i = 0; i < 3; i += 1) {
        f.clock.at += 60_000;
        await f.runner.tick();
      }
      const after = f.store.get(row.id) as Asset;
      expect(after.status).toBe("failed");
      expect(after.error).toMatch(/^The workflow file could not be read/);
      expect(f.logs.filter((line) => line.includes(row.id) && /workflow file could not be read/.test(line))).toHaveLength(1);
      expect(f.submits()).toBe(1);
    });

    it("warns once per outage when Comfy Cloud cannot be asked about a lost submit", async () => {
      const f = lostSubmit(["timeout"]);
      const row = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH);
      await f.runner.tick();
      f.options.offline = true;
      f.logs.length = 0;
      for (let i = 0; i < 4; i += 1) {
        f.clock.at += 60_000;
        await f.runner.tick();
      }
      expect(f.store.get(row.id)?.status).toBe("unknown");
      expect(f.logs.filter((line) => line.includes(row.id) && line.includes("could not look for"))).toHaveLength(1);
      f.options.offline = false;
      f.clock.at += 60_000;
      await f.runner.tick();
      expect(f.store.get(row.id)?.comfyPromptId).toBe("job-1");
    });

    it("sends again when the first submit certainly never reached Comfy Cloud", async () => {
      // The positive control: a refused connection is safe to repeat.
      const f = lostSubmit(["refused"]);
      const row = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH);
      await f.runner.tick();
      expect(f.store.get(row.id)?.status).toBe("queued");
      expect(f.server.jobs).toHaveLength(0);
      await f.runner.tick();
      expect(f.store.get(row.id)?.status).toBe("running");
      expect(f.submits()).toBe(2);
      expect(f.server.jobs).toHaveLength(1);
    });

    it("lets Retry take a lost submit's job back, and refuses to resend while it may still turn up", async () => {
      const f = lostSubmit(["timeout"]);
      const row = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH);
      await f.runner.tick();
      const recovered = await f.runner.recover(f.store.get(row.id) as Asset);
      expect(recovered?.id).toBe(row.id);
      expect(recovered?.comfyPromptId).toBe("job-1");
      expect(recovered?.status).toBe("running");

      const g = lostSubmit(["timeout"]);
      const other = queueRow(g.store, g.assetDir, "image", IMAGE_GRAPH);
      await g.runner.tick();
      g.server.jobs.length = 0;
      await expect(g.runner.recover(g.store.get(other.id) as Asset)).rejects.toThrow(/nothing was sent/);
      expect(g.submits()).toBe(1);
    });
  });

  it("submits at most 4 rows at a time", async () => {
    const { runner, store, assetDir } = runnerFixture({ status: fixture("status-executing.json") });
    for (let i = 0; i < 6; i += 1) queueRow(store, assetDir, "image", IMAGE_GRAPH);
    await runner.tick();
    expect(store.byStatus("running").length).toBe(4);
    expect(store.byStatus("queued").length).toBe(2);
  });
});

// ---------- cost ----------

describe("estimateCredits", () => {
  it("prices every image shape the legacy table covers", () => {
    // Comfy's published figures for these shapes.
    expect(estimateCredits("image", "seedream 5.0 pro", { sizePreset: "(1K) 1024x1024 (1:1)" })).toEqual({ credits: 9.5, confidence: "published" });
    expect(estimateCredits("image", "seedream 5.0 pro", { sizePreset: "(1K) 1312x736 (16:9)" })).toEqual({ credits: 9.5, confidence: "published" });
    expect(estimateCredits("image", "seedream 5.0 pro", { sizePreset: "(1K) 1568x672 (21:9)" })).toEqual({ credits: 9.5, confidence: "published" });
    expect(estimateCredits("image", "seedream 5.0 pro", { sizePreset: "(2K) 2048x2048 (1:1)" })).toEqual({ credits: 18.99, confidence: "published" });
    expect(estimateCredits("image", "seedream 5.0 lite", { sizePreset: "(2K) 2048x2048 (1:1)" })).toEqual({ credits: 7.39, confidence: "published" });
    // Flat models cost the same at 4K as at 2K.
    expect(estimateCredits("image", "seedream 5.0 lite", { sizePreset: "(4K) 4096x4096 (1:1)" })).toEqual({ credits: 7.39, confidence: "published" });
    expect(estimateCredits("image", "seedream-4-5-251128", { sizePreset: "(4K) 4096x4096 (1:1)" })).toEqual({ credits: 8.44, confidence: "published" });
    expect(estimateCredits("image", "seedream-4-0-250828", { sizePreset: "(1K) 1024x1024 (1:1)" })).toEqual({ credits: 6.33, confidence: "published" });
  });

  it("multiplies by count and returns null for a shape it has no price for", () => {
    expect(estimateCredits("image", "seedream 5.0 pro", { sizePreset: "(1K) 1024x1024 (1:1)", count: 3 }).credits).toBe(28.5);
    expect(estimateCredits("image", "made-up-model", { sizePreset: "(1K) 1024x1024 (1:1)" })).toEqual({ credits: null, confidence: "unknown" });
    expect(estimateCredits("image", "seedream 5.0 pro", {})).toEqual({ credits: null, confidence: "unknown" });
    expect(estimateCredits("video", "made-up-model", { resolution: "480p", duration: 5 })).toEqual({ credits: null, confidence: "unknown" });
    // A resolution the model does not offer has no price, whatever the formula says.
    expect(estimateCredits("video", "Seedance 2.0 Fast", { resolution: "1080p", duration: 5 })).toEqual({ credits: null, confidence: "unknown" });
    expect(estimateCredits("video", "Seedance 2.5", { resolution: "4k", duration: 5 })).toEqual({ credits: null, confidence: "unknown" });
  });

  it("bills video by the token formula", () => {
    // A 5 s 480p clip is 49005 tokens = 121 x 864 x 480 / 1024.
    expect(videoTokens("480p", 5)).toBe(49005);
    expect(estimateCredits("video", "seedance-1-0-pro-fast-251015", { resolution: "480p", duration: 4 })).toEqual({ credits: 8.29, confidence: "inferred" });
    expect(estimateCredits("video", "Seedance 2.0 Fast", { resolution: "480p", duration: 4 })).toEqual({ credits: 66.38, confidence: "inferred" });
    // Same model, another length: the formula again, marked inferred.
    const longer = estimateCredits("video", "seedance-1-0-pro-fast-251015", { resolution: "480p", duration: 5 });
    expect(longer.confidence).toBe("inferred");
    expect(longer.credits).toBeCloseTo(10.34, 2);
    // A per resolution rate: 6 s and 12 s of 1080p at Seedance 2.0's 1080p rate.
    expect(estimateCredits("video", "Seedance 2.0", { resolution: "1080p", duration: 6 }).credits).toBeCloseTo(682.19, 2);
    expect(estimateCredits("video", "Seedance 2.0", { resolution: "1080p", duration: 12 }).credits).toBeCloseTo(1359.67, 2);
    // Audio doubles Seedance 1.5 Pro and nothing else.
    const silent = estimateCredits("video", "seedance-1-5-pro-251215", { resolution: "480p", duration: 5 }).credits as number;
    const loud = estimateCredits("video", "seedance-1-5-pro-251215", { resolution: "480p", duration: 5, generateAudio: true }).credits as number;
    expect(loud).toBeCloseTo(silent * 2, 2);
  });

  it("prefers what this account was actually billed once it has two samples", () => {
    const samples = new Map<string, { credits: number; samples: number }>();
    const observed = (signature: string) => samples.get(signature) ?? null;
    const shape = { sizePreset: "(1K) 1024x1024 (1:1)" };
    const signature = costSignature("image", "seedream 5.0 pro", shape);
    expect(signature).toBe("image|seedream 5.0 pro|1K");

    // One sample is not enough: the table still wins.
    samples.set(signature, { credits: 12, samples: 1 });
    expect(estimateCredits("image", "seedream 5.0 pro", shape, observed)).toEqual({ credits: 9.5, confidence: "published" });
    // Two samples of the same shape take over, and a count still multiplies.
    samples.set(signature, { credits: 12, samples: 2 });
    expect(estimateCredits("image", "seedream 5.0 pro", shape, observed)).toEqual({ credits: 12, confidence: "measured" });
    expect(estimateCredits("image", "seedream 5.0 pro", { ...shape, count: 2 }, observed).credits).toBe(24);
    // A model with no table entry is promoted from unknown to measured.
    const oddSignature = costSignature("image", "made-up-model", shape);
    expect(estimateCredits("image", "made-up-model", shape, observed)).toEqual({ credits: null, confidence: "unknown" });
    samples.set(oddSignature, { credits: 3.5, samples: 4 });
    expect(estimateCredits("image", "made-up-model", shape, observed)).toEqual({ credits: 3.5, confidence: "measured" });
  });

  it("keys images by tier and videos by resolution and length", () => {
    expect(imageTier("(2K) 2304x1728 (4:3)")).toBe("2K");
    expect(imageTier("4096x4096")).toBe("4K");
    expect(imageTier("")).toBeNull();
    expect(costSignature("video", "Seedance 2.0", { resolution: "1080p", duration: 6 })).toBe("video|Seedance 2.0|1080p|6s");
    // No duration falls back to the model's own default, not to a made up one.
    expect(costSignature("video", "Seedance 2.0", { resolution: "480p" })).toBe("video|Seedance 2.0|480p|5s");
    expect(estimateParamsOf({ params: { sizePreset: "(1K) 1024x1024 (1:1)", seed: 7 } })).toEqual({
      sizePreset: "(1K) 1024x1024 (1:1)",
      resolution: null,
      duration: null,
      generateAudio: null,
      width: null,
      height: null,
      count: null,
      quality: null,
      // Only a second reference costs anything, so the shape carries the count
      // and `costSignature` ignores it below two.
      references: null,
      draft: null,
      durationAuto: null,
    });
    // A row built by run_workflow keeps the graph's own input names, so its
    // only size is `model.size` and its dimensions are on the row rather than
    // in the params. Read neither and the shape is unknown and the row prices
    // at the model's floor instead of its own shape's figure. These params have
    // the shape such a row stores.
    const rawWorkflowRow = {
      kind: "image" as const,
      width: 1024,
      height: 1024,
      params: { "model.size": "1024x1024", "model.custom_width": 1024, "model.quality": "low", n: 1, seed: 4242 },
    };
    expect(estimateParamsOf(rawWorkflowRow)).toMatchObject({ sizePreset: "1024x1024", width: 1024, height: 1024, quality: "low" });
    // And the row's own dimensions are a fallback, never an override: a queued
    // row has no file yet, and what the request asked for is what the form
    // quoted, so a params size wins wherever there is one.
    expect(estimateParamsOf({ ...rawWorkflowRow, params: { width: 512, height: 512 } })).toMatchObject({ width: 512, height: 512 });

    // A quality tier is part of the shape at any size: GPT Image charges ten
    // times more for "high" than for "low" at the same 1024x1024.
    expect(costSignature("image", "gpt-image-2", { sizePreset: "1024x1024", quality: "low" })).toBe("image|gpt-image-2|1K|low");
    expect(costSignature("image", "gpt-image-2", { sizePreset: "1024x1024", quality: "high" })).toBe("image|gpt-image-2|1K|high");
    // A model with no preset list is keyed by the pixels it was asked for, so
    // two sizes of the same model do not teach each other the wrong price.
    expect(costSignature("image", "qwen-image-3.0", { width: 1024, height: 1024 })).toBe("image|qwen-image-3.0|1024x1024");
    expect(costSignature("image", "qwen-image-3.0", { width: 1792, height: 1536 })).toBe("image|qwen-image-3.0|1792x1536");
  });

  it("learns a resolution-only or aspect-only model's bill under the shape the next request asks for", () => {
    // FLUX.3 and Luma uni-1 have no preset list. Keying each bill by the file's
    // pixels, because the row has a width and height, would never meet the next
    // estimate, which asks for "1K" or, for uni-1, carries no size at all. These
    // params have the shape such rows store.
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const store = createStore(db);
    const learn = (id: string, model: string, params: Asset["params"], width: number, height: number, credits: number) => {
      const asset = { kind: "image" as const, model, params, width, height };
      store.addCostSample({ signature: assetCostSignature(asset), kind: "image", model: priceKeyOf(model), credits, assetId: id });
    };
    const flux = getModel("Flux3ImageNode")!;
    const fluxParams = { resolution: "1K", aspectRatio: "1:1", referenceCount: 2, seed: 1 };
    learn("img_flux_a", flux.key, fluxParams, 1024, 1024, 7.5);
    learn("img_flux_b", flux.key, { ...fluxParams, seed: 2 }, 1024, 1024, 7.5);
    const fluxNext = estimateParamsOf({ kind: "image", params: { ...fluxParams, seed: 3 } });
    expect(estimateCredits("image", priceKeyOf(flux.key), fluxNext, (sig) => store.observedCredits(sig), priceForEstimate(flux))).toEqual({ credits: 7.5, confidence: "measured" });

    const uni = getModel("LumaImageNode2/uni-1")!;
    const uniParams = { aspectRatio: "1:1", referenceCount: 2, seed: 1 };
    learn("img_uni_a", uni.key, uniParams, 2048, 2048, 9.6);
    learn("img_uni_b", uni.key, { ...uniParams, seed: 2 }, 2048, 2048, 9.6);
    const uniNext = estimateParamsOf({ kind: "image", params: { ...uniParams, seed: 3 } });
    expect(estimateCredits("image", priceKeyOf(uni.key), uniNext, (sig) => store.observedCredits(sig), priceForEstimate(uni))).toEqual({ credits: 9.6, confidence: "measured" });

    // A model with free pixels still learns by the pixels it was asked for.
    expect(assetCostSignature({ kind: "image", model: "qwen-image-3.0", params: { width: 1792, height: 1536 }, width: 1792, height: 1536 })).toBe("image|qwen-image-3.0|1792x1536");
  });

  it("converts to dollars only when a rate is set", () => {
    expect(usdForCredits(9.5, 1 / CREDITS_PER_USD)).toBeCloseTo(0.045, 4);
    expect(usdForCredits(9.5, null)).toBeNull();
    expect(usdForCredits(null, 1 / CREDITS_PER_USD)).toBeNull();
    expect(usdForCredits(9.5, 0)).toBeNull();
    expect(creditsPerSecond("seedance-1-0-pro-fast-251015")).toBeCloseTo(2.05, 2);
    expect(creditsPerSecond("made-up-model")).toBeNull();
    expect(costNote("image", "seedream 5.0 pro")).toContain("9.50 credits");
    expect(costNote("video", "made-up-model")).toContain("No published price");
  });
});

describe("billing payloads", () => {
  it("keeps only the five fields it needs and never the prompt or the key", () => {
    const page = parseBillingPage(fixture("billing-events.json"), KEY);
    expect(page.page).toBe(2);
    expect(page.totalPages).toBe(4);
    expect(page.events).toHaveLength(3);
    expect(page.events[0]).toEqual({
      jobId: "cccccccc-cccc-4ccc-8ccc-cccccccccaaa",
      credits: 3.1,
      model: "gpt-image-2",
      outputTier: "medium",
      createdAt: Date.parse("2031-11-04T13:30:00.000000Z"),
    });
    // No prompt, no endpoint, no key anywhere in what we keep.
    const text = JSON.stringify(page);
    expect(text).not.toContain("prompt");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("api_key");
  });

  it("ignores rows that carry no charge, such as GPU time", () => {
    const page = parseBillingPage(fixture("billing-events.json"));
    // The GPU row has a job_id but no credits, so a lookup for it finds nothing.
    expect(findBillingEvent(page.events, "cccccccc-cccc-4ccc-8ccc-cccccccccbbb")).toBeNull();
    expect(findBillingEvent(page.events, "cccccccc-cccc-4ccc-8ccc-cccccccccddd")?.credits).toBe(18.4);
    expect(page.events[2]?.outputTier).toBeNull();
    expect(findBillingEvent(page.events, "not-a-job")).toBeNull();
    expect(parseBillingPage(null).events).toEqual([]);
    expect(parseBillingPage({ events: "nope" }).events).toEqual([]);
  });

  it("reads the balance as US cents, not as the field name claims", async () => {
    const { impl, calls } = makeFetch({});
    const client = createComfyClient({ fetch: impl });
    const balance = await client.billingBalance(KEY);
    // 1234.5 cents is $12.345, which is 2604.8 credits at 211 to the dollar.
    // What this pins is the unit.
    expect(balance.usd).toBeCloseTo(12.345, 3);
    expect(balance.credits).toBeCloseTo(2604.8, 1);
    expect(calls.some((call) => call.url.includes("/api/billing/balance"))).toBe(true);
  });
});

describe("cost samples in the store", () => {
  function freshStore() {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    return createStore(db);
  }

  it("takes the median of the most recent samples and counts them", () => {
    const store = freshStore();
    expect(store.observedCredits("image|m|1K")).toBeNull();
    const add = (credits: number, assetId: string) => store.addCostSample({ signature: "image|m|1K", kind: "image", model: "m", credits, assetId });
    add(10, "a1");
    expect(store.observedCredits("image|m|1K")).toEqual({ credits: 10, samples: 1 });
    add(20, "a2");
    expect(store.observedCredits("image|m|1K")).toEqual({ credits: 15, samples: 2 });
    add(12, "a3");
    expect(store.observedCredits("image|m|1K")).toEqual({ credits: 12, samples: 3 });
    // Nonsense is not a sample.
    add(0, "a4");
    add(Number.NaN, "a5");
    expect(store.observedCredits("image|m|1K")?.samples).toBe(3);
    // The same asset cannot be counted twice, so a backfill is safe to repeat.
    add(999, "a1");
    expect(store.observedCredits("image|m|1K")).toEqual({ credits: 12, samples: 3 });
    expect(store.observedShapes()).toEqual([{ signature: "image|m|1K", kind: "image", model: "m", credits: 12, samples: 3 }]);
  });

  it("re-keys the samples it has already learned when the shape rule moves", () => {
    const store = freshStore();
    const asset: Asset = {
      id: "img_aaaaaaaa",
      kind: "image",
      status: "completed",
      prompt: "p",
      model: "LumaImageNode/photon-flash-1",
      params: { aspectRatio: "1:1", seed: 3 },
      file: null,
      path: null,
      workflowPath: "/tmp/none.json",
      mime: null,
      width: null,
      height: null,
      durationS: null,
      sizeBytes: null,
      comfyPromptId: "p1",
      parentId: null,
      threadId: null,
      source: "panel",
      starred: false,
      error: null,
      estimatedCredits: 0.6,
      actualCredits: 0.5,
      billedModel: "photon-flash-1",
      outputTier: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: Date.now(),
    };
    store.insert(asset);
    store.addCostSample({ signature: "image|LumaImageNode/photon-flash-1|unknown", kind: "image", model: "LumaImageNode/photon-flash-1", credits: 0.5, assetId: asset.id });
    expect(store.observedCredits("image|photon-flash-1|unknown")).toBeNull();

    const moved = store.resignCostSamples((row) => ({ signature: assetCostSignature(row), model: priceKeyOf(row.model) }));
    expect(moved).toBe(1);
    expect(store.observedCredits("image|photon-flash-1|unknown")).toEqual({ credits: 0.5, samples: 1 });
    expect(store.observedShapes()[0]?.model).toBe("photon-flash-1");
    // Idempotent: running it again at the next load moves nothing.
    expect(store.resignCostSamples((row) => ({ signature: assetCostSignature(row), model: priceKeyOf(row.model) }))).toBe(0);
    // A sample with no asset row left is not touched, because nothing can say
    // what shape it was.
    store.addCostSample({ signature: "image|orphan|1K", kind: "image", model: "orphan", credits: 1, assetId: "img_zzzzzzzz" });
    expect(store.resignCostSamples(() => ({ signature: "moved", model: "moved" }))).toBe(1);
    expect(store.observedCredits("image|orphan|1K")).toEqual({ credits: 1, samples: 1 });

    // A FLUX.3 bill learned under the file's pixels moves to the tier the next
    // request asks for, and nothing is deleted on the way.
    const before = store.observedShapes().reduce((sum, row) => sum + row.samples, 0);
    store.insert({ ...asset, id: "img_fluxaaaa", model: "Flux3ImageNode", params: { resolution: "1K", referenceCount: 2 }, width: 1024, height: 1024 });
    store.addCostSample({ signature: "image|Flux3ImageNode|1024x1024|2ref", kind: "image", model: "Flux3ImageNode", credits: 7.5, assetId: "img_fluxaaaa" });
    expect(store.resignCostSamples((row) => ({ signature: assetCostSignature(row), model: priceKeyOf(row.model) }))).toBeGreaterThan(0);
    expect(store.observedCredits("image|Flux3ImageNode|1K|2ref")).toEqual({ credits: 7.5, samples: 1 });
    expect(store.observedCredits("image|Flux3ImageNode|1024x1024|2ref")).toBeNull();
    expect(store.observedShapes().reduce((sum, row) => sum + row.samples, 0)).toBe(before + 1);
  });
});

describe("the runner and the bill", () => {
  /** The charge for the job the submit fixture returns. */
  function billingFor(promptId: string, credits = 9.5): unknown {
    return {
      events: [
        {
          createdAt: "2031-03-12T05:30:30.000000Z",
          event_type: "api_usage_completed",
          params: { job_id: promptId, credits_used: credits, model: "seedream-5-0-pro-260628", output_tier: "standard" },
        },
      ],
      page: 1,
      totalPages: 1,
    };
  }

  /** A runner on a clock the test moves, so a backoff can be waited out in no time. */
  function billingFixture(fetchOptions: FakeFetchOptions) {
    const clock = { at: Date.now() };
    const f = runnerFixture(fetchOptions, { now: () => clock.at });
    return { ...f, clock, advance: (ms: number) => (clock.at += ms) };
  }

  async function runToCompletion(f: ReturnType<typeof billingFixture>): Promise<Asset> {
    const row = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH, {
      model: "seedream 5.0 pro",
      params: { sizePreset: "(1K) 1024x1024 (1:1)", seed: 7 },
      estimatedCredits: 9.5,
    });
    await f.runner.tick(); // submit
    await f.runner.tick(); // success, download, complete
    expect(f.store.get(row.id)?.status).toBe("completed");
    return row;
  }

  it("joins a completed asset to its billing event by job_id and remembers the price", async () => {
    const f = billingFixture({ billingPages: [billingFor(SUBMITTED_JOB_ID)] });
    const row = await runToCompletion(f);
    expect(f.runner.pendingBilling()).toBe(1);
    await f.runner.tick(); // the charge settles
    const asset = f.store.get(row.id) as Asset;
    expect(asset.actualCredits).toBe(9.5);
    expect(asset.billedModel).toBe("seedream-5-0-pro-260628");
    expect(asset.outputTier).toBe("standard");
    expect(asset.status).toBe("completed");
    expect(f.runner.pendingBilling()).toBe(0);
    expect(f.store.observedCredits("image|seedream 5.0 pro|1K")).toEqual({ credits: 9.5, samples: 1 });
  });

  it("retries while the charge has not settled", async () => {
    let settled = false;
    const options: FakeFetchOptions = {};
    Object.defineProperty(options, "billingPages", { get: () => [settled ? billingFor(SUBMITTED_JOB_ID) : { events: [], page: 1, totalPages: 1 }] });
    const f = billingFixture(options);
    const row = await runToCompletion(f);
    await f.runner.tick();
    expect(f.store.get(row.id)?.actualCredits).toBeNull();
    expect(f.runner.pendingBilling()).toBe(1);
    settled = true;
    f.advance(3_000); // wait the first backoff out
    await f.runner.tick();
    expect(f.store.get(row.id)?.actualCredits).toBe(9.5);
    expect(f.runner.pendingBilling()).toBe(0);
  });

  it("never fails a completed generation because billing was slow or broken", async () => {
    const f = billingFixture({ billingHttp: 500 });
    const row = await runToCompletion(f);
    for (let i = 0; i < BILLING_TRIES + 2; i += 1) {
      await f.runner.tick();
      f.advance(60_000);
    }
    const asset = f.store.get(row.id) as Asset;
    expect(asset.status).toBe("completed");
    expect(asset.error).toBeNull();
    expect(asset.actualCredits).toBeNull();
    expect(asset.path).not.toBeNull();
    // Still waiting for billing to come back, and said so once, not per try.
    expect(f.runner.pendingBilling()).toBe(1);
    expect(f.logs.filter((line) => line.includes("billing lookup failed")).length).toBe(1);
    expect(f.logs.join("\n")).not.toContain(KEY);
  });

  it("records a charge missed during a billing outage once billing answers again", async () => {
    // A failed lookup is the endpoint's outage, not the row's, so it costs no
    // try and the charge is recorded once billing answers again.
    const options: FakeFetchOptions = { billingHttp: 503, billingPages: [billingFor(SUBMITTED_JOB_ID)] };
    const f = billingFixture(options);
    const row = await runToCompletion(f);
    for (let i = 0; i < BILLING_TRIES * 3; i += 1) {
      await f.runner.tick();
      f.advance(60_000);
    }
    expect(f.store.get(row.id)?.actualCredits).toBeNull();
    expect(f.runner.awaitingBill(row.id)).toBe(true);
    options.billingHttp = undefined;
    await f.runner.tick();
    expect(f.store.get(row.id)?.actualCredits).toBe(9.5);
    expect(f.runner.pendingBilling()).toBe(0);
    expect(f.logs.some((line) => line.includes("billing lookups work again"))).toBe(true);
  });

  it("still gives up on a charge that never appears while billing works", async () => {
    // The positive control for the test above: a job whose billing event
    // never appears must not be looked up for ever.
    const f = billingFixture({ billingPages: [{ events: [], page: 1, totalPages: 1 }] });
    const row = await runToCompletion(f);
    for (let i = 0; i < BILLING_TRIES + 2; i += 1) {
      await f.runner.tick();
      f.advance(60_000);
    }
    expect(f.store.get(row.id)?.actualCredits).toBeNull();
    expect(f.runner.pendingBilling()).toBe(0);
    expect(f.logs.some((line) => line.includes(`${row.id}: no billing event after ${BILLING_TRIES} tries`))).toBe(true);
  });

  it("hands the rows a failed cost backfill did not reach to the billing queue", async () => {
    const options: FakeFetchOptions = { billingHttp: 503, billingPages: [billingFor("older-job-id", 18.99)] };
    const f = billingFixture(options);
    const row = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH, {
      status: "completed",
      model: "seedream 5.0 pro",
      params: { sizePreset: "(2K) 2048x2048 (1:1)", seed: 7 },
      comfyPromptId: "older-job-id",
      completedAt: Date.now(),
    });
    expect(await f.runner.backfillCosts(50)).toBe(0);
    expect(f.runner.awaitingBill(row.id)).toBe(true);
    options.billingHttp = undefined;
    f.advance(60_000);
    await f.runner.tick();
    expect(f.store.get(row.id)?.actualCredits).toBe(18.99);
  });

  it("backfills assets that completed before the cost columns existed", async () => {
    // The GPU time row carries the same job_id and no charge; it must not
    // settle the asset and hide the real one behind it.
    const page = billingFor("older-job-id", 18.99) as { events: unknown[] };
    page.events.unshift({ createdAt: "2031-03-12T05:00:00Z", event_type: "cloud_workflow_executed", params: { job_id: "older-job-id", gpu_seconds: 20 } });
    const f = billingFixture({ billingPages: [page] });
    const row = queueRow(f.store, f.assetDir, "image", IMAGE_GRAPH, {
      status: "completed",
      model: "seedream 5.0 pro",
      params: { sizePreset: "(2K) 2048x2048 (1:1)", seed: 7 },
      comfyPromptId: "older-job-id",
      completedAt: Date.now(),
    });
    expect(f.store.needsCost(50).map((a) => a.id)).toEqual([row.id]);
    expect(await f.runner.backfillCosts(50)).toBe(1);
    expect(f.store.get(row.id)?.actualCredits).toBe(18.99);
    expect(f.store.observedCredits("image|seedream 5.0 pro|2K")).toEqual({ credits: 18.99, samples: 1 });
    // Running it again is a no-op: the row no longer needs a cost.
    expect(f.store.needsCost(50)).toEqual([]);
    expect(await f.runner.backfillCosts(50)).toBe(0);
  });

  it("leaves a cancelled row alone even when its charge turns up", async () => {
    const f = billingFixture({ billingPages: [billingFor(SUBMITTED_JOB_ID)] });
    const row = await runToCompletion(f);
    f.store.update(row.id, { status: "cancelled" });
    await f.runner.tick();
    const asset = f.store.get(row.id) as Asset;
    expect(asset.status).toBe("cancelled");
    expect(asset.actualCredits).toBeNull();
    expect(f.runner.pendingBilling()).toBe(0);
  });
});

// ---------- the plugin on the fake host ----------

interface Loaded {
  host: FakePluginHost;
  assetDir: string;
  dataDir: string;
  calls: FetchCall[];
  /** Every rootPath the plugin asked the host to publish, in call order. */
  previewRoots: string[];
  startService: () => void;
}

async function loadPlugin(
  options: { key?: string | null; fetch?: FakeFetchOptions; keyFile?: string; pluginDirs?: string[]; creditRate?: string; imageModel?: string; videoModel?: string } = {},
): Promise<Loaded> {
  const assetDir = tmpDir("plugin-assets");
  const dataDir = tmpDir("plugin-data");
  const { impl, calls } = makeFetch(options.fetch ?? {});
  const previewRoots: string[] = [];
  const host = createFakePluginHost({
    pluginId: "comfy-cloud",
    dataDir,
    settings: {
      ...(options.key === null ? {} : { apiKey: options.key ?? KEY }),
      assetDir,
      keyFile: options.keyFile ?? "",
      ...(options.creditRate === undefined ? {} : { creditRate: options.creditRate }),
      ...(options.imageModel === undefined ? {} : { imageModel: options.imageModel }),
      ...(options.videoModel === undefined ? {} : { videoModel: options.videoModel }),
    },
    sdk: {
      files: {
        createPreview: async ({ rootPath }: { rootPath: string }) => {
          previewRoots.push(rootPath);
          return { baseUrl: "http://127.0.0.1:1/preview/abc", expiresAtMs: Date.now() + 3_600_000 };
        },
      },
    },
  });
  const entry: { host: FakePluginHost; controller?: AbortController } = { host };
  hosts.push(entry);
  await createPlugin({
    tickMs: 20,
    fetch: impl,
    pluginDirs: options.pluginDirs ?? [tmpDir("plugin-dir")],
    dataDir,
    probeVideo: async () => ({ width: 864, height: 480, durationS: 3 }),
  })(host.bb);
  return {
    host,
    assetDir,
    dataDir,
    calls,
    previewRoots,
    startService: () => {
      const svc = host.harness.behavior.runService("jobs");
      entry.controller = svc.controller;
      svc.done.catch(() => undefined);
    },
  };
}

async function rpc<T>(host: FakePluginHost, method: string, input: unknown): Promise<T> {
  return (await host.harness.behavior.callRpc(method, input)) as T;
}

describe("plugin on the fake host", () => {
  it("serves the model registry, keeps the current default in it, and remembers favourites", async () => {
    const { host } = await loadPlugin();
    const all = await rpc<ModelsResult>(host, "models", null);
    expect(all.models.length).toBeGreaterThan(80);
    expect(all.counts.supported).toBeGreaterThan(80);
    expect(all.defaults.image).toBe("ByteDanceSeedreamNodeV3/seedream 5.0 pro");
    expect(all.creditRate).toBeCloseTo(1 / 211, 6);
    // The shipped default is the live V3 node, not the deprecated V2 one the
    // legacy id still resolves to, so the default is a visible row and the
    // ByteDance section lists "Seedream 5.0 Pro" once.
    const current = all.models.find((m) => m.key === all.defaults.image);
    expect(current?.hidden).toBe(false);
    expect(current?.label).toBe("Seedream 5.0 Pro");
    expect(current?.capabilities.sizePresets.length).toBeGreaterThan(5);
    // And no two visible rows of one kind share a label.
    const imageLabels = all.models.filter((m) => m.kind === "image").map((m) => m.label);
    expect(new Set(imageLabels).size).toBe(imageLabels.length);
    // A hidden default is still put back when there is one, which is what keeps
    // an install whose setting names the legacy id able to see its own model.
    const kept = await rpc<ModelsResult>(host, "models", { kind: "video" });
    expect(kept.models.some((m) => m.key === kept.defaults.video)).toBe(true);

    const images = await rpc<ModelsResult>(host, "models", { kind: "image" });
    expect(images.models.every((m) => m.kind === "image")).toBe(true);
    expect(images.models.some((m) => m.vendor === "Google")).toBe(true);
    for (const model of images.models) {
      expect(model.priceLine).not.toBe("");
      expect(model.capabilityLine).not.toBe("");
    }

    // Every name an asset row can carry has a friendly label, so the Library,
    // the Viewer and the Jobs rows do not print a raw key.
    const { labels } = await rpc<{ labels: Record<string, string> }>(host, "model_labels", null);
    expect(labels["ByteDanceSeedreamNodeV2/seedream 5.0 pro"]).toBe("Seedream 5.0 Pro");
    expect(labels["seedream 5.0 pro"]).toBe("Seedream 5.0 Pro");
    expect(labels["LumaImageNode/photon-flash-1"]).toBe("Photon Flash 1");
    expect(labels["photon-flash-1"]).toBe("Photon Flash 1");
    // A bare id several nodes offer is named by the model, not by whichever
    // node the catalog lists first: "Seedance 2.0" is not the first-and-last-
    // frame node, and the node marker never reaches an asset row.
    expect(labels["Seedance 2.0 Fast"]).toBe("Seedance 2.0 Fast");
    expect(labels["seedance-1-0-pro-fast-251015"]).toBe("Seedance 1.0 Pro Fast");
    // The node marker never reaches an asset row for a model the picker offers.
    for (const model of all.models) expect(labels[model.key], model.key).not.toMatch(/\((legacy|superseded) node\)/i);
    expect(Object.keys(labels).length).toBeGreaterThan(150);
    for (const model of all.models) expect(labels[model.key], model.key).toBeTruthy();

    // Nothing the picker is handed can fail in the builder, and nothing
    // unsupported reaches it. This is the same walk test/models.test.ts does,
    // through the RPC the panel actually calls.
    for (const model of images.models) {
      expect(model.supported, model.key).toBe(true);
      const graph = buildWorkflow(resolveImageSpec({ prompt: "a quiet harbour at dawn", model: model.key }, model.key));
      expect(Object.keys(graph), model.key).toEqual(["1", "2"]);
      expect(graph["1"]?.class_type, model.key).toBe(model.node);
    }
    // The learned prices come with the list, so the form quotes what the server
    // will store. A fresh store has none.
    expect(Array.isArray(images.observed)).toBe(true);

    const empty = await rpc<ModelPrefs>(host, "model_prefs", null);
    expect(empty).toEqual({ favourites: [], recent: [], chosen: { image: null, video: null } });
    const saved = await rpc<ModelPrefs>(host, "model_prefs", {
      favourites: ["IdeogramV3", "Krea2ImageNode/Krea 2 Large", "IdeogramV3"],
    });
    expect(saved.favourites).toEqual(["IdeogramV3", "Krea2ImageNode/Krea 2 Large"]);
    expect((await rpc<ModelPrefs>(host, "model_prefs", null)).favourites).toEqual(["IdeogramV3", "Krea2ImageNode/Krea 2 Large"]);

    // Both lists self-heal. A key the registry no longer offers is written out
    // of the stored list rather than dropped at draw time: a "Recent" heading
    // over fewer rows than the user remembers using is a bug with no visible
    // cause. A hidden entry is not gone, so it stays and the picker shows it.
    const healed = await rpc<ModelPrefs>(host, "model_prefs", {
      recent: ["OpenAIDalle3", "ByteDanceSeedreamNodeV2/seedream 5.0 pro", "a-model-comfy-retired", "IdeogramV3"],
    });
    expect(healed.recent, "the unsupported and the unknown key are gone, the hidden one stays").toEqual([
      "ByteDanceSeedreamNodeV2/seedream 5.0 pro",
      "IdeogramV3",
    ]);
    expect((await rpc<ModelPrefs>(host, "model_prefs", null)).recent).toEqual(["ByteDanceSeedreamNodeV2/seedream 5.0 pro", "IdeogramV3"]);
    // And the hidden one is in the list the picker draws from, or the Recent
    // section would still be a row short.
    const withRecent = await rpc<ModelsResult>(host, "models", { kind: "image" });
    expect(withRecent.models.some((model) => model.key === "ByteDanceSeedreamNodeV2/seedream 5.0 pro")).toBe(true);
    expect(withRecent.models.find((model) => model.key === "ByteDanceSeedreamNodeV2/seedream 5.0 pro")?.hidden).toBe(true);
    // The Generate tab is a fixed tab and is unmounted on every switch to Jobs,
    // so the model it is on lives here rather than in React state.
    const chose = await rpc<ModelPrefs>(host, "model_prefs", { chosen: { image: "Krea2ImageNode/Krea 2 Large" } });
    expect(chose.chosen?.image).toBe("Krea2ImageNode/Krea 2 Large");
    expect((await rpc<ModelPrefs>(host, "model_prefs", null)).chosen?.image).toBe("Krea2ImageNode/Krea 2 Large");
    // A key the registry does not offer is not stored, so a retired model can
    // never strand the tab on a row that is not there.
    const junk = await rpc<ModelPrefs>(host, "model_prefs", { chosen: { image: "a-model-comfy-retired" } });
    expect(junk.chosen?.image).toBe("Krea2ImageNode/Krea 2 Large");
  });

  it("keeps a saved setting working, whichever generation of id it holds", async () => {
    // The setting is a select, so the host only stores one of the strings
    // `settingOptions` offers: the shipped legacy id and every registry
    // key. Anything else, a hand
    // edited file or a model Comfy has retired, falls back to the shipped
    // default rather than failing every generation.
    expect(settingOptions("image")[0]).toBe("ByteDanceSeedreamNodeV3/seedream 5.0 pro");
    expect(settingOptions("image")).toContain("seedream 5.0 pro");
    expect(settingOptions("image")).toContain("LumaImageNode/photon-flash-1");
    expect(settingOptions("video")[0]).toBe("seedance-1-0-pro-fast-251015");
    // Every id the plugin ever shipped stays a legal setting, or the host
    // rejects a saved choice and the user quietly loses it.
    for (const id of [...IMAGE_MODELS, ...VIDEO_MODELS]) {
      expect(settingOptions(id.startsWith("seedream") ? "image" : "video"), id).toContain(id);
    }
    for (const [setting, expected] of [
      ["seedream 5.0 pro", "seedream 5.0 pro"],
      ["ByteDanceSeedreamNodeV3/seedream 5.0 pro", "ByteDanceSeedreamNodeV3/seedream 5.0 pro"],
      ["LumaImageNode/photon-flash-1", "LumaImageNode/photon-flash-1"],
      ["a-model-comfy-retired", "ByteDanceSeedreamNodeV3/seedream 5.0 pro"],
    ] as const) {
      const { host } = await loadPlugin({ imageModel: setting });
      const status = await rpc<Status>(host, "status", null);
      expect(status.imageModel, setting).toBe(expected);
      // Whatever it resolves to, the picker can show the model the user is on.
      const models = await rpc<ModelsResult>(host, "models", { kind: "image" });
      expect(models.models.some((model) => model.key === models.defaults.image), setting).toBe(true);
    }
    const video = await loadPlugin({ videoModel: "Seedance 2.0 Fast" });
    expect((await rpc<Status>(video.host, "status", null)).videoModel).toBe("Seedance 2.0 Fast");
  });

  it("names the closest models when a tool is given a model that does not exist", async () => {
    const { host } = await loadPlugin();
    const tools = host.harness.behavior;
    const failed = JSON.stringify(await tools.callAgentTool("comfy_generate_image", { prompt: "x", model: "seadream 5 pro", wait: false }));
    expect(failed).toMatch(/Unknown model/);
    expect(failed).toMatch(/Closest matches/);
    const listed = (await tools.callAgentTool("comfy_models", { kind: "image", vendor: "ByteDance" })) as string;
    expect(listed).toContain("ByteDance:");
    expect(listed).toContain("credits");
    expect(listed).not.toContain("video,");
  });

  it("reports status with the key source and never the key", async () => {
    const { host, assetDir } = await loadPlugin();
    const status = await rpc<Status>(host, "status", null);
    expect(status.configured).toBe(true);
    expect(status.keySource).toBe("setting");
    expect(status.assetDir).toBe(assetDir);
    expect(status.imageModel).toBe("ByteDanceSeedreamNodeV3/seedream 5.0 pro");
    expect(status.counts.total).toBe(0);
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(host.harness.inspection.needsConfigurationMessages).toEqual([]);
    expect(host.harness.inspection.registrations.agentTools.map((t) => t.name).sort()).toEqual([
      "comfy_asset",
      "comfy_assets",
      "comfy_costs",
      "comfy_generate_image",
      "comfy_generate_video",
      "comfy_models",
      "comfy_run_workflow",
      "comfy_status",
    ]);
    for (const tool of host.harness.inspection.registrations.agentTools) expect(tool.presentation?.label?.pending).toBeTruthy();
    expect(host.harness.inspection.registrations.cli?.name).toBe("comfy");
  });

  it("accepts status with an empty object body, with null, and with no argument", async () => {
    const { host } = await loadPlugin();
    expect((await rpc<Status>(host, "status", {})).configured).toBe(true);
    expect((await rpc<Status>(host, "status", null)).configured).toBe(true);
    expect((await rpc<Status>(host, "status", undefined)).configured).toBe(true);
    const preview = await rpc<{ baseUrl: string }>(host, "preview_base", {});
    expect(preview.baseUrl).toBeTruthy();
  });

  it("serves the artwork folder from the plugin dir and explains itself when it is missing", async () => {
    const bare = await loadPlugin();
    await expect(rpc(bare.host, "art_base", null)).rejects.toThrow(/make-art/);

    const root = tmpDir("art-plugin");
    const artDir = path.join(root, ART_FOLDER);
    fs.mkdirSync(artDir, { recursive: true });
    const { host, previewRoots } = await loadPlugin({ pluginDirs: [path.join(root, "dist"), root] });
    const art = await rpc<{ baseUrl: string; expiresAtMs: number }>(host, "art_base", {});
    expect(art.baseUrl).toContain("/preview/");
    expect(art.expiresAtMs).toBeGreaterThan(Date.now());
    expect(previewRoots).toEqual([artDir]);
  });

  it("flags needs-configuration without a key and reads the keyFile setting", async () => {
    const none = await loadPlugin({ key: null });
    expect(none.host.harness.inspection.needsConfigurationMessages.length).toBe(1);
    expect(none.host.harness.inspection.needsConfigurationMessages[0]).toMatch(/apiKey/);
    const status = await rpc<Status>(none.host, "status", null);
    expect(status.configured).toBe(false);
    expect(status.keySource).toBeNull();
    expect(status.configureHint).toMatch(/keyFile/);
    const tool = await none.host.harness.behavior.callAgentTool("comfy_generate_image", { prompt: "x" });
    expect(tool).toMatchObject({ isError: true });
    const cli = await none.host.harness.behavior.runCli(["image", "a kettle"]);
    expect(cli.exitCode).toBe(1);

    const keyFile = path.join(tmpDir("kf"), "ai.env");
    fs.writeFileSync(keyFile, `OTHER=1\nCOMFY_API_KEY=${KEY}\n`);
    const withFile = await loadPlugin({ key: null, keyFile });
    expect(withFile.host.harness.inspection.needsConfigurationMessages).toEqual([]);
    expect((await rpc<Status>(withFile.host, "status", null)).keySource).toBe("key-file");
    expect(withFile.host.harness.inspection.logEntries.map((e) => e.message).join("\n")).not.toContain(KEY);
  });

  it("generates an image end to end through rpc and the jobs service", async () => {
    const loaded = await loadPlugin({ fetch: { statusSequence: [fixture("status-executing.json")] } });
    const { host, assetDir } = loaded;
    const { asset } = await rpc<{ asset: Asset }>(host, "generate_image", { prompt: "a brass compass on a folded map, overhead photo", seed: 7, source: "panel" });
    expect(asset.id).toMatch(/^img_[a-z0-9]{8}$/);
    expect(asset.status).toBe("queued");
    expect(asset.params).toEqual({ sizePreset: "(1K) 1024x1024 (1:1)", width: 1024, height: 1024, seed: 7 });
    expect(JSON.parse(fs.readFileSync(asset.workflowPath, "utf8"))).toEqual(DEFAULT_IMAGE_GRAPH);
    loaded.startService();
    const done = await waitUntil(
      () => rpc<{ asset: Asset; workflow: Workflow; job: unknown }>(host, "asset_get", { id: asset.id }),
      (r) => r.asset.status === "completed",
    );
    expect(done.asset.file).toBe(`${path.basename(path.dirname(asset.workflowPath))}/${asset.id}.png`);
    expect(done.asset.path).toBe(path.join(assetDir, done.asset.file as string));
    expect(done.asset.width).toBe(1024);
    expect(done.workflow).toEqual(DEFAULT_IMAGE_GRAPH);
    expect(done.job).not.toBeNull();
    expect(containsSecret(JSON.stringify(done.job))).toBe(false);
    expect(JSON.stringify(done)).not.toContain(KEY);
    const files = fs.readdirSync(path.dirname(asset.workflowPath));
    // The three the generation must write, whatever else is beside them.
    for (const name of [`${asset.id}.job.json`, `${asset.id}.png`, `${asset.id}.workflow.json`]) expect(files, name).toContain(name);
    // **No small copies here, and that is the case worth pinning.** The fake
    // image this fixture serves is a PNG header with no pixels, so ffmpeg
    // refuses it: exit 69, and it leaves a 0 byte .webp behind because it opens
    // the destination before it decodes the source. A generation must survive
    // that with its columns null and its folder clean, because every surface
    // falls back to the original. Making real copies from a real image is
    // outside what a pixel-free fixture can cover.
    expect(files.sort()).toEqual([`${asset.id}.job.json`, `${asset.id}.png`, `${asset.id}.workflow.json`]);
    expect(files.some((name) => name.endsWith(".webp")), "a failed ffmpeg run cleans up after itself").toBe(false);
    expect(done.asset.thumbPath ?? null).toBe(null);
    expect(done.asset.mediumPath ?? null).toBe(null);
    expect(done.asset.status, "and the generation still completed").toBe("completed");
    for (const file of files) expect(fs.readFileSync(path.join(path.dirname(asset.workflowPath), file), "latin1")).not.toContain(KEY);
    await waitUntil(
      () => host.harness.inspection.realtimeSignals,
      (signals) => signals.some((s) => s.channel === "comfy-changed"),
    );
    expect(JSON.stringify(host.harness.inspection.realtimeSignals)).not.toContain(KEY);
    expect(host.harness.inspection.logEntries.map((e) => e.message).join("\n")).not.toContain(KEY);
  });

  it("uploads a reference image, wires it into the graph, and refuses a model that cannot take one", async () => {
    const loaded = await loadPlugin();
    const { host } = loaded;

    // A path on the bb server. The graph must carry a LoadImage node whose
    // `image` is the uploaded name, wired into the model's own slot.
    const file = path.join(tmpDir("references"), "compass.png");
    fs.writeFileSync(file, tinyPng(512, 512));
    const byPath = (
      await rpc<{ asset: Asset }>(host, "generate_image", {
        prompt: "the same street as a watercolour postcard",
        model: "ByteDanceSeedreamNodeV3/seedream 5.0 pro",
        references: [file],
        seed: 7,
      })
    ).asset;
    const graph = JSON.parse(fs.readFileSync(byPath.workflowPath, "utf8")) as Workflow;
    expect(Object.keys(graph).sort()).toEqual(["1", "2", "3"]);
    expect(graph["3"]?.class_type).toBe("LoadImage");
    const uploaded = graph["3"]?.inputs.image as string;
    expect(uploaded).toMatch(/^[0-9a-f]{64}\.png$/);
    // The one spelling that works. `model.image_1` raises at execute time and
    // `model.images` as a dict is accepted, billed and silently ignored.
    expect(graph["1"]?.inputs["model.images.image_1"]).toEqual(["3", 0]);
    expect(byPath.params.references).toBe(file);
    // A row that has not produced a file yet cannot be a reference.
    await expect(rpc(host, "generate_image", { prompt: "x", references: [byPath.id] })).rejects.toThrow(/has no file yet/);

    // An asset id is the form worth having: "vary this one" in one call. It
    // resolves through the store to the file the runner downloaded.
    const parent = (await rpc<{ asset: Asset }>(host, "generate_image", { prompt: "a plain compass rose", seed: 3 })).asset;
    loaded.startService();
    const finished = await waitUntil(
      () => rpc<{ asset: Asset }>(host, "asset_get", { id: parent.id }),
      (r) => r.asset.status === "completed",
    );
    expect(finished.asset.path).not.toBeNull();
    const byId = (
      await rpc<{ asset: Asset }>(host, "generate_image", {
        prompt: "the same scene in watercolour",
        model: "ByteDanceSeedreamNodeV3/seedream 5.0 pro",
        references: [parent.id],
      })
    ).asset;
    expect(byId.params.references).toBe(parent.id);
    const idGraph = JSON.parse(fs.readFileSync(byId.workflowPath, "utf8")) as Workflow;
    expect(idGraph["3"]?.class_type).toBe("LoadImage");
    expect(idGraph["1"]?.inputs["model.images.image_1"]).toEqual(["3", 0]);

    // Two references fill two slots in the order they were given.
    const second = path.join(path.dirname(file), "second.png");
    fs.writeFileSync(second, tinyPng(256, 256));
    const two = (
      await rpc<{ asset: Asset }>(host, "generate_image", {
        prompt: "both shapes together",
        model: "ByteDanceSeedreamNodeV3/seedream 5.0 pro",
        references: [file, second],
      })
    ).asset;
    const twoGraph = JSON.parse(fs.readFileSync(two.workflowPath, "utf8")) as Workflow;
    expect(Object.keys(twoGraph).sort()).toEqual(["1", "2", "3", "4"]);
    expect(twoGraph["1"]?.inputs["model.images.image_1"]).toEqual(["3", 0]);
    expect(twoGraph["1"]?.inputs["model.images.image_2"]).toEqual(["4", 0]);
    expect(twoGraph["3"]?.inputs.image).not.toBe(twoGraph["4"]?.inputs.image);

    // A model without the capability refuses, and names one that has it.
    await expect(rpc(host, "generate_image", { prompt: "x", model: "IdeogramV3", references: [file] })).rejects.toThrow(/does not take a reference image.*Models that do:/s);
    // So does a name that is neither an asset nor a file.
    await expect(rpc(host, "generate_image", { prompt: "x", references: ["img_nosuchid"] })).rejects.toThrow(/No asset and no file/);
    // And a file that is not an image.
    const notAnImage = path.join(path.dirname(file), "notes.txt");
    fs.writeFileSync(notAnImage, "hello");
    await expect(rpc(host, "generate_image", { prompt: "x", references: [notAnImage] })).rejects.toThrow(/is not an image/);
    // No key at all cannot upload, so it says so rather than queueing a row
    // whose graph can never be finished.
    const none = await loadPlugin({ key: null });
    await expect(rpc(none.host, "generate_image", { prompt: "x", references: [file] })).rejects.toThrow(/API key/);

    // Nothing about the key reached the graphs or the logs.
    for (const path_ of [byPath.workflowPath, byId.workflowPath, two.workflowPath]) expect(fs.readFileSync(path_, "utf8")).not.toContain(KEY);
    expect(host.harness.inspection.logEntries.map((e) => e.message).join("\n")).not.toContain(KEY);
  });

  it("generates a video end to end and records tool provenance", async () => {
    const loaded = await loadPlugin({ fetch: { job: fixture("job-completed-video.json"), view: { bytes: Buffer.from("mp4"), type: "video/mp4" } } });
    const { host } = loaded;
    loaded.startService();
    const result = await host.harness.behavior.callAgentTool(
      "comfy_generate_video",
      { prompt: "a windmill turning slowly on a hill at dawn", duration: 3, seed: 7 },
      { threadId: "th_42" },
    );
    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text).toMatch(/^vid_[a-z0-9]{8}: completed/);
    expect(text).toContain(".mp4");
    expect(text).toContain("864x480, 3s");
    const id = text.split(":")[0] as string;
    const { asset } = await rpc<{ asset: Asset; workflow: Workflow; job: unknown }>(host, "asset_get", { id });
    expect(asset.threadId).toBe("th_42");
    expect(asset.source).toBe("tool");
    expect(asset.durationS).toBe(3);
    expect(JSON.parse(fs.readFileSync(asset.workflowPath, "utf8"))).toEqual(VIDEO_GRAPH_1X);
  });

  it("lists with filters, stars, retries with a new seed, cancels and deletes", async () => {
    const { host } = await loadPlugin();
    const img = (await rpc<{ asset: Asset }>(host, "generate_image", { prompt: "a copper kettle on a stove", seed: 1 })).asset;
    const vid = (await rpc<{ asset: Asset }>(host, "generate_video", { prompt: "a fox running", seed: 2 })).asset;
    const all = await rpc<{ assets: Asset[] }>(host, "assets_list", {});
    expect(all.assets.map((a) => a.id)).toEqual([vid.id, img.id]);
    expect((await rpc<{ assets: Asset[] }>(host, "assets_list", { kind: "image" })).assets.map((a) => a.id)).toEqual([img.id]);
    expect((await rpc<{ assets: Asset[] }>(host, "assets_list", { query: "fox" })).assets.map((a) => a.id)).toEqual([vid.id]);
    expect((await rpc<{ assets: Asset[] }>(host, "assets_list", { status: "completed" })).assets).toEqual([]);
    expect((await rpc<{ assets: Asset[] }>(host, "assets_list", { limit: 1 })).assets.length).toBe(1);
    expect((await rpc<{ assets: Asset[] }>(host, "assets_list", { before: img.createdAt })).assets.length).toBe(0);
    await rpc(host, "asset_star", { id: img.id, starred: true });
    expect((await rpc<{ assets: Asset[] }>(host, "assets_list", { starred: true })).assets.map((a) => a.id)).toEqual([img.id]);

    const retried = (await rpc<{ asset: Asset }>(host, "asset_retry", { id: img.id, newSeed: true })).asset;
    expect(retried.parentId).toBe(img.id);
    expect(retried.params.seed).not.toBe(1);
    const retriedGraph = JSON.parse(fs.readFileSync(retried.workflowPath, "utf8")) as Workflow;
    // The default model keeps its seed under `model.seed`; the legacy V2 node
    // spelled it `seed`, and both have to keep working.
    expect(retriedGraph["1"]?.inputs["model.seed"]).toBe(retried.params.seed);
    const same = (await rpc<{ asset: Asset }>(host, "asset_retry", { id: img.id })).asset;
    expect(same.params.seed).toBe(1);

    const cancelled = (await rpc<{ asset: Asset }>(host, "asset_cancel", { id: vid.id })).asset;
    expect(cancelled.status).toBe("cancelled");
    await expect(rpc(host, "asset_cancel", { id: vid.id })).rejects.toThrow(/already cancelled/);

    const deleted = await rpc<{ ok: boolean; text: string }>(host, "asset_delete", { id: retried.id });
    expect(deleted.ok).toBe(true);
    expect(fs.existsSync(retried.workflowPath)).toBe(false);
    await expect(rpc(host, "asset_get", { id: retried.id })).rejects.toThrow(/not found/);

    const preview = await rpc<{ baseUrl: string }>(host, "preview_base", null);
    expect(preview.baseUrl).toContain("/preview/");
  });

  describe("Retry never pays twice for a job that finished", () => {
    /** A row marked failed whose job goes on to finish. */
    async function failedButFinished(loaded: Loaded): Promise<Asset> {
      const { asset } = await rpc<{ asset: Asset }>(loaded.host, "generate_image", { prompt: "a kettle", seed: 3 });
      loaded.startService();
      await waitUntil(
        () => rpc<{ asset: Asset }>(loaded.host, "asset_get", { id: asset.id }),
        (r) => r.asset.status === "completed",
      );
      createStore(loaded.host.bb.storage.database()).update(asset.id, { status: "failed", error: "Could not reach Comfy Cloud.", file: null, path: null });
      return asset;
    }

    it("fetches the finished job and records its bill instead of submitting a new one", async () => {
      const loaded = await loadPlugin();
      const asset = await failedButFinished(loaded);
      const submits = () => loaded.calls.filter((call) => call.url.endsWith("/api/prompt")).length;
      const before = submits();
      const retried = (await rpc<{ asset: Asset }>(loaded.host, "asset_retry", { id: asset.id })).asset;
      expect(retried.id).toBe(asset.id);
      const done = await waitUntil(
        () => rpc<{ asset: Asset }>(loaded.host, "asset_get", { id: asset.id }),
        (r) => r.asset.status === "completed" && r.asset.actualCredits !== null,
      );
      expect(done.asset.actualCredits).toBe(9.5);
      expect(submits()).toBe(before);
      expect((await rpc<{ assets: Asset[] }>(loaded.host, "assets_list", {})).assets.length).toBe(1);
    });

    it("sends nothing when Comfy Cloud cannot be asked", async () => {
      const options: FakeFetchOptions = {};
      const loaded = await loadPlugin({ fetch: options });
      const asset = await failedButFinished(loaded);
      const before = loaded.calls.filter((call) => call.url.endsWith("/api/prompt")).length;
      options.statusOffline = true;
      await expect(rpc(loaded.host, "asset_retry", { id: asset.id })).rejects.toThrow(/nothing was sent and nothing was charged/);
      expect(loaded.calls.filter((call) => call.url.endsWith("/api/prompt")).length).toBe(before);
      expect((await rpc<{ assets: Asset[] }>(loaded.host, "assets_list", {})).assets.length).toBe(1);
    });

    it("still makes a new job for a failure Comfy itself reported", async () => {
      // The positive control: Retry must still work on a real failure.
      const loaded = await loadPlugin({ fetch: { status: fixture("status-error.json") } });
      const { asset } = await rpc<{ asset: Asset }>(loaded.host, "generate_image", { prompt: "a kettle", seed: 3 });
      loaded.startService();
      await waitUntil(
        () => rpc<{ asset: Asset }>(loaded.host, "asset_get", { id: asset.id }),
        (r) => r.asset.status === "failed",
      );
      const retried = (await rpc<{ asset: Asset }>(loaded.host, "asset_retry", { id: asset.id })).asset;
      expect(retried.id).not.toBe(asset.id);
      expect(retried.parentId).toBe(asset.id);
    });
  });

  it("answers the Library's deepest Show older page", async () => {
    // The grid raises its limit 200 at a time to LIBRARY_MAX, so the contract
    // must accept every limit up to it or a deep click would be refused.
    const { host } = await loadPlugin();
    for (let i = 0; i < 3; i += 1) await rpc(host, "generate_image", { prompt: `kettle ${i}`, seed: i + 1 });
    const deepest = await rpc<{ assets: Asset[] }>(host, "assets_list", { limit: LIBRARY_MAX });
    expect(deepest.assets).toHaveLength(3);
    await expect(rpc(host, "assets_list", { limit: LIBRARY_MAX + 1 })).rejects.toThrow();
  });

  it("runs an edited workflow with auto kind and a parent", async () => {
    const { host } = await loadPlugin();
    const parent = (await rpc<{ asset: Asset }>(host, "generate_image", { prompt: "seed image" })).asset;
    const { asset } = await rpc<{ asset: Asset }>(host, "run_workflow", { workflow: VIDEO_GRAPH_2X, parentId: parent.id });
    expect(asset.kind).toBe("video");
    expect(asset.model).toBe("Seedance 2.0 Fast");
    expect(asset.prompt).toContain("turning");
    expect(asset.parentId).toBe(parent.id);
    expect(asset.params).toMatchObject({ resolution: "480p", duration: 4, seed: 7 });
    const tool = await host.harness.behavior.callAgentTool("comfy_run_workflow", {
      workflow_json: JSON.stringify({ ...IMAGE_GRAPH, extra_data: { api_key_comfy_org: "leak" } }),
      wait: false,
    });
    expect(typeof tool).toBe("string");
    const id = (tool as string).match(/img_[a-z0-9]{8}/)?.[0] as string;
    const stored = fs.readFileSync((await rpc<{ asset: Asset; workflow: Workflow; job: unknown }>(host, "asset_get", { id })).asset.workflowPath, "utf8");
    expect(stored).not.toContain("api_key_comfy_org");
    const badJson = await host.harness.behavior.callAgentTool("comfy_run_workflow", { workflow_json: "{nope" });
    expect(badJson).toMatchObject({ isError: true });
  });

  it("serves the node catalog from the cached object_info", async () => {
    const { host, dataDir } = await loadPlugin();
    const file = path.join(dataDir, "plugins", "comfy-cloud", "object_info.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        ByteDanceSeedreamNodeV2: {
          display_name: "ByteDance Seedream",
          category: "partner/image/ByteDance",
          output: ["IMAGE"],
          input: { required: { prompt: ["STRING", { multiline: true }], model: [["seedream 5.0 pro"], {}] }, optional: { seed: ["INT", {}] } },
          input_order: { required: ["model", "prompt"] },
        },
        SaveImage: { name: "SaveImage", category: "image", output: [], input: { required: { images: ["IMAGE"], filename_prefix: ["STRING", {}] } } },
      }),
    );
    expect((await rpc<Status>(host, "status", null)).catalogLoaded).toBe(true);
    const { nodes } = await rpc<{ nodes: Record<string, { displayName: string; inputs: { name: string; type: string; required: boolean }[]; outputs: string[] }> }>(
      host,
      "node_catalog",
      { classTypes: ["ByteDanceSeedreamNodeV2", "SaveImage", "Unknown"] },
    );
    expect(Object.keys(nodes).sort()).toEqual(["ByteDanceSeedreamNodeV2", "SaveImage"]);
    expect(nodes.ByteDanceSeedreamNodeV2?.displayName).toBe("ByteDance Seedream");
    expect(nodes.ByteDanceSeedreamNodeV2?.outputs).toEqual(["IMAGE"]);
    expect(nodes.ByteDanceSeedreamNodeV2?.inputs).toEqual([
      { name: "model", type: "COMBO", required: true },
      { name: "prompt", type: "STRING", required: true },
      { name: "seed", type: "INT", required: false },
    ]);
  });

  it("CLI: list, status, models, sizes, show, image --no-wait", async () => {
    const { host } = await loadPlugin();
    const cli = host.harness.behavior;
    const empty = await cli.runCli(["list"]);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("No assets.");

    // A bad --extra is refused before anything is queued or spent.
    const badExtra = await cli.runCli(["image", "a kettle", "--no-wait", "--extra", "quality"]);
    expect(badExtra.exitCode).toBe(1);
    expect(badExtra.stderr).toContain("name=value");
    const unknownExtra = await cli.runCli(["image", "a kettle", "--no-wait", "--extra", "nonsense=1"]);
    expect(unknownExtra.exitCode).toBe(1);
    expect(unknownExtra.stderr).toContain('has no input called "nonsense"');

    const queued = await cli.runCli(["image", "a", "small", "copper", "kettle", "--seed", "3", "--no-wait", "--size", "(1K) 1312x736 (16:9)"]);
    expect(queued.exitCode).toBe(0);
    expect(queued.stdout).toMatch(/^img_[a-z0-9]{8} queued/);
    const id = queued.stdout.match(/img_[a-z0-9]{8}/)?.[0] as string;
    const shown = await cli.runCli(["show", id, "--workflow"]);
    expect(shown.stdout).toContain("prompt: a small copper kettle");
    expect(shown.stdout).toContain('"model.width": 1312');
    const shownJson = JSON.parse((await cli.runCli(["show", id, "--json", "--job"])).stdout) as { asset: Asset; job: unknown };
    expect(shownJson.asset.id).toBe(id);
    expect(shownJson.job).toBeNull();

    const list = await cli.runCli(["list", "--kind", "image"]);
    expect(list.stdout).toContain(id);
    expect(list.stdout).toContain("queued");
    const listJson = JSON.parse((await cli.runCli(["list", "--json", "--limit", "5"])).stdout) as { assets: Asset[] };
    expect(listJson.assets[0]?.id).toBe(id);
    expect(listJson.assets[0]?.source).toBe("cli");

    const status = await cli.runCli(["status"]);
    expect(status.stdout).toContain("configured (key source: setting)");
    expect(status.stdout).toContain("1 total");
    expect(status.stdout).not.toContain(KEY);
    const statusJson = JSON.parse((await cli.runCli(["status", "--json"])).stdout) as Status;
    expect(statusJson.keySource).toBe("setting");

    const models = await cli.runCli(["models"]);
    expect(models.stdout).toContain("ByteDanceSeedreamNodeV3/seedream 5.0 pro  [default");
    expect(models.stdout).toContain("ByteDance2TextToVideoNode/Seedance 2.0 Fast");
    const modelsJson = JSON.parse((await cli.runCli(["models", "--json"])).stdout) as ModelsResult;
    expect(modelsJson.counts.supported).toBeGreaterThan(80);
    expect(modelsJson.models.every((m) => m.supported || m.key === modelsJson.defaults.image || m.key === modelsJson.defaults.video)).toBe(true);
    const videoOnly = JSON.parse((await cli.runCli(["models", "--kind", "video", "--json"])).stdout) as ModelsResult;
    expect(videoOnly.models.every((m) => m.kind === "video")).toBe(true);
    const oneVendor = await cli.runCli(["models", "--vendor", "Ideogram"]);
    expect(oneVendor.stdout).toContain("Ideogram:");
    expect(oneVendor.stdout).not.toContain("ByteDance:");
    // --all is the only way to see why a model is not offered.
    const withAll = await cli.runCli(["models", "--all", "--kind", "image"]);
    expect(withAll.stdout).toContain("UNSUPPORTED");
    expect(withAll.stdout).toContain("why not:");
    const searched = await cli.runCli(["models", "flux"]);
    expect(searched.stdout).toContain("Flux");
    expect(searched.stdout).not.toContain("Seedance");

    const sizes = await cli.runCli(["sizes", "--model", "seedream 5.0 lite"]);
    expect(sizes.stdout).toContain("(4K) 4096x4096 (1:1)");
    expect(sizes.stdout).not.toContain("(1K)");
    // The model's own options are how an agent finds the price lever that is
    // not a size: Ideogram's quality tier is a third of the default price.
    const ideogram = await cli.runCli(["sizes", "--model", "IdeogramPImage"]);
    expect(ideogram.stdout).toContain("options (--extra name=value):");
    expect(ideogram.stdout).toContain("quality = VERY_LOW, LOW, MEDIUM, HIGH (default MEDIUM)");
    const badModel = await cli.runCli(["sizes", "--model", "nope"]);
    expect(badModel.exitCode).toBe(1);
    const unknown = await cli.runCli(["frobnicate"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Unknown command");
    expect((await cli.runCli([])).stdout).toContain("bb comfy image");
  });

  it("CLI: image waits and ends with the file path; retry, star, cancel, delete", async () => {
    const loaded = await loadPlugin();
    const { host } = loaded;
    loaded.startService();
    const cli = host.harness.behavior;
    const done = await cli.runCli(["image", "a kettle", "--seed", "7"]);
    expect(done.exitCode).toBe(0);
    const lines = done.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^img_[a-z0-9]{8} completed in \d+s \(1024x1024, image\/png\)$/);
    // What it cost sits between the headline and the path, and the path stays last.
    expect(lines[1]).toMatch(/^cost: billed 9\.5 credits \(\$0\.05\), estimate was 9\.5 credits/);
    expect(lines[1]).toContain("billed as seedream-5-0-pro-260628 (tier standard)");
    const filePath = lines[lines.length - 1] as string;
    expect(filePath).toMatch(/\/img_[a-z0-9]{8}\.png$/);
    expect(fs.existsSync(filePath)).toBe(true);
    const id = lines[0]?.split(" ")[0] as string;

    expect((await cli.runCli(["star", id])).stdout).toContain("starred");
    expect((await cli.runCli(["list", "--starred"])).stdout).toContain(id);
    expect((await cli.runCli(["unstar", id])).stdout).toContain("unstarred");

    const retried = await cli.runCli(["retry", id, "--new-seed", "--no-wait"]);
    expect(retried.exitCode).toBe(0);
    const retryId = retried.stdout.match(/img_[a-z0-9]{8}/)?.[0] as string;
    expect(retryId).not.toBe(id);
    const cancelled = await cli.runCli(["cancel", retryId]);
    expect(cancelled.exitCode).toBe(0);
    expect(cancelled.stdout).toContain("cancelled");
    // A cancelled row whose download a hard kill cut off leaves a .part that
    // no path on the row names; deleting the row must take it anyway.
    const cancelledRow = await rpc<{ asset: Asset }>(host, "asset_get", { id: retryId });
    const strayPart = path.join(path.dirname(cancelledRow.asset.workflowPath), `${retryId}.png.part`);
    fs.writeFileSync(strayPart, "half a download");
    expect((await cli.runCli(["delete", retryId])).exitCode).toBe(0);
    expect(fs.existsSync(strayPart)).toBe(false);
    const deleted = await cli.runCli(["delete", id]);
    expect(deleted.exitCode).toBe(0);
    expect(fs.existsSync(filePath)).toBe(false);
    expect((await cli.runCli(["show", id])).exitCode).toBe(1);
  });

  it("costs: the balance, the spend, the learned prices, and never the key", async () => {
    const loaded = await loadPlugin();
    const { host } = loaded;
    loaded.startService();
    const before = await rpc<Costs>(host, "costs", {});
    expect(before.balanceCredits).toBeCloseTo(2604.8, 1);
    expect(before.balanceUsd).toBeCloseTo(12.345, 3);
    expect(before.creditRate).toBeCloseTo(1 / CREDITS_PER_USD, 6);
    expect(before.spend).toEqual({ today: 0, week: 0, total: 0 });
    expect(before.byModel).toEqual([]);
    expect(before.days).toBe(30);

    const done = await host.harness.behavior.runCli(["image", "a kettle", "--seed", "7"]);
    expect(done.exitCode).toBe(0);
    const id = done.stdout.match(/img_[a-z0-9]{8}/)?.[0] as string;

    const after = await rpc<Costs>(host, "costs", { days: 7 });
    expect(after.spend.today).toBe(9.5);
    expect(after.spend.total).toBe(9.5);
    expect(after.byModel).toEqual([{ model: "seedream 5.0 pro", kind: "image", credits: 9.5, count: 1 }]);
    expect(after.recent[0]).toMatchObject({ id, credits: 9.5, estimatedCredits: 9.5, kind: "image" });
    expect(after.observed).toEqual([{ signature: "image|seedream 5.0 pro|1K", kind: "image", model: "seedream 5.0 pro", credits: 9.5, samples: 1 }]);
    expect(after.days).toBe(7);
    // Nothing about the key survives into a cost payload.
    expect(JSON.stringify(after)).not.toContain(KEY);
    expect(JSON.stringify(after)).not.toContain("api_key");

    const cli = await host.harness.behavior.runCli(["costs"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("Credits left: 2604.8 credits ($12.35)");
    expect(cli.stdout).toContain("Spent by this plugin: 9.5 credits ($0.05) today");
    expect(cli.stdout).toContain("seedream 5.0 pro");
    expect(cli.stdout).toContain("Prices learned from this account's own bills:");
    expect(cli.stdout).not.toContain(KEY);

    const status = await host.harness.behavior.runCli(["status"]);
    expect(status.stdout).toContain("Credits left: 2604.8 credits ($12.35)");
    // "all time" is on the line on purpose: a count with no period on it reads as recent.
    expect(status.stdout).toContain("Spent here, all time: 9.5 credits ($0.05)");
    // Nothing failed here, so the Assets line says nothing about the last day.
    // A stray "(0 in the last day)" is the failure mode worth pinning.
    expect(status.stdout).toContain("0 in progress, 0 failed");
    expect(status.stdout).not.toContain("in the last day");

    const shown = await host.harness.behavior.runCli(["show", id]);
    expect(shown.stdout).toContain("cost: billed 9.5 credits ($0.05), estimate was 9.5 credits ($0.05), exact");

    const tool = (await host.harness.behavior.callAgentTool("comfy_costs", {})) as string;
    expect(tool).toContain("Credits left:");
    expect(tool).not.toContain(KEY);
  });

  it("shows credits only when no credit rate is configured", async () => {
    const { host } = await loadPlugin({ creditRate: "" });
    const costs = await rpc<Costs>(host, "costs", null);
    expect(costs.creditRate).toBeNull();
    const status = await rpc<Status>(host, "status", null);
    expect(status.creditRate).toBeNull();
    expect(status.balanceCredits).toBeCloseTo(2604.8, 1);
    const cli = await host.harness.behavior.runCli(["costs"]);
    expect(cli.stdout).not.toContain("$");
    expect(cli.stdout).toContain("No credit rate set");
  });

  it("keeps working when the billing endpoints are down", async () => {
    const { host } = await loadPlugin({ fetch: { billingHttp: 503 } });
    const status = await rpc<Status>(host, "status", null);
    expect(status.configured).toBe(true);
    expect(status.balanceCredits).toBeNull();
    const cli = await host.harness.behavior.runCli(["status"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("Credits left: not read yet");
    const queued = await host.harness.behavior.runCli(["image", "a kettle", "--no-wait"]);
    expect(queued.exitCode).toBe(0);
    expect(queued.stdout).toContain("cost: estimated 9.5 credits");
  });

  it("warns once when the balance goes unreadable, then once when it comes back", async () => {
    // An outage of the balance endpoint warns once, not at every status poll,
    // and says so when it ends.
    const options: FakeFetchOptions = { billingHttp: 503 };
    const { host } = await loadPlugin({ fetch: options });
    const balanceLines = () => host.harness.inspection.logEntries.map((e) => e.message).filter((m) => m.includes("credit balance"));
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      for (let minute = 0; minute < 4; minute += 1) {
        await rpc<Status>(host, "status", null);
        await waitUntil(() => balanceLines().length, (n) => n >= 1);
        clock += 61_000;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(balanceLines().filter((m) => m.includes("unavailable"))).toHaveLength(1);
      options.billingHttp = undefined;
      await rpc<Status>(host, "status", null);
      await waitUntil(balanceLines, (lines) => lines.some((m) => m.includes("readable again")));
      const status = await waitUntil(() => rpc<Status>(host, "status", null), (s) => s.balanceCredits !== null);
      expect(status.balanceCredits).toBeCloseTo(2604.8, 1);
    } finally {
      Date.now = realNow;
    }
  });

  it("tools: comfy_assets, comfy_asset, comfy_status", async () => {
    const { host } = await loadPlugin();
    const tools = host.harness.behavior;
    expect(await tools.callAgentTool("comfy_assets", {})).toBe("No assets match.");
    const queued = await tools.callAgentTool("comfy_generate_image", { prompt: "an icon of a kettle, black line drawing on white", wait: false }, { threadId: "th_1" });
    const id = (queued as string).match(/img_[a-z0-9]{8}/)?.[0] as string;
    const listed = (await tools.callAgentTool("comfy_assets", { kind: "image" })) as string;
    expect(listed).toContain(id);
    expect(listed).toContain("queued");
    expect(listed).toContain("an icon of a kettle");
    expect(await tools.callAgentTool("comfy_assets", { query: "zebra" })).toBe("No assets match.");
    const one = (await tools.callAgentTool("comfy_asset", { id, workflow: true })) as string;
    expect(one).toContain(`${id}: queued`);
    expect(one).toContain("ByteDanceSeedreamNodeV3");
    expect(one).toContain("UTC");
    expect(await tools.callAgentTool("comfy_asset", { id: "img_missing0" })).toMatchObject({ isError: true });
    const status = (await tools.callAgentTool("comfy_status", {})) as string;
    expect(status).toContain("configured (key source: setting)");
    expect(status).toContain("Assets: 1 total");
    expect(status).not.toContain(KEY);
    const { asset } = await rpc<{ asset: Asset; workflow: Workflow; job: unknown }>(host, "asset_get", { id });
    expect(asset.threadId).toBe("th_1");
    expect(asset.source).toBe("tool");
  });
});

// ---------- the media route ----------
//
// Every picture the panel draws goes through here, with a cache header bb's own
// preview cannot give (media.ts). Driven through the fake host's real Hono
// context, so the query and header reads are the ones bb makes.

describe("media route", () => {
  const ROUTE = "/api/v1/plugins/comfy-cloud/http/media";

  async function withFile(): Promise<{ loaded: Loaded; relative: string; bytes: Buffer; fetch: (query: string, init?: RequestInit) => Promise<Response> }> {
    const loaded = await loadPlugin();
    const folder = path.join(loaded.assetDir, "2031-12-02");
    fs.mkdirSync(folder, { recursive: true });
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
    fs.writeFileSync(path.join(folder, "vid_media001.mp4"), bytes);
    return {
      loaded,
      relative: "2031-12-02/vid_media001.mp4",
      bytes,
      // The fake host matches the path exactly the way bb does, so the file goes in the query.
      fetch: (query, init) => loaded.host.harness.behavior.fetchHttp("GET", `/media?${query}`, init),
    };
  }

  it("is mounted where the panel asks for it", async () => {
    const { host } = await loadPlugin();
    const routes = host.harness.inspection.registrations.httpRoutes.map((r) => `${r.method} ${r.path} ${r.auth}`);
    expect(routes).toContain("GET /media local");
    expect(ROUTE.endsWith("/http/media")).toBe(true);
  });

  it("lets a versioned URL be kept for a year, and an unversioned one never", async () => {
    const { relative, bytes, fetch } = await withFile();
    expect(mediaVersion("/nonexistent-root", relative), "no version for a file that is not there").toBe(null);
    const bare = await fetch(`p=${encodeURIComponent(relative)}`);
    expect(bare.status).toBe(200);
    expect(bare.headers.get("cache-control")).toBe("private, no-cache");
    expect(bare.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await bare.arrayBuffer()).equals(bytes)).toBe(true);
    const etag = bare.headers.get("etag") as string;
    const v = etag.replace(/"/g, "");
    const pinned = await fetch(`p=${encodeURIComponent(relative)}&v=${v}`);
    expect(pinned.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    // A version that no longer matches the bytes is not pinned to them.
    const stale = await fetch(`p=${encodeURIComponent(relative)}&v=old`);
    expect(stale.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("answers 304 to a matching If-None-Match", async () => {
    const { relative, fetch } = await withFile();
    const first = await fetch(`p=${encodeURIComponent(relative)}`);
    const again = await fetch(`p=${encodeURIComponent(relative)}`, { headers: { "if-none-match": first.headers.get("etag") as string } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("serves a byte range, which Safari needs before it will play an mp4", async () => {
    const { relative, bytes, fetch } = await withFile();
    const part = await fetch(`p=${encodeURIComponent(relative)}`, { headers: { range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect(part.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(10, 20))).toBe(true);
    const tail = await fetch(`p=${encodeURIComponent(relative)}`, { headers: { range: "bytes=-5" } });
    expect(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(995))).toBe(true);
    const past = await fetch(`p=${encodeURIComponent(relative)}`, { headers: { range: "bytes=5000-" } });
    expect(past.status).toBe(416);
  });

  it("asks the browser to save the original on download=1", async () => {
    const { relative, fetch } = await withFile();
    const saved = await fetch(`p=${encodeURIComponent(relative)}&download=1`);
    expect(saved.headers.get("content-disposition")).toBe('attachment; filename="vid_media001.mp4"');
    const shown = await fetch(`p=${encodeURIComponent(relative)}`);
    expect(shown.headers.get("content-disposition")).toBe(null);
  });

  it("refuses anything outside the asset folder, and anything that is not media", async () => {
    const { loaded, fetch } = await withFile();
    // A real file one level above the asset folder, so a missing guard would
    // serve it rather than 404 for the wrong reason.
    const outside = path.join(path.dirname(loaded.assetDir), "secret.png");
    fs.writeFileSync(outside, "outside");
    cleanup.push(outside);
    const escapes = [
      `p=${encodeURIComponent("../secret.png")}`,
      `p=${encodeURIComponent(`2031-12-02/../../${path.basename(outside)}`)}`,
      `p=${encodeURIComponent(outside)}`,
    ];
    for (const query of escapes) expect((await fetch(query)).status, query).toBe(404);
    // A symlink inside the folder that points out of it.
    fs.symlinkSync(outside, path.join(loaded.assetDir, "2031-12-02", "link.png"));
    expect((await fetch(`p=${encodeURIComponent("2031-12-02/link.png")}`)).status).toBe(404);
    // Inside the folder but not media: the workflow JSON and the job record.
    fs.writeFileSync(path.join(loaded.assetDir, "2031-12-02", "vid_media001.job.json"), "{}");
    expect((await fetch(`p=${encodeURIComponent("2031-12-02/vid_media001.job.json")}`)).status).toBe(404);
    // A folder with a media name, a missing file, and no p at all.
    fs.mkdirSync(path.join(loaded.assetDir, "2031-12-02", "dir.png"));
    expect((await fetch(`p=${encodeURIComponent("2031-12-02/dir.png")}`)).status).toBe(404);
    expect((await fetch(`p=${encodeURIComponent("2031-12-02/nope.png")}`)).status).toBe(404);
    expect((await fetch("")).status).toBe(404);
  });

  it("stamps a version on every completed row the panel receives", async () => {
    const { loaded, relative } = await withFile();
    // The fake host hands every caller one shared database, so this is the
    // plugin's own store: generating is heavy, so the row is written directly.
    const store = createStore(loaded.host.bb.storage.database());
    const row = queueRow(store, loaded.assetDir, "video", {}, {
      status: "completed",
      file: relative,
      path: path.join(loaded.assetDir, relative),
      thumbPath: "2031-12-02/vid_media001.thumb.webp",
    });
    const listed = (await rpc<{ assets: Asset[] }>(loaded.host, "assets_list", {})).assets.find((a) => a.id === row.id) as Asset;
    expect(listed.fileVersion).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
    // The thumbnail is named but not on disk, so it gets no version and the
    // panel falls back rather than asking for a URL that would 404.
    expect(listed.thumbVersion).toBe(null);
    const got = await rpc<{ asset: Asset }>(loaded.host, "asset_get", { id: row.id });
    expect(got.asset.fileVersion).toBe(listed.fileVersion);
    // And it is the version the route itself checks.
    const response = await loaded.host.harness.behavior.fetchHttp("GET", `/media?p=${encodeURIComponent(relative)}&v=${listed.fileVersion}`);
    expect(response.headers.get("cache-control")).toContain("immutable");
    // A queued row has no files to version.
    const queued = queueRow(store, loaded.assetDir, "image", {});
    const q = (await rpc<{ assets: Asset[] }>(loaded.host, "assets_list", {})).assets.find((a) => a.id === queued.id) as Asset;
    expect(q.fileVersion ?? null).toBe(null);
  });
});

describe("parseRange", () => {
  it("reads one range and serves anything else whole", () => {
    expect(parseRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=2-99", 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,4-5", 10)).toBe(null);
    expect(parseRange(undefined, 10)).toBe(null);
  });
});

describe("derivative backfill", () => {
  it("redoes rows made at an older revision and leaves current ones alone", () => {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const store = createStore(db);
    const dir = tmpDir("rev");
    const base = { status: "completed" as const, path: path.join(dir, "x.png"), file: "x.png", thumbPath: "x.thumb.webp", mediumPath: "x.medium.webp" };
    const old = queueRow(store, dir, "image", {}, base);
    const current = queueRow(store, dir, "image", {}, base);
    store.setDerivativeRevision(current.id, DERIVATIVE_REVISION);
    const due = store.needsDerivatives(10, DERIVATIVE_REVISION).map((a) => a.id);
    expect(due).toContain(old.id);
    expect(due).not.toContain(current.id);
  });
});
