// @vitest-environment jsdom
// Frontend tests: the pure graph layout on three working graphs, the route and preview helpers, and the panel rendered through
// the SDK harness with rpc stubs (grid, viewer, arrow keys, graph toggle).
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { DEFAULT_CREDIT_RATE, estimateCredits } from "../contract";
import type { Asset, Costs, NodeInfo, RpcContract, Status, Workflow } from "../contract";
import {
  clockTime,
  elapsedOfEstimate,
  estimateLabel,
  estimateSeconds,
  modelLabel,
  setModelLabels,
  previewUrl,
  shortTime,
  videoCapabilities,
} from "../components/comfy/format";
import {
  COLUMN_GAP,
  HEADER_HEIGHT,
  HEADER_HEIGHT_SUBTITLE,
  LITERAL_MAX,
  NODE_WIDTH,
  layoutWorkflow,
  literalText,
  sortNodeIds,
  workflowClassTypes,
} from "../components/comfy/graph-layout";
import { assetCost, billedAsText, costCell, costSentence, formatEstimateCredits, jobCostText } from "../components/comfy/cost";
import { assetIdFromSubPath, assetSubPath } from "../components/comfy/tabs";
import { SHEET_DELETE_SEPARATOR } from "../components/comfy/touch-geometry";
import {
  attachReference,
  referenceLimit,
  referenceModel,
  droppedReferenceCount,
  referencesFromParams,
  removeReference,
  sentReferences,
  showsReferences,
} from "../components/comfy/form-session";
import { STRIP_FAILED_MS, JOBS_FAILED_MS, splitJobs, splitLibrary, unknownHeadline } from "../components/comfy/now";
import { LIBRARY_LIMIT } from "../components/comfy/library-paging";
import {
  batchesInOneRun,
  carryOver,
  extraOptionLabel,
  formModel,
  generateFields,
  initialValues,
  qualityOf,
  sizeModeOf,
  valuesFromParams,
} from "../components/comfy/model-form";
import { cheapestCredits, filtersFor, findModel, groupModels, listedModels, matchesQuery, sortModels } from "../components/comfy/model-list";
import {
  FLUX_2,
  GPT_IMAGE_2,
  IDEOGRAM_3,
  IMAGE_MODELS_FIXTURE,
  REVE_CREATE,
  SEEDANCE_1_FAST,
  SEEDANCE_25,
  SEEDREAM_4,
  SEEDREAM_5_PRO,
  VEO_3,
} from "./model-fixtures";
import { TILE_GAP, TILE_HEIGHTS, TILE_SIZES, familyOf, groupByDay, justifyRows, moveFocus, phoneRowHeight, rowHeightFor, tilePositions, tilesPerRow } from "../components/comfy/gallery-layout";

// ---------- fixtures ----------

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

const VIDEO_1_GRAPH: Workflow = {
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
  "2": {
    class_type: "SaveVideo",
    inputs: { video: ["1", 0], filename_prefix: "video/bb", format: "mp4", "format.codec": "h264" },
  },
};

const VIDEO_2_GRAPH: Workflow = {
  "1": {
    class_type: "ByteDance2TextToVideoNode",
    inputs: {
      model: "Seedance 2.0 Fast",
      "model.prompt": "a windmill turning slowly on a hill at dawn, one slow pan",
      "model.resolution": "480p",
      "model.ratio": "16:9",
      "model.duration": 4,
      "model.generate_audio": false,
      seed: 7,
      watermark: false,
    },
  },
  "2": {
    class_type: "SaveVideo",
    inputs: { video: ["1", 0], filename_prefix: "video/bb", format: "mp4", "format.codec": "h264" },
  },
};

const CATALOG: Record<string, NodeInfo> = {
  ByteDanceSeedreamNodeV2: {
    classType: "ByteDanceSeedreamNodeV2",
    displayName: "ByteDance Seedream",
    category: "partner/image/bytedance",
    outputs: ["IMAGE"],
    inputs: [{ name: "prompt", type: "STRING", required: true }],
  },
  SaveImage: {
    classType: "SaveImage",
    displayName: "Save Image",
    category: "image",
    outputs: [],
    inputs: [{ name: "images", type: "IMAGE", required: true }],
  },
};

/**
 * A stand-in for the detached `Image` the viewer decodes the original in, so a
 * test can decide when it lands, whether it fails, and whether the viewer let
 * go of it. jsdom loads no resources, so without this the swap never happens
 * and the test would be watching nothing.
 */
interface FakeImage {
  src: string;
  settle: () => void;
  fail: () => void;
  cancelled: boolean;
}

function stubImage(loads: FakeImage[]): () => void {
  const original = globalThis.Image;
  class Stub {
    #src = "";
    #resolve: (() => void) | null = null;
    #reject: (() => void) | null = null;
    entry: FakeImage;
    constructor() {
      this.entry = {
        src: "",
        cancelled: false,
        settle: () => this.#resolve?.(),
        fail: () => this.#reject?.(),
      };
    }
    set src(value: string) {
      // The viewer clears src to drop an in-flight request.
      if (value === "" && this.#src !== "") this.entry.cancelled = true;
      this.#src = value;
      if (value === "") return;
      this.entry.src = value;
      loads.push(this.entry);
    }
    get src(): string {
      return this.#src;
    }
    decode(): Promise<void> {
      return new Promise((resolve, reject) => {
        this.#resolve = resolve;
        this.#reject = () => reject(new Error("could not load"));
      });
    }
  }
  globalThis.Image = Stub as unknown as typeof globalThis.Image;
  return () => {
    globalThis.Image = original;
  };
}

/**
 * A phone, as far as the plugin can tell: the compact media query matches, and
 * optionally reduced motion. jsdom has no matchMedia at all, so every other
 * test renders the wide layout.
 */
function stubViewport({ compact = false, coarse = false, reduced = false }: { compact?: boolean; coarse?: boolean; reduced?: boolean }): () => void {
  const had = Object.prototype.hasOwnProperty.call(window, "matchMedia");
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches:
      (compact && query.includes("max-width: 767px")) ||
      (coarse && query.includes("pointer: coarse")) ||
      (reduced && query.includes("prefers-reduced-motion")),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    if (had) window.matchMedia = original;
    else delete (window as { matchMedia?: unknown }).matchMedia;
  };
}

/**
 * One finger down, along and up on an element, with pointer events the way a
 * phone sends them. An event's timeStamp is the wall clock and cannot be set,
 * so a slow drag really waits: fired back to back, every drag is a flick.
 */
async function drag(target: Element, from: { x: number; y: number }, to: { x: number; y: number }, holdMs = 0, pointerId = 1): Promise<void> {
  fireEvent.pointerDown(target, { pointerId, pointerType: "touch", clientX: from.x, clientY: from.y, button: 0 });
  fireEvent.pointerMove(target, { pointerId, pointerType: "touch", clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2 });
  fireEvent.pointerMove(target, { pointerId, pointerType: "touch", clientX: to.x, clientY: to.y });
  if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
  fireEvent.pointerUp(target, { pointerId, pointerType: "touch", clientX: to.x, clientY: to.y });
}

function tap(target: Element, at: { x: number; y: number }, pointerId = 1): void {
  fireEvent.pointerDown(target, { pointerId, pointerType: "touch", clientX: at.x, clientY: at.y, button: 0 });
  fireEvent.pointerUp(target, { pointerId, pointerType: "touch", clientX: at.x, clientY: at.y });
}

// 12:00 local time (UTC in tests), 30 days before the run: a library row has
// to sit in the past against the real clock, and noon keeps every fixture
// below on the same local day.
const BASE = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 30 * 86_400_000 + 12 * 3_600_000;

const IMAGE_ASSET: Asset = {
  id: "img_aaaaaaaa",
  kind: "image",
  status: "completed",
  prompt: "a brass compass on a folded map, overhead photo",
  model: "seedream 5.0 pro",
  params: { sizePreset: "(1K) 1024x1024 (1:1)", seed: 7 },
  file: "2031-06-17/img_aaaaaaaa.png",
  thumbPath: "2031-06-17/img_aaaaaaaa.thumb.webp",
  mediumPath: "2031-06-17/img_aaaaaaaa.medium.webp",
  path: "/data/.bb/plugins/comfy-cloud/assets/2031-06-17/img_aaaaaaaa.png",
  workflowPath: "/data/.bb/plugins/comfy-cloud/assets/2031-06-17/img_aaaaaaaa.workflow.json",
  mime: "image/png",
  width: 1024,
  height: 1024,
  durationS: null,
  sizeBytes: 1_234_567,
  comfyPromptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaabab",
  parentId: null,
  threadId: null,
  source: "panel",
  starred: false,
  error: null,
  estimatedCredits: 9.5,
  actualCredits: 9.5,
  billedModel: "seedream-5-0-pro-260628",
  outputTier: "standard",
  createdAt: BASE,
  startedAt: BASE + 1_000,
  completedAt: BASE + 30_000,
};

const VIDEO_ASSET: Asset = {
  id: "vid_bbbbbbbb",
  kind: "video",
  status: "completed",
  prompt: "a windmill turning slowly on a hill at dawn",
  model: "seedance-1-0-pro-fast-251015",
  params: { resolution: "480p", aspectRatio: "16:9", duration: 3, seed: 7 },
  file: "2031-06-17/vid_bbbbbbbb.mp4",
  path: "/data/.bb/plugins/comfy-cloud/assets/2031-06-17/vid_bbbbbbbb.mp4",
  workflowPath: "/data/.bb/plugins/comfy-cloud/assets/2031-06-17/vid_bbbbbbbb.workflow.json",
  mime: "video/mp4",
  width: 864,
  height: 480,
  durationS: 3,
  sizeBytes: 2_345_678,
  comfyPromptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaabaaa",
  parentId: null,
  threadId: "th_1",
  source: "tool",
  starred: true,
  error: null,
  estimatedCredits: 8.29,
  actualCredits: 8.29,
  billedModel: "seedance-1-0-pro-fast-251015",
  outputTier: null,
  createdAt: BASE - 120_000,
  startedAt: BASE - 118_000,
  completedAt: BASE - 90_000,
};

/** Newest first, as the server returns them. */
const ASSETS: Asset[] = [IMAGE_ASSET, VIDEO_ASSET];

const STATUS: Status = {
  configured: true,
  keySource: "key-file",
  configureHint: null,
  assetDir: "/data/.bb/plugins/comfy-cloud/assets",
  imageModel: "seedream 5.0 pro",
  videoModel: "seedance-1-0-pro-fast-251015",
  counts: { total: 2, images: 1, videos: 1, running: 0, failed: 0, failedRecent: 0 },
  catalogLoaded: true,
  registry: { generatedAt: "2031-04-10", catalogDate: "2031-04-09", catalogFetched: "2031-04-09" },
  balanceCredits: 3165,
  balanceUsd: 15,
  creditRate: DEFAULT_CREDIT_RATE,
};

const COSTS: Costs = {
  balanceCredits: 3165,
  balanceUsd: 15,
  creditRate: DEFAULT_CREDIT_RATE,
  spend: { today: 7.5, week: 42, total: 640 },
  byModel: [
    { model: "gpt-image-2", kind: "image", credits: 61.5, count: 14 },
    { model: "kling-v2-5-turbo", kind: "video", credits: 147.7, count: 2 },
    { model: "seedream 5.0 pro", kind: "image", credits: 85.5, count: 9 },
  ],
  recent: [],
  observed: [],
  days: 14,
};

const PREVIEW = { baseUrl: "http://bb.test/preview/abc", expiresAtMs: Date.now() + 60 * 60 * 1000 };
const ART = { baseUrl: "http://bb.test/preview/art", expiresAtMs: Date.now() + 60 * 60 * 1000 };

