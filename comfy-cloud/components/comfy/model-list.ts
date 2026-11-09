// Searching, sorting and grouping the model registry for the picker. Pure, so
// `test/app.test.tsx` can hold it to its promises without rendering a sheet.
//
// The price is the reason this screen exists: the catalog spans two orders of
// magnitude, so every row carries a figure and one click sorts by it.
import { floorCredits, floorShape, parseSizePreset } from "../../contract";
import type { AssetKind, ModelCapabilities, ModelSummary } from "../../contract";

export type ModelSort = "recommended" | "cheapest" | "az";

export const SORT_OPTIONS: readonly { id: ModelSort; label: string }[] = [
  { id: "recommended", label: "Recommended" },
  { id: "cheapest", label: "Cheapest" },
  { id: "az", label: "A to Z" },
];

export interface ModelFilter {
  id: string;
  label: string;
  /** What the chip means, for its title. */
  hint: string;
  matches: (model: ModelSummary) => boolean;
}

/**
 * The pixel size one size name stands for, as a long and a short edge.
 *
 * The three vocabularies say different things with the same shape of string, so
 * reading them all as one number makes the filter chips wrong: a tier is
 * named after its *short* edge ("1080p" is 1080 tall and 1920 wide), a K tier
 * after its long edge ("2K" is about 2048 across), and a preset carries both.
 * Keeping both edges lets "1080p" pass a 1920 long edge threshold and "4K"
 * pass a 3840 one.
 */
export function tierSize(tier: string): { long: number; short: number } | null {
  const text = tier.trim().toLowerCase();
  // A preset carries its own pixels wherever they sit in the string, so
  // "(4K) 4096x4096 (1:1)" and "480p: 16:9 (832x480)" are both exact.
  const size = parseSizePreset(text);
  if (size !== null) return { long: Math.max(size.width, size.height), short: Math.min(size.width, size.height) };
  if (text === "4k" || text === "uhd") return { long: 3840, short: 2160 };
  if (text === "8k") return { long: 7680, short: 4320 };
  const progressive = /^(\d{3,4})\s*p$/.exec(text);
  if (progressive !== null) {
    const short = Number(progressive[1]);
    return { long: Math.round((short * 16) / 9), short };
  }
  // An image tier is a megapixel class, not a shape, so it counts as a square.
  const kilo = /^(\d+(?:\.\d+)?)\s*k$/.exec(text);
  if (kilo !== null) {
    const edge = Math.round(Number(kilo[1]) * 1024);
    return { long: edge, short: edge };
  }
  return null;
}

/**
 * The biggest long edge and the biggest short edge a model can be asked for,
 * over every size vocabulary it speaks. The two maxima are taken separately
 * because each one is real on its own: a chip asks "can it reach this", not
 * "can it reach both at once".
 */
export function sizeCeiling(caps: ModelCapabilities): { long: number; short: number } {
  let long = 0;
  let short = 0;
  const take = (size: { long: number; short: number } | null) => {
    if (size === null) return;
    long = Math.max(long, size.long);
    short = Math.max(short, size.short);
  };
  for (const tier of caps.resolutions) take(tierSize(tier));
  for (const preset of caps.sizePresets) take(tierSize(preset));
  if (caps.dimensions !== null) {
    const { widthMax, heightMax } = caps.dimensions;
    take({ long: Math.max(widthMax, heightMax), short: Math.min(widthMax, heightMax) });
  }
  return { long, short };
}

/**
 * The longest clip a model can be asked for. A model with no length control
 * still has a length: Gemini's Omni Flash takes it from the prompt and returns
 * about 10 seconds, which is what `promptDurationDefault` records, so it still
 * counts for the "10 s or longer" chip.
 */
export function longestSeconds(caps: ModelCapabilities): number {
  return caps.duration?.max ?? caps.promptDurationDefault ?? 0;
}

const IMAGE_FILTERS: readonly ModelFilter[] = [
  { id: "4k", label: "4K", hint: "Can produce a 4K image", matches: (model) => sizeCeiling(model.capabilities).long >= 3840 },
  { id: "batch", label: "Batch", hint: "Returns more than one image from a single run", matches: (model) => (model.capabilities.count?.max ?? 1) > 1 },
];

const VIDEO_FILTERS: readonly ModelFilter[] = [
  { id: "audio", label: "With audio", hint: "Can generate a soundtrack", matches: (model) => model.capabilities.audio },
  { id: "hd", label: "1080p or better", hint: "Offers 1080p or higher", matches: (model) => sizeCeiling(model.capabilities).short >= 1080 },
  { id: "long", label: "10 s or longer", hint: "Can run for at least 10 seconds", matches: (model) => longestSeconds(model.capabilities) >= 10 },
];

