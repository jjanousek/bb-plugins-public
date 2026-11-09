// The model registry: the generated snapshot, the generic builder, and the
// schema validation that stands in for running the 112 supported entries.
//
// The golden Seedream and Seedance graphs live here as files, compared byte for
// byte, because the whole point of the generic builder is that it reproduces
// them exactly. test/server.test.ts keeps its own structural copies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  costSignature, estimateCredits, estimateParamsOf, floorCredits, priceCredits, type ModelPrice, type Workflow } from "../contract";
import {
  CATALOG_DATE,
  UNMATCHED_DOC_RECORDS,
  MODEL_ENTRIES,
  capabilitiesOf,
  capabilityLine,
  closestModels,
  defaultsOf,
  extrasOf,
  assetCostSignature,
  getModel,
  lengthIsUnpredictable,
  listModels,
  modelSummary,
  priceForEstimate,
  priceKeyOf,
  priceLine,
  referenceImageModels,
  resolveModelKey,
  type GeneratedInput,
  type RegistryEntry,
} from "../registry";
import { buildWorkflow, resolveSpec, specParams } from "../workflows";
import { draftOf, durationOf, extraOptionLabel, formModel, generateFields, initialValues, visibleExtras, type FormValues } from "../components/comfy/model-form";
import { cheapestCredits, filtersFor, sortModels } from "../components/comfy/model-list";
import { estimateCreditsText } from "../components/comfy/cost";

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
const WRITE_GOLDEN = process.env.WRITE_GOLDEN === "1";

function golden(name: string, workflow: Workflow): void {
  const file = path.join(FIXTURES, name);
  const text = `${JSON.stringify(workflow, null, 2)}\n`;
  if (WRITE_GOLDEN) fs.writeFileSync(file, text);
  expect(text).toBe(fs.readFileSync(file, "utf8"));
}

const SUPPORTED = MODEL_ENTRIES.filter((entry) => entry.supported);

// ---------- the generated snapshot ----------

describe("the generated registry", () => {
  it("holds a whole catalog, and every entry has a key, a kind and an output node", () => {
    expect(MODEL_ENTRIES.length).toBeGreaterThan(120);
    expect(MODEL_ENTRIES.length).toBeLessThan(400);
    expect(SUPPORTED.length).toBeGreaterThan(80);
    expect(new Set(MODEL_ENTRIES.map((e) => e.key)).size).toBe(MODEL_ENTRIES.length);
    expect(CATALOG_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const entry of MODEL_ENTRIES) {
      expect(entry.kind === "image" || entry.kind === "video").toBe(true);
      expect(entry.outputNodeKind).toBe(entry.kind === "image" ? "SaveImage" : "SaveVideo");
      expect(entry.vendor).not.toBe("");
      expect(entry.label).not.toBe("");
      if (!entry.supported) expect(entry.unsupportedReason).toBeTruthy();
    }
  });

  it("gives every supported entry a prompt role and satisfiable required inputs", () => {
    for (const entry of SUPPORTED) {
      expect(entry.roles.prompt, entry.key).toBeTruthy();
      for (const input of entry.inputs) {
        if (!input.required || input.type === "COMFY_DYNAMICCOMBO_V3") continue;
        const filled = Object.values(entry.roles).includes(input.name) || input.default !== undefined || entry.compat?.[input.name] !== undefined;
        const derivable = input.type === "INT" || input.type === "FLOAT" || input.type === "BOOLEAN" || input.type === "STRING";
        expect(filled || derivable, `${entry.key} cannot fill required input ${input.name}`).toBe(true);
      }
    }
  });

  it("covers both kinds and more than ten vendors", () => {
    const vendors = new Set(SUPPORTED.map((e) => e.vendor));
    expect(vendors.size).toBeGreaterThanOrEqual(10);
    expect(SUPPORTED.filter((e) => e.kind === "image").length).toBeGreaterThan(30);
    expect(SUPPORTED.filter((e) => e.kind === "video").length).toBeGreaterThan(30);
  });

  it("resolves the legacy ids to the entries whose graphs they built", () => {
    expect(resolveModelKey("seedream 5.0 pro")).toBe("ByteDanceSeedreamNodeV2/seedream 5.0 pro");
    expect(resolveModelKey("seedream-4-0-250828")).toBe("ByteDanceSeedreamNodeV2/seedream-4-0-250828");
    expect(resolveModelKey("seedance-1-0-pro-fast-251015")).toBe("ByteDanceTextToVideoNode/seedance-1-0-pro-fast-251015");
    expect(resolveModelKey("Seedance 2.5")).toBe("ByteDance2TextToVideoNode/Seedance 2.5");
    // A bare model id that only one live node offers resolves to that node.
    expect(resolveModelKey("veo-3.1-generate")).toBe("Veo3VideoGenerationNode/veo-3.1-generate");
    expect(resolveModelKey("not-a-model")).toBeNull();
  });

  it("names the closest models when an id does not resolve", () => {
    const close = closestModels("seedream 5 pro", "image");
    expect(close.length).toBe(3);
    expect(close.some((key) => key.includes("seedream 5.0 pro"))).toBe(true);
  });

  it("carries a reference image group only where the catalog really has one", () => {
    const withGroup = SUPPORTED.filter((entry) => entry.referenceImages !== undefined);
    expect(withGroup.length).toBeGreaterThan(15);
    for (const entry of withGroup) {
      const group = entry.referenceImages!;
      // A group that cannot be left empty belongs to an edit node, and those
      // are unsupported. Every group the plugin keeps is optional.
      expect(group.min, entry.key).toBe(0);
      expect(group.slots.length, entry.key).toBe(group.max);
      expect(group.max, entry.key).toBeGreaterThan(0);
      expect(new Set(group.slots).size, entry.key).toBe(group.slots.length);
      // The group itself is never a normal input: the builder walks
      // `inputs` in catalog order and a link-only group in there would move the
      // frozen graphs.
      expect(entry.inputs.some((input) => input.name === group.input), entry.key).toBe(false);
      // A dotted group hangs off a dynamic combo the entry does declare.
      if (group.input.includes(".")) {
        const head = group.input.slice(0, group.input.lastIndexOf("."));
        expect(entry.inputs.some((input) => input.name === head && input.type === "COMFY_DYNAMICCOMBO_V3"), entry.key).toBe(true);
      }
      expect(capabilitiesOf(entry).referenceImages).toEqual({ min: 0, max: group.max });
    }
    // Nothing else claims the capability.
    for (const entry of SUPPORTED.filter((e) => e.referenceImages === undefined)) {
      expect(capabilitiesOf(entry).referenceImages, entry.key).toBeNull();
    }
    // Both kinds, and the shipped image default is one of them.
    expect(withGroup.some((entry) => entry.kind === "image")).toBe(true);
    expect(withGroup.some((entry) => entry.kind === "video")).toBe(true);
    expect(getModel("ByteDanceSeedreamNodeV3/seedream 5.0 pro")?.referenceImages?.max).toBe(10);
  });

  it("marks capabilities schema derived only when no documentation backs them", () => {
    const documented = SUPPORTED.filter((e) => !capabilitiesOf(e).schemaDerived);
    expect(documented.length).toBe(SUPPORTED.length);
    // The flag still has to work, so prove it on a synthetic entry.
    const bare = { ...SUPPORTED[0]!, override: null, documented: false } as RegistryEntry;
    expect(capabilitiesOf(bare).schemaDerived).toBe(true);
  });
});

// ---------- the golden graphs ----------

describe("the frozen graphs", () => {
  it("builds the Seedream image graph byte for byte", () => {
    const spec = resolveSpec({ prompt: "a brass compass on a folded map, overhead photo", seed: 7 }, "seedream 5.0 pro", "image");
    golden("graph-seedream-5-pro.json", buildWorkflow(spec));
    expect(specParams(spec)).toEqual({ sizePreset: "(1K) 1024x1024 (1:1)", width: 1024, height: 1024, seed: 7 });
  });

  it("builds the Seedance 1.x video graph byte for byte", () => {
    const spec = resolveSpec(
      { prompt: "a windmill turning slowly on a hill at dawn", duration: 3, seed: 7, resolution: "480p" },
      "seedance-1-0-pro-fast-251015",
      "video",
    );
    golden("graph-seedance-1x.json", buildWorkflow(spec));
    expect(specParams(spec)).toEqual({ resolution: "480p", aspectRatio: "16:9", duration: 3, generateAudio: false, seed: 7 });
  });

  it("builds the Seedance 2.x video graph byte for byte", () => {
    const spec = resolveSpec(
      { prompt: "a windmill turning slowly on a hill at dawn", duration: 4, seed: 7, model: "Seedance 2.0 Fast" },
      "seedance-1-0-pro-fast-251015",
      "video",
    );
    golden("graph-seedance-2x.json", buildWorkflow(spec));
  });

  it("builds the Seedream reference graph byte for byte, and changes nothing without a reference", () => {
    const request = { prompt: "the same street as a watercolour postcard", seed: 7 };
    const model = "ByteDanceSeedreamNodeV3/seedream 5.0 pro";
    // The node reads references only under this spelling; another spelling
    // fails at execute time or is ignored, so the graph is frozen here.
    const withReference = resolveSpec({ ...request, references: [{ name: "b2c3.png", from: "img_ab12cd34" }] }, model, "image");
    golden("graph-seedream-ref.json", buildWorkflow(withReference));
    expect(specParams(withReference).references).toBe("img_ab12cd34");

    // The same request with no reference has no trace of references:
    // no LoadImage node, no slot key, nothing about references in the params.
    const plain = buildWorkflow(resolveSpec(request, model, "image"));
    expect(Object.keys(plain)).toEqual(["1", "2"]);
    expect(Object.keys(plain["1"]?.inputs ?? {}).some((name) => name.includes("images"))).toBe(false);
    expect(specParams(resolveSpec(request, model, "image")).references).toBeUndefined();
    // And an explicit empty list is the same thing.
    expect(buildWorkflow(resolveSpec({ ...request, references: [] }, model, "image"))).toEqual(plain);
  });

  it("refuses a reference on a model that cannot take one, and names models that can", () => {
    const one = [{ name: "b2c3.png", from: "img_ab12cd34" }];
    expect(() => resolveSpec({ prompt: "p", references: one }, "IdeogramV3", "image")).toThrow(/Ideogram 3.0 does not take a reference image/);
    expect(() => resolveSpec({ prompt: "p", references: one }, "IdeogramV3", "image")).toThrow(/Models that do: .+ \(.+\)/);
    // Named models are real, supported and take one.
    const named = referenceImageModels("image");
    expect(named.length).toBeGreaterThan(5);
    for (const entry of named) expect(entry.referenceImages?.max).toBeGreaterThan(0);
    // Same vendor first, so asking Seedance points at ByteDance where it can.
    expect(() => resolveSpec({ prompt: "p", references: one }, "seedance-1-0-pro-fast-251015", "video")).toThrow(/does not take a reference image/);
    // More than the model's own maximum is refused rather than truncated.
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `r${i}.png`, from: `img_${i}` }));
    expect(() => resolveSpec({ prompt: "p", references: many }, "ByteDanceSeedreamNodeV3/seedream 5.0 pro", "image")).toThrow(/takes at most 10 reference images, not 11/);
  });

  it("keeps the model.width and model.height clamp that Comfy Cloud validates", () => {
    const spec = resolveSpec({ prompt: "p", sizePreset: "(1K) 1312x736 (16:9)", seed: 1 }, "seedream 5.0 pro", "image");
    const graph = buildWorkflow(spec);
    expect(graph["1"]?.inputs["model.size_preset"]).toBe("(1K) 1312x736 (16:9)");
    expect(graph["1"]?.inputs["model.width"]).toBe(1312);
    expect(graph["1"]?.inputs["model.height"]).toBe(1024);
    expect(specParams(spec)).toEqual({ sizePreset: "(1K) 1312x736 (16:9)", width: 1312, height: 736, seed: 1 });
  });
});

