// @vitest-environment jsdom
// The two fixed tabs, rendered through the SDK harness: the Generate form's
// controls and states, and the Jobs list. Kept apart from app.test.tsx (which
// owns the Library and the Viewer) so the two files stay readable.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { ComponentType } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { DEFAULT_CREDIT_RATE } from "../contract";
import type { Asset, AssetStatus, Costs, RpcContract, Status } from "../contract";
import { requestReference, resetSession } from "../components/comfy/form-session";
import { modelsResult } from "./model-fixtures";

// A whole hour 30 days before the run: the Jobs tab reads the real clock, so a
// fixed date would not stay in the past.
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 86_400_000;

function asset(over: Partial<Asset> & { id: string; status: AssetStatus }): Asset {
  return {
    kind: "image",
    prompt: "a brass compass on a folded map, overhead photo",
    model: "seedream 5.0 pro",
    params: { sizePreset: "(1K) 1024x1024 (1:1)", seed: 7 },
    file: null,
    path: null,
    workflowPath: "/tmp/x.workflow.json",
    mime: null,
    width: 1024,
    height: 1024,
    durationS: null,
    sizeBytes: null,
    comfyPromptId: null,
    parentId: null,
    threadId: null,
    source: "panel",
    starred: false,
    error: null,
    createdAt: NOW - 40_000,
    startedAt: null,
    completedAt: null,
    ...over,
  };
}

const RUNNING = asset({ id: "img_run00000", status: "running", startedAt: NOW - 20_000 });
const QUEUED = asset({ id: "img_que00000", status: "queued" });
const FAILED = asset({
  id: "img_fail0000",
  status: "failed",
  error: "Duration must be at least 4 for this model.",
});
const DONE = asset({
  id: "img_done0000",
  status: "completed",
  file: "2031-04-16/img_done0000.png",
  path: "/assets/2031-04-16/img_done0000.png",
  mime: "image/png",
  startedAt: NOW - 90_000,
  completedAt: NOW - 60_000,
});

const STATUS: Status = {
  configured: true,
  keySource: "key-file",
  configureHint: null,
  assetDir: "/data/.bb/plugins/comfy-cloud/assets",
  imageModel: "seedream 5.0 pro",
  videoModel: "seedance-1-0-pro-fast-251015",
  counts: { total: 4, images: 4, videos: 0, running: 1, failed: 1, failedRecent: 1 },
  catalogLoaded: true,
  registry: { generatedAt: "2031-04-10", catalogDate: "2031-04-09", catalogFetched: "2031-04-09" },
  balanceCredits: 1055,
  balanceUsd: 5,
  creditRate: DEFAULT_CREDIT_RATE,
};

const COSTS: Costs = {
  balanceCredits: 1055,
  balanceUsd: 5,
  creditRate: DEFAULT_CREDIT_RATE,
  spend: { today: 0, week: 12.4, total: 230 },
  byModel: [
    { model: "veo-3.1-lite", kind: "video", credits: 150, count: 2 },
    { model: "reve-create@20250915", kind: "image", credits: 12, count: 4 },
  ],
  recent: [],
  observed: [],
  days: 7,
};

const PREVIEW = { baseUrl: "http://bb.test/preview/abc", expiresAtMs: Date.now() + 3_600_000 };
const ART = { baseUrl: "http://bb.test/preview/art", expiresAtMs: Date.now() + 3_600_000 };

const notStubbed = (method: string) => () => {
  throw new Error(`${method} is not stubbed in this test`);
};

function handlers(rows: Asset[], overrides: Partial<PluginRpcTestHandlers<RpcContract>> = {}): PluginRpcTestHandlers<RpcContract> {
  return {
    status: () => STATUS,
    costs: () => COSTS,
    assets_list: (input) => ({ assets: input.status === undefined || input.status === null ? rows : rows.filter((row) => row.status === input.status) }),
    asset_get: ({ id }) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row === undefined) throw new Error(`no asset ${id}`);
      return { asset: row, workflow: {}, job: null };
    },
    preview_base: () => PREVIEW,
    art_base: () => ART,
    node_catalog: () => ({ nodes: {} }),
    // The Generate tab renders from the registry, so both of these are live
    // in every Generate test; test/model-fixtures.ts holds the summaries.
    models: (input) =>
      modelsResult(input?.kind === "video" ? "video" : "image", DEFAULT_CREDIT_RATE, [
        // One shape this account has been billed for, so the form can be held
        // to quoting a learned price over the published one.
        { signature: "image|seedream 5.0 pro|2K", kind: "image", model: "seedream 5.0 pro", credits: 12, samples: 3 },
      ]),
    model_prefs: () => ({ favourites: [], recent: [] }),
    model_labels: () => ({ labels: {} }),
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