/**
 * The rows the sheet groups into sections, out of everything the server sent.
 *
 * A hidden entry is in that payload only because something names it: the model
 * the form is on, a Favourite or a Recent. Hidden is not gone, so it has to be
 * reachable from the section that named it, but it must not also take a row in
 * its vendor section, or ByteDance draws "Seedream 5.0 Pro" and "Seedream 5.0
 * Pro (legacy node)" one above the other at the same price with the check mark
 * on the legacy one. The model the form is on is the exception: it is drawn
 * everywhere, because the sheet has to be able to show which one you are on.
 */
export function listedModels(models: readonly ModelSummary[], current: string | null): ModelSummary[] {
  return models.filter((model) => !model.hidden || model.key === current);
}

export function filtersFor(kind: AssetKind): readonly ModelFilter[] {
  return kind === "video" ? VIDEO_FILTERS : IMAGE_FILTERS;
}

/** Name, vendor, model id and key, the way the CLI searches. */
export function matchesQuery(model: ModelSummary, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (text === "") return true;
  const words = text.split(/\s+/);
  const haystack = [model.label, model.vendor, model.modelId ?? "", model.key, model.strengths ?? "", ...model.aliases].join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * Credits the cheapest run this model can do, for the Cheapest sort. Not a
 * quote: it is the same shape for every model (its cheapest tier, smallest
 * size, shortest clip), which is the only way two models compare in one column.
 * `floorCredits` in contract.ts is shared with `bb comfy models`, so the CLI
 * table and the sheet order the catalog the same way.
 */
export function cheapestCredits(model: ModelSummary): number | null {
  if (model.price === null) return null;
  return floorCredits(model.price, model.kind, floorShape(model.capabilities, model.defaults));
}

function sortKey(model: ModelSummary): number {
  const credits = cheapestCredits(model);
  return credits === null ? Number.POSITIVE_INFINITY : credits;
}

export function sortModels(models: readonly ModelSummary[], sort: ModelSort): ModelSummary[] {
  const rows = [...models];
  if (sort === "cheapest") return rows.sort((a, b) => sortKey(a) - sortKey(b) || a.label.localeCompare(b.label));
  if (sort === "az") return rows.sort((a, b) => a.label.localeCompare(b.label) || a.vendor.localeCompare(b.vendor));
  // Recommended: the documented picks first, then vendor by vendor.
  return rows.sort(
    (a, b) => Number(b.recommended) - Number(a.recommended) || a.vendor.localeCompare(b.vendor) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
  );
}

export interface ModelGroup {
  key: string;
  label: string;
  models: ModelSummary[];
  /** True when the header already names the vendor, so the rows need not repeat it. */
  vendorHeader: boolean;
}

/**
 * The sections the sheet draws. Recommended leads with the picks and then runs
 * vendor by vendor; the other two sorts group by price band and by initial,
 * because a hundred rows with no headers is a wall.
 */
export function groupModels(models: readonly ModelSummary[], sort: ModelSort): ModelGroup[] {
  const groups: ModelGroup[] = [];
  const index = new Map<string, ModelGroup>();
  const push = (key: string, label: string, vendorHeader: boolean, model: ModelSummary) => {
    let group = index.get(key);
    if (group === undefined) {
      group = { key, label, models: [], vendorHeader };
      index.set(key, group);
      groups.push(group);
    }
    group.models.push(model);
  };
  for (const model of models) {
    if (sort === "recommended") {
      if (model.recommended) push("recommended", "Recommended", false, model);
      else push(`vendor:${model.vendor}`, model.vendor, true, model);
    } else if (sort === "az") {
      const initial = (model.label.trim()[0] ?? "?").toUpperCase();
      push(`letter:${initial}`, initial, false, model);
    } else {
      push("cheapest", "Cheapest first", false, model);
    }
  }
  return groups;
}

/** The rows in the order they are drawn, which is the order the arrow keys move in. */
export function flatten(groups: readonly ModelGroup[]): ModelSummary[] {
  return groups.flatMap((group) => group.models);
}

/** The model a key, a legacy id or an alias names. */
export function findModel(models: readonly ModelSummary[], id: string | null): ModelSummary | null {
  if (id === null || id === "") return null;
  return (
    models.find((model) => model.key === id) ??
    models.find((model) => model.aliases.includes(id)) ??
    models.find((model) => model.modelId === id) ??
    null
  );
}
