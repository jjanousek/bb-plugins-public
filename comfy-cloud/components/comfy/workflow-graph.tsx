// A rough, readable picture of a ComfyUI workflow: pure SVG, no library.
// Cards are nodes (display name, class type under it when they differ, one
// row per input with a truncated literal or a port dot for a link, output
// ports on the right); edges are smooth curves coloured by slot type. Layout
// comes from graph-layout.ts; this file draws it and owns pan (drag), zoom
// (wheel, buttons), Fit, node selection, and the friendly tweak path: the
// selected node's inputs appear as a form below the canvas, and a JSON view
// exposes the raw graph. Editing marks the graph changed; "Run tweaked
// workflow" hands the draft to the parent component.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { isLink, workflowSchema } from "../../contract";
import type { JsonValue, NodeInfo, Workflow } from "../../contract";
import { Glyph } from "./glyphs";
import { BOX_PADDING, HEADER_HEIGHT, ROW_HEIGHT, edgePath, fitTransform, layoutWorkflow } from "./graph-layout";
import type { LayoutNode } from "./graph-layout";
import { BAR, CheckBox, GhostButton, PrimaryButton, Segmented } from "./kit";
import { useElementSize } from "./use-comfy";

const MIN_SCALE = 0.2;
const MAX_SCALE = 3;
/** Pointer travel under this many pixels is a click, not a drag. */
const CLICK_SLOP = 4;
const PORT_RADIUS = 3.5;
/** How far the rows under a dotted prefix heading sit in from the other input names. */
const GROUP_INDENT = 7;

/** Edge colours by slot type: a small fixed set of palette classes, the one exception to host tokens, so slot types tell apart at a glance. */
const EDGE_CLASS: Record<string, string> = {
  IMAGE: "text-sky-500",
  VIDEO: "text-violet-500",
  LATENT: "text-pink-500",
  MASK: "text-emerald-500",
};

export function edgeClass(type: string | null): string {
  return (type !== null ? EDGE_CLASS[type] : undefined) ?? "text-muted-foreground";
}

const MODE_OPTIONS = [
  { id: "graph", label: "Nodes" },
  { id: "json", label: "JSON" },
] as const;

interface Transform {
  x: number;
  y: number;
  k: number;
}

export interface WorkflowGraphProps {
  workflow: Workflow;
  catalog: Readonly<Record<string, NodeInfo>> | null;
  /** When present, an edited graph can be run as a new asset. */
  onRun?: (workflow: Workflow) => Promise<void> | void;
  busy?: boolean;
  /** Bump to bring the JSON view forward (the "Edit workflow" action). A value above zero starts there. */
  jsonRequest?: number;
  /**
   * Where the selected node's form and the Run bar are rendered. On wide
   * layouts the viewer passes its details column, so selecting a node never
   * shrinks the canvas; without it they sit under the canvas.
   */
  panelContainer?: HTMLElement | null;
  /** The host body is stacked (narrow), so the canvas gets a taller band to keep node text readable. */
  stacked?: boolean;
  className?: string;
}

function pretty(workflow: Workflow): string {
  return JSON.stringify(workflow, null, 2);
}