const notStubbed = (method: string) => () => {
  throw new Error(`${method} is not stubbed in this test`);
};

/**
 * What the `model_labels` RPC hands over: every name an asset row can carry,
 * mapped to the registry's own label. A row generated from the panel stores a
 * registry key, so without this map the Library would print "reve-create@20250915"
 * where the picker says "Reve Image Create".
 */
const MODEL_LABEL_STUB: Record<string, string> = {
  "ByteDanceSeedreamNodeV2/seedream 5.0 pro": "Seedream 5.0 Pro",
  "seedream 5.0 pro": "Seedream 5.0 Pro",
  "ReveImageCreateNode/reve-create@20250915": "Reve Image Create",
  "reve-create@20250915": "Reve Image Create",
};

function handlers(overrides: Partial<PluginRpcTestHandlers<RpcContract>> = {}): PluginRpcTestHandlers<RpcContract> {
  return {
    status: () => STATUS,
    costs: () => COSTS,
    assets_list: () => ({ assets: ASSETS }),
    asset_get: ({ id }) => {
      const asset = ASSETS.find((row) => row.id === id);
      if (asset === undefined) throw new Error(`no asset ${id}`);
      return { asset, workflow: asset.kind === "image" ? IMAGE_GRAPH : VIDEO_1_GRAPH, job: null };
    },
    preview_base: () => PREVIEW,
    art_base: () => ART,
    node_catalog: ({ classTypes }) => ({
      nodes: Object.fromEntries(classTypes.filter((type) => type in CATALOG).map((type) => [type, CATALOG[type]!])),
    }),
    models: notStubbed("models"),
    model_prefs: notStubbed("model_prefs"),
    model_labels: () => ({ labels: MODEL_LABEL_STUB }),
    generate_image: notStubbed("generate_image"),
    generate_video: notStubbed("generate_video"),
    run_workflow: notStubbed("run_workflow"),
    asset_retry: notStubbed("asset_retry"),
    asset_cancel: notStubbed("asset_cancel"),
    asset_star: notStubbed("asset_star"),
    asset_delete: notStubbed("asset_delete"),
    ...overrides,
  };
}

// ---------- pure modules ----------

describe("graph layout", () => {
  it("lays the image graph out in two columns joined by one edge", () => {
    const layout = layoutWorkflow(IMAGE_GRAPH, { catalog: CATALOG });
    expect(layout.nodes.map((node) => node.id)).toEqual(["1", "2"]);
    const [generator, saver] = layout.nodes;
    expect(generator!.depth).toBe(0);
    expect(saver!.depth).toBe(1);
    expect(saver!.x - generator!.x).toBe(NODE_WIDTH + COLUMN_GAP);
    expect(generator!.title).toBe("ByteDance Seedream");
    expect(saver!.title).toBe("Save Image");
    expect(generator!.outputs.map((output) => output.name)).toEqual(["IMAGE"]);
    expect(generator!.inputs.every((input) => input.kind === "literal")).toBe(true);
    expect(saver!.inputs.find((input) => input.name === "images")).toMatchObject({ kind: "link", from: { node: "1", slot: 0 } });

    expect(layout.edges).toHaveLength(1);
    const edge = layout.edges[0]!;
    expect(edge).toMatchObject({ from: "1", fromSlot: 0, to: "2", toInput: "images", type: "IMAGE" });
    // The catalog gives both nodes a display name, so their headers carry the class type under it.
    expect(generator!.headerHeight).toBe(HEADER_HEIGHT_SUBTITLE);
    expect(edge.x1).toBe(generator!.x + generator!.width);
    expect(edge.y1).toBe(generator!.outputs[0]!.y);
    expect(edge.x2).toBe(saver!.x);
    expect(edge.y2).toBe(saver!.inputs[0]!.y);
    expect(layout.width).toBeGreaterThan(saver!.x + saver!.width);
    expect(layout.height).toBeGreaterThan(generator!.y + generator!.height);
  });

  it("falls back to class types and inferred output ports without a catalog", () => {
    const layout = layoutWorkflow(VIDEO_1_GRAPH);
    const [generator, saver] = layout.nodes;
    expect(generator!.title).toBe("ByteDanceTextToVideoNode");
    expect(saver!.title).toBe("SaveVideo");
    expect(generator!.headerHeight).toBe(HEADER_HEIGHT);
    // Node 1 is referenced as ["1", 0], so it gets one inferred output port.
    expect(generator!.outputs).toHaveLength(1);
    expect(saver!.outputs).toHaveLength(0);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ from: "1", to: "2", toInput: "video", type: null });
    // Box height grows with the input count: 9 inputs versus 4.
    expect(generator!.height).toBeGreaterThan(saver!.height);
  });

  it("truncates long literals in the Seedance 2 graph", () => {
    const layout = layoutWorkflow(VIDEO_2_GRAPH);
    const prompt = layout.nodes[0]!.inputs.find((input) => input.name === "model.prompt");
    expect(prompt?.kind).toBe("literal");
    expect(prompt!.text.length).toBe(LITERAL_MAX);
    expect(prompt!.text.endsWith("…")).toBe(true);
    expect(layout.nodes[0]!.inputs.find((input) => input.name === "model.duration")?.text).toBe("4");
    expect(layout.edges[0]).toMatchObject({ from: "1", to: "2", toInput: "video" });
    expect(workflowClassTypes(VIDEO_2_GRAPH)).toEqual(["ByteDance2TextToVideoNode", "SaveVideo"]);
  });

  it("orders node ids numerically and uses the longest path for depth", () => {
    const graph: Workflow = {
      "10": { class_type: "C", inputs: { a: ["1", 0], b: ["2", 0] } },
      "2": { class_type: "B", inputs: { x: ["1", 0] } },
      "1": { class_type: "A", inputs: {} },
    };
    expect(sortNodeIds(Object.keys(graph))).toEqual(["1", "2", "10"]);
    const layout = layoutWorkflow(graph);
    const depth = Object.fromEntries(layout.nodes.map((node) => [node.id, node.depth]));
    expect(depth).toEqual({ "1": 0, "2": 1, "10": 2 });
    expect(layout.edges).toHaveLength(3);
    expect(literalText("x".repeat(100))).toHaveLength(LITERAL_MAX);
    expect(literalText({ nested: true })).toBe('{"nested":true}');
  });
});

describe("route and preview helpers", () => {
  it("round-trips the asset deep link, even when the host encodes it again", () => {
    expect(assetSubPath("img_aaaaaaaa")).toBe("a/img_aaaaaaaa");
    expect(assetIdFromSubPath("a/img_aaaaaaaa")).toBe("img_aaaaaaaa");
    expect(assetIdFromSubPath("/a/img_aaaaaaaa/")).toBe("img_aaaaaaaa");
    expect(assetIdFromSubPath(encodeURIComponent("a/img_aaaaaaaa").replace("a%2F", "a/"))).toBe("img_aaaaaaaa");
    expect(assetIdFromSubPath("")).toBeNull();
    expect(assetIdFromSubPath("generate")).toBeNull();
  });

  it("encodes every path segment of the preview URL separately", () => {
    expect(previewUrl("http://h/p/", "2031-06-17/a b#1.png")).toBe("http://h/p/2031-06-17/a%20b%231.png");
    expect(previewUrl("http://h/p", "x.png")).toBe("http://h/p/x.png");
  });
});

