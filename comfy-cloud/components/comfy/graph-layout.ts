// Pure layout for the workflow graph view. Takes a ComfyUI API-format
// workflow and returns positioned nodes and edges; no DOM, no React, so it is
// unit-testable and the SVG renderer stays a plain projection of this output.
//
// Layout: depth = longest path from a source node (a node without link
// inputs); one column per depth; rows in node id order; box height from the
// larger of the input and output counts.
import { isLink } from "../../contract";
import type { JsonValue, NodeInfo, Workflow } from "../../contract";

export const NODE_WIDTH = 280;
/** Header height with the display name alone, and with the class type under it. */
export const HEADER_HEIGHT = 26;
export const HEADER_HEIGHT_SUBTITLE = 38;
export const ROW_HEIGHT = 18;
export const BOX_PADDING = 8;
export const COLUMN_GAP = 90;
export const ROW_GAP = 28;
export const MARGIN = 20;
/** Literal input values are cut to this many characters. */
export const LITERAL_MAX = 40;
/** Input names are shown with at most this many characters, cut in the middle. */
export const NAME_MAX = 24;

export interface LayoutInput {
  name: string;
  /** The name as the row shows it: a shared dotted prefix dropped, then cut in the middle. */
  label: string;
  /** The full "name: value" for the row's hover title. */
  title: string;
  kind: "link" | "literal";
  /** What the row shows: the truncated literal, or the source node for a link. */
  text: string;
  from: { node: string; slot: number } | null;
  /** True when the row sits under a dotted prefix group row, so it is drawn indented. */
  grouped: boolean;
  /** Absolute y of the input port. */
  y: number;
}

/** A muted row standing for a dotted prefix shared by the inputs under it, for example "model.". */
export interface LayoutGroup {
  label: string;
  /** Absolute y of the row's middle. */
  y: number;
}

export interface LayoutOutput {
  slot: number;
  name: string;
  /** Slot type from the catalog ("IMAGE", "VIDEO", ...), null when inferred from links. */
  type: string | null;
  /** Absolute y of the output port. */
  y: number;
}

export interface LayoutNode {
  id: string;
  classType: string;
  /** Display name from the catalog, falling back to the class type. */
  title: string;
  /** Header height: taller when the class type is shown under the title. */
  headerHeight: number;
  depth: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  inputs: LayoutInput[];
  /** Prefix rows drawn between the input rows. */
  groups: LayoutGroup[];
  outputs: LayoutOutput[];
}

export interface LayoutEdge {
  id: string;
  from: string;
  fromSlot: number;
  to: string;
  toInput: string;
  /** The output slot's type, for colouring; null when unknown. */
  type: string | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GraphLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  catalog?: Readonly<Record<string, NodeInfo>> | null;
}

/** One line of text for any literal value, whitespace collapsed, not cut. */
export function flatten(value: JsonValue): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value === null) text = "null";
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  return text.replace(/\s+/g, " ").trim();
}

/** One line of text for a literal input, cut to LITERAL_MAX characters. */
export function literalText(value: JsonValue): string {
  const flat = flatten(value);
  return flat.length <= LITERAL_MAX ? flat : `${flat.slice(0, LITERAL_MAX - 1)}…`;
}

/**
 * True when a node only writes a result, so its output ports would be noise.
 * The catalog says so with `output_node`; without it, a Save or Preview node
 * that nothing links out of counts.
 */
export function isOutputNode(info: NodeInfo | undefined, classType: string, hasOutgoing: boolean): boolean {
  const declared = info?.outputNode;
  if (declared === true) return true;
  if (declared === false) return false;
  return !hasOutgoing && /^(Save|Preview)/.test(classType);
}

/** Cut a name in the middle so both ends stay readable. */
export function middleClip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.max(0, max - 1 - head);
  return `${text.slice(0, head)}…${tail === 0 ? "" : text.slice(text.length - tail)}`;
}

/** The dotted prefix of an input name ("model.width" -> "model."), or null when it has none. */
export function dottedPrefix(name: string): string | null {
  const dot = name.indexOf(".");
  return dot <= 0 || dot === name.length - 1 ? null : name.slice(0, dot + 1);
}

/** Node ids sorted numerically when they are numbers, otherwise as text. */
export function sortNodeIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    const aNumeric = a !== "" && Number.isFinite(na);
    const bNumeric = b !== "" && Number.isFinite(nb);
    if (aNumeric && bNumeric) return na - nb;
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a.localeCompare(b);
  });
}

