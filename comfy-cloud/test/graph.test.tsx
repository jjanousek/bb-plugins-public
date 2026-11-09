// @vitest-environment jsdom
// The workflow graph on its own: the draft must survive the viewer's 15 s
// poll (a new object with the same content), "Edit workflow" must land on the
// JSON editor, and the layout must group dotted inputs and drop the output
// ports of a node that only saves a file.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { NodeInfo, Workflow } from "../contract";
import { WorkflowGraph } from "../components/comfy/workflow-graph";
import { FIT_MAX_SCALE, dottedPrefix, fitTransform, layoutWorkflow, middleClip } from "../components/comfy/graph-layout";

const GRAPH: Workflow = {
  "1": {
    class_type: "ByteDanceSeedreamNodeV2",
    inputs: {
      prompt: "a brass compass on a folded map",
      model: "seedream 5.0 pro",
      "model.size_preset": "(1K) 1024x1024 (1:1)",
      "model.width": 1024,
      "model.height": 1024,
      seed: 7,
    },
  },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "bb" } },
};

const CATALOG: Record<string, NodeInfo> = {
  ByteDanceSeedreamNodeV2: {
    classType: "ByteDanceSeedreamNodeV2",
    displayName: "ByteDance Seedream 4.5 & 5.0",
    category: "partner/image/bytedance",
    outputs: ["IMAGE"],
    inputs: [],
  },
  SaveImage: { classType: "SaveImage", displayName: "Save Image", category: "image", outputs: ["IMAGE"], inputs: [], outputNode: true },
};

afterEach(cleanup);

describe("workflow graph", () => {
  it("keeps an edit when the same workflow arrives as a new object", () => {
    const view = render(<WorkflowGraph workflow={GRAPH} catalog={CATALOG} onRun={() => {}} />);
    fireEvent.click(view.container.querySelector('svg [data-node-id="1"]')!);
    const seed = screen.getByLabelText("seed") as HTMLInputElement;
    fireEvent.change(seed, { target: { value: "99" } });
    expect(screen.getByText("(changed)")).toBeTruthy();

    // The poll returns an equal but different object; the draft must survive it.
    view.rerender(<WorkflowGraph workflow={JSON.parse(JSON.stringify(GRAPH)) as Workflow} catalog={CATALOG} onRun={() => {}} />);
    expect(screen.getByText("(changed)")).toBeTruthy();
    expect((screen.getByLabelText("seed") as HTMLInputElement).value).toBe("99");

    // A genuinely different workflow does reset it.
    view.rerender(<WorkflowGraph workflow={{ ...GRAPH, "3": { class_type: "PreviewImage", inputs: { images: ["1", 0] } } }} catalog={CATALOG} onRun={() => {}} />);
    expect(screen.queryByText("(changed)")).toBeNull();
  });

  it("names the source of a link and jumps to it", () => {
    const view = render(<WorkflowGraph workflow={GRAPH} catalog={CATALOG} onRun={() => {}} />);
    fireEvent.click(view.container.querySelector('svg [data-node-id="2"]')!);
    const link = screen.getByRole("button", { name: "from ByteDance Seedream 4.5 & 5.0 (node 1), IMAGE" });
    fireEvent.click(link);
    // Node 1 is selected now, so its own inputs are the ones in the form.
    expect(screen.getByLabelText("seed")).toBeTruthy();
    expect(screen.queryByLabelText("filename_prefix")).toBeNull();
  });

  it("opens on the JSON editor when Edit workflow asked for it", () => {
    render(<WorkflowGraph workflow={GRAPH} catalog={CATALOG} onRun={() => {}} jsonRequest={1} />);
    const box = screen.getByLabelText("Workflow JSON") as HTMLTextAreaElement;
    expect(box.value).toContain('"class_type": "ByteDanceSeedreamNodeV2"');
  });

  it("blocks the run while the JSON is broken and says how to check again", () => {
    render(<WorkflowGraph workflow={GRAPH} catalog={CATALOG} onRun={() => {}} jsonRequest={1} />);
    const box = screen.getByLabelText("Workflow JSON") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "{ not json" } });
    fireEvent.blur(box);
    expect(screen.getByText(/Fix it and leave the box to check again\./)).toBeTruthy();
    const run = screen.getByRole("button", { name: "Run tweaked workflow" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.closest("span")?.getAttribute("title")).toBe("Fix the JSON first");
  });

  it("names the zoom and fit controls and portals the form into a given container", () => {
    const panel = document.createElement("div");
    document.body.append(panel);
    const view = render(<WorkflowGraph workflow={GRAPH} catalog={CATALOG} onRun={() => {}} panelContainer={panel} />);
    for (const name of ["Zoom out", "Zoom in", "Fit"]) expect(screen.getByRole("button", { name })).toBeTruthy();

    // The hint and, once a node is chosen, its form live in the viewer's
    // reading column rather than under the canvas.
    expect(panel.textContent).toContain("Drag to pan");
    fireEvent.click(view.container.querySelector('svg [data-node-id="1"]')!);
    expect(panel.querySelector('input[aria-label="seed"]')).not.toBeNull();
    expect(view.container.querySelector('input[aria-label="seed"]')).toBeNull();
    panel.remove();
  });
});

describe("graph layout details", () => {
  it("groups dotted inputs, names the source of a link and drops output-only ports", () => {
    const layout = layoutWorkflow(GRAPH, { catalog: CATALOG });
    const [generator, saver] = layout.nodes;
    expect(generator!.groups.map((group) => group.label)).toEqual(["model."]);
    expect(generator!.inputs.find((input) => input.name === "model.width")?.label).toBe("width");
    // The rows under the prefix row are marked so the card can indent them; the
    // top level ones are not, which is how the group visibly closes.
    expect(generator!.inputs.find((input) => input.name === "model.width")?.grouped).toBe(true);
    expect(generator!.inputs.find((input) => input.name === "prompt")?.grouped).toBe(false);
    expect(generator!.inputs.find((input) => input.name === "seed")?.grouped).toBe(false);
    expect(generator!.inputs.find((input) => input.name === "prompt")?.title).toBe("prompt: a brass compass on a folded map");
    // The group row takes a row of its own, so the box is one row taller than the input count.
    expect(generator!.height).toBeGreaterThan(saver!.height);

    const link = saver!.inputs.find((input) => input.name === "images");
    expect(link?.text).toBe("from ByteDance Seedream 4.5 & 5.0 (node 1), IMAGE");
    // SaveImage is an output node, so its own IMAGE port is not drawn.
    expect(saver!.outputs).toEqual([]);
  });

  it("cuts long names in the middle", () => {
    expect(middleClip("short", 24)).toBe("short");
    expect(middleClip("a".repeat(30), 24)).toHaveLength(24);
    expect(middleClip("abcdefghij", 5)).toBe("ab…ij");
    expect(dottedPrefix("model.width")).toBe("model.");
    expect(dottedPrefix("prompt")).toBeNull();
  });
});

describe("fit", () => {
  it("centres a graph that fits, and holds 100 percent top left rather than shrinking below 0.85", () => {
    const graph = { width: 600, height: 400 };
    expect(fitTransform({ width: 632, height: 432 }, graph).k).toBe(1);
    expect(fitTransform({ width: 2000, height: 2000 }, graph).k).toBe(FIT_MAX_SCALE);
    const tight = fitTransform({ width: 560, height: 520 }, { width: 900, height: 1400 });
    expect(tight.k).toBe(1);
    expect(tight.x).toBeLessThanOrEqual(16);
    expect(tight.y).toBeLessThanOrEqual(16);
  });
});