describe("gallery layout", () => {
  it("fills justified rows to the container width and leaves the last row at its natural size", () => {
    const items = Array.from({ length: 7 }, (_, index) => ({ id: `t${index}`, aspect: 1 }));
    const rows = justifyRows(items, 600, 100, TILE_GAP);
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.items).toHaveLength(6);
    expect(first.items.reduce((sum, item) => sum + item.width, 0) + TILE_GAP * 5).toBe(600);
    expect(first.height).toBeLessThanOrEqual(100);
    const last = rows[1]!;
    expect(last.items).toHaveLength(1);
    expect(last.height).toBe(100);
    expect(last.items[0]!.width).toBe(100);
  });

  // Each justified row spreads its rounding across all of its tiles, so no
  // last tile is narrowed and cropped, and no last row runs past the
  // container edge. These are the properties that hold both.
  it("fills every justified row to the pixel and keeps each tile on the row's scale", () => {
    // A small deterministic generator, so a failure is reproducible from its seed.
    const random = (seed: number) => {
      let state = seed >>> 0;
      return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
      };
    };
    for (let seed = 1; seed <= 600; seed += 1) {
      const next = random(seed);
      // Fractional widths on purpose: a ResizeObserver hands over fractions.
      const width = Math.round(160 + next() * 1400) + next();
      const rowHeight = Math.round(64 + next() * 300);
      const count = 1 + Math.floor(next() * 24);
      const items = Array.from({ length: count }, (_, index) => ({ id: `t${index}`, aspect: 0.4 + next() * 2.6 }));
      const rows = justifyRows(items, width, rowHeight, TILE_GAP);
      const where = `seed ${seed}, width ${width.toFixed(2)}, row height ${rowHeight}`;

      expect(rows.flatMap((row) => row.items).map((item) => item.id), where).toEqual(items.map((item) => item.id));
      for (const row of rows) {
        const total = row.items.reduce((sum, item) => sum + item.width, 0) + TILE_GAP * (row.items.length - 1);
        // Nothing ever reaches past the container edge, whatever the rounding did.
        expect(total, `${where}: row of ${row.items.length} runs to ${total}`).toBeLessThanOrEqual(width);
        // A justified row lands on the edge, within the pixel the width was floored to.
        if (row.justified) expect(Math.abs(total - Math.floor(width)), where).toBeLessThanOrEqual(1);
        // Every tile in a row shares one scale: no tile carries the drift alone.
        const scale = row.items.reduce((sum, item) => sum + item.width, 0) / row.items.reduce((sum, item) => sum + item.aspect, 0);
        expect(Math.abs(scale - row.height), `${where}: scale ${scale} against height ${row.height}`).toBeLessThanOrEqual(1.5);
        for (const item of row.items) {
          expect(item.width, where).toBeLessThanOrEqual(width);
          expect(Number.isInteger(item.width) && item.width >= 1, `${where}: width ${item.width}`).toBe(true);
          expect(Number.isInteger(item.height) && item.height >= 1, `${where}: height ${item.height}`).toBe(true);
          expect(Math.abs(item.width - item.aspect * scale), `${where}: tile off the row scale`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("keeps aspect ratios inside a row", () => {
    const rows = justifyRows(
      [
        { id: "wide", aspect: 2 },
        { id: "tall", aspect: 0.5 },
        { id: "square", aspect: 1 },
      ],
      400,
      120,
    );
    for (const row of rows) {
      for (const item of row.items) expect(Math.abs(item.width / item.height - item.aspect)).toBeLessThan(0.05);
    }
    expect(justifyRows([], 400, 120)).toEqual([]);
  });

  it("groups by local day with Today and Yesterday labels", () => {
    const now = Date.UTC(2031, 2, 20, 5, 0, 0);
    const groups = groupByDay(
      [
        { id: "a", createdAt: now - 60_000 },
        { id: "b", createdAt: now - 3 * 3_600_000 },
        { id: "c", createdAt: now - 26 * 3_600_000 },
        { id: "d", createdAt: now - 5 * 86_400_000 },
      ],
      now,
    );
    expect(groups.map((group) => group.items.length)).toEqual([2, 1, 1]);
    expect(groups[0]!.label).toBe("Today, 20 Mar 2031");
    expect(groups[1]!.label).toBe("Yesterday, 19 Mar 2031");
    expect(groups[2]!.label).toBe("Sat 15 Mar 2031");
  });

  it("moves focus along rows and to the nearest tile above or below", () => {
    const rows = justifyRows(
      Array.from({ length: 5 }, (_, index) => ({ id: `t${index}`, aspect: 1 })),
      300,
      100,
    );
    const positions = tilePositions(rows, 0);
    expect(moveFocus(positions, "t0", "ArrowRight")).toBe("t1");
    expect(moveFocus(positions, "t0", "ArrowLeft")).toBeNull();
    expect(moveFocus(positions, "t4", "ArrowRight")).toBeNull();
    expect(moveFocus(positions, "t0", "End")).toBe("t4");
    const below = moveFocus(positions, "t0", "ArrowDown");
    expect(below).not.toBeNull();
    expect(positions.find((position) => position.id === below)?.row).toBe(1);
    expect(moveFocus(positions, below!, "ArrowUp")).toBe("t0");
  });

  it("finds the family of an asset through parentId", () => {
    const child = { ...IMAGE_ASSET, id: "img_child001", parentId: IMAGE_ASSET.id, createdAt: IMAGE_ASSET.createdAt + 1 };
    const grandchild = { ...IMAGE_ASSET, id: "img_child002", parentId: child.id, createdAt: IMAGE_ASSET.createdAt + 2 };
    const family = familyOf([grandchild, child, IMAGE_ASSET, VIDEO_ASSET], child.id);
    expect(family.map((asset) => asset.id)).toEqual([IMAGE_ASSET.id, child.id, grandchild.id]);
    expect(familyOf([IMAGE_ASSET, VIDEO_ASSET], VIDEO_ASSET.id)).toHaveLength(1);
  });
});

// ---------- the panel ----------

describe("Comfy panel", () => {
  afterEach(() => {
    cleanup();
  });

  async function loadPanel() {
    const app = await loadPluginApp(() => import("../app"));
    const panel = app.navPanels[0];
    if (panel === undefined) throw new Error("no nav panel registered");
    return { app, panel };
  }

  it("registers the panel, its two fixed tabs, the settings section and two palette actions", async () => {
    const { app, panel } = await loadPanel();
    expect(panel.id).toBe("comfy");
    expect(panel.path).toBe("comfy");
    expect(panel.fixedTabs?.map((tab) => tab.id)).toEqual(["generate", "jobs"]);
    expect(app.settingsSections).toHaveLength(1);
  });

  it("renders the grid rows from assets_list with preview URLs", async () => {
    const { panel } = await loadPanel();
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "" }, { rpc: handlers() });
    const imageTile = await slot.findByRole("button", { name: /Image: a brass compass/ });
    await slot.findByRole("button", { name: /Video: a windmill turning slowly/ });
    expect(slot.container.querySelector("h3")?.textContent).toMatch(/\d{4}$/);
    // The count sits in the day header, not the toolbar, where the eye already is.
    expect(slot.container.querySelector("[data-day-count]")?.textContent).toBe("2");
    expect(slot.queryByText("2 assets")).toBeNull();
    const img = imageTile.querySelector("img");
    // The tile draws the 10 KB copy, not the original, so the grid never pulls
    // the originals on a phone.
    expect(img?.getAttribute("src")).toBe(`${PREVIEW.baseUrl}/2031-06-17/img_aaaaaaaa.thumb.webp`);
    // The first rows are what the panel was opened to see, so they are asked
    // for at once and first; everything under them waits to be scrolled to.
    expect(img?.getAttribute("loading")).toBe("eager");
    expect(img?.getAttribute("fetchpriority")).toBe("high");
    const video = slot.container.querySelector("video");
    expect(video?.getAttribute("src")).toBe(`${PREVIEW.baseUrl}/2031-06-17/vid_bbbbbbbb.mp4`);
    expect(slot.inspection.rpcCalls.some((call) => call.method === "assets_list")).toBe(true);
    expect(slot.inspection.rpcCalls.some((call) => call.method === "preview_base")).toBe(true);
  });

  it("selecting a tile navigates to the asset deep link and the viewer opens there", async () => {
    const { panel } = await loadPanel();
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "" }, { rpc: handlers() });
    const tile = await slot.findByRole("button", { name: /Image: a brass compass/ });
    fireEvent.click(tile);
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "comfy",
      options: { subPath: "a/img_aaaaaaaa", replace: true },
    });

    const Page = panel.component;
    slot.lifecycle.rerender(<Page subPath="a/img_aaaaaaaa" />);
    await slot.findByRole("button", { name: /^Regenerate/ });
    await slot.findByText("1 of 2");
    await slot.findByRole("button", { name: /Back to the Library/ });
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "asset_get", input: { id: "img_aaaaaaaa" } });
    expect(slot.getAllByText(IMAGE_ASSET.prompt).length).toBeGreaterThan(0);
    expect(slot.getByText("Seedream 5.0 Pro")).toBeTruthy();
    const download = slot.getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe(`${PREVIEW.baseUrl}/2031-06-17/img_aaaaaaaa.png`);
    expect(download.getAttribute("download")).toBe("img_aaaaaaaa.png");
  });

  it("the viewer spec strip carries a Cost cell and Details spells the bill out", async () => {
    const { panel } = await loadPanel();
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "a/img_aaaaaaaa" }, { rpc: handlers() });
    await slot.findByRole("button", { name: /^Regenerate/ });
    expect(slot.getAllByText("Cost").length).toBeGreaterThan(0);
    expect(slot.getByText("9.5 credits")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /^Details/ }));
    expect(slot.getByText("Billed 9.5 credits, as estimated.")).toBeTruthy();
    // The billed id is code, the tier is a word beside it.
    expect(slot.getByText("seedream-5-0-pro-260628")).toBeTruthy();
    expect(slot.getByText(", standard tier")).toBeTruthy();
  });

  it("arrow keys move through the filtered list and Escape returns to the grid", async () => {
    const { panel } = await loadPanel();
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "a/img_aaaaaaaa" }, { rpc: handlers() });
    await slot.findByText("1 of 2");

    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() =>
      expect(slot.inspection.navigateCalls.at(-1)).toEqual({
        method: "toPluginPanel",
        path: "comfy",
        options: { subPath: "a/vid_bbbbbbbb", replace: true },
      }),
    );

    // Newest is first, so there is nothing to the left of the first asset.
    const before = slot.inspection.navigateCalls.length;
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(slot.inspection.navigateCalls.length).toBe(before);

    const Page = panel.component;
    slot.lifecycle.rerender(<Page subPath="a/vid_bbbbbbbb" />);
    await slot.findByText("2 of 2");
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(slot.inspection.navigateCalls.at(-1)).toEqual({
        method: "toPluginPanel",
        path: "comfy",
        options: { subPath: "a/img_aaaaaaaa", replace: true },
      }),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(slot.inspection.navigateCalls.at(-1)).toEqual({
        method: "toPluginPanel",
        path: "comfy",
        options: { subPath: "", replace: true },
      }),
    );
  });

  it("the Graph toggle renders one SVG box per node with catalog names", async () => {
    const { panel } = await loadPanel();
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "a/img_aaaaaaaa" }, { rpc: handlers() });
    await slot.findByText("1 of 2");
    fireEvent.click(slot.getByRole("button", { name: "Graph" }));
    await waitFor(() => expect(slot.container.querySelectorAll("svg [data-node-id]")).toHaveLength(2));
    await waitFor(() =>
      expect(slot.container.querySelector('svg [data-node-id="2"] text')?.textContent).toContain("Save Image"),
    );
    expect(slot.container.querySelectorAll("svg [data-edge-id]")).toHaveLength(1);
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "node_catalog",
      input: { classTypes: ["ByteDanceSeedreamNodeV2", "SaveImage"] },
    });

    // Selecting a node shows its inputs as a form below the canvas; links are read only.
    fireEvent.click(slot.container.querySelector('svg [data-node-id="1"]')!);
    await slot.findAllByText(/model\.size_preset/);
    const preset = slot.container.querySelector<HTMLInputElement>('input[aria-label="model.size_preset"]');
    expect(preset?.value).toBe("(1K) 1024x1024 (1:1)");
    const promptBox = slot.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="prompt"]');
    expect(promptBox?.value).toBe(IMAGE_ASSET.prompt);
    fireEvent.click(slot.container.querySelector('svg [data-node-id="2"]')!);
    await slot.findAllByText(/filename_prefix/);
    await slot.findAllByText(/from ByteDance Seedream \(node 1\), IMAGE/);

    // Editing an input marks the graph changed and offers to run it.
    fireEvent.change(slot.container.querySelector<HTMLInputElement>('input[aria-label="filename_prefix"]')!, { target: { value: "bb-tweak" } });
    await slot.findByRole("button", { name: /Run tweaked workflow/ });
    expect(slot.getByText("(changed)")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(slot.queryByText("(changed)")).toBeNull());
  });

  it("reads well when nothing has been generated and no key is configured", async () => {
    const { panel } = await loadPanel();
    const hint = "Set the apiKey setting, add COMFY_API_KEY to the plugin .env, or point keyFile at a dotenv file.";
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(
      panel,
      { subPath: "" },
      {
        rpc: handlers({
          status: () => ({ ...STATUS, configured: false, keySource: null, configureHint: hint, counts: { ...STATUS.counts, total: 0 } }),
          assets_list: () => ({ assets: [] }),
        }),
      },
    );
    await slot.findByText("Add your Comfy Cloud key");
    expect(slot.container.querySelector("pre")?.textContent).toContain("bb secret request COMFY_API_KEY --write-env");
    expect(slot.getByRole("link", { name: "Open settings" }).getAttribute("href")).toBe("/settings/plugins/comfy-cloud");
    slot.lifecycle.unmount();

    const empty = renderSlot<PluginNavPanelProps, RpcContract>(
      panel,
      { subPath: "" },
      { rpc: handlers({ status: () => ({ ...STATUS, counts: { ...STATUS.counts, total: 0 } }), assets_list: () => ({ assets: [] }) }) },
    );
    await empty.findByText("Nothing generated yet");
    fireEvent.click(empty.getByRole("button", { name: /Generate an image/ }));
    expect(empty.inspection.experimental_fixedTabOpenCalls).toContainEqual({ surface: { kind: "current" }, panelId: "comfy", tabId: "generate" });
    empty.lifecycle.unmount();

    const Header = panel.headerContent;
    if (Header === undefined) throw new Error("no headerContent registered");
    const header = renderSlot<PluginNavPanelProps, RpcContract>(
      { component: Header },
      { subPath: "" },
      { rpc: handlers({ status: () => ({ ...STATUS, configured: false, keySource: null, configureHint: hint }) }) },
    );
    await header.findByText("No key");
    expect(header.getByRole("button", { name: "Generate" })).toBeTruthy();
  });

  it("shows a running row's elapsed time and offers Retry and Delete on a failed one", async () => {
    const { panel } = await loadPanel();
    const running: Asset = { ...IMAGE_ASSET, id: "img_running1", status: "running", file: null, startedAt: Date.now() - 12_000, completedAt: null };
    const failed: Asset = { ...IMAGE_ASSET, id: "img_failed01", status: "failed", file: null, error: "The size was refused: it is below the smallest size this model takes.", completedAt: null };
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(
      panel,
      { subPath: "" },
      { rpc: handlers({ assets_list: () => ({ assets: [running, failed, ...ASSETS] }) }) },
    );
    // The estimate on the tile is the same sentence the Generate button quotes.
    await slot.findByText(/of about 20 to 40 s/);
    await slot.findByText("Failed");
    await slot.findByText(/below the smallest size this model takes/);
    expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Delete" })).toBeTruthy();
    // A completed row carries the star toggle, a running one does not.
    expect(slot.getAllByRole("button", { name: /Star|Remove star/ })).toHaveLength(3);
  });

  it("offers older work past the first page instead of stopping at it", async () => {
    // The Library starts with the newest LIBRARY_LIMIT rows, and "Show older"
    // reaches everything past them.
    const { panel } = await loadPanel();
    const page: Asset[] = Array.from({ length: LIBRARY_LIMIT + 5 }, (_, index) => ({
      ...IMAGE_ASSET,
      id: `img_pg${String(index).padStart(6, "0")}`,
      createdAt: IMAGE_ASSET.createdAt - index * 60_000,
    }));
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(
      panel,
      { subPath: "" },
      { rpc: handlers({ assets_list: (input) => ({ assets: page.slice(0, (input as { limit?: number }).limit ?? 100) }) }) },
    );
    const more = await slot.findByRole("button", { name: "Show older" });
    expect(slot.container.querySelectorAll("[data-tile-id]")).toHaveLength(LIBRARY_LIMIT);
    fireEvent.click(more);
    await waitFor(() => expect(slot.container.querySelectorAll("[data-tile-id]")).toHaveLength(LIBRARY_LIMIT + 5));
    const asked = slot.inspection.rpcCalls.filter((call) => call.method === "assets_list").map((call) => (call.input as { limit?: number }).limit);
    expect(asked).toContain(LIBRARY_LIMIT * 2);
    // Everything is loaded now, so there is no button promising more.
    expect(slot.queryByRole("button", { name: "Show older" })).toBeNull();
  });

  it("counts only the filtered page when it decides whether older rows exist", async () => {
    // With a filter on, the failed and in-progress rows are fetched apart and
    // merged in. A starred page just under the limit plus a few failed rows
    // adds up to more than the limit, and "Show older" must still not appear
    // for a page that is whole.
    const { panel } = await loadPanel();
    const starredPage: Asset[] = Array.from({ length: 195 }, (_, index) => ({
      ...IMAGE_ASSET,
      id: `img_st${String(index).padStart(6, "0")}`,
      starred: true,
      createdAt: IMAGE_ASSET.createdAt - index * 60_000,
    }));
    const failedRows: Asset[] = Array.from({ length: 10 }, (_, index) => ({
      ...IMAGE_ASSET,
      id: `img_fl${String(index).padStart(6, "0")}`,
      status: "failed",
      file: null,
      error: "Comfy Cloud reported an error",
      createdAt: IMAGE_ASSET.createdAt - (200 + index) * 60_000,
      completedAt: IMAGE_ASSET.createdAt - (200 + index) * 60_000,
    }));
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(
      panel,
      { subPath: "" },
      {
        rpc: handlers({
          assets_list: (input) => {
            const args = input as { starred?: boolean; status?: string };
            if (args.status === "failed") return { assets: failedRows };
            if (args.status !== undefined) return { assets: [] };
            return { assets: args.starred ? starredPage : [...starredPage, ...failedRows] };
          },
        }),
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Show starred only" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((call) => call.method === "assets_list" && (call.input as { status?: string }).status === "failed")).toBe(true),
    );
    await waitFor(() => expect(slot.container.querySelectorAll("[data-tile-id]").length).toBeGreaterThan(0));
    expect(slot.queryByRole("button", { name: "Show older" })).toBeNull();
  });

  it("loads only the first rows eagerly and fades each picture in once it has decoded", async () => {
    const { panel } = await loadPanel();
    // jsdom measures nothing, so every tile is its own row and the eager rows are the first two tiles.
    const many: Asset[] = Array.from({ length: 5 }, (_, index) => ({ ...IMAGE_ASSET, id: `img_many000${index}`, createdAt: IMAGE_ASSET.createdAt - index * 1000 }));
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "" }, { rpc: handlers({ assets_list: () => ({ assets: many }) }) });
    await slot.findAllByRole("button", { name: /Image: a brass compass/ });
    const images = Array.from(slot.container.querySelectorAll<HTMLImageElement>("[data-tile-id] img"));
    expect(images.map((image) => image.getAttribute("loading"))).toEqual(["eager", "eager", "lazy", "lazy", "lazy"]);
    expect(images.map((image) => image.getAttribute("fetchpriority"))).toEqual(["high", "high", "auto", "auto", "auto"]);
    // The box is sized before the bytes: the tile carries its width and height
    // from the stored pixels, and the picture is transparent until it decodes.
    const tile = slot.container.querySelector<HTMLElement>("[data-tile-id]");
    expect(tile?.style.width).not.toBe("");
    expect(tile?.style.height).not.toBe("");
    expect(images[0]!.className).toContain("opacity-0");
    fireEvent.load(images[0]!);
    expect(images[0]!.className).toContain("opacity-100");
    expect(images[0]!.className).toContain("motion-reduce:transition-none");
  });

  it("puts what is running, and what failed in the last hour, in a Now strip above the first day", async () => {
    const { panel } = await loadPanel();
    const now = Date.now();
    const running: Asset = { ...IMAGE_ASSET, id: "img_running1", status: "running", file: null, createdAt: now - 20_000, startedAt: now - 12_000, completedAt: null };
    const fresh: Asset = { ...IMAGE_ASSET, id: "img_freshfai", status: "failed", file: null, error: "Steps must be at least 8", createdAt: now - 120_000, completedAt: now - 100_000 };
    const stale: Asset = { ...IMAGE_ASSET, id: "img_stalefai", status: "failed", file: null, error: "An old refusal", createdAt: now - 3 * 3600_000, completedAt: now - 3 * 3600_000 };
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(
      panel,
      { subPath: "" },
      { rpc: handlers({ assets_list: () => ({ assets: [running, fresh, stale, ...ASSETS] }), asset_retry: () => ({ asset: { ...fresh, id: "img_again001", status: "queued" } }) }) },
    );
    const strip = await slot.findByRole("region", { name: "Now" });
    expect(strip.querySelector('[data-now-id="img_running1"]')).not.toBeNull();
    expect(strip.querySelector('[data-now-id="img_freshfai"]')).not.toBeNull();
    // An hour on, a failure is history: it is a tile in its day, not news.
    expect(strip.querySelector('[data-now-id="img_stalefai"]')).toBeNull();
    expect(slot.container.querySelector('[data-tile-id="img_stalefai"]')).not.toBeNull();
    // A row is in one place only: a running card and a running tile would be the same news twice.
    expect(slot.container.querySelector('[data-tile-id="img_running1"]')).toBeNull();
    expect(strip.textContent).toContain("1 in progress, 1 failed");
    expect(strip.textContent).toMatch(/of about 20 to 40 s/);
    // Tapping a card brings the Jobs tab forward, where the whole story is.
    fireEvent.click(within(strip).getByRole("button", { name: /^\d+ s of about.*Open Jobs$/ }));
    expect(slot.inspection.experimental_fixedTabOpenCalls).toContainEqual({ surface: { kind: "current" }, panelId: "comfy", tabId: "jobs" });
    // A fresh failure carries Retry on its card, and a double tap is one
    // retry: each call is a new paid generation.
    const retryButton = within(strip).getByRole("button", { name: /Retry/ });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "asset_retry", input: { id: "img_freshfai" } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "asset_retry")).toHaveLength(1);
  });

  it("draws no Now strip when nothing is happening", async () => {
    const { panel } = await loadPanel();
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "" }, { rpc: handlers() });
    await slot.findByRole("button", { name: /Image: a brass compass/ });
    expect(slot.queryByRole("region", { name: "Now" })).toBeNull();
  });

  it("draws a row that has no small copy yet from the original", async () => {
    // A row from before the backfill, or one whose ffmpeg run failed, has no
    // small copy. The thumbnail is an optimisation, so nothing may depend on
    // it existing.
    const { panel } = await loadPanel();
    const bare: Asset = { ...IMAGE_ASSET, thumbPath: null, mediumPath: null };
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "" }, { rpc: handlers({ assets_list: () => ({ assets: [bare] }) }) });
    await slot.findByRole("button", { name: /Image: a brass compass/ });
    expect(slot.container.querySelector("img")?.getAttribute("src")).toBe(`${PREVIEW.baseUrl}/2031-06-17/img_aaaaaaaa.png`);
  });

  it("gives a video tile a poster and fetches no video until it is asked to play", async () => {
    // A tile must not mount the whole clip to show a still, which a phone pays
    // for and never plays.
    const { panel } = await loadPanel();
    const withPoster: Asset = { ...VIDEO_ASSET, thumbPath: "2031-06-17/vid_bbbbbbbb.thumb.webp" };
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "" }, { rpc: handlers({ assets_list: () => ({ assets: [withPoster] }) }) });
    await slot.findByRole("button", { name: /Video: a windmill turning slowly/ });
    const video = slot.container.querySelector("video");
    expect(video?.getAttribute("poster")).toBe(`${PREVIEW.baseUrl}/2031-06-17/vid_bbbbbbbb.thumb.webp`);
    expect(video?.getAttribute("preload")).toBe("none");
    // The clip is still the source, because the tile plays it on hover.
    expect(video?.getAttribute("src")).toBe(`${PREVIEW.baseUrl}/2031-06-17/vid_bbbbbbbb.mp4`);
  });

  it("opens the viewer on the thumbnail and settles on the view copy, never the original", async () => {
    // The stage ends at the 2048 px view copy and the download is full
    // resolution, so the multi megabyte original is fetched by nothing but
    // Download.
    const loads: FakeImage[] = [];
    const restore = stubImage(loads);
    try {
      const { panel } = await loadPanel();
      const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "a/img_aaaaaaaa" }, { rpc: handlers() });
      const stage = await slot.findByAltText(IMAGE_ASSET.prompt);
      expect(stage.getAttribute("src")).toBe(`${PREVIEW.baseUrl}/2031-06-17/img_aaaaaaaa.thumb.webp`);
      expect(loads[0]?.src).toBe(`${PREVIEW.baseUrl}/2031-06-17/img_aaaaaaaa.medium.webp`);
      await act(async () => {
        loads[0]!.settle();
      });
      expect(slot.getByAltText(IMAGE_ASSET.prompt).getAttribute("src")).toBe(`${PREVIEW.baseUrl}/2031-06-17/img_aaaaaaaa.medium.webp`);
      expect(
        loads.some((load) => load.src.endsWith("img_aaaaaaaa.png")),
        "the original is never loaded into the stage",
      ).toBe(false);
    } finally {
      restore();
    }
  });

  it("asks the media route for every picture once the row carries versions", async () => {
    // The route is what lets a phone keep a picture across openings of the
    // panel: bb's own preview answers no-cache under a new base URL every time.
    const loads: FakeImage[] = [];
    const restore = stubImage(loads);
    try {
      const versioned: Asset = { ...IMAGE_ASSET, fileVersion: "f1", thumbVersion: "t1", mediumVersion: "m1" };
      const route = "/api/v1/plugins/comfy-cloud/http/media";
      const { panel } = await loadPanel();
      const grid = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "" }, { rpc: handlers({ assets_list: () => ({ assets: [versioned] }) }) });
      const tile = await grid.findByRole("button", { name: /Image: a brass compass/ });
      expect(tile.querySelector("img")?.getAttribute("src")).toBe(`${route}?p=2031-06-17%2Fimg_aaaaaaaa.thumb.webp&v=t1`);
      grid.lifecycle.unmount();

      const slot = renderSlot<PluginNavPanelProps, RpcContract>(
        panel,
        { subPath: "a/img_aaaaaaaa" },
        { rpc: handlers({ assets_list: () => ({ assets: [versioned] }), asset_get: () => ({ asset: versioned, workflow: {}, job: null }) }) },
      );
      await slot.findByRole("button", { name: /^Regenerate/ });
      await waitFor(() => expect(loads.some((load) => load.src === `${route}?p=2031-06-17%2Fimg_aaaaaaaa.medium.webp&v=m1`)).toBe(true));
      // Download is the untouched original, as an attachment.
      const download = slot.getByRole("link", { name: "Download" });
      expect(download.getAttribute("href")).toBe(`${route}?p=2031-06-17%2Fimg_aaaaaaaa.png&v=f1&download=1`);
    } finally {
      restore();
    }
  });

  it("says so rather than leaving a soft copy passing for the file", async () => {
    const loads: FakeImage[] = [];
    const restore = stubImage(loads);
    try {
      const { panel } = await loadPanel();
      const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "a/img_aaaaaaaa" }, { rpc: handlers() });
      await slot.findByAltText(IMAGE_ASSET.prompt);
      await act(async () => {
        loads[0]!.fail();
      });
      // The thumbnail stays up, because a reduced picture beats no picture,
      // and the line underneath stops it reading as the real thing.
      expect(slot.getByAltText(IMAGE_ASSET.prompt).getAttribute("src")).toContain("thumb.webp");
      await slot.findByText(/reduced copy/i);
    } finally {
      restore();
    }
  });

  it("drops the original when the viewer goes away before it lands", async () => {
    // A late arrival must not paint over whatever is on screen now.
    //
    // This closes the viewer rather than swiping, because the harness renders a
    // fixed subPath; both go through the same effect cleanup, which is the
    // thing being tested. The swipe case is the one to check by hand.
    const loads: FakeImage[] = [];
    const restore = stubImage(loads);
    try {
      const { panel } = await loadPanel();
      const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "a/img_aaaaaaaa" }, { rpc: handlers() });
      await slot.findByAltText(IMAGE_ASSET.prompt);
      const first = loads[0]!;
      expect(first.cancelled).toBe(false);
      slot.lifecycle.unmount();
      expect(first.cancelled, "the request is dropped rather than left running").toBe(true);
      // And the late arrival changes nothing, rather than throwing on a
      // component that is gone.
      await act(async () => {
        first.settle();
      });
    } finally {
      restore();
    }
  });

  it("swipes to the next picture and snaps back from a short drag", async () => {
    const { panel } = await loadPanel();
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "a/img_aaaaaaaa" }, { rpc: handlers() });
    await slot.findByText("1 of 2");
    const surface = slot.container.querySelector("[data-stage-surface]")!;
    const track = slot.container.querySelector<HTMLElement>("[data-stage-track]")!;
    const before = slot.inspection.navigateCalls.length;
    // 20 px over a fifth of a second is a hesitation, not a swipe: the picture
    // goes back where it was.
    await drag(surface, { x: 200, y: 100 }, { x: 180, y: 102 }, 200);
    expect(track.style.transform).toBe("translateX(0px)");
    expect(slot.inspection.navigateCalls.length).toBe(before);
    // A finger moving left pulls the next picture in from the right.
    await drag(surface, { x: 200, y: 100 }, { x: 120, y: 104 });
    await waitFor(() =>
      expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "comfy", options: { subPath: "a/vid_bbbbbbbb", replace: true } }),
    );
    expect(slot.inspection.navigateCalls.length).toBe(before + 1);
    // Nothing is newer than the first asset, so a drag the other way only resists.
    await drag(surface, { x: 100, y: 100 }, { x: 220, y: 100 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(slot.inspection.navigateCalls.length).toBe(before + 1);
  });

  it("zooms to 2.5x on a double tap and back out on the next, and stops swiping while zoomed", async () => {
    const { panel } = await loadPanel();
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "a/img_aaaaaaaa" }, { rpc: handlers() });
    await slot.findByAltText(IMAGE_ASSET.prompt);
    const surface = slot.container.querySelector("[data-stage-surface]")!;
    const zoom = () => slot.container.querySelector<HTMLElement>("[data-stage-zoom]")!.style.transform;
    expect(zoom()).toBe("");
    tap(surface, { x: 40, y: 40 });
    tap(surface, { x: 42, y: 41 });
    await waitFor(() => expect(zoom()).toContain("scale(2.5)"));
    // Zoomed, one finger pans and the list stays where it is.
    const before = slot.inspection.navigateCalls.length;
    await drag(surface, { x: 200, y: 100 }, { x: 60, y: 100 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(slot.inspection.navigateCalls.length).toBe(before);
    tap(surface, { x: 40, y: 40 });
    tap(surface, { x: 40, y: 40 });
    await waitFor(() => expect(zoom()).toBe(""));
  });

  it("loads the original only when Full resolution is asked for, and says so on the stage", async () => {
    const loads: FakeImage[] = [];
    const restore = stubImage(loads);
    try {
      const { panel } = await loadPanel();
      const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "a/img_aaaaaaaa" }, { rpc: handlers() });
      await slot.findByAltText(IMAGE_ASSET.prompt);
      await act(async () => loads[0]!.settle());
      expect(loads.some((load) => load.src.endsWith("img_aaaaaaaa.png"))).toBe(false);
      fireEvent.click(slot.getByRole("button", { name: /Full resolution/ }));
      await waitFor(() => expect(loads.some((load) => load.src === `${PREVIEW.baseUrl}/2031-06-17/img_aaaaaaaa.png`)).toBe(true));
      // Until the original has decoded the view copy stays on screen.
      expect(slot.getByAltText(IMAGE_ASSET.prompt).getAttribute("src")).toContain("medium.webp");
      await act(async () => loads.at(-1)!.settle());
      expect(slot.getByAltText(IMAGE_ASSET.prompt).getAttribute("src")).toBe(`${PREVIEW.baseUrl}/2031-06-17/img_aaaaaaaa.png`);
      expect(slot.getAllByText("Full resolution").length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("offers Use as reference on a finished image and hands the asset to the Generate tab", async () => {
    const { panel } = await loadPanel();
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "a/img_aaaaaaaa" }, { rpc: handlers() });
    const button = await slot.findByRole("button", { name: "Use as reference" });
    fireEvent.click(button);
    expect(slot.inspection.experimental_fixedTabOpenCalls).toContainEqual({ surface: { kind: "current" }, panelId: "comfy", tabId: "generate" });
    slot.lifecycle.unmount();
    // A video cannot be a reference, and the button says so rather than failing later.
    const video = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "a/vid_bbbbbbbb" }, { rpc: handlers() });
    expect(((await video.findByRole("button", { name: "Use as reference" })) as HTMLButtonElement).disabled).toBe(true);
  });

  describe("on a phone", () => {
    it("lays a slim bar over a black stage, hides it on a tap, and puts the four actions two by two", async () => {
      const restore = stubViewport({ compact: true, coarse: true });
      try {
        const { panel } = await loadPanel();
        const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "a/img_aaaaaaaa" }, { rpc: handlers() });
        await slot.findByAltText(IMAGE_ASSET.prompt);
        const stage = slot.container.querySelector<HTMLElement>("[data-stage]")!;
        expect(stage.className).toContain("bg-black");
        const bar = slot.container.querySelector<HTMLElement>("[data-overlay-bar]")!;
        expect(bar.textContent).toContain("1 of 2");
        // The header has no glyph row: star, download and delete live in the sheet.
        expect(slot.queryByRole("button", { name: "Star" })).toBeNull();
        expect(slot.queryByRole("button", { name: "Delete" })).toBeNull();
        // Regenerate, Tweak, Use as reference, Download: one grid, two columns.
        const regenerate = slot.getByRole("button", { name: /^Regenerate/ });
        const grid = regenerate.parentElement!;
        expect(grid.className).toContain("grid-cols-2");
        expect(grid.children).toHaveLength(4);
        expect(slot.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(`${PREVIEW.baseUrl}/2031-06-17/img_aaaaaaaa.png`);
        for (const cell of Array.from(grid.children)) expect(cell.className, cell.textContent ?? "").toContain("h-11");
        // One tap on the picture hides the bar, another brings it back.
        tap(slot.container.querySelector("[data-stage-surface]")!, { x: 50, y: 50 });
        await waitFor(() => expect(bar.getAttribute("aria-hidden")).toBe("true"));
        tap(slot.container.querySelector("[data-stage-surface]")!, { x: 50, y: 50 });
        await waitFor(() => expect(bar.getAttribute("aria-hidden")).toBe("false"));
      } finally {
        restore();
      }
    });

    it("keeps Star, Copy prompt, Full resolution, the graph and Delete in the sheet, Delete last and apart", async () => {
      const restore = stubViewport({ compact: true, coarse: true });
      try {
        const { panel } = await loadPanel();
        const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "a/img_aaaaaaaa" }, { rpc: handlers() });
        await slot.findByAltText(IMAGE_ASSET.prompt);
        fireEvent.click(within(slot.container.querySelector<HTMLElement>("[data-overlay-bar]")!).getByRole("button", { name: "More actions" }));
        const menu = await slot.findByRole("menu");
        const items = within(menu).getAllByRole("menuitem").map((item) => item.textContent ?? "");
        expect(items.map((text) => text.replace(/\d.*$/, "").trim())).toEqual(["Star", "Copy prompt", "Full resolution", "Show the graph", "Edit workflow", "Delete"]);
        // The first row takes the focus, so the keyboard and Escape reach the sheet.
        expect(document.activeElement?.textContent).toBe("Star");
        // Delete is set apart by the separator touch-geometry.ts measures.
        const remove = within(menu).getByRole("menuitem", { name: "Delete" });
        expect(remove.parentElement?.className).toBe(SHEET_DELETE_SEPARATOR.class);
        // And it opens the one confirm rather than deleting.
        fireEvent.click(remove);
        const dialog = await slot.findByRole("dialog", { name: /Delete this image/ });
        expect(dialog.textContent).toContain("There is no undo.");
        expect(slot.inspection.rpcCalls.some((call) => call.method === "asset_delete")).toBe(false);
      } finally {
        restore();
      }
    });
  });

  it("names what a delete takes and puts the focus on Cancel", async () => {
    // A dialog is for irreversible actions only, and this is the plugin's one
    // confirm, so it has to earn it: say what goes rather than assert that it
    // is permanent, and let a habitual return key cancel.
    const { panel } = await loadPanel();
    // A completed row is deleted from the Viewer, which is the asset subPath.
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "a/img_aaaaaaaa" }, { rpc: handlers() });
    fireEvent.click(await slot.findByRole("button", { name: "Delete" }));
    const dialog = await slot.findByRole("dialog");
    expect(dialog.textContent).toContain("its prompt and its workflow all go");
    expect(dialog.textContent).toContain("no Regenerate and no Tweak");
    // The money is the part that does not come back, and it is quoted the same
    // way the viewer's COST cell quotes it.
    expect(dialog.textContent).toContain("It cost 9.5 credits.");
    expect(dialog.textContent).toContain("There is no undo.");
    expect(dialog.textContent).not.toContain("cannot be undone");
    const cancel = slot.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);
    expect(slot.queryByRole("dialog")).toBe(null);
    expect(slot.inspection.rpcCalls.some((call) => call.method === "asset_delete")).toBe(false);
  });

  it("says what a failed row loses, which is not a picture", async () => {
    const { panel } = await loadPanel();
    const failed: Asset = { ...IMAGE_ASSET, id: "img_failed02", status: "failed", file: null, path: null, actualCredits: null, estimatedCredits: null };
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "" }, { rpc: handlers({ assets_list: () => ({ assets: [failed] }) }) });
    await slot.findByText("Failed");
    fireEvent.click(slot.getAllByRole("button", { name: "Delete" })[0]!);
    const dialog = await slot.findByRole("dialog");
    // Nothing was produced and nothing was billed, so the sentence claims
    // neither: no "the image goes" and no invented cost.
    expect(dialog.textContent).toContain("Its prompt and its workflow go");
    expect(dialog.textContent).not.toContain("It cost");
    expect(dialog.textContent).toContain("There is no undo.");
  });

  it("refetches the list on the comfy-changed signal", async () => {
    const { panel } = await loadPanel();
    const slot = renderSlot<PluginNavPanelProps, RpcContract>(panel, { subPath: "" }, { rpc: handlers() });
    await slot.findByRole("button", { name: /Image: a brass compass/ });
    const before = slot.inspection.rpcCalls.filter((call) => call.method === "assets_list").length;
    await slot.behavior.emitRealtime("comfy-changed", { at: Date.now(), assetId: "img_aaaaaaaa" });
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.filter((call) => call.method === "assets_list").length).toBeGreaterThan(before),
    );
  });
});

