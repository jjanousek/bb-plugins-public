import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { clearFaces, mountFaces, paintFaces, publishFaces, type PaintedFace } from "../components/paint.ts";

// The shape of a sidebar row on bb 0.48.1: an empty link laid over the row,
// and beside it a span holding the provider icon, the title, the "in another
// project" folder and the menu button. Thread titles are made up.
function row(threadId: string, title: string, withProvider = true): string {
  return `
    <div class="row" style="position: relative">
      <span class="guide"></span>
      <span class="title-span">
        <a data-sidebar-thread-shortcut-target="" data-sidebar-thread-id="${threadId}" aria-label="Open ${title}"></a>
        <span class="contents">
          <span class="title-group">
            ${withProvider ? `<span data-sidebar-thread-provider="sample" style="position: relative"><span data-provider-logo=""></span></span>` : ""}
            <span class="bb-thread-title"><span>${title}</span></span>
          </span>
          <span data-sidebar-thread-cross-project=""></span>
          <button aria-label="More"></button>
        </span>
      </span>
    </div>`;
}

function page(rows: string): JSDOM {
  return new JSDOM(`<!doctype html><html><head></head><body><nav data-sidebar="sidebar" style="overflow-y: auto">${rows}</nav></body></html>`, {
    pretendToBeVisual: true,
  });
}

const egg = { shape: "egg", colour: "teal" };
const cloud = { shape: "cloud", colour: "pink" };
const want = (entries: [string, PaintedFace][]) => new Map(entries);
const provider = (dom: JSDOM, threadId: string) =>
  dom.window.document.querySelector(`a[data-sidebar-thread-id="${threadId}"]`)!.parentElement!.querySelector<HTMLElement>("[data-sidebar-thread-provider]")!;

describe("drawing faces on bb's rows", () => {
  it("puts a face inside the provider icon of each thread that wants one, and nowhere else", () => {
    const dom = page(row("thr_one", "Plan the garden") + row("thr_two", "Sort the photos") + row("thr_bare", "No icon here", false));
    const doc = dom.window.document;
    const drawn = paintFaces(want([["thr_one", { face: egg, state: "idle" }], ["thr_bare", { face: cloud, state: "idle" }]]), "·", doc);
    assert.equal(drawn, 1);
    const icon = provider(dom, "thr_one");
    const face = icon.querySelector<HTMLElement>(":scope > [data-faces-face]")!;
    assert.equal(face.dataset.face, "egg/teal");
    assert.equal(face.dataset.state, "idle");
    assert.ok(face.querySelector("svg") !== null);
    assert.ok(icon.hasAttribute("data-faces-covered"), "the provider's own picture is hidden under the face");
    assert.equal(provider(dom, "thr_two").querySelector("[data-faces-face]"), null);
    assert.equal(doc.querySelectorAll("[data-faces-face]").length, 1, "a row with no provider icon gets nothing");
  });

  it("swaps the face for the bloom while the thread runs, and back, on the same element", () => {
    const dom = page(row("thr_one", "Plan the garden"));
    const doc = dom.window.document;
    paintFaces(want([["thr_one", { face: egg, state: "idle" }]]), "·", doc);
    const face = doc.querySelector<HTMLElement>("[data-faces-face]")!;
    paintFaces(want([["thr_one", { face: egg, state: "running" }]]), "✶", doc);
    assert.equal(face.dataset.state, "running");
    assert.equal(face.style.getPropertyValue("--faces-bloom"), '"✶"');
    paintFaces(want([["thr_one", { face: egg, state: "waiting" }]]), "·", doc);
    assert.equal(doc.querySelector("[data-faces-face]"), face);
    assert.equal(face.dataset.state, "waiting");
    paintFaces(want([["thr_one", { face: cloud, state: "idle" }]]), "·", doc);
    assert.equal(face.dataset.face, "cloud/pink");
  });

  it("takes a face away when the thread no longer wants one, and shows the provider icon again", () => {
    const dom = page(row("thr_one", "Plan the garden"));
    const doc = dom.window.document;
    paintFaces(want([["thr_one", { face: egg, state: "idle" }]]), "·", doc);
    paintFaces(want([]), "·", doc);
    assert.equal(doc.querySelector("[data-faces-face]"), null);
    assert.equal(doc.querySelector("[data-faces-covered]"), null);
  });

  it("draws again on a provider icon bb replaced, and uncovers one whose face bb dropped", () => {
    const dom = page(row("thr_one", "Plan the garden") + row("thr_two", "Sort the photos"));
    const doc = dom.window.document;
    const faces = want([["thr_one", { face: egg, state: "idle" }], ["thr_two", { face: cloud, state: "idle" }]]);
    paintFaces(faces, "·", doc);
    const fresh = doc.createElement("span");
    fresh.setAttribute("data-sidebar-thread-provider", "sample");
    provider(dom, "thr_one").replaceWith(fresh);
    provider(dom, "thr_two").querySelector("[data-faces-face]")!.remove();
    paintFaces(want([["thr_one", { face: egg, state: "idle" }]]), "·", doc);
    assert.ok(fresh.querySelector("[data-faces-face]") !== null);
    assert.equal(provider(dom, "thr_two").hasAttribute("data-faces-covered"), false);
  });
});

describe("the content script", () => {
  /** Run `mountFaces` against a jsdom page, as bb runs it in the app window. */
  function install(dom: JSDOM) {
    const g = globalThis as Record<string, unknown>;
    const w = dom.window;
    Object.assign(g, {
      window: w,
      document: w.document,
      Element: w.Element,
      MutationObserver: w.MutationObserver,
      requestAnimationFrame: w.requestAnimationFrame.bind(w),
      getComputedStyle: w.getComputedStyle.bind(w),
    });
    w.matchMedia = ((query: string) => ({ matches: false, media: query })) as unknown as typeof w.matchMedia;
  }
  /**
   * Wait until the painter has drawn: bb's mutations reach it on a microtask,
   * and it draws on the next animation frame, which runs before this one
   * because it was asked for first.
   */
  async function nextPaint(dom: JSDOM): Promise<void> {
    await Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    dom.window.requestAnimationFrame(() => resolve());
    await promise;
  }

  it("draws what it is given, follows bb adding rows, and removes every trace when it stops", async () => {
    const dom = page(row("thr_one", "Plan the garden"));
    install(dom);
    const doc = dom.window.document;
    publishFaces(want([]));
    const controller = new AbortController();
    mountFaces({ signal: controller.signal });
    publishFaces(want([["thr_one", { face: egg, state: "idle" }], ["thr_new", { face: cloud, state: "running" }]]));
    await nextPaint(dom);
    assert.equal(doc.querySelectorAll("[data-faces-face]").length, 1);
    assert.ok(doc.getElementById("bb-plugin-faces-style") !== null);
    doc.querySelector("nav")!.insertAdjacentHTML("beforeend", row("thr_new", "Write the notes"));
    await nextPaint(dom);
    assert.equal(provider(dom, "thr_new").querySelector<HTMLElement>("[data-faces-face]")?.dataset.state, "running");
    controller.abort();
    assert.equal(doc.querySelector("[data-faces-face]"), null);
    assert.equal(doc.querySelector("[data-faces-covered]"), null);
    assert.equal(doc.getElementById("bb-plugin-faces-style"), null);
    publishFaces(want([["thr_one", { face: egg, state: "idle" }]]));
    await nextPaint(dom);
    assert.equal(doc.querySelector("[data-faces-face]"), null, "nothing is drawn after it stopped");
    clearFaces(doc);
  });
});