// ---------- schema validation, the substitute for running them ----------

type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

/** Every way one built value can be wrong for the input it was written to. */
function checkValue(input: GeneratedInput, value: Value): string | null {
  switch (input.type) {
    case "INT":
    case "FLOAT": {
      if (typeof value !== "number") return `${input.name}: expected a number, got ${typeof value}`;
      if (input.type === "INT" && !Number.isInteger(value)) return `${input.name}: ${value} is not a whole number`;
      if (input.min !== undefined && value < input.min) return `${input.name}: ${value} is below the minimum of ${input.min}`;
      if (input.max !== undefined && value > input.max) return `${input.name}: ${value} is above the maximum of ${input.max}`;
      if (input.step !== undefined && input.step > 1 && input.min !== undefined && (value - input.min) % input.step !== 0) {
        return `${input.name}: ${value} is off the step grid of ${input.step} from ${input.min}`;
      }
      return null;
    }
    case "BOOLEAN":
      return typeof value === "boolean" ? null : `${input.name}: expected a boolean, got ${typeof value}`;
    case "STRING":
      return typeof value === "string" ? null : `${input.name}: expected a string, got ${typeof value}`;
    case "COMBO":
    case "COMFY_DYNAMICCOMBO_V3": {
      if (input.options === undefined || input.options.length === 0) return null;
      const text = String(value);
      return input.options.includes(text) ? null : `${input.name}: "${text}" is not one of ${input.options.slice(0, 6).join(", ")}`;
    }
    default:
      return null;
  }
}

/** Validate a built graph against one entry's own declared inputs. */
function validate(entry: RegistryEntry, graph: Workflow): string[] {
  const problems: string[] = [];
  const node = graph["1"];
  if (node === undefined) return [`${entry.key}: no node 1`];
  if (node.class_type !== entry.node) problems.push(`${entry.key}: node 1 is ${node.class_type}, not ${entry.node}`);
  const save = graph["2"];
  if (save === undefined || save.class_type !== entry.outputNodeKind) problems.push(`${entry.key}: node 2 is not ${entry.outputNodeKind}`);
  const link = entry.outputNodeKind === "SaveVideo" ? save?.inputs.video : save?.inputs.images;
  if (!Array.isArray(link) || link[0] !== "1") problems.push(`${entry.key}: the save node is not wired to node 1`);

  const declared = new Map(entry.inputs.map((i) => [i.name, i]));
  for (const input of entry.inputs) {
    if (!input.required || input.compat === true) continue;
    if (!(input.name in node.inputs)) problems.push(`${entry.key}: required input ${input.name} is missing`);
  }
  const slotNames = new Set((entry.referenceImages?.slots ?? []).map((slot) => `${entry.referenceImages!.input}.${slot}`));
  for (const [name, value] of Object.entries(node.inputs)) {
    if (slotNames.has(name)) {
      // A reference slot carries a link to a LoadImage node, not a scalar.
      const link = value as Value;
      if (!Array.isArray(link) || typeof link[0] !== "string" || link[1] !== 0) problems.push(`${entry.key}: ${name} is not a link`);
      else if (graph[link[0]]?.class_type !== "LoadImage") problems.push(`${entry.key}: ${name} points at ${graph[link[0]]?.class_type ?? "nothing"}, not LoadImage`);
      continue;
    }
    const input = declared.get(name);
    if (input === undefined) {
      problems.push(`${entry.key}: sends ${name}, which the node does not declare`);
      continue;
    }
    const problem = checkValue(input, value as Value);
    if (problem !== null) problems.push(`${entry.key}: ${problem}`);
  }
  return problems;
}