describe("tile sizes", () => {
  it("hits 3, 2 and 1 in a 560 px panel and 5, 4 and 3 at full width", () => {
    // The gallery is the panel less its 12 px gutters.
    expect(TILE_SIZES.map((size) => tilesPerRow(size, 560 - 24))).toEqual([3, 2, 1]);
    expect(TILE_SIZES.map((size) => tilesPerRow(size, 1120 - 24))).toEqual([5, 4, 3]);
  });

  it("keeps the three sizes apart at every width, and bigger always means fewer", () => {
    for (let width = 240; width <= 1600; width += 4) {
      const [small, medium, large] = TILE_SIZES.map((size) => tilesPerRow(size, width));
      expect(small).toBeGreaterThan(medium!);
      expect(medium).toBeGreaterThanOrEqual(large!);
      expect(large).toBeGreaterThanOrEqual(1);
      // The row height is the other half of the difference: S is always the
      // shortest row and L the tallest, whatever the container does.
      const heights = TILE_SIZES.map((size) => rowHeightFor(size, width));
      expect(heights[0]).toBeLessThan(heights[1]!);
      expect(heights[1]).toBeLessThanOrEqual(heights[2]!);
    }
  });

  it("packs two squares a row on a phone at every phone width", () => {
    // The phone has one density. Two squares must close a row at every width a
    // phone can hand over, fractions included, which is why the row height
    // rounds up.
    for (let width = 320; width <= 460; width += 0.2) {
      const height = phoneRowHeight(width);
      const squares = justifyRows(Array.from({ length: 6 }, (_, index) => ({ id: `s${index}`, aspect: 1 })), width, height);
      expect(squares.map((row) => row.items.length), `width ${width.toFixed(1)}`).toEqual([2, 2, 2]);
    }
    expect(phoneRowHeight(0)).toBe(TILE_HEIGHTS.L);
  });

  it("falls back to the fixed heights before the container is measured", () => {
    expect(rowHeightFor("M", 0)).toBe(TILE_HEIGHTS.M);
    expect(rowHeightFor("M", Number.NaN)).toBe(TILE_HEIGHTS.M);
  });
});