function sameGraph(a: Workflow, b: Workflow): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Parse and validate JSON typed into the raw view; a message when it is not a workflow. */
export function parseWorkflowText(text: string): { workflow: Workflow } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { error: `Not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const checked = workflowSchema.safeParse(parsed);
  if (!checked.success) return { error: "Not a ComfyUI API workflow: every node needs class_type and inputs" };
  if (Object.keys(checked.data).length === 0) return { error: "The workflow has no nodes" };
  return { workflow: checked.data };
}

export function WorkflowGraph({ workflow, catalog, onRun, busy = false, jsonRequest = 0, panelContainer = null, stacked = false, className }: WorkflowGraphProps) {
  const [draft, setDraft] = useState<Workflow>(workflow);
  // "Edit workflow" mounts this component with a request already pending, so
  // the JSON view has to be the starting mode, not something an effect gets to.
  const [mode, setMode] = useState<"graph" | "json">(jsonRequest > 0 ? "json" : "graph");
  const [jsonText, setJsonText] = useState(() => pretty(workflow));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resetVersion, setResetVersion] = useState(0);
  const [formOpen, setFormOpen] = useState(true);
  const layout = useMemo(() => layoutWorkflow(draft, { catalog }), [draft, catalog]);
  const changed = useMemo(() => !sameGraph(draft, workflow), [draft, workflow]);

  const [canvasRef, size] = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const fitted = useRef(false);
  /** True once the user has panned or zoomed: after that the canvas is theirs and never re-fits. */
  const touched = useRef(false);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const lastDragMoved = useRef(false);

  // The viewer refetches every 15 s, so the workflow prop is a new object with
  // the same content over and over. Reset on the content, never on identity,
  // or an unsaved edit would vanish under the poll.
  const workflowKey = useMemo(() => JSON.stringify(workflow), [workflow]);
  const latest = useRef(workflow);
  latest.current = workflow;
  useEffect(() => {
    const next = latest.current;
    setDraft(next);
    setJsonText(pretty(next));
    setJsonError(null);
    setSelectedId(null);
    setResetVersion((version) => version + 1);
    fitted.current = false;
    touched.current = false;
  }, [workflowKey]);

  // A later "Edit workflow" while the graph is already open asks for the JSON view again.
  const seenJsonRequest = useRef(jsonRequest);
  useEffect(() => {
    if (jsonRequest === seenJsonRequest.current) return;
    seenJsonRequest.current = jsonRequest;
    setJsonText(pretty(draft));
    setJsonError(null);
    setMode("json");
    // draft is read once when the request lands; later edits go through the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jsonRequest]);

  const fit = useCallback(() => {
    if (size.width === 0 || size.height === 0) return;
    setTransform(fitTransform({ width: size.width, height: size.height }, { width: layout.width, height: layout.height }));
  }, [size.width, size.height, layout.width, layout.height]);

  // Fit on the first measure, and again when the canvas changes size, until the user takes over.
  useEffect(() => {
    if (size.width === 0 || size.height === 0) return;
    if (fitted.current && touched.current) return;
    fitted.current = true;
    fit();
  }, [fit, size.width, size.height]);

  // React registers wheel listeners as passive, so page scroll can only be
  // stopped with a native listener.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      touched.current = true;
      setTransform((previous) => {
        const factor = Math.exp(-event.deltaY * 0.0015);
        const k = Math.max(MIN_SCALE, Math.min(MAX_SCALE, previous.k * factor));
        const ratio = k / previous.k;
        return { k, x: px - (px - previous.x) * ratio, y: py - (py - previous.y) * ratio };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [mode]);

  const selected = selectedId === null ? null : (draft[selectedId] ?? null);
  const selectedLayout = selectedId === null ? null : (layout.nodes.find((node) => node.id === selectedId) ?? null);

  const zoomBy = (factor: number) => {
    touched.current = true;
    setTransform((previous) => {
      const k = Math.max(MIN_SCALE, Math.min(MAX_SCALE, previous.k * factor));
      const ratio = k / previous.k;
      // Zoom about the selected node when there is one, so it stays in view.
      const anchorX = selectedLayout === null ? size.width / 2 : previous.x + (selectedLayout.x + selectedLayout.width / 2) * previous.k;
      const anchorY = selectedLayout === null ? size.height / 2 : previous.y + (selectedLayout.y + selectedLayout.height / 2) * previous.k;
      return { k, x: anchorX - (anchorX - previous.x) * ratio, y: anchorY - (anchorY - previous.y) * ratio };
    });
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: transform.x, originY: transform.y, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const state = drag.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (!state.moved && Math.abs(dx) + Math.abs(dy) > CLICK_SLOP) {
      state.moved = true;
      touched.current = true;
      // Capture only once this is a drag: capturing on pointerdown would
      // retarget the click to the svg and nodes could never be selected.
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (!state.moved) return;
    setTransform((previous) => ({ ...previous, x: state.originX + dx, y: state.originY + dy }));
  };
  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const state = drag.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    // Keep the "moved" verdict for the click that follows a drag; pointerup lands first.
    lastDragMoved.current = state.moved;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const selectNode = (id: string) => {
    // A drag that ends on a node is not a selection.
    if (lastDragMoved.current) {
      lastDragMoved.current = false;
      return;
    }
    setFormOpen(true);
    setSelectedId((previous) => (previous === id ? null : id));
  };

  /** Clicking a link row jumps to the node the value comes from. */
  const showNode = (id: string) => {
    if (draft[id] === undefined) return;
    setFormOpen(true);
    setSelectedId(id);
  };

  const setInput = (nodeId: string, name: string, value: JsonValue) => {
    setDraft((previous) => {
      const node = previous[nodeId];
      if (node === undefined) return previous;
      return { ...previous, [nodeId]: { ...node, inputs: { ...node.inputs, [name]: value } } };
    });
  };

  const reset = () => {
    setDraft(workflow);
    setJsonText(pretty(workflow));
    setJsonError(null);
    setResetVersion((version) => version + 1);
  };

  const switchMode = (next: string) => {
    if (next === "json") {
      setJsonText(pretty(draft));
      setJsonError(null);
      setMode("json");
    } else {
      // Take any pending JSON edit along, if it parses.
      const parsed = parseWorkflowText(jsonText);
      if ("workflow" in parsed) {
        setDraft(parsed.workflow);
        setJsonError(null);
      }
      setMode("graph");
    }
  };

  const commitJson = (): Workflow | null => {
    const parsed = parseWorkflowText(jsonText);
    if ("error" in parsed) {
      setJsonError(parsed.error);
      return null;
    }
    setJsonError(null);
    setDraft(parsed.workflow);
    return parsed.workflow;
  };

  const run = async () => {
    if (onRun === undefined) return;
    const graph = mode === "json" ? commitJson() : draft;
    if (graph === null) return;
    await onRun(graph);
  };

  const jsonDirty = mode === "json" && jsonText !== pretty(draft);
  const showChanged = changed || jsonDirty;
  // In the JSON view the text is the truth, so a broken box blocks the run.
  const jsonBroken = mode === "json" && (jsonError !== null || (jsonDirty && "error" in parseWorkflowText(jsonText)));

  // Under the canvas the panel owns its own gutter; in the viewer's reading
  // column it must line up with the labels already there.
  const panelPad = panelContainer === null ? "px-3" : "px-0";

  const runBar =
    onRun !== undefined && showChanged ? (
      <div className={cn("shrink-0 border-t border-border/60 py-2.5", panelPad)}>
        <div className="flex flex-wrap items-center gap-1.5">
          <span title={jsonBroken ? "Fix the JSON first" : undefined}>
            <PrimaryButton glyph="play" busy={busy} disabled={busy || jsonBroken} onClick={() => void run()}>
              Run tweaked workflow
            </PrimaryButton>
          </span>
          <GhostButton disabled={busy} onClick={reset}>
            Reset
          </GhostButton>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">Creates a new asset linked to this one.</p>
      </div>
    ) : null;

  const form =
    mode !== "graph" ? null : selected === null || selectedLayout === null ? (
      <p className={cn("shrink-0 border-t border-border/60 py-2 text-[11px] leading-4 text-muted-foreground", panelPad)}>
        Drag to pan, scroll to zoom, click a node to see and change its inputs.
      </p>
    ) : (
      <div className="shrink-0 border-t border-border/60">
        <button
          type="button"
          className={cn("flex w-full cursor-pointer items-start gap-1.5 py-2 text-left transition-colors duration-150 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none", panelPad)}
          aria-expanded={formOpen}
          onClick={() => setFormOpen((open) => !open)}
        >
          {formOpen ? <Glyph.down className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /> : <Glyph.forward className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-medium leading-4 text-foreground">{selectedLayout.title}</span>
            <span className="block text-[11px] leading-4 text-muted-foreground">
              node {selectedLayout.id}
              {selectedLayout.title === selected.class_type ? "" : `, ${selected.class_type}`}
            </span>
          </span>
        </button>
        {formOpen ? (
          // Under the canvas the form is a band and scrolls; in the reading column the column already does.
          <div className={cn("pb-3", panelContainer === null && "max-h-72 overflow-auto", panelPad)}>
            <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-[11px]">
              {Object.entries(selected.inputs).map(([name, value]) => (
                <InputRow
                  key={`${resetVersion}:${selectedLayout.id}:${name}`}
                  name={name}
                  value={value as JsonValue}
                  editable={onRun !== undefined}
                  catalog={catalog}
                  workflow={draft}
                  onShowNode={showNode}
                  onChange={(next) => setInput(selectedLayout.id, name, next)}
                />
              ))}
              {Object.keys(selected.inputs).length === 0 ? <p className="col-span-2 text-muted-foreground">No inputs.</p> : null}
            </div>
          </div>
        ) : null}
      </div>
    );

  const panel: ReactNode = (
    <>
      {form}
      {runBar}
    </>
  );

  return (
    <div className={cn("flex h-full min-h-0 w-full min-w-0 flex-col", className)}>
      <div className={BAR}>
        <Segmented ariaLabel="Workflow view" options={MODE_OPTIONS} value={mode} onSelect={switchMode} />
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {layout.nodes.length} {layout.nodes.length === 1 ? "node" : "nodes"}, {layout.edges.length}{" "}
          {layout.edges.length === 1 ? "link" : "links"}
          {showChanged ? <span className="ml-1 text-foreground">(changed)</span> : null}
        </span>
        {mode === "graph" ? (
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <span className="pr-1 text-[11px] tabular-nums text-muted-foreground">{Math.round(transform.k * 100)}%</span>
            <GhostButton iconOnly ariaLabel="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
              <Glyph.minus className="size-3.5" />
            </GhostButton>
            <GhostButton iconOnly ariaLabel="Zoom in" title="Zoom in" onClick={() => zoomBy(1.25)}>
              <Glyph.plus className="size-3.5" />
            </GhostButton>
            <GhostButton
              title="Fit the whole graph in view"
              onClick={() => {
                touched.current = false;
                fit();
              }}
            >
              <Glyph.fit className="size-3.5" />
              Fit
            </GhostButton>
          </span>
        ) : null}
      </div>

      {mode === "graph" ? (
        <div ref={canvasRef} className={cn("relative flex-1 overflow-hidden bg-muted/40", stacked ? "min-h-[32.5rem]" : "min-h-[26rem]")}>
          <svg
            ref={svgRef}
            role="img"
            aria-label="Workflow graph"
            className="size-full cursor-grab touch-none select-none active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
              {layout.edges.map((edge) => {
                const touchedEdge = selectedId !== null && (edge.from === selectedId || edge.to === selectedId);
                const dimmed = selectedId !== null && !touchedEdge;
                return (
                  <path
                    key={edge.id}
                    data-edge-id={edge.id}
                    d={edgePath(edge)}
                    fill="none"
                    className={cn("stroke-current", edgeClass(edge.type), dimmed && "opacity-30")}
                    strokeWidth={touchedEdge ? 2.5 : 1.5}
                  >
                    <title>{`${edge.type ?? "link"}: node ${edge.from} output ${edge.fromSlot} to node ${edge.to} ${edge.toInput}`}</title>
                  </path>
                );
              })}
              {layout.nodes.map((node) => (
                <GraphNode key={node.id} node={node} selected={node.id === selectedId} onSelect={selectNode} onShowNode={showNode} />
              ))}
            </g>
          </svg>
          {layout.nodes.length === 0 ? (
            <p className="absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground">This workflow has no nodes.</p>
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-[20rem] flex-1 flex-col gap-1.5 p-3">
          <Textarea
            value={jsonText}
            onChange={(event) => setJsonText(event.target.value)}
            onBlur={() => {
              if (jsonText !== pretty(draft)) commitJson();
            }}
            spellCheck={false}
            aria-label="Workflow JSON"
            className="min-h-0 flex-1 resize-none rounded-md border-border/60 font-mono text-[11px] leading-4"
          />
          {jsonError === null ? (
            <p className="text-[11px] text-muted-foreground">ComfyUI API format. Edits are checked when you leave the box.</p>
          ) : (
            <p className="text-[11px] text-destructive">
              {/^.*[.!?]$/.test(jsonError.trim()) ? jsonError.trim() : `${jsonError.trim()}.`} Fix it and leave the box to check again.
            </p>
          )}
        </div>
      )}

      {panelContainer === null ? panel : createPortal(panel, panelContainer)}
    </div>
  );
}

interface InputRowProps {
  name: string;
  value: JsonValue;
  editable: boolean;
  catalog: Readonly<Record<string, NodeInfo>> | null;
  workflow: Workflow;
  onShowNode: (id: string) => void;
  onChange: (value: JsonValue) => void;
}

function InputRow({ name, value, editable, catalog, workflow, onShowNode, onChange }: InputRowProps) {
  const label = <label className="text-muted-foreground">{name}</label>;
  if (isLink(value)) {
    const [fromId, slot] = value;
    const source = workflow[fromId];
    const sourceTitle = source === undefined ? `node ${fromId}` : (catalog?.[source.class_type]?.displayName ?? source.class_type);
    const type = source === undefined ? null : (catalog?.[source.class_type]?.outputs[slot] ?? null);
    return (
      <>
        {label}
        <button
          type="button"
          className="justify-self-start text-left text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={`Show ${sourceTitle}, node ${fromId}`}
          onClick={() => onShowNode(fromId)}
        >
          from {sourceTitle} (node {fromId}){type === null ? "" : `, ${type}`}
        </button>
      </>
    );
  }
  if (typeof value === "string") {
    const multiline = value.includes("\n") || value.length > 60 || /prompt|text/i.test(name);
    return (
      <>
        {label}
        {multiline ? (
          <Textarea
            value={value}
            readOnly={!editable}
            aria-label={name}
            rows={3}
            onChange={(event) => onChange(event.target.value)}
            className="min-h-0 border-border/60 py-1 text-[11px] leading-4"
          />
        ) : (
          <Input value={value} readOnly={!editable} aria-label={name} onChange={(event) => onChange(event.target.value)} className="h-7 border-border/60 text-[11px]" />
        )}
      </>
    );
  }
  if (typeof value === "number") {
    return (
      <>
        {label}
        <Input
          type="number"
          step="any"
          defaultValue={String(value)}
          readOnly={!editable}
          aria-label={name}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (event.target.value.trim() !== "" && Number.isFinite(next)) onChange(next);
          }}
          className="h-7 border-border/60 text-[11px] tabular-nums"
        />
      </>
    );
  }
  if (typeof value === "boolean") {
    return (
      <>
        {label}
        <span className="flex items-center gap-2">
          <CheckBox checked={value} disabled={!editable} ariaLabel={name} onChange={(next) => onChange(next)} />
          <span className="text-muted-foreground">{value ? "true" : "false"}</span>
        </span>
      </>
    );
  }
  return (
    <>
      {label}
      <span className="min-w-0 whitespace-pre-wrap break-words font-mono text-foreground [overflow-wrap:anywhere]">
        {value === null ? "null" : JSON.stringify(value)}
      </span>
    </>
  );
}

interface GraphNodeProps {
  node: LayoutNode;
  selected: boolean;
  onSelect: (id: string) => void;
  /** Clicking a link row jumps to the node the value comes from. */
  onShowNode: (id: string) => void;
}

function GraphNode({ node, selected, onSelect, onShowNode }: GraphNodeProps) {
  const textX = node.x + BOX_PADDING + PORT_RADIUS * 2 + 2;
  const subtitle = node.title !== node.classType;
  // Names get a fixed column so the values line up; the rest of the card is
  // theirs, minus the room the output labels need on the right edge.
  const valueX = textX + 118;
  const valueEnd = node.x + node.width - BOX_PADDING - PORT_RADIUS * 2;
  /** Room for an output label sitting on the same row, so the two never overlap. */
  const roomFor = (y: number): number => {
    const neighbour = node.outputs.find((output) => Math.abs(output.y - y) < ROW_HEIGHT);
    return neighbour === undefined ? 0 : clip(neighbour.name, 10).length * 5.2 + 8;
  };
  const charsAt = (y: number): number => Math.max(6, Math.round((valueEnd - roomFor(y) - valueX) / 5.1));
  return (
    <g data-node-id={node.id} className="cursor-pointer" onClick={() => onSelect(node.id)} role="button" aria-label={`${node.title}, node ${node.id}`} aria-pressed={selected}>
      <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={6} className="fill-current text-card" />
      <rect x={node.x} y={node.y} width={node.width} height={node.headerHeight} rx={6} className="fill-current text-muted" />
      {/* Square off the header's bottom corners. */}
      <rect x={node.x} y={node.y + node.headerHeight - 6} width={node.width} height={6} className="fill-current text-muted" />
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={6}
        fill="none"
        className={cn("stroke-current", selected ? "text-foreground" : "text-border")}
        strokeWidth={selected ? 2 : 1}
      />
      <title>{`${node.title} (${node.classType}), node ${node.id}`}</title>
      <text
        x={node.x + BOX_PADDING}
        y={node.y + (subtitle ? HEADER_HEIGHT / 2 - 1 : node.headerHeight / 2)}
        dominantBaseline="middle"
        fontSize={11}
        fontWeight={600}
        className="fill-current text-foreground"
      >
        {clip(node.title, 34)}
      </text>
      {subtitle ? (
        <text x={node.x + BOX_PADDING} y={node.y + HEADER_HEIGHT + 4} dominantBaseline="middle" fontSize={8.5} className="fill-current text-muted-foreground">
          {clip(node.classType, 44)}
        </text>
      ) : null}
      <text
        x={node.x + node.width - BOX_PADDING}
        y={node.y + HEADER_HEIGHT / 2 - (subtitle ? 1 : 0)}
        dominantBaseline="middle"
        textAnchor="end"
        fontSize={9}
        className="fill-current text-muted-foreground"
      >
        {node.id}
      </text>
      {node.groups.map((group) => (
        // A heading, not a truncated input name: the prefix set in small caps,
        // with the rows it covers indented under it.
        <text
          key={`group:${group.label}`}
          x={textX}
          y={group.y}
          dominantBaseline="middle"
          fontSize={8}
          fontWeight={600}
          letterSpacing={0.7}
          className="fill-current text-muted-foreground/70"
        >
          {group.label.replace(/\.$/, "").toUpperCase()}
        </text>
      ))}
      {node.inputs.map((input) => (
        <g
          key={input.name}
          data-input={input.name}
          onClick={
            input.from === null
              ? undefined
              : (event) => {
                  event.stopPropagation();
                  if (input.from !== null) onShowNode(input.from.node);
                }
          }
        >
          <circle cx={node.x} cy={input.y} r={PORT_RADIUS} className={cn("fill-current", input.kind === "link" ? "text-foreground" : "text-muted-foreground/40")} />
          <text x={input.grouped ? textX + GROUP_INDENT : textX} y={input.y} dominantBaseline="middle" fontSize={9.5} className="fill-current text-foreground">
            <title>{input.title}</title>
            <tspan className="fill-current text-muted-foreground">{input.label}</tspan>
          </text>
          <text x={valueX} y={input.y} dominantBaseline="middle" fontSize={9.5} className={cn("fill-current", input.kind === "link" ? "text-muted-foreground" : "text-foreground")}>
            <title>{input.title}</title>
            {clip(input.text, charsAt(input.y))}
          </text>
        </g>
      ))}
      {node.outputs.map((output) => (
        <g key={output.slot} data-output={output.slot}>
          <circle cx={node.x + node.width} cy={output.y} r={PORT_RADIUS} className={cn("fill-current", edgeClass(output.type) === "text-muted-foreground" ? "text-foreground" : edgeClass(output.type))} />
          <text x={node.x + node.width - BOX_PADDING - PORT_RADIUS} y={output.y} dominantBaseline="middle" textAnchor="end" fontSize={9} className="fill-current text-muted-foreground">
            {clip(output.name, 10)}
          </text>
        </g>
      ))}
      {node.inputs.length === 0 && node.outputs.length === 0 ? (
        <text x={node.x + BOX_PADDING} y={node.y + node.headerHeight + BOX_PADDING + ROW_HEIGHT / 2} dominantBaseline="middle" fontSize={9.5} className="fill-current text-muted-foreground">
          no inputs
        </text>
      ) : null}
    </g>
  );
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}
