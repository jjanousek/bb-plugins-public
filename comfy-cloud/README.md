# bb-plugin-comfy-cloud

Generate images and videos on [Comfy Cloud](https://cloud.comfy.org) from
inside bb, keep every result on disk next to the workflow that made it, flip
through the results in a panel, and see a rough graph of each workflow.

Plugin id `comfy-cloud`. CLI `bb comfy`. Agent tools `comfy_*`.

## What it needs

- bb 0.41 or newer.
- A Comfy Cloud account with an API key and credits. Generation is billed to
  that account.
- `ffmpeg` and `ffprobe` on the bb server for thumbnails and video probes.

## Install

From a clone of this repository:

```
cd comfy-cloud
npm ci --ignore-scripts
bb plugin install . --yes
bb plugin config comfy-cloud set keyFile /path/to/your/.env
bb plugin reload comfy-cloud
bb comfy status
```

## Settings

- **API key** (secret): your Comfy Cloud API key.
- **Key file**: path to a dotenv file on the bb server holding `COMFY_API_KEY`.
- **Default image model**, **Default video model**: what the Generate tab
  and the CLI pick when you name none.
- **Asset folder**: where generated files are kept; empty means
  `<bb data dir>/plugins/comfy-cloud/assets`.
- **Credits per US dollar**: 211 by default; empty shows credits only.

## The API key

The plugin looks for the key in this order, on the server only:

1. The secret setting `apiKey` (Settings, Extensions, Comfy Cloud).
2. `COMFY_API_KEY=` in a git-ignored `.env` in this folder
   (copy `.env.example` to `.env` and fill it in).
3. `COMFY_API_KEY=` in the file named by the `keyFile` setting.

The key never reaches the frontend, the CLI output, agent tools, or the
stored job records. Downloads follow the `/api/view` redirect by hand so the
signed storage URL is fetched with no plugin headers at all.

## Use

- Panel: sidebar entry "Comfy". Grid of assets, click one to open the viewer,
  arrow keys to flip through, "Media | Graph" toggle for the workflow graph,
  Tweak or Edit workflow to regenerate with changes. The Generate tab in the
  right panel makes new images and videos; the Jobs tab shows what is running.
- CLI: `bb comfy image "<prompt>" --size "(1K) 1312x736 (16:9)"`,
  `bb comfy video "<prompt>" --resolution 480p|720p|1080p|4k --aspect 16:9 --duration 5`,
  `bb comfy list`, `bb comfy show <id> --workflow`, `bb comfy run <workflow.json>`,
  `bb comfy models --kind video`, `bb comfy sizes --model <key>`,
  `bb comfy status`, `bb comfy costs`. Add `--json` for machine output.
  Anything a model declares beyond the shared controls is `--extra
  name=value,...` (`bb comfy sizes` lists what each model takes).
- Reference images: `bb comfy image "<prompt>" --reference img_ab12cd34`, or a
  path to an image on the bb server, repeated for more than one. 19 image and 5
  video models take them; `bb comfy models` marks which, and a model that takes
  none refuses and names two that do. The first reference is included in the
  price and each one after it adds a little (0.63 credits on Seedream 5.0 Pro).
- Agents: `comfy_generate_image`, `comfy_generate_video`, `comfy_models`,
  `comfy_run_workflow`, `comfy_assets`, `comfy_asset`, `comfy_status`,
  `comfy_costs`. The `comfy-cloud` skill explains them.

## Models

The plugin offers **every text-to-image and text-to-video model Comfy Cloud
sells**: **103 models to choose from**, 53 image and 50 video, across 23 vendors
(ByteDance, Google, OpenAI, xAI, BFL, Kling, Luma, MiniMax, Meta, Microsoft,
Wan, Qwen, Ideogram, Recraft, Krea, Vidu, PixVerse, LTXV, Runway, HappyHorse,
Tencent, Pruna and HeyGen). They come
out of 171 catalog entries from 89 partner nodes: 120 of those can be built from
a prompt alone, and 17 of the 120 are legacy or superseded nodes offering a
model a live node already offers, so they are hidden rather than shown twice.
`bb comfy models` prints the 103 with their capabilities and their price,
cheapest first inside each vendor; `--all` adds the hidden ones and the entries
that cannot be offered, and says why.

A model is named by its key, `<node class>/<model id>` (or just the node class
when the node runs one model). The ten legacy ids work unchanged:
`seedream 5.0 pro`, `seedance-1-0-pro-fast-251015` and the rest resolve to the
same nodes and build the same graphs, byte for byte. A price is
keyed by the id Comfy bills under, so a model named by its key, by its bare id
or by one of those ten is one shape everywhere: one row in the spend table and
one set of learned prices.

The registry is generated, not hand written:

- `scripts/make-models.mjs` reads the cached node catalog
  (`~/.bb/plugins/comfy-cloud/object_info.json`) and writes
  `models.generated.ts`: one entry per node and model id, with every declared
  input in its catalog order, mapped to roles (prompt, size, aspect,
  resolution, dimensions, length, sound, count, seed).
- The same script reads `qa/model-docs/*.json`, the hand checked record of what
  each vendor's own documentation says, and writes `models.overrides.ts`:
  labels, capabilities the schema cannot express, the combinations a vendor
  refuses, and prices. Overrides win.
- `registry.ts` merges the two. `workflows.ts` has one generic builder that
  fills a node's inputs from a request through the role map, clamping numbers
  to the schema and checking enum membership.

Run `node scripts/make-models.mjs` by hand when Comfy Cloud changes its
catalog. Runtime never reads the 6 MB catalog: the generated files are the
source of truth, so the tests are deterministic. `test/models.test.ts` builds a
graph for every supported model and validates it against that snapshot, which
is how the whole catalog is known to work without running it, and it walks the
picker's own path so a model the sheet offers and the builder refuses fails
there rather than at a user's expense.

## What it costs

Comfy Cloud bills in credits: 211 credits are one US dollar. The plugin
records what each generation was expected to cost before it runs and what it
was actually billed afterwards, reads both from
`GET /api/billing/events` (matched to the job by `job_id`), and shows the
balance, the spend and the gap in the panel, in `bb comfy costs` and in
`bb comfy show <id>`.

A 1K Seedream 5.0 Pro image is 9.50 credits ($0.045); a 2K one is 18.99.
Across the whole catalog, images run from about 0.7 to 53 credits and video
from about 6 credits for a short 480p clip to over 3000 for a long 4K one, so
the estimate is shown before the click and `bb comfy models` sorts by it. The
ten legacy Seedream and Seedance ids keep their own price tables in
`contract.ts`; every other model carries a `ModelPrice` from its vendor's
published figures, and `priceCredits` walks its tier table with the request's
own values. Where nothing is published the estimate says the cost is unknown,
and the plugin learns from its own bills: what this account is charged wins
after it has seen a shape twice.

The `creditRate` setting is credits per US dollar (211 by default). Empty it
and the plugin shows credits only and never a dollar figure.

## Files

Assets live under `~/.bb/plugins/comfy-cloud/assets/<date>/` as
`<id>.png|mp4`, `<id>.workflow.json` (the exact graph submitted) and
`<id>.job.json` (the Comfy job record with the key stripped). Change the
folder with the `assetDir` setting.

## Develop

`contract.ts` is the RPC contract shared by `server.ts` and `app.tsx`. Checks:
`npx tsc -p tsconfig.json`, `npx vitest run`, `bb plugin build`, then
`bb plugin reload comfy-cloud`.

The price tables in `contract.ts` hold Comfy's published figures for the ten
legacy ids; your own bills take over after the plugin has seen a shape twice.