describe("times and estimates", () => {
  const base = Date.parse("2031-11-05T23:45:00Z"); // 23:45 local time (UTC in tests)

  it("is relative for an hour, then the local clock, then the date", () => {
    expect(shortTime(base, base + 20_000)).toBe("now");
    expect(shortTime(base, base + 19 * 60_000)).toBe("19m");
    // Still 5 November local time: the clock alone.
    const morning = Date.parse("2031-11-05T09:30:00Z"); // 09:30 local time (UTC in tests)
    expect(shortTime(morning, morning + 90 * 60_000)).toBe("09:30");
    // Past midnight, so the date comes back.
    expect(shortTime(base, base + 90 * 60_000)).toBe("5 Nov 23:45");
    expect(shortTime(base, base + 26 * 3_600_000)).toBe("5 Nov 23:45");
    expect(clockTime(base)).toBe("23:45");
  });

  it("estimates images by tier and videos by model, length and resolution", () => {
    expect(estimateSeconds("image", "seedream 5.0 pro", { sizePreset: "(1K) 1024x1024 (1:1)" }).low).toBe(20);
    expect(estimateSeconds("image", "seedream 5.0 pro", { sizePreset: "(2K) 2048x2048 (1:1)" }).low).toBe(40);
    expect(estimateSeconds("video", "seedance-1-0-pro-fast-251015", { duration: 5, resolution: "480p" }).low).toBe(35);
    expect(estimateSeconds("video", "Seedance 2.0 Fast", { duration: 5, resolution: "480p" }).low).toBe(110);
    expect(estimateSeconds("video", "Seedance 2.0", { duration: 5, resolution: "1080p" }).low).toBe(220);
    expect(estimateLabel({ low: 20, high: 44 })).toBe("about 20 to 40 s");
    expect(estimateLabel({ low: 60, high: 120 })).toBe("about 1 to 2 min");
    expect(estimateLabel({ low: 20, high: 20 })).toBe("about 20 s");
  });

  it("quotes both ends of the estimate on a running row, like the Generate button", () => {
    const started = Date.parse("2031-02-11T09:30:00Z");
    const running: Asset = { ...IMAGE_ASSET, status: "running", startedAt: started, completedAt: null };
    expect(elapsedOfEstimate(running, started + 35_000)).toBe("35 s of about 20 to 40 s");
  });

  it("shows friendly model labels for both kinds", () => {
    expect(modelLabel("seedream 5.0 pro")).toBe("Seedream 5.0 Pro");
    expect(modelLabel("seedance-1-5-pro-251215")).toBe("Seedance 1.5 Pro");
    expect(modelLabel("something-else")).toBe("something-else");
    // A row generated from the picker carries the registry key, which is the
    // node class and the model id; the id is the half worth reading.
    expect(modelLabel("ByteDanceSeedreamNodeV3/seedream 5.0 pro")).toBe("Seedream 5.0 Pro");
    expect(modelLabel("Flux2ImageNode/Flux.2 [pro]")).toBe("Flux.2 [pro]");
  });

  it("names every model once the label map has arrived", () => {
    // Without the map the id after the slash is all the panel has, and the
    // Library reads "reve-create@20250915" while the picker says "Reve Image Create".
    setModelLabels({});
    expect(modelLabel("ReveImageCreateNode/reve-create@20250915")).toBe("reve-create@20250915");
    setModelLabels(MODEL_LABEL_STUB);
    try {
      expect(modelLabel("ReveImageCreateNode/reve-create@20250915")).toBe("Reve Image Create");
      expect(modelLabel("reve-create@20250915")).toBe("Reve Image Create");
      // The contract's own tables still answer for anything the map misses.
      expect(modelLabel("seedance-1-5-pro-251215")).toBe("Seedance 1.5 Pro");
      expect(modelLabel("something-else")).toBe("something-else");
    } finally {
      setModelLabels({});
    }
  });
});

