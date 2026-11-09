// @vitest-environment jsdom
// The plugin's own glyph set and UI kit. The glyph tests guard the drawing
// rules (one 20x20 box, 1.5 stroke, round caps and joins,
// no fill, no coordinate outside the box) so a new glyph cannot quietly break
// the system; the kit tests check the controls mount and behave.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GLYPH_NAMES, Glyph } from "../components/comfy/glyphs";
import type { GlyphName } from "../components/comfy/glyphs";
import { BAR, Card, CheckBox, Chip, Disclosure, EmptyState, FieldLabel, GhostButton, Hairline, PrimaryButton, Segmented, Spinner, SweepStyle, primaryButtonClass } from "../components/comfy/kit";
import fs from "node:fs";
import path from "node:path";

afterEach(cleanup);

function drawOne(name: GlyphName): SVGSVGElement {
  const Component = Glyph[name];
  const { container } = render(<Component className="size-4" />);
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error(`${name} drew nothing`);
  return svg;
}

describe("glyphs", () => {
  it("covers every glyph the panel asks for", () => {
    // Every glyph the surfaces draw by name.
    for (const name of ["back", "forward", "up", "down", "close", "plus", "minus", "fit", "search", "refresh", "spark", "sliders", "braces", "nodes", "star", "starFilled", "download", "trash", "copy", "play", "pause", "spinner", "alert", "check", "image", "video", "grid"]) {
      expect(GLYPH_NAMES).toContain(name);
    }
  });

  it("draws each glyph in one 20x20 box with the house stroke", () => {
    for (const name of GLYPH_NAMES) {
      const svg = drawOne(name);
      expect(svg.getAttribute("viewBox"), name).toBe("0 0 20 20");
      expect(svg.getAttribute("stroke"), name).toBe("currentColor");
      expect(svg.getAttribute("stroke-width"), name).toBe("1.5");
      expect(svg.getAttribute("stroke-linecap"), name).toBe("round");
      expect(svg.getAttribute("stroke-linejoin"), name).toBe("round");
      expect(svg.getAttribute("fill"), name).toBe("none");
      expect(svg.getAttribute("aria-hidden"), name).toBe("true");
      expect(svg.querySelectorAll("path, circle, rect").length, name).toBeGreaterThan(0);
      cleanup();
    }
  });

  it("keeps every coordinate inside the box, and fills nothing but the starred star and the dice pips", () => {
    for (const name of GLYPH_NAMES) {
      const svg = drawOne(name);
      for (const shape of Array.from(svg.querySelectorAll("path, circle, rect"))) {
        const fill = shape.getAttribute("fill");
        if (fill !== null) expect([name, fill]).toEqual([name, "currentColor"]);
        if (fill !== null) expect(["starFilled", "dice"]).toContain(name);
        const numbers = (shape.getAttribute("d") ?? "")
          .replace(/[A-Za-z]/g, " ")
          .split(/[\s,]+/)
          .filter((part: string) => part !== "")
          .map(Number);
        for (const attribute of ["cx", "cy", "r", "x", "y", "width", "height", "rx"]) {
          const value = shape.getAttribute(attribute);
          if (value !== null) numbers.push(Number(value));
        }
        for (const value of numbers) {
          expect(Number.isFinite(value), `${name}: ${value}`).toBe(true);
          expect(value, `${name}: ${value}`).toBeGreaterThanOrEqual(0);
          expect(value, `${name}: ${value}`).toBeLessThanOrEqual(20);
        }
      }
      cleanup();
    }
  });

  it("takes the caller's size and colour classes", () => {
    const svg = drawOne("spark");
    expect(svg.getAttribute("class")).toContain("size-4");
    cleanup();
    const { container } = render(<Glyph.star className="size-3.5 text-muted-foreground" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("text-muted-foreground");
  });

  it("spins the spinner unless motion is reduced", () => {
    const { container } = render(<Spinner />);
    const className = container.querySelector("svg")?.getAttribute("class") ?? "";
    expect(className).toContain("animate-spin");
    expect(className).toContain("motion-reduce:animate-none");
  });
});

describe("kit", () => {
  it("segments, and reports the chosen id", () => {
    const onSelect = vi.fn();
    render(
      <Segmented
        ariaLabel="View"
        value="media"
        onSelect={onSelect}
        options={[
          { id: "media", label: "Media" },
          { id: "graph", label: "Graph" },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "Media" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(onSelect).toHaveBeenCalledWith("graph");
  });

  it("presses a chip and calls back", () => {
    const onClick = vi.fn();
    render(
      <Chip active onClick={onClick}>
        Images
      </Chip>,
    );
    const chip = screen.getByRole("button", { name: "Images" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("names a glyph only ghost button and disables it on request", () => {
    const onClick = vi.fn();
    render(
      <GhostButton iconOnly ariaLabel="Delete" disabled onClick={onClick}>
        <Glyph.trash className="size-3.5" />
      </GhostButton>,
    );
    const button = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("puts the estimate inside the primary button and swaps the glyph while busy", () => {
    const { container, rerender } = render(
      <PrimaryButton glyph="spark" meta="about 20 s" block>
        Generate image
      </PrimaryButton>,
    );
    expect(screen.getByRole("button").textContent).toContain("about 20 s");
    expect(container.querySelectorAll("svg").length).toBe(1);
    rerender(
      <PrimaryButton glyph="spark" meta="about 20 s" block busy>
        Generate image
      </PrimaryButton>,
    );
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
  });

  it("labels a field and can point at a control", () => {
    render(
      <>
        <FieldLabel htmlFor="seed" hint="1312x736">
          Size
        </FieldLabel>
        <input id="seed" aria-label="Seed" />
      </>,
    );
    expect(screen.getByText("Size").getAttribute("for")).toBe("seed");
    expect(screen.getByText("1312x736")).toBeTruthy();
  });

  it("draws a hairline and a card without a shadow", () => {
    const { container } = render(
      <Card className="mt-2">
        <Hairline />
      </Card>,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain("border-border/60");
    expect(card.className).not.toContain("shadow");
    expect(container.querySelector("[aria-hidden]")?.className).toContain("bg-border/60");
  });

  it("shows artwork, a title, a body and one action in an empty state", () => {
    render(
      <EmptyState art={<span data-testid="art" />} title="Nothing generated yet" action={<button type="button">Generate an image</button>}>
        <p>Your images will appear here.</p>
      </EmptyState>,
    );
    expect(screen.getByTestId("art")).toBeTruthy();
    expect(screen.getByText("Nothing generated yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate an image" })).toBeTruthy();
  });

  it("ticks its own checkbox rather than the host one", () => {
    const seen: boolean[] = [];
    render(<CheckBox checked={false} ariaLabel="watermark" onChange={(next) => seen.push(next)} />);
    const box = screen.getByRole("checkbox", { name: "watermark" });
    expect(box.getAttribute("aria-checked")).toBe("false");
    // The tick is this plugin's own glyph, in the one 20x20 box.
    expect(box.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 20 20");
    fireEvent.click(box);
    expect(seen).toEqual([true]);
  });

  it("hands the primary look to an anchor, and the danger tone to a confirm", () => {
    expect(primaryButtonClass()).toContain("bg-foreground");
    expect(primaryButtonClass({ block: true })).toContain("h-9");
    expect(primaryButtonClass({ tone: "danger" })).toContain("bg-destructive");
    // One bar height for every surface: the Library toolbar, the Viewer header
    // and the graph toolbar all read it from here.
    expect(BAR).toContain("h-10");
    expect(BAR).toContain("px-3");
  });

  it("ships one sweep keyframe, with a reduced motion branch", () => {
    const { container } = render(<SweepStyle />);
    const css = container.querySelector("style")?.textContent ?? "";
    expect(css).toContain("@keyframes comfy-sweep");
    expect(css).toContain(".comfy-sweep-slow");
    expect(css).toContain("prefers-reduced-motion");
    // Only one definition of the keyframe exists in the plugin.
    const dir = path.join(__dirname, "..", "components", "comfy");
    const owners = fs
      .readdirSync(dir)
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) => fs.readFileSync(path.join(dir, file), "utf8").includes("@keyframes comfy-sweep"));
    expect(owners).toEqual(["kit.tsx"]);
  });

  it("keeps every plugin surface free of the host icon set and of emoji", () => {
    const roots = [path.join(__dirname, "..", "components", "comfy")];
    const files = roots.flatMap((dir) => fs.readdirSync(dir).filter((name) => /\.tsx?$/.test(name)).map((name) => path.join(dir, name)));
    files.push(path.join(__dirname, "..", "app.tsx"));
    const banned = /components\/ui\/icon|icon-extended|icon-registry|hugeicons/;
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      expect({ file, hit: banned.test(text) }).toEqual({ file, hit: false });
      expect({ file, hit: emoji.test(text) }).toEqual({ file, hit: false });
    }
  });

  it("opens and closes a disclosure, closed to start with", () => {
    render(
      <Disclosure label="Details" meta="6 rows">
        <p>Path and file size</p>
      </Disclosure>,
    );
    const summary = screen.getByRole("button", { name: /Details/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Path and file size").closest("[hidden]")).not.toBeNull();
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Path and file size").closest("[hidden]")).toBeNull();
  });
});