/** Distinct class types in the graph, in node id order (for the catalog lookup). */
export function workflowClassTypes(workflow: Workflow): string[] {
  const seen = new Set<string>();
  for (const id of sortNodeIds(Object.keys(workflow))) {
    const node = workflow[id];
    if (node !== undefined) seen.add(node.class_type);
  }
  return [...seen];
}

function computeDepths(workflow: Workflow): Map<string, number> {
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const node = workflow[id];
    if (node === undefined) return 0;
    // A cycle is a malformed graph; break it by treating the re-entered node as a source.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let depth = 0;
    for (const value of Object.values(node.inputs)) {
      if (!isLink(value)) continue;
      const [fromId] = value;
      if (workflow[fromId] === undefined) continue;
      depth = Math.max(depth, depthOf(fromId) + 1);
    }
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  for (const id of Object.keys(workflow)) depthOf(id);
  return depths;
}

/** Output slots each node is referenced by, for nodes the catalog does not describe. */
function referencedSlots(workflow: Workflow): Map<string, number> {
  const slots = new Map<string, number>();
  for (const node of Object.values(workflow)) {
    for (const value of Object.values(node.inputs)) {
      if (!isLink(value)) continue;
      const [fromId, slot] = value;
      slots.set(fromId, Math.max(slots.get(fromId) ?? 0, slot + 1));
    }
  }
  return slots;
}

export function layoutWorkflow(workflow: Workflow, options: LayoutOptions = {}): GraphLayout {
  const catalog = options.catalog ?? null;
  const ids = sortNodeIds(Object.keys(workflow));
  const depths = computeDepths(workflow);
  const slots = referencedSlots(workflow);

  // Column buckets in id order.
  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const depth = depths.get(id) ?? 0;
    const bucket = columns.get(depth);
    if (bucket === undefined) columns.set(depth, [id]);
    else bucket.push(id);
  }
  const depthKeys = [...columns.keys()].sort((a, b) => a - b);

  const nodes: LayoutNode[] = [];
  const byId = new Map<string, LayoutNode>();
  let maxColumnHeight = 0;
  for (const depth of depthKeys) {
    const bucket = columns.get(depth) ?? [];
    const x = MARGIN + depth * (NODE_WIDTH + COLUMN_GAP);
    let y = MARGIN;
    bucket.forEach((id, row) => {
      const node = workflow[id];
      if (node === undefined) return;
      const info = catalog?.[node.class_type];
      const title = info?.displayName ?? node.class_type;
      const headerHeight = title === node.class_type ? HEADER_HEIGHT : HEADER_HEIGHT_SUBTITLE;
      const inputNames = Object.keys(node.inputs);
      // Output ports are noise on a node that only writes a file.
      const hasOutgoing = (slots.get(id) ?? 0) > 0;
      const outputNames: string[] = isOutputNode(info, node.class_type, hasOutgoing)
        ? []
        : info !== undefined && info.outputs.length > 0
          ? [...info.outputs]
          : Array.from({ length: slots.get(id) ?? 0 }, (_, index) => `out ${index}`);
      const fromCatalog = info !== undefined && info.outputs.length > 0;
      const portY = (index: number) => y + headerHeight + BOX_PADDING + index * ROW_HEIGHT + ROW_HEIGHT / 2;

      // Inputs that share a dotted prefix ("model.width", "model.height") sit
      // under one muted group row, so the names have room for the values.
      const prefixCount = new Map<string, number>();
      for (const name of inputNames) {
        const prefix = dottedPrefix(name);
        if (prefix !== null) prefixCount.set(prefix, (prefixCount.get(prefix) ?? 0) + 1);
      }
      const groups: LayoutGroup[] = [];
      const inputs: LayoutInput[] = [];
      let rowIndex = 0;
      let openGroup: string | null = null;
      for (const name of inputNames) {
        const prefix = dottedPrefix(name);
        const grouped = prefix !== null && (prefixCount.get(prefix) ?? 0) >= 2;
        if (grouped && prefix !== openGroup) {
          groups.push({ label: prefix, y: portY(rowIndex) });
          rowIndex += 1;
          openGroup = prefix;
        }
        if (!grouped) openGroup = null;
        const shown = grouped && prefix !== null ? name.slice(prefix.length) : name;
        const label = middleClip(shown, NAME_MAX);
        const value = node.inputs[name] as JsonValue;
        const y0 = portY(rowIndex);
        rowIndex += 1;
        if (isLink(value)) {
          const [fromId, slot] = value;
          const source = workflow[fromId];
          const sourceTitle = source === undefined ? `node ${fromId}` : (catalog?.[source.class_type]?.displayName ?? source.class_type);
          const type = source === undefined ? null : (catalog?.[source.class_type]?.outputs[slot] ?? null);
          const text = `from ${sourceTitle} (node ${fromId})${type === null ? "" : `, ${type}`}`;
          inputs.push({ name, label, title: `${name}: ${text}`, kind: "link", text, from: { node: fromId, slot }, grouped, y: y0 });
          continue;
        }
        inputs.push({ name, label, title: `${name}: ${flatten(value)}`, kind: "literal", text: literalText(value), from: null, grouped, y: y0 });
      }
      const rows = Math.max(rowIndex, outputNames.length, 1);
      const height = headerHeight + BOX_PADDING * 2 + rows * ROW_HEIGHT;
      const outputs: LayoutOutput[] = outputNames.map((name, slot) => ({ slot, name, type: fromCatalog ? name : null, y: portY(slot) }));
      const laid: LayoutNode = {
        id,
        classType: node.class_type,
        title,
        headerHeight,
        depth,
        row,
        x,
        y,
        width: NODE_WIDTH,
        height,
        inputs,
        groups,
        outputs,
      };
      nodes.push(laid);
      byId.set(id, laid);
      y += height + ROW_GAP;
    });
    maxColumnHeight = Math.max(maxColumnHeight, y - ROW_GAP - MARGIN);
  }

  const edges: LayoutEdge[] = [];
  for (const node of nodes) {
    for (const input of node.inputs) {
      if (input.from === null) continue;
      const source = byId.get(input.from.node);
      if (source === undefined) continue;
      const port = source.outputs[input.from.slot];
      const y1 = port === undefined ? source.y + source.headerHeight / 2 : port.y;
      edges.push({
        id: `${input.from.node}:${input.from.slot}->${node.id}:${input.name}`,
        from: source.id,
        fromSlot: input.from.slot,
        to: node.id,
        toInput: input.name,
        type: port?.type ?? null,
        x1: source.x + source.width,
        y1,
        x2: node.x,
        y2: input.y,
      });
    }
  }

  const columnCount = depthKeys.length;
  const width = columnCount === 0 ? MARGIN * 2 : MARGIN * 2 + columnCount * NODE_WIDTH + (columnCount - 1) * COLUMN_GAP;
  const height = MARGIN * 2 + Math.max(0, maxColumnHeight);
  return { nodes, edges, width, height };
}