describe("cost phrasing", () => {
  const RATE = DEFAULT_CREDIT_RATE;

  it("leads with the billed figure and adds the dollars", () => {
    const cell = costCell(IMAGE_ASSET, RATE);
    expect(cell.unknown).toBe(false);
    expect(cell.main).toBe("9.5 credits");
    // formatUsd in contract.ts prints two decimals down to a cent; 9.5 credits is $0.045.
    expect(cell.note).toMatch(/^ \u2248 \$0\.0[45]$/);
    expect(costSentence(IMAGE_ASSET)).toBe("Billed 9.5 credits, as estimated.");
    expect(billedAsText(IMAGE_ASSET)).toBe("seedream-5-0-pro-260628, standard tier");
  });

  it("shows the estimate with a leading about until the bill arrives", () => {
    const running: Asset = { ...IMAGE_ASSET, status: "running", actualCredits: null, estimatedCredits: null, completedAt: null };
    expect(assetCost(running)).toEqual({ actual: null, estimate: 9.5, confidence: "published" });
    expect(costCell(running, null)).toEqual({ main: "about 9.5 credits", note: null, unknown: false });
    expect(jobCostText(running)).toBe("est 9.5 credits");
    expect(costSentence(running)).toBe("Estimated 9.5 credits.");
    // A finished row with no billing event yet says so rather than staying silent.
    expect(costSentence({ ...running, status: "completed" })).toBe("Estimated 9.5 credits. Comfy has not reported what it billed yet.");
    // And the cell says which of the two it is, because "about 9.5 credits" on
    // a finished generation otherwise reads like a bill.
    expect(costCell({ ...running, status: "completed" }, RATE)).toEqual({ main: "about 9.5 credits", note: ", not billed yet", unknown: false });
  });

  it("names the estimate beside the actual only when they are more than 20 percent apart", () => {
    const close: Asset = { ...IMAGE_ASSET, actualCredits: 10.5 };
    expect(costCell(close, null).note).toBe(null);
    const far: Asset = { ...IMAGE_ASSET, actualCredits: 18.99 };
    expect(costCell(far, null)).toEqual({ main: "18.99 credits", note: ", est 9.5", unknown: false });
    expect(costSentence(far)).toBe("Billed 18.99 credits. The estimate was 9.5, so it cost 100 percent more.");
    expect(jobCostText(far)).toBe("18.99 credits");
  });

  it("writes an estimate without fake precision", () => {
    // Published image prices are exact to the cent; the video formula is not.
    expect(formatEstimateCredits(9.5)).toBe("9.5");
    expect(formatEstimateCredits(18.99)).toBe("18.99");
    expect(formatEstimateCredits(869.83)).toBe("870");
  });

  it("says cost unknown rather than a made up number", () => {
    const odd: Asset = { ...IMAGE_ASSET, model: "some-future-model", actualCredits: null, estimatedCredits: null };
    expect(costCell(odd, RATE)).toEqual({ main: "unknown", note: null, unknown: true });
    expect(jobCostText(odd)).toBe(null);
    expect(costSentence(odd)).toBe(null);
    expect(billedAsText({ ...odd, billedModel: null, outputTier: null })).toBe(null);
  });

});

describe("video capabilities", () => {
  it("spells out what a video model can do", () => {
    expect(videoCapabilities("seedance-1-5-pro-251215")).toBe("480p to 1080p, 3 to 12 s, audio");
    expect(videoCapabilities("Seedance 2.0 Fast")).toBe("480p to 720p, 4 to 15 s, audio");
    expect(videoCapabilities("seedance-1-0-pro-fast-251015")).toBe("480p to 1080p, 3 to 12 s, no audio");
  });
});

// ---------- the model picker and the schema driven form ----------
//
// The rendered picker is exercised with the Generate tab in surfaces.test.tsx;
// what follows is the logic under it, which is where the interesting decisions
// live: what survives a model change, what the vendor refuses, and what is
// actually sent.