describe("every supported model builds a legal graph", () => {
  it("fills every required input with a value the schema accepts", () => {
    const problems: string[] = [];
    let built = 0;
    for (const entry of SUPPORTED) {
      let graph: Workflow;
      try {
        graph = buildWorkflow(resolveSpec({ prompt: "a quiet harbour at dawn, wide shot" }, entry.key));
      } catch (cause) {
        problems.push(`${entry.key}: ${cause instanceof Error ? cause.message : String(cause)}`);
        continue;
      }
      built += 1;
      problems.push(...validate(entry, graph));
    }
    expect(problems).toEqual([]);
    expect(built).toBe(SUPPORTED.length);
  });

  it("stays legal at every resolution, ratio, preset and length the model offers", () => {
    const problems: string[] = [];
    for (const entry of SUPPORTED) {
      const caps = capabilitiesOf(entry);
      const shapes: Parameters<typeof resolveSpec>[0][] = [{ prompt: "p" }];
      for (const resolution of caps.resolutions) shapes.push({ prompt: "p", resolution });
      for (const aspect of caps.aspects) shapes.push({ prompt: "p", aspect });
      for (const sizePreset of caps.sizePresets) shapes.push({ prompt: "p", sizePreset });
      if (caps.duration !== null) {
        shapes.push({ prompt: "p", duration: caps.duration.min }, { prompt: "p", duration: caps.duration.max }, { prompt: "p", duration: 999 }, { prompt: "p", duration: 0 });
      }
      if (caps.count !== null) shapes.push({ prompt: "p", count: caps.count.max }, { prompt: "p", count: 99 });
      if (caps.audio) shapes.push({ prompt: "p", generateAudio: true });
      if (caps.dimensions !== null) {
        shapes.push(
          { prompt: "p", width: caps.dimensions.widthMin, height: caps.dimensions.heightMin },
          { prompt: "p", width: caps.dimensions.widthMax, height: caps.dimensions.heightMax },
          { prompt: "p", width: 1, height: 1 },
          { prompt: "p", width: 99_999, height: 99_999 },
        );
      }
      for (const shape of shapes) {
        try {
          problems.push(...validate(entry, buildWorkflow(resolveSpec({ ...shape, model: entry.key }, entry.key))));
        } catch (cause) {
          problems.push(`${entry.key} ${JSON.stringify(shape)}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    }
    expect(problems.slice(0, 20)).toEqual([]);
    expect(problems.length).toBe(0);
  });

  it("builds a legal graph at every reference count every capable model allows", () => {
    const problems: string[] = [];
    let built = 0;
    for (const entry of SUPPORTED.filter((e) => e.referenceImages !== undefined)) {
      const group = entry.referenceImages!;
      for (const count of [1, 2, Math.min(3, group.max), group.max]) {
        const references = Array.from({ length: count }, (_, i) => ({ name: `ref-${i}.png`, from: `img_${i}` }));
        try {
          const graph = buildWorkflow(resolveSpec({ prompt: "the same scene in watercolour", references }, entry.key, entry.kind));
          built += 1;
          problems.push(...validate(entry, graph));
          const loaders = Object.entries(graph).filter(([, node]) => node?.class_type === "LoadImage");
          if (loaders.length !== count) problems.push(`${entry.key}: ${loaders.length} LoadImage nodes for ${count} references`);
          for (let i = 0; i < count; i += 1) {
            const wire = `${group.input}.${group.slots[i]}`;
            if (graph["1"]?.inputs[wire] === undefined) problems.push(`${entry.key}: slot ${wire} is empty`);
          }
          // A slot past the ones asked for is never written.
          if (count < group.max && graph["1"]?.inputs[`${group.input}.${group.slots[count]}`] !== undefined) {
            problems.push(`${entry.key}: wrote a slot past reference ${count}`);
          }
        } catch (cause) {
          problems.push(`${entry.key} x${count}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(built).toBeGreaterThan(50);
  });

  it("refuses an option the model does not offer, and says what it does offer", () => {
    expect(() => resolveSpec({ prompt: "p", sizePreset: "(9K) 1x1 (1:1)" }, "seedream 5.0 pro", "image")).toThrow(/not available/);
    expect(() => resolveSpec({ prompt: "p", resolution: "4k" }, "seedance-1-0-pro-fast-251015", "video")).toThrow(/supports resolutions/);
    expect(() => resolveSpec({ prompt: "p", model: "seedream 5.0 pro" }, "seedream 5.0 pro", "video")).toThrow(/is an image model/);
    expect(() => resolveSpec({ prompt: "p" }, "nope")).toThrow(/Unknown model/);
    expect(() => resolveSpec({ prompt: "p", extras: { not_an_input: 1 } }, "seedream 5.0 pro")).toThrow(/has no input called/);
  });
});

// ---------- the same check against the live catalog, when it is present ----------

const CATALOG = process.env.COMFY_CATALOG ?? path.join(os.homedir(), ".bb", "plugins", "comfy-cloud", "object_info.json");
const haveCatalog = fs.existsSync(CATALOG);

describe.skipIf(!haveCatalog)("the generated snapshot against the live catalog", () => {
  it("declares the same inputs, options and bounds the catalog does", () => {
    const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8")) as Record<string, { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }>;
    const problems: string[] = [];
    for (const entry of SUPPORTED.slice(0, 400)) {
      const node = catalog[entry.node];
      if (node === undefined) {
        problems.push(`${entry.key}: node is gone from the catalog`);
        continue;
      }
      if (entry.modelId !== null && entry.modelInput !== null) {
        const top = { ...(node.input?.required ?? {}), ...(node.input?.optional ?? {}) } as Record<string, [unknown, Record<string, unknown>] | undefined>;
        const spec = top[entry.modelInput];
        const raw = Array.isArray(spec?.[0]) ? spec[0] : ((spec?.[1]?.options ?? []) as unknown[]);
        const keys = raw.map((o) => (typeof o === "string" ? o : typeof o === "object" && o !== null && "key" in o && typeof o.key === "string" ? o.key : ""));
        if (!keys.includes(entry.modelId)) {
          problems.push(`${entry.key}: model ${entry.modelId} is gone from ${entry.node}`);
          continue;
        }
      }
      const graph = buildWorkflow(resolveSpec({ prompt: "a quiet harbour at dawn" }, entry.key));
      for (const name of Object.keys(graph["1"]?.inputs ?? {})) {
        if (entry.compat?.[name] !== undefined) continue;
        const [head, ...tail] = name.split(".");
        const top = { ...(node.input?.required ?? {}), ...(node.input?.optional ?? {}) } as Record<string, [unknown, Record<string, unknown>] | undefined>;
        const spec = top[head!];
        if (spec === undefined) {
          problems.push(`${entry.key}: the catalog has no input ${head}`);
          continue;
        }
        if (tail.length === 0) continue;
        const options = (spec[1]?.options ?? []) as { key: string; inputs?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }[];
        const chosen = options.find((o) => o.key === graph["1"]?.inputs[head!]);
        if (chosen === undefined) continue;
        const subs = { ...(chosen.inputs?.required ?? {}), ...(chosen.inputs?.optional ?? {}) };
        if (!(tail.join(".") in subs)) problems.push(`${entry.key}: the catalog has no sub input ${name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("never offers a model whose catalog entry demands a picture", () => {
    // The node level media check only reads the node's own required inputs, and
    // a node that keeps everything under a `COMFY_DYNAMICCOMBO_V3` hides its
    // media one level down: Meta Muse Image Edit declares `model.images`, an
    // autogrow of one to ten IMAGE slots with min 1. Read both levels, so a node
    // shaped like that is refused on the day the catalog lands rather than by a
    // generation that fails.
    const MEDIA = new Set(["IMAGE", "VIDEO", "AUDIO", "MASK", "LATENT"]);
    const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8")) as Record<string, { input?: { required?: Record<string, unknown> } }>;
    const demands = (spec: unknown): boolean => {
      const pair = spec as [unknown, Record<string, unknown>] | undefined;
      const type = String(pair?.[0] ?? "");
      if (MEDIA.has(type)) return true;
      if (type !== "COMFY_AUTOGROW_V3") return false;
      const template = (pair?.[1]?.template ?? {}) as { min?: unknown; input?: { required?: Record<string, unknown> } };
      if (Number(template.min ?? 0) < 1) return false;
      return Object.values(template.input?.required ?? {}).some((inner) => MEDIA.has(String((inner as [unknown])[0])));
    };
    const problems: string[] = [];
    for (const entry of SUPPORTED) {
      const node = catalog[entry.node];
      if (node === undefined) continue;
      for (const [name, spec] of Object.entries(node.input?.required ?? {})) {
        if (demands(spec)) problems.push(`${entry.key}: required ${name} demands media`);
        const options = ((spec as [unknown, Record<string, unknown>])[1]?.options ?? []) as { key: string; inputs?: { required?: Record<string, unknown> } }[];
        const chosen = entry.modelId === null ? options[0] : options.find((option) => option.key === entry.modelId);
        for (const [sub, subSpec] of Object.entries(chosen?.inputs?.required ?? {})) {
          if (demands(subSpec)) problems.push(`${entry.key}: required ${name}.${sub} demands media`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("names reference slots the catalog really declares", () => {
    const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8")) as Record<string, { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }>;
    const problems: string[] = [];
    for (const entry of SUPPORTED.filter((e) => e.referenceImages !== undefined)) {
      const group = entry.referenceImages!;
      const node = catalog[entry.node];
      const [head, ...tail] = group.input.split(".");
      const top = { ...(node?.input?.required ?? {}), ...(node?.input?.optional ?? {}) } as Record<string, [unknown, Record<string, unknown>] | undefined>;
      let spec = top[head!];
      if (tail.length > 0) {
        const options = (spec?.[1]?.options ?? []) as { key: string; inputs?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }[];
        const chosen = options.find((option) => option.key === entry.modelId);
        if (chosen === undefined) {
          problems.push(`${entry.key}: model ${entry.modelId} is gone from ${entry.node}`);
          continue;
        }
        const subs = { ...(chosen.inputs?.required ?? {}), ...(chosen.inputs?.optional ?? {}) } as Record<string, [unknown, Record<string, unknown>] | undefined>;
        spec = subs[tail.join(".")];
      }
      if (spec === undefined) {
        problems.push(`${entry.key}: the catalog has no input ${group.input}`);
        continue;
      }
      if (spec[0] !== "COMFY_AUTOGROW_V3") problems.push(`${entry.key}: ${group.input} is ${String(spec[0])}, not an autogrow group`);
      const template = (spec[1]?.template ?? {}) as { names?: unknown; min?: unknown };
      if (Number(template.min ?? 0) !== 0) problems.push(`${entry.key}: ${group.input} demands ${String(template.min)} images`);
      expect(template.names, entry.key).toEqual([...group.slots]);
    }
    expect(problems).toEqual([]);
  });
});

// ---------- the picker and the builder are one product ----------
//
// The picker renders `modelSummary` rows and puts `generateFields` on the wire.
// These two tests walk that exact path for every row the sheet can show, so a
// model can never appear in the picker that the builder would then refuse.

describe("the picker only offers models the builder can build", () => {
  const listed = [...listModels({ kind: "image" }), ...listModels({ kind: "video" })];

  it("lists only supported entries, and every one of them builds", () => {
    expect(listed.length).toBeGreaterThan(80);
    const unsupported = listed.filter((entry) => !entry.supported);
    expect(unsupported.map((e) => e.key)).toEqual([]);
    // Nothing in the picker is outside the set the graph validation covers.
    const validated = new Set(SUPPORTED.map((e) => e.key));
    expect(listed.filter((entry) => !validated.has(entry.key)).map((e) => e.key)).toEqual([]);
  });

  it("builds a legal graph for every value its own controls offer", () => {
    const problems: string[] = [];
    let built = 0;
    for (const entry of listed) {
      const summary = modelSummary(entry, 1 / 211);
      const start = initialValues(summary);
      /** One pass of the form: pick the wishes, resolve them, send what the tab sends. */
      const attempt = (label: string, wish: FormValues): void => {
        const shape = formModel(summary, wish);
        const fields = generateFields(summary, shape);
        try {
          const graph = buildWorkflow(resolveSpec({ prompt: "a quiet harbour at dawn", ...fields }, entry.key, entry.kind));
          built += 1;
          problems.push(...validate(entry, graph).map((problem) => `${label}: ${problem}`));
        } catch (cause) {
          problems.push(`${entry.key} ${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      };
      attempt("defaults", start);
      const caps = summary.capabilities;
      for (const sizePreset of caps.sizePresets) attempt(`preset ${sizePreset}`, { ...start, sizePreset });
      for (const aspect of caps.aspects) attempt(`aspect ${aspect}`, { ...start, aspect });
      for (const resolution of caps.resolutions) attempt(`resolution ${resolution}`, { ...start, resolution });
      if (caps.duration !== null) {
        const lengths = caps.duration.allowed ?? [caps.duration.min, caps.duration.max];
        for (const duration of lengths) attempt(`duration ${duration}`, { ...start, duration });
      }
      if (caps.audio) attempt("audio", { ...start, audio: true });
      if (caps.count !== null) attempt(`count ${caps.count.max}`, { ...start, count: caps.count.max });
      if (caps.dimensions !== null) {
        const d = caps.dimensions;
        attempt("smallest", { ...start, sizePreset: "Custom", width: d.widthMin, height: d.heightMin });
        attempt("largest", { ...start, sizePreset: "Custom", width: d.widthMax, height: d.heightMax });
      }
      // Everything in More options, one value at a time, because that is the
      // one control the picker renders from the schema alone.
      for (const extra of summary.extras) {
        const values: (string | number | boolean)[] =
          extra.options !== undefined
            ? [...extra.options]
            : extra.type === "BOOLEAN"
              ? [true, false]
              : extra.type === "INT" || extra.type === "FLOAT"
                ? [extra.min, extra.max].filter((value): value is number => typeof value === "number")
                : [];
        for (const value of values) attempt(`${extra.name}=${String(value)}`, { ...start, extras: { [extra.name]: value } });
      }
    }
    expect(problems).toEqual([]);
    expect(built).toBeGreaterThan(1000);
  });
});

// ---------- the frontend must not bundle the registry ----------

describe("what the panel is allowed to import", () => {
  it("keeps the 500 KB registry out of the app bundle", () => {
    const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
    const files: string[] = [path.join(root, "app.tsx")];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(path.join(root, "components"));
    const offenders = files.filter((file) => /from "[^"]*(models\.generated|models\.overrides|\/registry)"/.test(fs.readFileSync(file, "utf8")));
    // The panel gets model rows from the `models` RPC. Importing the registry
    // would pull half a megabyte of catalog into the browser.
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});

// ---------- pricing and the picker rows ----------

describe("pricing a catalog this size", () => {
  it("prices most of the catalog, and says so honestly when it cannot", () => {
    const priced = SUPPORTED.filter((e) => e.price !== null);
    expect(priced.length / SUPPORTED.length).toBeGreaterThan(0.9);
    for (const entry of priced) {
      expect(entry.price!.note, entry.key).not.toBe("");
      expect(["measured", "published", "inferred", "unknown"]).toContain(entry.price!.confidence);
    }
  });

  it("walks a tier table with the request's own role values", () => {
    const veo = getModel("veo-3.1-generate");
    expect(veo?.price?.unit).toBe("per-second");
    const silent = priceCredits(veo!.price as ModelPrice, "video", { resolution: "720p", duration: 8, generateAudio: false });
    const withAudio = priceCredits(veo!.price as ModelPrice, "video", { resolution: "720p", duration: 8, generateAudio: true });
    expect(silent).toBeCloseTo(42.2 * 8, 1);
    expect(withAudio).toBeCloseTo(42.2 * 2 * 8, 1);
    // 4k costs more than 720p at the same length.
    expect(priceCredits(veo!.price as ModelPrice, "video", { resolution: "4k", duration: 8 })!).toBeGreaterThan(silent!);
  });

  it("prices an image by its pixel tier and by its count", () => {
    const flux = getModel("Flux2ImageNode/Flux.2 [pro]");
    expect(flux?.price?.unit).toBe("per-image");
    const oneMp = priceCredits(flux!.price as ModelPrice, "image", { width: 1024, height: 1024 });
    const fourMp = priceCredits(flux!.price as ModelPrice, "image", { width: 2048, height: 2048 });
    expect(oneMp).toBeCloseTo(6.33, 2);
    expect(fourMp).toBeCloseTo(6.33 + 3.17 * 3, 2);
  });

  it("prices Seedream from its published figure and prices Seedance from the formula", () => {
    expect(estimateCredits("image", "seedream 5.0 pro", { sizePreset: "(1K) 1024x1024 (1:1)" })).toEqual({ credits: 9.5, confidence: "published" });
    expect(estimateCredits("video", "seedance-1-0-pro-fast-251015", { resolution: "480p", duration: 4 })).toEqual({ credits: 8.29, confidence: "inferred" });
  });

  it("uses a registry price for a model the two legacy tables never had", () => {
    const grok = getModel("GrokImageNode/grok-imagine-image");
    const estimate = estimateCredits("image", grok!.key, {}, undefined, grok!.price);
    expect(estimate.credits).toBeCloseTo(4.22, 2);
    expect(estimate.confidence).toBe("published");
    // No price at all is still an honest unknown.
    expect(estimateCredits("image", "made-up", {}, undefined, null)).toEqual({ credits: null, confidence: "unknown" });
  });

  it("keys a price by the id Comfy bills under, whichever name the caller used", () => {
    // The panel sends a registry key, the CLI and the agent tools take a bare
    // id, and a stored row may hold a legacy bare id. All three price and learn
    // as one shape.
    expect(priceKeyOf("LumaImageNode/photon-flash-1")).toBe("photon-flash-1");
    expect(priceKeyOf("photon-flash-1")).toBe("photon-flash-1");
    expect(priceKeyOf("ByteDanceSeedreamNodeV2/seedream 5.0 pro")).toBe("seedream 5.0 pro");
    expect(priceKeyOf("seedream 5.0 pro")).toBe("seedream 5.0 pro");
    // A node that runs one model has no id of its own, so the key is the name.
    expect(priceKeyOf("IdeogramPImage")).toBe("IdeogramPImage");
    // Nothing in the registry is returned unchanged rather than guessed at.
    expect(priceKeyOf("made-up-model")).toBe("made-up-model");

    const params = specParams(resolveSpec({ prompt: "p", sizePreset: "(1K) 1024x1024 (1:1)" }, "ByteDanceSeedreamNodeV2/seedream 5.0 pro", "image"));
    const shape = estimateParamsOf({ params, kind: "image" });
    expect(assetCostSignature({ kind: "image", model: "ByteDanceSeedreamNodeV2/seedream 5.0 pro", params })).toBe("image|seedream 5.0 pro|1K");
    expect(estimateCredits("image", priceKeyOf("ByteDanceSeedreamNodeV2/seedream 5.0 pro"), shape)).toEqual({ credits: 9.5, confidence: "published" });
  });

  it("stores the same estimate the form quoted, quality and count included", () => {
    const entry = getModel("IdeogramPImage")!;
    const summary = modelSummary(entry, 1 / 211);
    for (const quality of ["VERY_LOW", "MEDIUM", "HIGH"]) {
      // What the form does: resolve the wishes, quote the price from them.
      const shape = formModel(summary, { ...initialValues(summary), resolution: "1K", extras: { quality } });
      const fields = generateFields(summary, shape);
      const quoted = estimateCredits("image", entry.key, { resolution: "1K", quality: quality.toLowerCase() }, undefined, entry.price);
      // What the server does: build the row, estimate from its own params.
      const params = specParams(resolveSpec({ prompt: "p", ...fields }, entry.key, "image"));
      const stored = estimateCredits("image", priceKeyOf(entry.key), estimateParamsOf({ params, kind: "image" }), undefined, entry.price);
      expect(stored, quality).toEqual(quoted);
      expect(params.quality, quality).toBe(quality);
    }
    expect(estimateCredits("image", "IdeogramPImage", { resolution: "1K", quality: "very_low" }, undefined, entry.price).credits).toBeCloseTo(0.91, 2);
    expect(estimateCredits("image", "IdeogramPImage", { resolution: "1K", quality: "high" }, undefined, entry.price).credits).toBeCloseTo(4.53, 2);

    // A model that batches charges per image, and the stored row has to say so.
    const seedream = getModel("seedream-4-0-250828")!;
    const many = specParams(resolveSpec({ prompt: "p", sizePreset: "(1K) 1024x1024 (1:1)", count: 3 }, seedream.key, "image"));
    expect(many.count).toBe(3);
    expect(estimateCredits("image", priceKeyOf(seedream.key), estimateParamsOf({ params: many, kind: "image" })).credits).toBeCloseTo(6.33 * 3, 2);
  });

  it("sorts a five unit catalog by the cheapest run each model can actually do", () => {
    // A tier on a per second or per 1000 tokens price is a rate, not a figure.
    // Read as a figure, Seedance 2.0 Mini's 1.06 credit tier would put one of
    // the dearest video models ahead of a 6 credit clip in the Cheapest sort.
    const mini = getModel("ByteDance2TextToVideoNode/Seedance 2.0 Mini")!;
    expect(mini.price?.unit).toBe("per-1k-tokens");
    expect(Math.min(...(mini.price?.tiers ?? []).map((tier) => tier.credits))).toBeCloseTo(1.06, 2);
    expect(floorCredits(mini.price!, "video", { resolution: "480p", duration: 4 })).toBeCloseTo(41.64, 1);

    for (const kind of ["image", "video"] as const) {
      const rows = listModels({ kind }).map((entry) => modelSummary(entry, 1 / 211));
      const sorted = sortModels(rows, "cheapest").map((row) => cheapestCredits(row) ?? Number.POSITIVE_INFINITY);
      for (let i = 1; i < sorted.length; i += 1) expect(sorted[i]!, `${kind} row ${i}`).toBeGreaterThanOrEqual(sorted[i - 1]!);
      // The cheapest of each kind is what the skill quotes.
      expect(sorted[0]).toBeLessThan(kind === "image" ? 1 : 7);
    }
  });

  it("prints the figure the Cheapest sort orders by, on every row", () => {
    // A video row's usual line is a rate per second and the sort key is a whole
    // clip, so the row prints the figure it is sorted on and the column ascends
    // under that sort.
    for (const kind of ["image", "video"] as const) {
      for (const entry of listModels({ kind })) {
        const row = modelSummary(entry, 1 / 211);
        const credits = cheapestCredits(row);
        expect(row.cheapestLine, entry.key).not.toBe("");
        if (credits === null) continue;
        const shown = /(\d+(?:\.\d+)?) credits/.exec(row.cheapestLine);
        expect(shown, `${entry.key}: ${row.cheapestLine}`).not.toBeNull();
        expect(Number(shown![1]), entry.key).toBeCloseTo(credits, 2);
      }
    }
    // "per clip" is a video word; the one image model billed per run says run.
    const wan = getModel("WanTextToImageApi/wan2.5-t2i-preview")!;
    expect(wan.price?.unit).toBe("per-run");
    expect(priceLine(wan, 1 / 211)).toContain("per run");
    expect(priceLine(wan, 1 / 211)).not.toContain("clip");
  });

  it("reads the length out of an extra when the model has no duration role", () => {
    // Kling keeps the length and the model version in one `mode` combo, and its
    // 10 s option costs exactly double, so `requestSeconds` has to read the
    // length out of that combo or a 10 s request is quoted at the 5 s price.
    const kling = getModel("KlingTextToVideoNode")!;
    expect(kling.roles.duration, "Kling still has no duration role").toBeUndefined();
    const summary = modelSummary(kling, 1 / 211);
    const long = "pro mode / 10s duration / kling-v2-5-turbo";
    // The combo is the length control: the picker offers 5 s and 10 s and the
    // raw vendor string never reaches the form.
    expect(summary.capabilities.durationVia).toBe("mode");
    expect(summary.capabilities.duration?.allowed).toEqual([5, 10]);
    expect(visibleExtras(summary).some((extra) => extra.name === "mode")).toBe(false);
    expect(durationOf(initialValues(summary), summary)).toBe(5);
    // A tweak arrives carrying the string and no length of its own.
    expect(durationOf({ ...initialValues(summary), duration: null, extras: { mode: long } }, summary)).toBe(10);

    // Choosing 10 s writes the string, which is what the vendor's own note asks
    // for: "a duration control must write the mode string, not a number".
    const shape = formModel(summary, { ...initialValues(summary), duration: 10 });
    expect(shape.values.extras.mode).toBe(long);
    const fields = generateFields(summary, shape);
    const params = specParams(resolveSpec({ prompt: "p", ...fields }, kling.key, "video"));
    const stored = estimateCredits("video", priceKeyOf(kling.key), estimateParamsOf({ params, kind: "video" }), undefined, kling.price);
    expect(stored.credits).toBeCloseTo(147.7, 1);
    // The default 5 s option is still the 5 s price.
    expect(estimateCredits("video", kling.key, {}, undefined, kling.price).credits).toBeCloseTo(73.85, 1);
  });

  it("matches a named resolution tier against a model that speaks in pixels", () => {
    // LTX-2.5 prices by tier ("4k") and sizes by preset ("3840x2160"), and
    // "3840x2160" contains no "4k", so the tier has to be read from the pixels.
    const ltx = getModel("LtxApi25TextToVideo/LTX-2.5 (Fast)")!;
    const price = ltx.price as ModelPrice;
    const at = (sizePreset: string) => priceCredits(price, "video", { sizePreset, duration: 5 });
    expect(at("1280x720")).toBeCloseTo(27.16 * 5, 1);
    expect(at("1920x1080")).toBeCloseTo(39.22 * 5, 1);
    expect(at("2560x1440")).toBeCloseTo(57.33 * 5, 1);
    expect(at("3840x2160")).toBeCloseTo(90.52 * 5, 1);
    // Portrait names the same tier as its landscape twin.
    expect(at("2160x3840")).toBe(at("3840x2160"));
    // An image tier is left alone: "2K" must not be read as a video tier.
    const seedream = getModel("seedream 5.0 pro")!;
    expect(estimateCredits("image", "seedream 5.0 pro", { sizePreset: "(2K) 2048x2048 (1:1)" }).credits).toBeCloseTo(18.99, 2);
    expect(seedream.kind).toBe("image");
  });

  it("hedges a price the vendor publishes as a span, not a figure", () => {
    // GPT Image bills on tokens and the token count follows the size the model
    // decides to return. Asked for "auto" it can return an odd size and bill
    // above the published figure, so a quote with no hedge would understate it.
    // Its record carries a range on every quality tier; that range is what
    // makes the figure a floor rather than a quote.
    const entry = getModel("OpenAIGPTImageNodeV2/gpt-image-2")!;
    expect(entry.price?.tiers?.every((tier) => tier.creditsRange !== undefined)).toBe(true);
    for (const quality of ["low", "medium", "high"]) {
      const estimate = estimateCredits("image", priceKeyOf(entry.key), { quality }, undefined, entry.price);
      expect(estimate.credits, quality).toBeGreaterThan(0);
      expect(estimate.confidence, quality).toBe("inferred");
      expect(estimateCreditsText(estimate), quality).toMatch(/^about /);
    }
    // A flat per-image price is still quoted as one, or every model would hedge.
    const krea = getModel("Krea2ImageNode/Krea 2 Medium Turbo")!;
    expect(estimateCredits("image", priceKeyOf(krea.key), {}, undefined, krea.price).confidence).toBe("published");
  });

  it("says unknown rather than quoting a rate it cannot apply", () => {
    // Gemini's Omni Flash takes its clip length from the prompt, so a per
    // second rate cannot be turned into a number for it.
    const omni = getModel("GeminiVideoOmniV2/Omni Flash 1.1");
    expect(omni, "Gemini Omni Flash 1.1 is missing from the registry").toBeTruthy();
    expect(lengthIsUnpredictable(omni!)).toBe(true);
    expect(priceForEstimate(omni!, null)).toBeNull();
    expect(estimateCredits(omni!.kind, omni!.key, {}, undefined, priceForEstimate(omni!, null))).toEqual({ credits: null, confidence: "unknown" });
    // A resolution the model does not offer has no price either.
    expect(estimateCredits("video", "seedance-1-0-pro-fast-251015", { resolution: "4k", duration: 5 })).toEqual({ credits: null, confidence: "unknown" });
  });

  it("lets this account's own bills win once a shape has been seen twice", () => {
    const entry = getModel("LumaImageNode/photon-flash-1")!;
    const params = specParams(resolveSpec({ prompt: "p", aspect: "1:1" }, entry.key, "image"));
    const signature = assetCostSignature({ kind: "image", model: entry.key, params });
    const shape = estimateParamsOf({ params, kind: "image" });
    // One sample is not enough to overrule the registry. The expectation is the
    // registry's own answer rather than a figure typed here, because Luma keeps
    // re-pricing and this test is about the rule, not about the number; the
    // number is pinned in the Luma test below.
    const registry = priceCredits(entry.price as ModelPrice, "image", shape);
    const once = (id: string) => (id === signature ? { credits: 0.5, samples: 1 } : null);
    expect(estimateCredits("image", priceKeyOf(entry.key), shape, once, entry.price).credits).toBe(registry);
    expect(registry, "and the single sample did not win").not.toBe(0.5);
    const twice = (id: string) => (id === signature ? { credits: 0.5, samples: 2 } : null);
    expect(estimateCredits("image", priceKeyOf(entry.key), shape, twice, entry.price)).toEqual({ credits: 0.5, confidence: "measured" });
    // And a row stored under the bare id keys the very same sample.
    expect(assetCostSignature({ kind: "image", model: "photon-flash-1", params })).toBe(signature);
  });
});

describe("the picker rows", () => {
  it("gives every listed model a capability line, a price line and legal defaults", () => {
    const rows = listModels();
    expect(rows.length).toBeGreaterThan(80);
    for (const entry of rows) {
      const caps = capabilitiesOf(entry);
      const defaults = defaultsOf(entry, caps);
      expect(capabilityLine(entry, caps), entry.key).not.toBe("");
      expect(priceLine(entry, 1 / 211), entry.key).not.toBe("");
      if (defaults.sizePreset !== null) expect(caps.sizePresets, entry.key).toContain(defaults.sizePreset);
      if (defaults.aspect !== null) expect(caps.aspects, entry.key).toContain(defaults.aspect);
      if (defaults.resolution !== null) expect(caps.resolutions, entry.key).toContain(defaults.resolution);
      if (defaults.duration !== null) {
        expect(defaults.duration).toBeGreaterThanOrEqual(caps.duration!.min);
        expect(defaults.duration).toBeLessThanOrEqual(caps.duration!.max);
      }
    }
  });

  it("lets exactly one model of each kind claim to be the cheapest", () => {
    // A strengths line that calls a model the cheapest in the catalog has to be
    // true, so it is checked: at most one per kind, and it holds the lowest floor.
    for (const kind of ["image", "video"] as const) {
      const rows = listModels({ kind }).map((entry) => modelSummary(entry, 1 / 211));
      const floors = rows.map((row) => cheapestCredits(row)).filter((credits): credits is number => credits !== null);
      const lowest = Math.min(...floors);
      const claims = rows.filter((row) => /cheapest .*(catalog|anywhere)/i.test(row.strengths ?? ""));
      expect(claims.length, `${kind}: ${claims.map((row) => row.label).join(", ")}`).toBeLessThanOrEqual(1);
      for (const row of claims) expect(cheapestCredits(row), row.label).toBeCloseTo(lowest, 2);
    }
  });

  it("never shows two rows a user cannot tell apart", () => {
    // Two Google nodes offer Nano Banana 2 at the same price, and the picker
    // could tell them apart only by a raw node class on the meta line, so the
    // weaker of the two is hidden; `--all` still lists it.
    for (const kind of ["image", "video"] as const) {
      const labels = listModels({ kind }).map((entry) => entry.label);
      expect(new Set(labels).size, `${kind} rows share a label`).toBe(labels.length);
    }
    expect(getModel("GeminiImage2Node/Nano Banana 2 (Gemini 3.1 Flash Image)")?.hidden).toBe(true);
    expect(getModel("GeminiNanoBanana2V2/Nano Banana 2 (Gemini 3.1 Flash Image)")?.hidden).toBe(false);
  });

  it("explains every exclusion in words, not in machine slugs", () => {
    // `bb comfy models --all` exists to say why a model is missing. "why not:
    // needs-image-input" is a tag, not an explanation.
    for (const entry of MODEL_ENTRIES.filter((e) => !e.supported)) {
      const why = entry.unsupportedReason;
      expect(why, entry.key).toBeTruthy();
      expect(why, entry.key).not.toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/);
      expect(why!, entry.key).toMatch(/ /);
    }
  });

  it("gives GPT Image 2 the same Size control as its siblings", () => {
    // Its size list carries "auto" and "Custom" beside eight pixel sizes; those
    // two do not count against the list, so it has a Size row like gpt-image-1
    // on the same node.
    for (const key of ["OpenAIGPTImageNodeV2/gpt-image-2", "OpenAIGPTImageNodeV2/gpt-image-1.5"]) {
      const entry = getModel(key)!;
      expect(entry.roles.sizePreset, key).toBe("model.size");
      const caps = capabilitiesOf(entry);
      expect(caps.sizePresets, key).toContain("1024x1024");
      expect(capabilityLine(entry, caps), key).toMatch(/1024x1024|x/);
    }
  });

  it("keeps a node that left the catalog out of the picker", () => {
    // A model that cannot run must not be listed, priced or sorted: a cheap
    // looking row that cannot run is worse than no row, because the Cheapest
    // sort is exactly where a cost conscious user lands. When a node leaves
    // the catalog its documentation record stays, which is what the unmatched
    // list proves: if the node comes back, it comes back refused.
    for (const [key, record] of [
      ["OpenAIDalle2", "dall-e-2"],
      ["OpenAIDalle3", "dall-e-3"],
    ]) {
      const entry = getModel(key);
      if (entry === null) {
        expect(UNMATCHED_DOC_RECORDS.some((line) => line.endsWith(`: ${record}`)), record).toBe(true);
      } else {
        expect(entry.supported, key).toBe(false);
        expect(entry.unsupportedReason, key).toMatch(/no longer in the Comfy Cloud catalog/i);
      }
      expect(
        listModels({ kind: "image" }).some((row) => row.key === key),
        key,
      ).toBe(false);
    }
  });

  it("prices a reference image, and refuses to quote when it cannot", () => {
    // A caller may check the estimate against a spending limit, so quoting a
    // reference run at the text only figure could carry a batch past that limit
    // unseen. A missing number is visibly missing; a confident wrong one is not.
    const gpt = getModel("OpenAIGPTImageNodeV2/gpt-image-2")!;
    const shape = { quality: "low", sizePreset: "1024x1024" };
    const quote = (params: Record<string, unknown>) => estimateCredits("image", priceKeyOf(gpt.key), params, undefined, gpt.price);
    // Text only.
    expect(quote(shape).credits).toBe(1.44);
    // One reference adds the badge's per reference figure: 1.44 + 2.26.
    expect(quote({ ...shape, references: 1 }).credits).toBe(3.7);
    // A batch of ten runs with one reference each.
    expect(quote({ ...shape, references: 1 }).credits! * 10).toBeCloseTo(37, 0);
    // A reference the vendor prices as a span keeps the quote hedged.
    expect(quote({ ...shape, references: 1 }).confidence).toBe("inferred");

    // Seedream's base price covers the first reference and bills the rest.
    const seedream = getModel("ByteDanceSeedreamNodeV3/seedream 5.0 pro")!;
    const seed = (references: number) =>
      estimateCredits("image", priceKeyOf(seedream.key), { sizePreset: "(1K) 1024x1024 (1:1)", references }, undefined, seedream.price).credits;
    expect(seed(0)).toBe(9.5);
    expect(seed(1)).toBe(9.5);
    expect(seed(2)).toBe(10.13);
    expect(seed(3)).toBe(10.76);

    // And a model that takes references with no figure for them says nothing
    // rather than saying the text only price.
    //
    // **The bare quote below is a positive control and is the point of it.** A
    // guard test with only refusals cannot tell the rule firing from the
    // harness being broken: a checker that forgets to pass the registry price
    // refuses every case, and its intended refusals then read as a pass. Only
    // a positive control that also refuses gives that away.
    const flux = getModel("Flux2ImageNode/Flux.2 [pro]")!;
    expect(flux.referenceImages, "Flux.2 takes references").toBeTruthy();
    expect(flux.price?.reference, "and its badge prices them per run, not per image").toBeUndefined();
    const bare = estimateCredits("image", priceKeyOf(flux.key), {}, undefined, flux.price);
    expect(bare.credits, "the positive control must quote, or a refusal proves nothing").not.toBe(null);
    expect(estimateCredits("image", priceKeyOf(flux.key), { references: 1 }, undefined, flux.price)).toEqual({ credits: null, confidence: "unknown" });
  });

  it("gives a reference run its own learned shape", () => {
    // GPT Image bills a reference from the first one, while Seedream's base
    // price covers one: a text only run and a run with one reference are
    // different shapes, not noisy samples of the same one.
    const base = costSignature("image", "gpt-image-2", { quality: "low", sizePreset: "1024x1024" });
    const one = costSignature("image", "gpt-image-2", { quality: "low", sizePreset: "1024x1024", references: 1 });
    const two = costSignature("image", "gpt-image-2", { quality: "low", sizePreset: "1024x1024", references: 2 });
    expect(new Set([base, one, two]).size).toBe(3);
    expect(one).toContain("1ref");
    // A row with no references has no reference part in its signature.
    expect(base).not.toContain("ref");
  });

  it("prices GPT Image 2.5 per size and quality from the price badge table", () => {
    // A later catalog added two variants with two quality tiers above
    // high and a transparent background. Forty figures, read out of the node's
    // price_badge rather than typed, so the tiers are keyed on quality AND size
    // and the most specific one wins.
    for (const key of ["OpenAIGPTImageNodeV2/gpt-image-2.5-flare", "OpenAIGPTImageNodeV2/gpt-image-2.5-sunburst"]) {
      const entry = getModel(key)!;
      expect(entry.supported, key).toBe(true);
      expect(listModels({ kind: "image" }).some((row) => row.key === key), key).toBe(true);
      // The generated label reads "Gpt Image 2.5 Flare"; the docs record sets it.
      expect(entry.label, key).toMatch(/^GPT Image 2\.5 (Flare|Sunburst)$/);
      // A registry priced model carries its own price, so it is passed in the
      // way the server and the picker pass it; the bare tables in contract.ts
      // cover only the ten legacy ids.
      const id = priceKeyOf(key);
      const quote = (params: Record<string, unknown>) => estimateCredits("image", id, params, undefined, entry.price);
      // The low square, at the table's own figure.
      expect(quote({ quality: "low", sizePreset: "1024x1024" }).credits, key).toBe(1.77);
      // A tier two rungs above anything gpt-image-2 offers.
      expect(quote({ quality: "max", sizePreset: "2048x2048" }).credits, key).toBe(129.2);
      expect(quote({ quality: "high", sizePreset: "1024x1536" }).credits, key).toBe(12.43);
      // GPT bills on tokens, so every figure is a floor and the whole price
      // carries a range: the surfaces must keep saying "about".
      expect(quote({ quality: "low", sizePreset: "1024x1024" }).confidence, key).toBe("inferred");
    }
  });

  it("prices the MAI pair from the token formula, cheapest first", () => {
    const full = getModel("OpenRouterImageNode/microsoft/mai-image-2.6")!;
    const flash = getModel("OpenRouterImageNode/microsoft/mai-image-2.6-flash")!;
    // The generated labels carry the OpenRouter vendor prefix.
    expect(full.label).toBe("MAI Image 2.6");
    expect(flash.label).toBe("MAI Image 2.6 Flash");
    // "1.5K" is a tier with a decimal place, and the tier key reader takes it,
    // so the model prices at its 1.5K figure rather than its 1K one.
    expect(estimateCredits("image", priceKeyOf(full.key), { resolution: "1.5K" }, undefined, full.price).credits).toBe(26.49);
    expect(estimateCredits("image", priceKeyOf(flash.key), { resolution: "1.5K" }, undefined, flash.price).credits).toBe(13.23);
    expect(estimateCredits("image", priceKeyOf(full.key), { resolution: "1K" }, undefined, full.price).credits).toBe(11.82);
    expect(estimateCredits("image", priceKeyOf(flash.key), { resolution: "1K" }, undefined, flash.price).credits).toBe(5.9);
  });

  it("prices Pruna P-Video-2 per second by resolution and draft, and refuses an automatic length", () => {
    // Added in a later catalog. The node's price badge and Comfy's pricing
    // page agree: 7.54 and 15.09 credits a second at 720p and 1080p, and a
    // draft bills 60 percent of that.
    const entry = getModel("PrunaTextToVideoNode/p-video-2")!;
    expect(entry.supported).toBe(true);
    const quote = (params: Record<string, unknown>) => estimateCredits("video", priceKeyOf(entry.key), params, undefined, entry.price).credits;
    expect(quote({ resolution: "720p", duration: 4 })).toBe(30.16);
    expect(quote({ resolution: "720p", duration: 4, draft: true })).toBe(18.12);
    expect(quote({ resolution: "1080p", duration: 10 })).toBe(150.9);
    expect(quote({ resolution: "1080p", duration: 10, draft: true })).toBe(90.5);
    // "auto" lets the model pick 1 to 20 seconds after the quote, so on a per
    // second price there is no figure to give. The form never sends it; a graph
    // through run_workflow can, and its stored shape has to refuse too.
    expect(quote({ resolution: "720p", durationAuto: true })).toBeNull();
    const stored = estimateParamsOf({ params: { resolution: "720p", "model.duration": "auto", "model.draft": true }, kind: "video" });
    expect(stored.durationAuto).toBe(true);
    expect(stored.draft).toBe(true);
    expect(quote(stored as Record<string, unknown>)).toBeNull();
    // A draft and an automatic length are different shapes from a plain clip,
    // so neither may teach the plain one a price.
    expect(costSignature("video", "p-video-2", { resolution: "720p", duration: 5, draft: true })).toBe("video|p-video-2|720p|5s|draft");
    expect(costSignature("video", "p-video-2", { resolution: "720p", durationAuto: true })).toBe("video|p-video-2|720p|auto");
    // The node's own default is the string "5" beside "auto"; the form opens at
    // 5 seconds rather than at the first number in the list.
    const summary = modelSummary(entry, 1 / 211);
    expect(summary.defaults.duration).toBe(5);
    // The live form reads the draft switch the same way the stored row does.
    expect(draftOf({ ...initialValues(summary), extras: { "model.draft": true } }, summary)).toBe(true);
    expect(draftOf(initialValues(summary), summary)).toBe(false);
  });

  it("sends a combo value in the type the catalog declares it", () => {
    // ComfyUI checks a combo with a plain `in` and no coercion. Pruna spells fps
    // "24" and "48" and would refuse 24; Kling spells its lengths 5 and 10 and
    // would refuse "5".
    const pruna = buildWorkflow(resolveSpec({ prompt: "p", duration: 7 }, "PrunaTextToVideoNode/p-video-2"))["1"]!.inputs;
    expect(pruna["model.fps"]).toBe("24");
    expect(pruna["model.duration"]).toBe("7");
    const ltx = buildWorkflow(resolveSpec({ prompt: "p" }, "LtxApi25TextToVideo/LTX-2.5 (Fast)"))["1"]!.inputs;
    expect(typeof ltx["model.duration"]).toBe("string");
    expect(typeof ltx["model.fps"]).toBe("string");
    const kling = buildWorkflow(resolveSpec({ prompt: "p" }, "KlingTextToVideoWithAudio/kling-v2-6"))["1"]!.inputs;
    expect(kling.duration).toBe(5);
    // MiniMax Hailuo's lengths are numbers in the catalog the same way.
    const hailuo = buildWorkflow(resolveSpec({ prompt: "p" }, "MinimaxHailuoVideoNode"))["1"]!.inputs;
    expect(typeof hailuo.duration).toBe("number");
  });

  it("quotes the three Nano Banana 2 rows with a reference, which their badge does not charge", () => {
    // The node's price badge reads no input group, so a reference adds
    // nothing. Without that recorded in the docs, a run with a reference
    // would quote "cost unknown".
    const quote = (key: string, references: number) => {
      const entry = getModel(key)!;
      return estimateCredits("image", priceKeyOf(entry.key), { resolution: "1K", references }, undefined, entry.price).credits;
    };
    for (const references of [0, 1, 2]) expect(quote("GeminiNanoBanana2V2/Gemini Nano Banana 2.1", references)).toBe(12.4);
    expect(quote("GeminiNanoBanana2V2/Nano Banana 2 (Gemini 3.1 Flash Image)", 1)).toBe(17.62);
    expect(quote("GeminiNanoBanana2V2/Nano Banana 2 Lite", 2)).toBe(8.61);
  });

  it("reads a decimal K size as a tier and prices FLUX.3 at each one", () => {
    // A K tier may carry a decimal, so FLUX.3's 0.75K and 1.5K read as tiers
    // and the model keeps its Size control instead of sitting at its 2K default.
    const flux = getModel("Flux3ImageNode")!;
    expect(capabilitiesOf(flux).resolutions).toEqual(["0.75K", "1K", "1.5K", "2K", "4K"]);
    const quote = (resolution: string) => estimateCredits("image", priceKeyOf(flux.key), { resolution }, undefined, flux.price).credits;
    expect([quote("0.75K"), quote("1K"), quote("1.5K"), quote("2K"), quote("4K")]).toEqual([12.37, 14.48, 21.12, 30.17, 183.15]);
    expect(buildWorkflow(resolveSpec({ prompt: "p", resolution: "0.75K" }, flux.key))["1"]!.inputs.resolution).toBe("0.75K");
  });

  it("refuses the two Sora 2 rows Comfy Cloud retired, and keeps their records", () => {
    // OpenAIVideoSora2 is gone from the catalog. A registry that carries the
    // node refuses the rows with the reason; once regenerated, the node is gone
    // and the records wait in the unmatched list, the way DALL-E's do, so a
    // node that comes back comes back refused.
    for (const [key, record] of [
      ["OpenAIVideoSora2/sora-2", "sora-2"],
      ["OpenAIVideoSora2/sora-2-pro", "sora-2-pro"],
    ]) {
      const entry = getModel(key);
      if (entry === null) {
        expect(UNMATCHED_DOC_RECORDS.some((line) => line.endsWith(`: ${record}`)), record).toBe(true);
      } else {
        expect(entry.supported, key).toBe(false);
        expect(() => resolveSpec({ prompt: "p" }, key)).toThrow(/dropped this node from its catalog/);
      }
      expect(listModels({ kind: "video" }).some((row) => row.key === key), key).toBe(false);
    }
  });

  it("refuses the two GPT Image 1 rows Comfy Cloud retired, and keeps their record", () => {
    // Comfy Cloud dropped gpt-image-1 from OpenAIGPTImageNodeV2 and
    // OpenAIGPTImage1 while keeping gpt-image-1.5, gpt-image-2 and
    // the two 2.5 variants (all four still declare model.images with 16 slots).
    for (const key of ["OpenAIGPTImageNodeV2/gpt-image-1", "OpenAIGPTImage1/gpt-image-1"]) {
      const entry = getModel(key);
      if (entry === null) {
        expect(UNMATCHED_DOC_RECORDS.some((line) => line.endsWith(": gpt-image-1"))).toBe(true);
      } else {
        expect(entry.supported, key).toBe(false);
        expect(() => resolveSpec({ prompt: "p" }, key)).toThrow(/dropped gpt-image-1/);
      }
      expect(listModels({ kind: "image" }).some((row) => row.key === key), key).toBe(false);
    }
  });

  it("prices HY Image 3.5 by tier, and does not learn a size the node ignored", () => {
    // 0.03432 US dollars at 1K and 2K and 0.04576 at 4K, from the node's badge.
    const entry = getModel("HunyuanImageTextToImageApi/hy-image-3.5-preview")!;
    expect(entry.supported).toBe(true);
    const quote = (resolution: string) => estimateCredits("image", priceKeyOf(entry.key), { resolution }, undefined, entry.price).credits;
    expect(quote("1K")).toBe(7.24);
    expect(quote("2K")).toBe(7.24);
    expect(quote("4K")).toBe(9.66);
    // Width and height only serve the node's "custom" size, which the plugin
    // drops. The graph still carries them (they are required), but the row must
    // not, or every bill would be keyed on 2048x2048 whatever the tier.
    const spec = resolveSpec({ prompt: "p", resolution: "4K", aspect: "16:9" }, entry.key);
    expect(buildWorkflow(spec)["1"]!.inputs["model.width"]).toBe(2048);
    const params = specParams(spec);
    expect(params.width).toBeUndefined();
    expect(assetCostSignature({ kind: "image", model: entry.key, params })).toBe("image|hy-image-3.5-preview|4K");
    // At 4K the model cannot pick the ratio itself, and the form says so.
    const summary = modelSummary(entry, 1 / 211);
    const shape = formModel(summary, { ...initialValues(summary), resolution: "4K", aspect: "auto" });
    expect(shape.values.aspect).not.toBe("auto");
  });

  it("offers GPT Image 2 the backgrounds its catalog lists, and refuses one it dropped", () => {
    // ComfyUI 0.37.0 added a transparent background to
    // gpt-image-2, and a later catalog took it away again: the node now
    // offers auto and opaque only. A graph asking for transparent would be
    // refused by Comfy, so the builder refuses it first.
    const gpt = getModel("OpenAIGPTImageNodeV2/gpt-image-2")!;
    const background = extrasOf(gpt).find((extra) => extra.name === "model.background");
    expect(background?.options).toEqual(["auto", "opaque"]);
    expect(background?.options?.map(extraOptionLabel)).toEqual(["auto", "opaque"]);
    const graph = buildWorkflow(resolveSpec({ prompt: "p", extras: { "model.background": "opaque" } }, gpt.key));
    expect(graph["1"]!.inputs["model.background"]).toBe("opaque");
    expect(() => buildWorkflow(resolveSpec({ prompt: "p", extras: { "model.background": "transparent" } }, gpt.key))).toThrow();
  });

  it("prices Luma Photon at Comfy's published flat figure", () => {
    // Luma's badge branches on the model alone and has no size term, so every
    // frame of Photon 1 and Photon Flash 1 costs one published figure.
    const entry = getModel("LumaImageNode/photon-1")!;
    expect(entry.price?.credits).toBe(2.19);
    expect(entry.price?.confidence).toBe("published");
    expect(estimateCredits("image", priceKeyOf(entry.key), {}, undefined, entry.price)).toEqual({ credits: 2.19, confidence: "published" });

    const flash = getModel("LumaImageNode/photon-flash-1")!;
    expect(flash.price?.credits).toBe(0.57);
    expect(flash.price?.confidence).toBe("published");
    expect(estimateCredits("image", priceKeyOf(flash.key), {}, undefined, flash.price).credits).toBe(0.57);
  });

  it("keeps the Luma figures in qa/model-docs and the registry in step", () => {
    // The registry is generated from qa/model-docs, so a price corrected in one
    // and not the other would quote a figure nobody recorded.
    const docs = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "qa", "model-docs", "google-openai-grok-luma.json"), "utf8"));
    for (const [id, key] of [["photon-1", "LumaImageNode/photon-1"], ["photon-flash-1", "LumaImageNode/photon-flash-1"]] as const) {
      const price = docs[id]?.price;
      expect(price?.credits, id).toBeGreaterThan(0);
      expect(getModel(key)?.price?.credits, id).toBe(price.credits);
      expect(price.credits, `${id} matches its US dollar figure at 211 to the dollar`).toBeCloseTo(price.usd * 211, 1);
    }
  });

  it("offers Muse Image but not its edit sibling, and prices both new models", () => {
    // A later catalog added three supported entries. Two are text to
    // something models and are priced from Comfy's own figures; the third,
    // Meta Muse Image Edit, is the same model behind a node that demands one to
    // ten input images, so it must not be in the picker at all.
    const edit = getModel("MetaMuseImageEditApi/muse-image-1.0");
    expect(edit, "the edit node should still be a known entry").toBeTruthy();
    expect(edit!.supported).toBe(false);
    expect(edit!.unsupportedReason).toMatch(/image/i);
    expect(listModels({ kind: "image" }).some((row) => row.key === edit!.key)).toBe(false);

    const muse = getModel("MetaMuseImageTextToImageApi/muse-image-1.0")!;
    expect(muse.supported).toBe(true);
    expect(listModels({ kind: "image" }).some((row) => row.key === muse.key)).toBe(true);
    // Comfy's pricing page says 3.017 credits an image and the node's own price
    // badge says a flat 0.0143 dollars, which is the same figure at 211 to the
    // dollar. Recorded at the two decimals every other price uses.
    expect(muse.price?.unit).toBe("per-image");
    expect(muse.price?.credits).toBe(3.02);

    // H3 Max Turbo has no row on the pricing page, so its rates come from the
    // node's price badge: exactly half of H3 Max at both sizes, which is what
    // Comfy's own H3 tutorial says Turbo costs.
    const turbo = getModel("MinimaxHailuo03TextToVideoNode/MiniMax H3 Max Turbo")!;
    const max = getModel("MinimaxHailuo03TextToVideoNode/MiniMax H3 Max")!;
    expect(turbo.supported).toBe(true);
    expect(listModels({ kind: "video" }).some((row) => row.key === turbo.key)).toBe(true);
    expect(turbo.price?.unit).toBe("per-second");
    for (const [tier, half] of [
      ["480P", 15.09],
      ["768P", 24.14],
    ] as const) {
      const rate = turbo.price?.tiers?.find((t) => t.when?.resolution === tier)?.credits;
      const full = max.price?.tiers?.find((t) => t.when?.resolution === tier)?.credits;
      expect(full, tier).toBe(half);
      expect(rate, tier).toBeCloseTo(half / 2, 1);
    }
  });

  it("drops the pixel fields that only serve a size the picker does not offer", () => {
    // "Custom" comes out of every preset list, so GPT Image 2's custom_width
    // and custom_height cannot do anything: their own tooltip says they are
    // read only when the size is Custom. They stay out of More options.
    const entry = getModel("OpenAIGPTImageNodeV2/gpt-image-2")!;
    expect(
      entry.inputs.some((input) => input.name === "model.custom_width"),
      "the node still declares them",
    ).toBe(true);
    const names = extrasOf(entry).map((extra) => extra.name);
    expect(names).not.toContain("model.custom_width");
    expect(names).not.toContain("model.custom_height");
    expect(capabilitiesOf(entry).sizePresets).not.toContain("Custom");
    // The sibling that has no Custom size keeps every extra it declares.
    const kept = extrasOf(getModel("OpenAIGPTImageNodeV2/gpt-image-1.5")!).map((extra) => extra.name);
    expect(kept).toContain("model.quality");
  });

  it("hedges a price the same way on the row and in the button", () => {
    // `estimateCreditsText` writes "about" for anything this account has not
    // been billed for, and `priceLine` must follow the same rule, or one model
    // reads as two prices on its row and in the button one click later.
    for (const entry of listModels()) {
      const price = entry.price;
      if (price === null || price.credits === null) continue;
      if (price.tiers !== undefined && price.tiers.length > 1) continue;
      if (price.perExtraMegapixelCredits !== undefined || price.creditsRange !== undefined) continue;
      if (price.unit !== "per-image" && price.unit !== "per-run" && price.unit !== "per-video") continue;
      const line = priceLine(entry, 1 / 211);
      const button = estimateCreditsText({ credits: price.credits, confidence: price.confidence });
      expect(button, entry.key).not.toBeNull();
      expect(line.startsWith("about "), `${entry.key}: ${line}`).toBe(button!.startsWith("about "));
    }
    // A few flat priced models by name, so the loop above cannot pass empty.
    for (const key of ["RecraftTextToImageNode", "KlingOmniProImageNode/kling-image-o1", "KlingImageGenerationNode/kling-v3"]) {
      const entry = getModel(key);
      expect(entry, key).toBeTruthy();
      expect(priceLine(entry!, 1 / 211), key).toMatch(/^about /);
    }
  });

  it("holds a documented rule over an extra, not only over a role", () => {
    // Kling Image O1 ignores series_amount: its own tooltip says a series is
    // not supported, so the form must not offer 2 through 9.
    const entry = getModel("KlingOmniProImageNode/kling-image-o1")!;
    const summary = modelSummary(entry, 1 / 211);
    const series = summary.extras.find((extra) => extra.name === "series_amount");
    expect(series?.options).toContain("9");
    const shape = formModel(summary, { ...initialValues(summary), extras: { series_amount: "4" } });
    const options = shape.extraOptions.series_amount ?? [];
    expect(options.filter((option) => !option.disabled).map((option) => option.value)).toEqual(["disabled"]);
    expect(shape.values.extras.series_amount, "an impossible value is put back").toBe("disabled");
    expect(shape.extraNotes.series_amount).toMatch(/cannot make a series/);
    // The note is prose, not a wire name: "series_amount" belongs in the title.
    expect(shape.extraNotes.series_amount).not.toMatch(/_/);
    // The sibling model on the same node keeps its series.
    const omni = modelSummary(getModel("KlingOmniProImageNode/kling-v3-omni")!, 1 / 211);
    expect(formModel(omni, initialValues(omni)).extraOptions.series_amount).toBeUndefined();
  });

  it("offers the same Count on both Seedream 5.0 Pro entries", () => {
    // One node returns one image per run and the plugin's Count queues that
    // many runs, so the legacy V2 entry and the V3 entry cannot disagree about
    // whether the control exists.
    const counts = ["ByteDanceSeedreamNodeV2/seedream 5.0 pro", "ByteDanceSeedreamNodeV3/seedream 5.0 pro"].map((key) => {
      const summary = modelSummary(getModel(key)!, 1 / 211);
      return formModel(summary, initialValues(summary)).countMax;
    });
    expect(counts[0]).toBe(counts[1]);
    expect(counts[0]).toBeGreaterThan(1);
  });

  it("keeps hidden and unsupported entries out of the default list", () => {
    for (const entry of listModels()) {
      expect(entry.supported, entry.key).toBe(true);
      expect(entry.hidden, entry.key).toBe(false);
    }
    expect(listModels({ all: true }).length).toBe(MODEL_ENTRIES.length);
    expect(listModels({ kind: "video" }).every((e) => e.kind === "video")).toBe(true);
    expect(listModels({ query: "seedream" }).every((e) => e.key.toLowerCase().includes("seedream"))).toBe(true);
  });

  it("summarises an entry into the shape the panel renders", () => {
    const entry = getModel("ByteDanceSeedreamNodeV3/seedream 5.0 pro")!;
    const summary = modelSummary(entry, 1 / 211);
    expect(summary.kind).toBe("image");
    expect(summary.vendor).toBe("ByteDance");
    expect(summary.capabilities.sizePresets.length).toBeGreaterThan(5);
    expect(summary.priceLine).toContain("credits");
    expect(summary.roles).toContain("prompt");
    expect(summary.constraints.length).toBeGreaterThan(0);
    expect(summary.documented).toBe(true);
    // The legacy node keeps the aliases so rows and settings that hold a legacy id resolve.
    expect(modelSummary(getModel("seedream 5.0 pro")!, null).aliases).toContain("seedream 5.0 pro");
  });

  it("puts every input with no role into the generic More options list", () => {
    const kling = getModel("KlingTextToVideoNode");
    if (kling !== null) {
      const names = extrasOf(kling).map((e) => e.name);
      expect(names.length).toBeGreaterThan(0);
      for (const extra of extrasOf(kling)) expect(["COMBO", "BOOLEAN", "INT", "FLOAT", "STRING"]).toContain(extra.type);
    }
    // No extra may repeat a role's input.
    for (const entry of SUPPORTED) {
      const roles = new Set(Object.values(entry.roles));
      for (const extra of extrasOf(entry)) expect(roles.has(extra.name), `${entry.key} ${extra.name}`).toBe(false);
    }
  });
});

// ---------- the picker's filter chips ----------

/**
 * The expected answer for one chip, read straight off the registry with a
 * deliberately different reading of the size vocabulary from the one
 * `model-list.ts` uses: every number in every option string, rather than one
 * parse per token. Two readings that disagree make a chip that lies: reading
 * "1080p" as 1080 against a width threshold of 1920 would hide most of the
 * models that offer it.
 */
function reachesHeight(model: ReturnType<typeof modelSummary>, want: number): boolean {
  const caps = model.capabilities;
  for (const token of [...caps.resolutions, ...caps.sizePresets]) {
    const pixels = /(\d{3,5})\s*[x\u00d7]\s*(\d{3,5})/i.exec(token);
    if (pixels !== null) {
      if (Math.min(Number(pixels[1]), Number(pixels[2])) >= want) return true;
      continue;
    }
    const progressive = /^\s*(\d{3,4})\s*p\s*$/i.exec(token);
    if (progressive !== null && Number(progressive[1]) >= want) return true;
    if (/^\s*(4k|uhd)\s*$/i.test(token) && 2160 >= want) return true;
    if (/^\s*8k\s*$/i.test(token) && 4320 >= want) return true;
    const kilo = /^\s*(\d+(?:\.\d+)?)\s*k\s*$/i.exec(token);
    if (kilo !== null && Number(kilo[1]) * 1024 >= want) return true;
  }
  return caps.dimensions !== null && Math.min(caps.dimensions.widthMax, caps.dimensions.heightMax) >= want;
}

function reachesWidth(model: ReturnType<typeof modelSummary>, want: number): boolean {
  const caps = model.capabilities;
  for (const token of [...caps.resolutions, ...caps.sizePresets]) {
    const pixels = /(\d{3,5})\s*[x\u00d7]\s*(\d{3,5})/i.exec(token);
    if (pixels !== null) {
      if (Math.max(Number(pixels[1]), Number(pixels[2])) >= want) return true;
      continue;
    }
    const progressive = /^\s*(\d{3,4})\s*p\s*$/i.exec(token);
    if (progressive !== null && Math.round((Number(progressive[1]) * 16) / 9) >= want) return true;
    if (/^\s*(4k|uhd)\s*$/i.test(token) && 3840 >= want) return true;
    if (/^\s*8k\s*$/i.test(token) && 7680 >= want) return true;
    const kilo = /^\s*(\d+(?:\.\d+)?)\s*k\s*$/i.exec(token);
    if (kilo !== null && Number(kilo[1]) * 1024 >= want) return true;
  }
  return caps.dimensions !== null && Math.max(caps.dimensions.widthMax, caps.dimensions.heightMax) >= want;
}

describe("the filter chips say what they mean", () => {
  const rowsOf = (kind: "image" | "video") => listModels({ kind }).map((entry) => modelSummary(entry, 1 / 211));

  const expected: Record<string, (model: ReturnType<typeof modelSummary>) => boolean> = {
    "4k": (model) => reachesWidth(model, 3840),
    batch: (model) => (model.capabilities.count?.max ?? 1) > 1,
    audio: (model) => model.capabilities.audio,
    hd: (model) => reachesHeight(model, 1080),
    long: (model) => (model.capabilities.duration?.max ?? model.capabilities.promptDurationDefault ?? 0) >= 10,
  };

  it("matches the set computed independently from the registry, chip by chip", () => {
    for (const kind of ["image", "video"] as const) {
      const rows = rowsOf(kind);
      for (const filter of filtersFor(kind)) {
        const want = expected[filter.id];
        expect(want, `no independent rule for the ${kind} chip "${filter.id}"`).toBeTruthy();
        const chip = rows.filter((model) => filter.matches(model)).map((model) => model.key).sort();
        const registry = rows.filter((model) => want!(model)).map((model) => model.key).sort();
        expect(chip, `${kind} chip "${filter.label}"`).toEqual(registry);
      }
    }
  });

  it("includes every model that offers the size, however it spells it", () => {
    // Named on purpose: one row per way a model can spell its sizes.
    const video = rowsOf("video");
    const hd = filtersFor("video").find((filter) => filter.id === "hd")!;
    for (const key of [
      "ByteDanceTextToVideoNode/seedance-1-0-pro-fast-251015", // "1080p"
      "ByteDanceTextToVideoNode/seedance-1-5-pro-251215",
      "ByteDance2TextToVideoNode/Seedance 2.5",
      "Veo3VideoGenerationNode/veo-3.1-lite",
      "KlingVideoNode/kling-3.0-turbo",
      "KlingOmniProTextToVideoNode/kling-video-o1",
      "ViduTextToVideoNode/viduq1",
      "Vidu3TextToVideoNode/viduq3-pro",
      "Wan2TextToVideoApi/wan2.7-t2v", // "1080P", shouted
      "Wan3ReferenceToVideoApi/wan3.0-video",
      "HappyHorseTextToVideoApi/happyhorse-1.0-t2v",
      "PixverseTextToVideoNode",
      "PixverseV6TextToVideoNode/PixVerse V6",
      "LumaRay32TextToVideoNode",
      "WanTextToVideoApi/wan2.5-t2v-preview", // "1080p: 16:9 (1920x1080)"
      "MinimaxHailuoVideoNode",
    ]) {
      const model = video.find((row) => row.key === key);
      expect(model, key).toBeTruthy();
      expect(hd.matches(model!), `${key} offers 1080p`).toBe(true);
    }

    const image = rowsOf("image");
    const fourK = filtersFor("image").find((filter) => filter.id === "4k")!;
    for (const key of [
      "GeminiNanoBanana2V2/Nano Banana 2 (Gemini 3.1 Flash Image)", // "4K" as a tier
      "GeminiImage2Node/gemini-3-pro-image-preview",
      "KlingOmniProImageNode/kling-v3-omni",
      "OpenAIGPTImageNodeV2/gpt-image-2", // "3840x2160" as a preset
      "ByteDanceSeedreamNodeV3/seedream 5.0 lite",
    ]) {
      const model = image.find((row) => row.key === key);
      expect(model, key).toBeTruthy();
      expect(fourK.matches(model!), `${key} makes a 4K image`).toBe(true);
    }
    // And a 2K model still says no, or the chip means nothing.
    for (const key of ["Krea2ImageNode/Krea 2 Large", "QwenImageTextToImageApi/qwen-image-3.0", "IdeogramV4"]) {
      const model = image.find((row) => row.key === key)!;
      expect(fourK.matches(model), `${key} does not make a 4K image`).toBe(false);
    }
  });

  it("counts a length the prompt sets", () => {
    // Gemini's Omni Flash has no duration input at all; its documented default
    // clip is about 10 seconds, which is exactly what the chip asks about.
    const long = filtersFor("video").find((filter) => filter.id === "long")!;
    for (const key of ["GeminiVideoOmniV2/Omni Flash", "GeminiVideoOmniV2/Omni Flash 1.1"]) {
      const model = rowsOf("video").find((row) => row.key === key)!;
      expect(model.capabilities.duration, key).toBeNull();
      expect(model.capabilities.promptDurationDefault, key).toBe(10);
      expect(long.matches(model), key).toBe(true);
    }
  });
});

// ---------- the sentences the form prints ----------

describe("a documented constraint reads like a sentence", () => {
  /**
   * A constraint note is printed under a control, so it is copy. These are the
   * shapes that give an engineer's notes away. A note reads like "At 1080p this
   * model only makes 6 second clips.", not like the error text the node raises.
   */
  const FORBIDDEN: readonly { name: string; pattern: RegExp }[] = [
    { name: "a backtick", pattern: /`/ },
    { name: "an exception ('the node raises')", pattern: /\braise[sd]?\b/i },
    { name: "the implementation ('the node', 'ComfyUI', 'tooltip', 'widget', 'combo', 'schema')", pattern: /\b(the node|ComfyUI|tooltip|widget|combo|schema|endpoint)\b/i },
    { name: "a snake_case wire name", pattern: /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/ },
    { name: "a dotted wire name", pattern: /\b[a-z][a-z0-9]*\.[a-z][a-z0-9_]*\b/ },
    { name: "a name=value pair", pattern: /\b[A-Za-z][\w.]*\s*=\s*\S/ },
    { name: "an HTTP status", pattern: /\bHTTP\s*\d{3}\b/i },
  ];

  it("never prints a wire name, a backtick or an exception message", () => {
    let checked = 0;
    for (const entry of MODEL_ENTRIES) {
      for (const constraint of entry.constraints) {
        const note = constraint.note;
        if (note === "") continue;
        checked += 1;
        for (const { name, pattern } of FORBIDDEN) {
          expect(pattern.test(note), `${entry.key} note has ${name}: ${note}`).toBe(false);
        }
        // A sentence, not a fragment of one.
        expect(note, entry.key).toMatch(/^[A-Z0-9"]/);
        expect(note, entry.key).toMatch(/[.!?]$/);
      }
    }
    expect(checked, "no constraint notes were checked, so this test proves nothing").toBeGreaterThan(40);
  });
});