async function tabComponent(id: "generate" | "jobs"): Promise<ComponentType<PluginNavPanelProps>> {
  const app = await loadPluginApp(() => import("../app"));
  const panel = app.navPanels[0];
  if (panel === undefined) throw new Error("no nav panel registered");
  const tab = panel.fixedTabs?.find((candidate) => candidate.id === id);
  if (tab === undefined) throw new Error(`no ${id} tab`);
  return tab.component;
}

describe("Generate tab", () => {
  afterEach(() => {
    cleanup();
    // The Generate tab keeps its form across mounts on purpose (a fixed tab is
    // unmounted on every switch to Jobs), so each test starts it fresh.
    resetSession();
  });

  async function open(rows: Asset[] = [DONE], overrides: Partial<PluginRpcTestHandlers<RpcContract>> = {}) {
    const component = await tabComponent("generate");
    return renderSlot<PluginNavPanelProps, RpcContract>({ component }, { subPath: "" }, { rpc: handlers(rows, overrides) });
  }

  it("names the chosen model on the row that opens the picker, and quotes the resulting size", async () => {
    const slot = await open();
    // The model row carries the label, the vendor, what the model can do and its price.
    const row = await slot.findByRole("button", { name: /^Model: Seedream 5.0 Pro \(legacy node\)/ });
    expect(row.textContent).toContain("ByteDance · 1K to 2K");
    expect(row.textContent).toContain("from 8 credits");
    await slot.findByText("1024x1024");
    // 16:9 at 1K is 1312x736, and the hint follows the chips.
    fireEvent.click(slot.getByRole("button", { name: "16:9" }));
    await slot.findByText("1312x736");
  });

  it("says why it cannot submit and puts the estimate inside the button", async () => {
    const slot = await open();
    const button = await slot.findByRole("button", { name: /^Generate image/ });
    expect(button.textContent).toContain("about 20 to 40 s");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // JSX drops the space after a closing tag at a line break, which would make
    // this caption read "Jobsshows".
    expect(slot.getByRole("button", { name: "Jobs" }).parentElement?.textContent).toContain("and Jobs shows what is waiting");
    // On a phone the button bar sticks to the bottom of the drawer, clear of
    // the home indicator, and carries the reason it cannot submit with it.
    const bar = button.closest("[data-generate-bar]");
    expect(bar?.className).toContain("max-md:sticky");
    // -bottom-3 cancels the host's 12 px of padding under a fixed tab, so the
    // bar sits on the drawer's own edge rather than 12 px above it.
    expect(bar?.className).toContain("max-md:-bottom-3");
    expect(bar?.className).toContain("safe-area-inset-bottom");
    // Sticky only travels inside its parent, so the bar has to be a child of
    // the whole form, not of a wrapper as short as itself.
    const form = bar?.parentElement;
    expect(form?.contains(slot.getByRole("textbox", { name: "Prompt" }))).toBe(true);
    const prompt = slot.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(prompt, { target: { value: "a stone bridge in fog" } });
    await waitFor(() => expect((slot.getByRole("button", { name: /^Generate image/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(prompt, { target: { value: "" } });
    const why = await slot.findByText("Write a prompt first");
    expect(why.closest("[data-generate-bar]")).not.toBeNull();
  });

  it("quotes what this account was actually billed, not the published price", async () => {
    // Two bills of the same shape beat the price list everywhere else in the
    // plugin, so the button has to say the same number: otherwise it promises
    // one price and the row it creates records another. The handler carries one
    // learned 2K sample; 1K has none, so the two tiers show the two sources.
    const slot = await open();
    const button = await slot.findByRole("button", { name: /^Generate image/ });
    expect(button.textContent).toContain("9.5 credits");
    fireEvent.click(slot.getByRole("button", { name: "2K" }));
    await waitFor(() => expect(slot.getByRole("button", { name: /^Generate image/ }).textContent).toContain("12 credits"));
    expect(slot.getByRole("button", { name: /^Generate image/ }).textContent).not.toContain("18.99");
  });

  it("swaps to the video controls and back, keeping the prompt", async () => {
    const slot = await open();
    const prompt = await slot.findByRole("textbox", { name: "Prompt" });
    fireEvent.change(prompt, { target: { value: "a kite over a sand dune at noon" } });
    fireEvent.click(slot.getByRole("button", { name: "Video" }));
    await slot.findByRole("button", { name: /^Model: Seedance 1.0 Pro Fast/ });
    // A video model brings a Length row with it; this one has no sound.
    await slot.findByText("Length");
    expect(slot.queryByRole("group", { name: "Sound" })).toBeNull();
    expect((slot.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement).value).toBe("a kite over a sand dune at noon");
    fireEvent.click(slot.getByRole("button", { name: "Image" }));
    await slot.findByRole("button", { name: /^Model: Seedream 5.0 Pro/ });
  });

  it("hides the seed box until the seed is fixed", async () => {
    const slot = await open();
    const prompt = await slot.findByRole("textbox", { name: "Prompt" });
    fireEvent.change(prompt, { target: { value: "a stone bridge in fog" } });
    await slot.findByRole("group", { name: "Seed" });
    expect(slot.queryByRole("textbox", { name: "Seed" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Fixed" }));
    const seed = await slot.findByRole("textbox", { name: "Seed" });
    fireEvent.change(seed, { target: { value: "12" } });
    fireEvent.click(slot.getByRole("button", { name: "3 variants" }));
    await slot.findByText("Seeds 12 to 14.");
    // The prompt is the first thing missing, so the seed complaint only shows once there is one.
    fireEvent.change(seed, { target: { value: "nope" } });
    await slot.findByText(/Seed must be a whole number/);
  });

  it("attaches a picture from the viewer as a reference, prices it, sends it, and lets it go", async () => {
    // The default here is the legacy Seedream node, which takes ten references
    // and covers the first, so one reference quotes the plain price.
    const sent: unknown[] = [];
    const slot = await open([DONE], {
      generate_image: (input) => {
        sent.push(input);
        return { asset: { ...DONE, id: "img_new00000", status: "queued" } };
      },
    });
    const prompt = await slot.findByRole("textbox", { name: "Prompt" });
    fireEvent.change(prompt, { target: { value: "the same compass, at night" } });
    // An empty row says how to fill it.
    await slot.findByText(/choose Use as reference/);
    requestReference(DONE);
    const list = await slot.findByRole("list", { name: "Reference images" });
    expect(list.querySelectorAll("li")).toHaveLength(1);
    expect(slot.getByText("1 of 10")).toBeTruthy();
    // The prompt somebody was writing survives the reference arriving.
    expect((slot.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement).value).toBe("the same compass, at night");
    expect(slot.getByRole("button", { name: /^Generate image/ }).textContent).toContain("9.5 credits");
    fireEvent.click(slot.getByRole("button", { name: /^Generate image/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ references: ["img_done0000"] });
    // Removed, the row is empty again and nothing is sent.
    fireEvent.click(slot.getByRole("button", { name: "Remove reference img_done0000" }));
    await waitFor(() => expect(slot.queryByRole("list", { name: "Reference images" })).toBeNull());
  });

  it("switches to a model that takes references when the current one cannot, and says so", async () => {
    const slot = await open();
    await slot.findByRole("textbox", { name: "Prompt" });
    fireEvent.click(await slot.findByRole("button", { name: /^Model:/ }));
    await slot.findByRole("dialog", { name: "Choose an image model" });
    fireEvent.click(slot.getByRole("button", { name: /^Reve Image Create/ }));
    await slot.findByRole("button", { name: /^Model: Reve Image Create/ });
    // Reve takes none, so there is no References row at all.
    expect(slot.queryByText("References")).toBeNull();
    requestReference(DONE);
    await slot.findByRole("button", { name: /^Model: Seedream 4.0/ });
    await slot.findByText("Reve Image Create takes no reference images, so this switched to Seedream 4.0.");
    expect((await slot.findByRole("list", { name: "Reference images" })).querySelectorAll("li")).toHaveLength(1);
  });

  it("says the price is unknown with a reference rather than quoting low", async () => {
    const slot = await open();
    await slot.findByRole("textbox", { name: "Prompt" });
    fireEvent.click(await slot.findByRole("button", { name: /^Model:/ }));
    await slot.findByRole("dialog", { name: "Choose an image model" });
    fireEvent.click(slot.getByRole("button", { name: /^Flux.2 \[pro\]/ }));
    await slot.findByRole("button", { name: /^Model: Flux.2 \[pro\]/ });
    // Quoted bare first, so the refusal below is the reference's doing.
    expect(slot.getByRole("button", { name: /^Generate image/ }).textContent).toMatch(/\d credits/);
    requestReference(DONE);
    await slot.findByRole("list", { name: "Reference images" });
    await waitFor(() => expect(slot.getByRole("button", { name: /^Generate image/ }).textContent).toContain("price unknown with a reference"));
  });

  it("offers to open the settings when no key is configured", async () => {
    const slot = await open([DONE], { status: () => ({ ...STATUS, configured: false, keySource: null, configureHint: "Set the apiKey setting." }) });
    await slot.findByText(/Set the apiKey setting/);
    expect(slot.getByRole("link", { name: "Open settings" }).getAttribute("href")).toBe("/settings/plugins/comfy-cloud");
    expect((slot.getByRole("button", { name: /^Generate image/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Model picker", () => {
  afterEach(() => {
    cleanup();
    // The Generate tab keeps its form across mounts on purpose (a fixed tab is
    // unmounted on every switch to Jobs), so each test starts it fresh.
    resetSession();
  });

  async function open(overrides: Partial<PluginRpcTestHandlers<RpcContract>> = {}) {
    const component = await tabComponent("generate");
    return renderSlot<PluginNavPanelProps, RpcContract>({ component }, { subPath: "" }, { rpc: handlers([DONE], overrides) });
  }

  /** Open the sheet from the model row on the Generate tab. */
  async function openSheet(slot: Awaited<ReturnType<typeof open>>) {
    const trigger = await slot.findByRole("button", { name: /^Model:/ });
    fireEvent.click(trigger);
    await slot.findByRole("dialog", { name: "Choose an image model" });
    return trigger;
  }

  it("lists every model with its price, and choosing one keeps the prompt", async () => {
    const slot = await open();
    const prompt = await slot.findByRole("textbox", { name: "Prompt" });
    fireEvent.change(prompt, { target: { value: "a paper crane on a windowsill" } });
    await openSheet(slot);

    // Vendor headers over the rows, and a price on every row.
    expect(slot.getByRole("region", { name: "ByteDance" })).toBeTruthy();
    const reve = slot.getByRole("button", { name: /^Reve Image Create/ });
    expect(reve.textContent).toContain("2 credits, about $0.01");
    expect(reve.textContent).toContain("Quick drafts at a low flat price");

    fireEvent.click(reve);
    // Back on the form: the new model, its own controls, and the prompt intact.
    await slot.findByRole("button", { name: /^Model: Reve Image Create/ });
    expect((slot.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement).value).toBe("a paper crane on a windowsill");
    // Reve has ratios and no tiers, so the tier chips are gone and its ratios are there.
    expect(slot.getByRole("group", { name: "Aspect ratio" }).textContent).toContain("21:9");
    expect(slot.queryByRole("group", { name: "Resolution tier" })).toBeNull();
    // And the estimate follows the model.
    expect(slot.getByRole("button", { name: /^Generate image/ }).textContent).toContain("2 credits");
  });

  it("still holds the chosen model and the prompt after the tab is unmounted", async () => {
    // Generate is a fixed tab, so one click on Jobs unmounts it; form-session.ts
    // keeps the chosen model and the prompt across that remount.
    const first = await open();
    fireEvent.change(await first.findByRole("textbox", { name: "Prompt" }), { target: { value: "a paper crane on a windowsill" } });
    await openSheet(first);
    fireEvent.click(first.getByRole("button", { name: /^Reve Image Create/ }));
    await first.findByRole("button", { name: /^Model: Reve Image Create/ });

    // The user goes to Jobs and comes back.
    cleanup();
    const again = await open();
    await again.findByRole("button", { name: /^Model: Reve Image Create/ });
    expect((again.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement).value).toBe("a paper crane on a windowsill");
    // And the sheet is closed on the way back in, not left open over the form.
    expect(again.queryByRole("dialog", { name: "Choose an image model" })).toBeNull();
  });

  it("searches by vendor and says so when nothing matches", async () => {
    const slot = await open();
    await openSheet(slot);
    const search = slot.getByRole("searchbox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "ideogram" } });
    await waitFor(() => expect(slot.queryByRole("button", { name: /^Seedream 4.0/ })).toBeNull());
    expect(slot.getByRole("button", { name: /^Ideogram 3.0/ })).toBeTruthy();
    fireEvent.change(search, { target: { value: "zqx" } });
    await slot.findByText("No models match");
    fireEvent.click(slot.getByRole("button", { name: "Clear search and filters" }));
    await slot.findByRole("button", { name: /^Seedream 4.0/ });
  });

  it("sorts by price in one click, cheapest first", async () => {
    const slot = await open();
    await openSheet(slot);
    fireEvent.click(slot.getByRole("button", { name: "Cheapest" }));
    await slot.findByRole("region", { name: "Cheapest first" });
    const order = Array.from(slot.container.querySelectorAll("[data-model-row]")).map((row) => row.getAttribute("data-model-key"));
    // The current model is pinned into Recent at the top, so the sort is read from the section under it.
    const cheapest = order.slice(order.indexOf("OpenAIGPTImageNodeV2/gpt-image-2"));
    expect(cheapest.slice(0, 3)).toEqual(["OpenAIGPTImageNodeV2/gpt-image-2", "ReveImageCreateNode/reve-create@20250915", "Flux2ImageNode/Flux.2 [pro]"]);
  });

  it("keeps a favourite through the model_prefs RPC and pins it above the vendors", async () => {
    let stored: string[] = [];
    const slot = await open({
      model_prefs: (input) => {
        if (input?.favourites !== undefined) stored = [...input.favourites];
        return { favourites: stored, recent: [] };
      },
    });
    await openSheet(slot);
    fireEvent.click(slot.getByRole("button", { name: "Add Ideogram 3.0 to favourites" }));
    await slot.findByRole("region", { name: "Favourites" });
    expect(stored).toEqual(["IdeogramV3"]);
    // The row is pinned at the top and also stays in its vendor group, so both stars are filled.
    expect(slot.getAllByRole("button", { name: "Remove Ideogram 3.0 from favourites" })).toHaveLength(2);
  });

  it("moves through the rows with the arrows and comes back to the search when you type", async () => {
    const slot = await open();
    await openSheet(slot);
    const search = slot.getByRole("searchbox", { name: "Search models" });
    const rows = () => Array.from(slot.container.querySelectorAll<HTMLButtonElement>("[data-model-row]"));
    fireEvent.keyDown(search, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(rows()[0]));
    fireEvent.keyDown(rows()[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[1]);
    fireEvent.keyDown(rows()[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows()[0]);
    // Up from the first row is the search box again, and any letter goes there too.
    fireEvent.keyDown(rows()[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(rows()[0]!, { key: "k" });
    await waitFor(() => expect((search as HTMLInputElement).value).toBe("k"));
    expect(document.activeElement).toBe(search);
  });

  it("closes on Escape and gives the focus back to the model row", async () => {
    const slot = await open();
    await openSheet(slot);
    fireEvent.keyDown(slot.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    // The form is drawn again, so the row that takes the focus back is the new one.
    await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("button", { name: /^Model:/ })));
  });

  it("greys out the lengths the vendor refuses at 1080p and says why", async () => {
    const slot = await open();
    fireEvent.click(await slot.findByRole("button", { name: "Video" }));
    const trigger = await slot.findByRole("button", { name: /^Model: Seedance 1.0 Pro Fast/ });
    fireEvent.click(trigger);
    await slot.findByRole("dialog", { name: "Choose a video model" });
    fireEvent.click(slot.getByRole("button", { name: /^Veo 3.1/ }));
    await slot.findByRole("button", { name: /^Model: Veo 3.1/ });
    // Veo runs 4, 6 or 8 seconds, and only 8 of those at 1080p.
    expect((slot.getByRole("button", { name: "4 s" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(slot.getByRole("group", { name: "Resolution" }).querySelector("button:nth-child(2)")!);
    await waitFor(() => expect((slot.getByRole("button", { name: "4 s" }) as HTMLButtonElement).disabled).toBe(true));
    expect(slot.getByText("1080p is only offered as an 8 second clip.")).toBeTruthy();
    expect(slot.getByRole("button", { name: "8 s" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Jobs tab", () => {
  afterEach(() => {
    cleanup();
    // The Generate tab keeps its form across mounts on purpose (a fixed tab is
    // unmounted on every switch to Jobs), so each test starts it fresh.
    resetSession();
  });

  async function open(rows: Asset[]) {
    const component = await tabComponent("jobs");
    return renderSlot<PluginNavPanelProps, RpcContract>({ component }, { subPath: "" }, { rpc: handlers(rows) });
  }

  it("lists what is happening with the elapsed time against the estimate", async () => {
    // The fixtures are dated 30 days back and the tab reads the real clock, so
    // the failure that should lead has to be a fresh one.
    const fresh = { ...FAILED, id: "img_fresh000", createdAt: Date.now() - 120_000, completedAt: Date.now() - 100_000 };
    const slot = await open([RUNNING, QUEUED, fresh, DONE]);
    await slot.findByText("Now");
    expect(slot.getByText(/of about 20 to 40 s/)).toBeTruthy();
    await slot.findByText("Waiting");
    expect(slot.getAllByRole("button", { name: "Cancel" })).toHaveLength(2);
    // A fresh failure is one line: the friendly sentence, the model, and Retry.
    const failed = slot.container.querySelector("[data-failed-row]")!;
    expect(failed.textContent).toContain("Duration must be at least 4");
    expect(within(failed as HTMLElement).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(slot.getByRole("button", { name: /Clear failed/ })).toBeTruthy();
    // The finished section keeps the last completed rows within reach, each with a 44 px picture.
    await slot.findByText("Finished");
    const done = slot.getByRole("button", { name: "Open img_done0000" });
    expect(done.querySelector("span")?.className).toContain("size-11");
  });

  it("moves a failure older than a day out of Now and into Finished, in time order, under a muted marker", async () => {
    // Dated 30 days before the run. The failure
    // sits between two finished rows in time, and the lists arrive as two
    // separate queries, so only a real sort puts it in the middle.
    const old = { ...FAILED, createdAt: NOW - 3 * 3600_000, completedAt: NOW - 2 * 3600_000 };
    const earlier = { ...DONE, id: "img_done0001", createdAt: NOW - 5 * 3600_000, startedAt: NOW - 5 * 3600_000, completedAt: NOW - 4 * 3600_000 };
    const slot = await open([RUNNING, old, DONE, earlier]);
    await slot.findByText("Finished");
    const sections = Array.from(slot.container.querySelectorAll("section"));
    const [now, finished] = sections;
    expect(now?.textContent).not.toContain("Duration must be");
    expect(now?.querySelector("[data-failed-row]")).toBeNull();
    const rows = Array.from(finished!.querySelectorAll("li"));
    // Time order: the finished row settled after the failure did.
    expect(rows.map((row) => row.querySelector("button")?.getAttribute("aria-label"))).toEqual(["Open img_done0000", "Open img_fail0000", "Open img_done0001"]);
    const marker = within(rows[1] as HTMLElement).getByText("Failed");
    expect(marker.className).toContain("text-muted-foreground");
    expect(marker.className).not.toContain("destructive");
    // No Retry on history, and Clear failed still reaches it.
    expect(within(finished!).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(slot.getByRole("button", { name: /Clear failed/ })).toBeTruthy();
  });

  it("shows the hourglass drawing and a way out when nothing is waiting", async () => {
    const slot = await open([DONE]);
    await slot.findByText("Nothing waiting");
    expect(slot.container.querySelector('[data-art="idle-jobs"]')).not.toBeNull();
    expect(slot.getByRole("button", { name: /Generate something/ })).toBeTruthy();
    // The two halves of the tab keep the same shape whether or not anything is
    // running: "Now" heads the empty state, "Finished" the list under it.
    expect(slot.getByText("Now")).toBeTruthy();
    await slot.findByText("Finished");
  });
});