describe("carrying settings across a model change", () => {
  it("keeps the tier and the ratio the next model also has", () => {
    const wish = { ...initialValues(SEEDREAM_5_PRO), sizePreset: "(1K) 1312x736 (16:9)" };
    const next = carryOver(wish, SEEDREAM_4);
    expect(next.sizePreset).toBe("(1K) 1312x736 (16:9)");
  });

  it("moves to the nearest shape when the next model has no such size, and drops what it cannot do", () => {
    // Seedream 5.0 Pro has no 16:9 at 2K; the closest 2K shape it does have is 3:2.
    const wish = { ...initialValues(SEEDREAM_4), sizePreset: "(2K) 2048x2048 (1:1)", count: 7, audio: true };
    const next = carryOver(wish, SEEDREAM_5_PRO);
    expect(next.sizePreset).toBe("(2K) 2048x2048 (1:1)");
    // The V2 node offers no count input, so seven falls back to the form's own maximum.
    expect(next.count).toBe(4);
    expect(next.audio).toBe(false);
  });

  it("keeps an extra the next model also declares and drops one it does not", () => {
    const wish = { ...initialValues(SEEDREAM_4), extras: { "model.thinking": false, "magic_prompt_option": "ON" } };
    expect(carryOver(wish, SEEDREAM_4).extras).toEqual({ "model.thinking": false });
    expect(carryOver(wish, IDEOGRAM_3).extras).toEqual({ magic_prompt_option: "ON" });
  });

  it("does not carry a pixel size out of a model whose size is a preset", () => {
    // Seedream declares width and height for its "Custom" escape hatch and
    // defaults them to 2048x2048, which its preset makes irrelevant, so that
    // pair must not set the size or the price of the next model.
    expect(initialValues(SEEDREAM_5_PRO).width).toBeNull();
    const next = carryOver(initialValues(SEEDREAM_5_PRO), FLUX_2);
    expect(next.width).toBe(FLUX_2.capabilities.dimensions!.widthDefault);
    expect(next.height).toBe(FLUX_2.capabilities.dimensions!.heightDefault);

    // A size the user really did type in the pixel fields still travels, and is
    // snapped to what the next model allows.
    const chosen = { ...initialValues(FLUX_2), width: 512, height: 768 };
    expect(carryOver(chosen, SEEDREAM_5_PRO).width).toBe(1024);
    expect(carryOver(chosen, SEEDREAM_5_PRO).height).toBe(1024);
  });

  it("keeps a video wish that the next video model shares", () => {
    const wish = { ...initialValues(SEEDANCE_1_FAST), resolution: "1080p", aspect: "9:16", duration: 12 };
    const next = carryOver(wish, VEO_3);
    expect(next.resolution).toBe("1080p");
    expect(next.aspect).toBe("9:16");
    // Veo only runs 4, 6 or 8 seconds, so 12 becomes the nearest it offers.
    expect(next.duration).toBe(8);
  });
});

describe("the vendor's own refusals", () => {
  it("greys out the lengths 1080p does not allow and snaps to one that is left", () => {
    const shape = formModel(VEO_3, { ...initialValues(VEO_3), resolution: "1080p", duration: 4 });
    const durations = shape.durations ?? [];
    expect(durations.map((option) => option.value)).toEqual(["4", "6", "8"]);
    expect(durations.filter((option) => option.disabled).map((option) => option.value)).toEqual(["4", "6"]);
    expect(shape.values.duration).toBe(8);
    expect(shape.notes.length).toContain("1080p is only offered as an 8 second clip.");
    // The ratio rule bites on the same selection, and it says so under Size.
    expect(shape.aspects.find((option) => option.value === "9:16")?.disabled).toBe(true);
    expect(shape.notes.size).toContain("1080p is landscape only.");
  });

  it("leaves everything on offer at a resolution with no rule", () => {
    const shape = formModel(VEO_3, { ...initialValues(VEO_3), resolution: "720p", duration: 4 });
    expect((shape.durations ?? []).some((option) => option.disabled)).toBe(false);
    expect(shape.values.duration).toBe(4);
    expect(shape.notes.length).toEqual([]);
  });

  it("says when a named size makes the ratio moot, and then stops sending it", () => {
    const auto = formModel(IDEOGRAM_3, initialValues(IDEOGRAM_3));
    expect(auto.ignored.aspect).toBeUndefined();
    expect(generateFields(IDEOGRAM_3, auto).aspect).toBe("1:1");
    const named = formModel(IDEOGRAM_3, { ...initialValues(IDEOGRAM_3), sizePreset: "1312x736" });
    expect(named.ignored.aspect).toBe("The ratio is ignored unless the size is Auto.");
    expect(generateFields(IDEOGRAM_3, named).aspect).toBeUndefined();
    expect(named.notes.size).toContain("The ratio is ignored unless the size is Auto.");
  });

  it("checks a free pixel size against the documented area, not just the edges", () => {
    const small = formModel(FLUX_2, { ...initialValues(FLUX_2), width: 256, height: 256 });
    expect(small.dimensionError).toContain("under the smallest area");
    const offGrid = formModel(FLUX_2, { ...initialValues(FLUX_2), width: 1000, height: 1024 });
    expect(offGrid.dimensionError).toContain("steps of 16");
    const fine = formModel(FLUX_2, { ...initialValues(FLUX_2), width: 1024, height: 1024 });
    expect(fine.dimensionError).toBeNull();
    // The size note quotes the model's own bounds and its step.
    expect(fine.dimensions).toMatchObject({ widthMin: 256, widthMax: 2048, step: 16 });
  });
});

describe("what the form draws and what it sends", () => {
  it("picks the size control from the model's own vocabulary", () => {
    expect(sizeModeOf(SEEDREAM_5_PRO)).toBe("tiers");
    expect(sizeModeOf(IDEOGRAM_3)).toBe("presets");
    expect(sizeModeOf(SEEDANCE_1_FAST)).toBe("aspect");
    expect(sizeModeOf(FLUX_2)).toBe("dimensions");
    // GPT Image keeps its size in an extra, so there is no Size row at all.
    expect(sizeModeOf(GPT_IMAGE_2)).toBe("none");
  });

  it("sends only the roles the model has", () => {
    const shape = formModel(SEEDREAM_5_PRO, initialValues(SEEDREAM_5_PRO));
    expect(generateFields(SEEDREAM_5_PRO, shape)).toEqual({ sizePreset: "(1K) 1024x1024 (1:1)" });
    const video = formModel(SEEDANCE_1_FAST, initialValues(SEEDANCE_1_FAST));
    // This one has no audio input at all, so nothing is sent for sound either.
    expect(generateFields(SEEDANCE_1_FAST, video)).toEqual({ resolution: "480p", aspect: "16:9", duration: 5 });
    const withSound = formModel(SEEDANCE_25, initialValues(SEEDANCE_25));
    expect(generateFields(SEEDANCE_25, withSound).generateAudio).toBe(false);
  });

  it("sends the pixel size only when the preset asks for one", () => {
    const preset = formModel(SEEDREAM_5_PRO, initialValues(SEEDREAM_5_PRO));
    expect(generateFields(SEEDREAM_5_PRO, preset).width).toBeUndefined();
    const custom = formModel(SEEDREAM_5_PRO, { ...initialValues(SEEDREAM_5_PRO), sizePreset: "Custom", width: 2048, height: 1152 });
    expect(generateFields(SEEDREAM_5_PRO, custom)).toEqual({ sizePreset: "Custom", width: 2048, height: 1152 });
  });

  it("says an option out loud without changing what is sent", () => {
    // Ideogram's quality tier arrives as VERY_LOW, Veo's person_generation as
    // ALLOW and BLOCK, Nano Banana 2's thinking level as MINIMAL. A select
    // reading VERY_LOW / LOW / MEDIUM / HIGH is a wire value on screen; only the
    // label changes, so the request still carries the vendor's own string.
    expect(extraOptionLabel("VERY_LOW")).toBe("very low");
    expect(extraOptionLabel("ALLOW")).toBe("allow");
    expect(extraOptionLabel("MINIMAL")).toBe("minimal");
    expect(extraOptionLabel("ON")).toBe("on");
    // A tier keeps its case, and anything already readable is left alone.
    expect(extraOptionLabel("4K")).toBe("4K");
    expect(extraOptionLabel("auto")).toBe("auto");
    expect(extraOptionLabel("pro mode / 10s duration / kling-v2-5-turbo")).toBe("pro mode / 10s duration / kling-v2-5-turbo");
    // What goes out is the raw option, whatever the label says.
    const moved = formModel(IDEOGRAM_3, { ...initialValues(IDEOGRAM_3), extras: { rendering_speed: "TURBO" } });
    expect(generateFields(IDEOGRAM_3, moved).extras).toEqual({ rendering_speed: "TURBO" });
  });

  it("sends an extra only once it has been moved off its default", () => {
    const untouched = formModel(IDEOGRAM_3, initialValues(IDEOGRAM_3));
    expect(generateFields(IDEOGRAM_3, untouched).extras).toBeUndefined();
    const moved = formModel(IDEOGRAM_3, { ...initialValues(IDEOGRAM_3), extras: { rendering_speed: "TURBO", magic_prompt_option: "AUTO" } });
    expect(generateFields(IDEOGRAM_3, moved).extras).toEqual({ rendering_speed: "TURBO" });
  });

  it("prices the quality an extra selects", () => {
    const values = initialValues(IDEOGRAM_3);
    expect(qualityOf(values, IDEOGRAM_3)).toBe("default");
    expect(estimateCredits("image", "IdeogramV3", { quality: "default" }, undefined, IDEOGRAM_3.price).credits).toBe(18.1);
    const turbo = { ...values, extras: { rendering_speed: "TURBO" } };
    expect(qualityOf(turbo, IDEOGRAM_3)).toBe("turbo");
    expect(estimateCredits("image", "IdeogramV3", { quality: qualityOf(turbo, IDEOGRAM_3) }, undefined, IDEOGRAM_3.price).credits).toBe(9.05);
  });

  it("submits one run per output only for a model that cannot batch", () => {
    expect(batchesInOneRun(SEEDREAM_5_PRO)).toBe(false);
    expect(batchesInOneRun(IDEOGRAM_3)).toBe(true);
    const shape = formModel(IDEOGRAM_3, { ...initialValues(IDEOGRAM_3), count: 4 });
    expect(generateFields(IDEOGRAM_3, shape).count).toBe(4);
  });

  it("reads an asset's own params back into the form", () => {
    const values = valuesFromParams({ sizePreset: "(1K) 1312x736 (16:9)", seed: 7, count: 3 });
    expect(values.sizePreset).toBe("(1K) 1312x736 (16:9)");
    // A tweak makes one of a thing, whatever the original run asked for.
    expect(values.count).toBe(1);
    const video = valuesFromParams({ resolution: "720p", aspectRatio: "9:16", duration: 8, generateAudio: true });
    expect(video).toMatchObject({ resolution: "720p", aspect: "9:16", duration: 8, audio: true });
  });
});