/** SVG path for an edge: a cubic curve leaving the output port to the right and entering the input port from the left. */
export function edgePath(edge: LayoutEdge): string {
  const dx = Math.max(40, Math.abs(edge.x2 - edge.x1) / 2);
  return `M ${edge.x1} ${edge.y1} C ${edge.x1 + dx} ${edge.y1}, ${edge.x2 - dx} ${edge.y2}, ${edge.x2} ${edge.y2}`;
}

// ---------- fit ----------

/** Fit never shrinks below this: past it the labels are unreadable, so full size anchored top left is shown instead. */
export const FIT_MIN_SCALE = 0.7;
/** Small graphs may be scaled up to fill the canvas. */
export const FIT_MAX_SCALE = 1.6;
export const FIT_PADDING = 16;

export interface FitTransform {
  x: number;
  y: number;
  k: number;
}

/**
 * Where Fit puts the graph in a canvas of this size. A graph that fits is
 * centred at its natural size or larger; one that would have to shrink below
 * FIT_MIN_SCALE is held at 100 percent and anchored top left, which stays
 * readable and can be dragged around.
 */
export function fitTransform(canvas: { width: number; height: number }, graph: { width: number; height: number }): FitTransform {
  const scale = Math.min((canvas.width - FIT_PADDING * 2) / graph.width, (canvas.height - FIT_PADDING * 2) / graph.height);
  if (!Number.isFinite(scale) || scale < FIT_MIN_SCALE) {
    // Too wide or too tall to show at a readable size: hold 100 percent and
    // anchor top left, which can be dragged around. A graph that does fit
    // vertically is still centred on that axis so it does not sit in a band
    // of empty canvas.
    const k = 1;
    const top = FIT_PADDING - MARGIN * k;
    const centred = (canvas.height - graph.height * k) / 2;
    return { x: FIT_PADDING - MARGIN * k, y: Math.max(top, centred), k };
  }
  const k = Math.min(FIT_MAX_SCALE, scale);
  return { x: (canvas.width - graph.width * k) / 2, y: (canvas.height - graph.height * k) / 2, k };
}