describe("reference images in the form", () => {
  it("shows the References row only for a model that takes a reference", () => {
    expect(showsReferences(SEEDREAM_5_PRO)).toBe(true);
    expect(referenceLimit(SEEDREAM_5_PRO)).toBe(10);
    expect(showsReferences(REVE_CREATE)).toBe(false);
    expect(referenceLimit(REVE_CREATE)).toBe(0);
    expect(showsReferences(null)).toBe(false);
  });

  it("attaches at the end, never twice and never past the limit, and removes by id", () => {
    let list: string[] = [];
    list = attachReference(list, "img_a", 2);
    list = attachReference(list, "img_b", 2);
    expect(attachReference(list, "img_a", 2)).toEqual(["img_a", "img_b"]);
    // Full is full: nothing is dropped behind the user's back.
    expect(attachReference(list, "img_c", 2)).toEqual(["img_a", "img_b"]);
    expect(removeReference(list, "img_a")).toEqual(["img_b"]);
    expect(removeReference(list, "img_z")).toEqual(["img_a", "img_b"]);
  });

  it("sends only what the model takes, and nothing to a model that takes none", () => {
    const four = ["img_a", "img_b", "img_c", "img_d"];
    expect(sentReferences(four, SEEDREAM_5_PRO)).toEqual(four);
    expect(sentReferences(four, REVE_CREATE)).toEqual([]);
    const narrow = { ...FLUX_2, capabilities: { ...FLUX_2.capabilities, referenceImages: { min: 0, max: 2 } } };
    expect(sentReferences(four, narrow)).toEqual(["img_a", "img_b"]);
  });

  it("moves to the first recommended image model that takes references", () => {
    // Seedream 5.0 Pro is hidden (the legacy node), Seedream 4.0 is recommended and takes ten.
    expect(referenceModel(IMAGE_MODELS_FIXTURE)?.key).toBe(SEEDREAM_4.key);
    expect(referenceModel([REVE_CREATE, IDEOGRAM_3])).toBe(null);
    // With no recommended one, any image model that can.
    expect(referenceModel([REVE_CREATE, GPT_IMAGE_2])?.key).toBe(GPT_IMAGE_2.key);
  });

  it("reads the asset ids a row was made from out of its params, and leaves paths out", () => {
    expect(referencesFromParams({ references: "img_ab12cd34, img_ef56gh78" })).toEqual(["img_ab12cd34", "img_ef56gh78"]);
    expect(referencesFromParams({ references: "/srv/pictures/cat.png, img_ab12cd34" })).toEqual(["img_ab12cd34"]);
    expect(referencesFromParams({})).toEqual([]);
    // What a Tweak cannot bring back is counted, so the form can say so.
    expect(droppedReferenceCount({ references: "/srv/pictures/cat.png, img_ab12cd34" })).toBe(1);
    expect(droppedReferenceCount({ references: "/a.png, /b.jpg" })).toBe(2);
    expect(droppedReferenceCount({ references: "img_ab12cd34" })).toBe(0);
    expect(droppedReferenceCount({})).toBe(0);
  });

  it("refuses to quote a reference on a price that has no figure for one, and adds one where it has", () => {
    // FLUX.2 prices references per run as a wide span, so a quote with one is refused rather than low.
    expect(estimateCredits("image", "Flux.2 [pro]", { width: 1024, height: 1024 }, undefined, FLUX_2.price).credits).not.toBe(null);
    expect(estimateCredits("image", "Flux.2 [pro]", { width: 1024, height: 1024, references: 1 }, undefined, FLUX_2.price).credits).toBe(null);
    // Seedream covers the first reference and the fixture adds 0.5 for the second.
    const one = estimateCredits("image", "seedream 5.0 pro", { sizePreset: "(1K) 1024x1024 (1:1)", references: 1 }, undefined, SEEDREAM_5_PRO.price);
    const two = estimateCredits("image", "seedream 5.0 pro", { sizePreset: "(1K) 1024x1024 (1:1)", references: 2 }, undefined, SEEDREAM_5_PRO.price);
    expect(one.credits).toBe(9.5);
    expect(two.credits).toBe(10);
  });
});

describe("what counts as now", () => {
  const NOW = Date.parse("2031-07-23T03:00:00Z");
  const row = (id: string, over: Partial<Asset>): Asset => ({ ...IMAGE_ASSET, id, createdAt: NOW - 60_000, completedAt: NOW - 50_000, ...over });

  it("keeps an hour of failures in the Library strip and a day of them at the top of Jobs", () => {
    expect(STRIP_FAILED_MS).toBe(3600_000);
    expect(JOBS_FAILED_MS).toBe(24 * 3600_000);
  });

  it("puts running and waiting rows first in the strip, the one nearest done leading, then fresh failures", () => {
    const rows = [
      row("new_run", { status: "running", createdAt: NOW - 10_000 }),
      row("old_run", { status: "running", createdAt: NOW - 50_000 }),
      row("waiting", { status: "queued", createdAt: NOW - 5_000 }),
      row("fresh_fail", { status: "failed", completedAt: NOW - 59 * 60_000 }),
      row("stale_fail", { status: "failed", completedAt: NOW - 61 * 60_000 }),
      row("done", { status: "completed" }),
    ];
    const split = splitLibrary(rows, NOW);
    expect(split.strip.map((asset) => asset.id)).toEqual(["old_run", "new_run", "waiting", "fresh_fail"]);
    expect(split.gallery.map((asset) => asset.id)).toEqual(["stale_fail", "done"]);
  });

  it("dates a failure by when it failed, not when it was asked for", () => {
    // Waited hours for a key and then failed a minute ago: that is news.
    const late = row("late", { status: "failed", createdAt: NOW - 5 * 3600_000, completedAt: NOW - 60_000 });
    expect(splitLibrary([late], NOW).strip).toHaveLength(1);
    const unstamped = row("unstamped", { status: "failed", createdAt: NOW - 2 * 3600_000, completedAt: null });
    expect(splitLibrary([unstamped], NOW).strip).toHaveLength(0);
  });

  it("moves a failure older than a day out of Now and into Finished, in time order", () => {
    const running = row("run", { status: "running" });
    const queued = row("wait", { status: "queued" });
    const fresh = row("fresh", { status: "failed", completedAt: NOW - 23 * 3600_000 });
    const old = row("old", { status: "failed", createdAt: NOW - 30 * 3600_000, completedAt: NOW - 30 * 3600_000 });
    const doneNew = row("done_new", { status: "completed", completedAt: NOW - 3600_000 });
    const doneOld = row("done_old", { status: "completed", completedAt: NOW - 40 * 3600_000 });
    const split = splitJobs([running, queued, fresh, old], [doneNew, doneOld], NOW);
    expect(split.working.map((asset) => asset.id)).toEqual(["run", "wait"]);
    expect(split.failed.map((asset) => asset.id)).toEqual(["fresh"]);
    expect(split.finished.map((asset) => asset.id)).toEqual(["done_new", "old", "done_old"]);
    // Clear failed still takes every failure, old or new.
    expect(split.allFailed.map((asset) => asset.id).sort()).toEqual(["fresh", "old"]);
    expect(splitJobs([], [doneNew, doneOld], NOW, 1).finished).toHaveLength(1);
  });

  it("keeps a row whose outcome is not known yet in play, never among the failures", () => {
    // An unknown row's job may still finish and be billed, so it sits with
    // the work in progress, where Cancel is, and never next to a Retry.
    const reason =
      "Lost contact with Comfy Cloud while this job ran. It may have finished, so it is not marked failed; the plugin checks again every minute and fetches the result when Comfy Cloud answers.";
    const lost = row("lost", { status: "unknown", error: reason, completedAt: null });
    const running = row("run", { status: "running" });
    const queued = row("wait", { status: "queued" });
    const library = splitLibrary([lost], NOW);
    expect(library.strip.map((asset) => asset.id)).toEqual(["lost"]);
    const jobs = splitJobs([queued, lost, running], [], NOW);
    expect(jobs.working.map((asset) => asset.id)).toEqual(["run", "lost", "wait"]);
    expect(jobs.failed).toEqual([]);
    expect(jobs.allFailed).toEqual([]);
    expect(unknownHeadline(lost)).toBe("Lost contact with Comfy Cloud while this job ran.");
    expect(unknownHeadline(row("bare", { status: "unknown", error: null }))).toBe("Waiting to hear back from Comfy Cloud.");
  });
});

describe("the picker's list", () => {
  it("searches label, vendor, id and the legacy alias", () => {
    expect(matchesQuery(SEEDREAM_5_PRO, "bytedance")).toBe(true);
    expect(matchesQuery(SEEDREAM_5_PRO, "seedream 5.0 pro")).toBe(true);
    expect(matchesQuery(SEEDREAM_5_PRO, "ideogram")).toBe(false);
    // Every word has to land, so two words narrow rather than widen.
    expect(matchesQuery(IDEOGRAM_3, "ideogram 3")).toBe(true);
    expect(matchesQuery(IDEOGRAM_3, "ideogram flux")).toBe(false);
  });

  it("sorts by the cheapest run a model can do and leaves unpriced models last", () => {
    const unpriced = { ...REVE_CREATE, key: "Unpriced/x", label: "Unpriced", price: null };
    const order = sortModels([...IMAGE_MODELS_FIXTURE, unpriced], "cheapest").map((entry) => entry.label);
    expect(order[0]).toBe("GPT Image 2"); // 1.22 credits at its low tier
    expect(order[1]).toBe("Reve Image Create"); // 2
    expect(order[order.length - 1]).toBe("Unpriced");
    expect(cheapestCredits(SEEDREAM_5_PRO)).toBe(8);
    expect(cheapestCredits(unpriced)).toBeNull();
  });

  it("leads with the recommended models, then goes vendor by vendor", () => {
    const groups = groupModels(sortModels(IMAGE_MODELS_FIXTURE, "recommended"), "recommended");
    expect(groups[0]?.label).toBe("Recommended");
    expect(groups[0]?.models.map((entry) => entry.label)).toEqual(["Flux.2 [pro]", "Seedream 4.0"]);
    expect(groups.slice(1).map((group) => group.label)).toEqual(["ByteDance", "Ideogram", "OpenAI", "Reve"]);
    // A vendor header names the vendor, so its rows do not repeat it.
    expect(groups[1]?.vendorHeader).toBe(true);
    expect(groups[0]?.vendorHeader).toBe(false);
  });

  it("groups A to Z by initial and cheapest into one run", () => {
    expect(groupModels(sortModels(IMAGE_MODELS_FIXTURE, "az"), "az").map((group) => group.label)).toEqual(["F", "G", "I", "R", "S"]);
    expect(groupModels(sortModels(IMAGE_MODELS_FIXTURE, "cheapest"), "cheapest").map((group) => group.label)).toEqual(["Cheapest first"]);
  });

  it("filters on what the kind actually offers", () => {
    const image = filtersFor("image").map((filter) => filter.id);
    expect(image).toEqual(["4k", "batch"]);
    expect(filtersFor("video").map((filter) => filter.id)).toEqual(["audio", "hd", "long"]);
    const fourK = filtersFor("image").find((filter) => filter.id === "4k")!;
    expect(fourK.matches(SEEDREAM_4)).toBe(true);
    expect(fourK.matches(SEEDREAM_5_PRO)).toBe(false);
    const batch = filtersFor("image").find((filter) => filter.id === "batch")!;
    expect(batch.matches(IDEOGRAM_3)).toBe(true);
    expect(batch.matches(SEEDREAM_5_PRO)).toBe(false);
    const long = filtersFor("video").find((filter) => filter.id === "long")!;
    expect(long.matches(SEEDANCE_25)).toBe(true);
    expect(long.matches(VEO_3)).toBe(false);
  });

  it("keeps a hidden model out of the vendor sections unless it is the one you are on", () => {
    // The server sends a hidden entry only because something names it: the
    // model the form is on, a Favourite or a Recent. Hidden is not gone, so the
    // section that named it still draws it, but a second row in ByteDance would
    // put "Seedream 5.0 Pro" and "Seedream 5.0 Pro (legacy node)" one above the
    // other at the same price.
    expect(SEEDREAM_5_PRO.hidden).toBe(true);
    const asRecent = listedModels(IMAGE_MODELS_FIXTURE, "ReveImageCreateNode/reve-create@20250915");
    expect(asRecent.some((model) => model.key === SEEDREAM_5_PRO.key)).toBe(false);
    expect(asRecent).toHaveLength(IMAGE_MODELS_FIXTURE.length - 1);
    const asCurrent = listedModels(IMAGE_MODELS_FIXTURE, SEEDREAM_5_PRO.key);
    expect(asCurrent.some((model) => model.key === SEEDREAM_5_PRO.key)).toBe(true);
    expect(asCurrent).toHaveLength(IMAGE_MODELS_FIXTURE.length);
  });

  it("finds a model by key, by legacy id and by alias", () => {
    expect(findModel(IMAGE_MODELS_FIXTURE, "ByteDanceSeedreamNodeV2/seedream 5.0 pro")?.label).toBe(SEEDREAM_5_PRO.label);
    expect(findModel(IMAGE_MODELS_FIXTURE, "seedream 5.0 pro")?.label).toBe(SEEDREAM_5_PRO.label);
    expect(findModel(IMAGE_MODELS_FIXTURE, "nothing")).toBeNull();
  });
});
