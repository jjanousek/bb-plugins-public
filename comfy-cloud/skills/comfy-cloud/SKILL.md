---
name: comfy-cloud
description: Generate images and videos on Comfy Cloud (103 models across 23 vendors, including Seedream, Seedance, Flux, Veo, Sora, Gemini, Kling, Wan, Ideogram and Recraft) with the comfy_* tools or the `bb comfy` CLI. Use whenever the user asks for an image, picture, illustration, thumbnail, cover, icon, logo draft, video clip, animation, or anything involving Comfy, ComfyUI, Seedream or Seedance, and to list, inspect, retry or tweak earlier generations.
---

# Comfy Cloud

The comfy-cloud plugin runs generation jobs on Comfy Cloud with the user's
API key, keeps every result on the bb server's disk next to the workflow
JSON that produced it, and shows everything in the Comfy panel.

## Tools and CLI

| Tool | CLI | What it does |
| --- | --- | --- |
| `comfy_generate_image({ prompt, size_preset?, aspect?, resolution?, width?, height?, count?, model?, reference_image?, seed?, extras?, wait? })` | `bb comfy image <prompt...> [--size <preset>] [--aspect <r>] [--resolution <tier>] [--width N] [--height N] [--count N] [--model <key>] [--reference <asset id or path>]... [--seed N] [--negative <text>] [--extra name=value,...] [--no-wait]` | Image, on any image model. Waits up to 6 minutes by default. |
| `comfy_generate_video({ prompt, resolution?, aspect_ratio?, duration?, model?, generate_audio?, reference_image?, seed?, extras?, wait? })` | `bb comfy video <prompt...> [--resolution <tier>] [--aspect <ratio>] [--duration N] [--model <key>] [--audio] [--reference <asset id or path>]... [--seed N] [--negative <text>] [--extra name=value,...] [--no-wait]` | Video, on any video model. Waits up to 10 minutes by default. |
| `comfy_models({ kind?, vendor?, query?, all? })` | `bb comfy models [words] [--kind image\|video] [--vendor X] [--all]` | Every model, what it can do and what it costs, cheapest first inside each vendor. |
| `comfy_run_workflow({ workflow_json, kind?, prompt?, parent_id?, wait? })` | `bb comfy run <file.json on the bb server> [--kind] [--prompt] [--parent <id>]` | Submit an edited or hand-written ComfyUI API workflow. |
| `comfy_assets({ kind?, status?, query?, limit? })` | `bb comfy list [--kind] [--status] [--starred] [--limit N] [--query text]` | Newest first, one compact line per asset. |
| `comfy_asset({ id, workflow? })` | `bb comfy show <id> [--workflow] [--job]` | Metadata, absolute file path, and the workflow JSON on request. |
| `comfy_status({})` | `bb comfy status` | Configured?, key source, credits left, default models, counts, asset directory. |
| `comfy_costs({ days? })` | `bb comfy costs [--days N]` | Credits left, spend today, this week and in total, the per model table, and the prices learned from this account's own bills. |
| | `bb comfy retry <id> [--new-seed] [--no-wait]`, `cancel <id>`, `star <id>`, `unstar <id>`, `delete <id>` | Housekeeping. |
| | `bb comfy sizes [--model <key>]` | Everything one model can be asked for: sizes, tiers, ratios, lengths and its own `--extra` options. |

Every CLI command accepts `--json`. A waiting command ends with the absolute
file path on its own line.

**A row that is "unknown" is not a failure.** It means the job was sent to
Comfy Cloud and the plugin lost sight of it: the connection dropped, the key
was refused, or the job ran past 20 minutes. The job may well finish and be
billed, so the plugin checks again every minute and fetches the result when
Comfy Cloud answers. Do not generate the same thing again, which could pay
twice. `bb comfy retry <id>` on a failed or unknown row asks Comfy Cloud first:
if the job finished it fetches that result instead of paying for a new one, and
if Comfy Cloud cannot be asked it sends nothing.

**A model's own options.** Size, ratio, length, sound, count and seed are the
same everywhere, but most models declare something of their own on top: a
quality tier, a mode, a style, a creativity number. Those are `extras`, one
string of `name=value` pairs separated by commas (`"quality=VERY_LOW"`), and
`bb comfy sizes --model <key>` lists what a model accepts and what each one
defaults to. They are worth reading before an expensive run, because on some
models an extra is the price: Ideogram P-Image is 0.91 credits at
`quality=VERY_LOW` and 3.02 at its default MEDIUM. An extra the model does not
declare is refused with the model's name, before anything is spent.

## Reference images

Some models can be given one or more pictures to work from, which is how you
say "like this one, but ...". Pass `reference_image` to the generate tools, or
repeat `--reference` on the CLI. Each one is either

- **an asset id of an earlier generation** (`img_ab12cd34`), which is the form
  worth reaching for: it turns "vary this one" into a single call, and
- **the path of an image file on the bb server's disk**
  (`~/pictures/logo.png`), for anything not generated here.

```
bb comfy image "the same street as a watercolour postcard" --reference img_ab12cd34
bb comfy image "the bird from the first reference on the fence from the second" --reference img_ab12cd34 --reference img_ef56gh78
```

The references fill the model's own slots in the order you give them, and the
prompt can talk about them as "the first reference image" and "the second".

- **Not every model takes one.** 19 image and 5 video models do, including
  Seedream 5.0 Pro and Lite, Seedream 4.5 and 4.0, FLUX.2 [pro] and [max],
  the four GPT Image models, Nano Banana 2, Luma UNI-1, Gemini Omni Flash and
  Wan 3.0. `bb comfy models` marks them "takes up to N reference images" and
  `bb comfy sizes --model <key>` says how many. A model that takes none refuses
  the request and names two that do, before anything is spent.
- **The first reference is included in the price.** Each one after it adds
  0.63 credits on Seedream 5.0 Pro.
- The upload itself is free and is content addressed, so using the same picture
  again costs nothing.

## Picking a model

Comfy Cloud offers 103 text-to-image and text-to-video models you can pick from,
53 image and 50 video, across 23 vendors. **Run `comfy_models` (or `bb comfy models`) before picking
an unfamiliar one**, because the table also carries the price and the price
spread is the whole point of the screen: images run from about 0.7 to 53
credits, and video from about 6 credits for a short 480p clip to over 3000 for
a long 4K one.

A model is named by its **key**, which is `<node class>/<model id>`, for
example `ByteDanceSeedreamNodeV3/seedream 5.0 pro` or
`Flux2ImageNode/Flux.2 [pro]`. A few nodes run one model and their key is just
the node class (`IdeogramPImage`). The legacy bare ids work too:
`seedream 5.0 pro`, `seedream 5.0 lite`, `seedream-4-5-251128`,
`seedream-4-0-250828`, `seedance-1-0-pro-fast-251015`,
`seedance-1-5-pro-251215`, `seedance-1-0-pro-250528`, `Seedance 2.0 Fast`,
`Seedance 2.0` and `Seedance 2.5`. A bare model id that only one node offers
resolves on its own, and an id that does not resolve comes back with the three
closest matches.

How to choose:

- **Default to what is already set** unless the user asks for something else.
  `comfy_status` names both defaults.
- **Read the capability line.** It says what the model can be asked for:
  "1K to 4K, up to 10 at once" or "480p to 1080p, 6 ratios, 3 to 12 s, audio".
  Asking for anything outside it comes back as an error naming what is legal,
  not as a failed generation.
- **Read the price line, always, for video.** A video model that costs 42
  credits a second is 336 credits for one 8 second clip.
- **Confirm before spending more than about 100 credits.** One sentence to the
  user is enough. `comfy_costs` says how many are left.
- Some models cost more at a higher tier or with audio; the estimate in the
  tool result already accounts for the request you made.
- Cheap models worth knowing: `LumaImageNode/photon-flash-1` (about 0.6 credits),
  `IdeogramPImage` (0.91 at VERY_LOW, 3.02 at the default MEDIUM),
  `GrokImageNode/grok-imagine-image` (4.22),
  `ByteDanceSeedreamNodeV3/seedream 5.0 flash` (5.43) for images, and
  `ByteDanceTextToVideoNode/seedance-1-0-pro-fast-251015` (about 2 credits a
  second at 480p) for video.
- `bb comfy models --all` lists the entries that cannot be offered and says
  why: almost all of them need a first and last frame, an input video, or a
  style the plugin has no control for. A model that merely *accepts* a
  reference is offered normally; only one that cannot run without media is out.

## Defaults

- Image: model `seedream 5.0 pro`, size `(1K) 1024x1024 (1:1)`, random seed.
  A 1K image usually finishes in under a minute. Other presets: `bb comfy sizes`. Every
  other model starts at its own first preset, tier and ratio; `comfy_models`
  reports them under `defaults`.
- Video: model `seedance-1-0-pro-fast-251015`, 480p, 16:9, 5 seconds, no
  audio. A short 480p clip usually finishes in a minute or two. Seedance 2.x models
  (`Seedance 2.0 Fast`, `Seedance 2.0`, `Seedance 2.5`) are slower.
  The models that can generate audio (`generate_audio: true`) are exactly
  `seedance-1-5-pro-251215` (Seedance 1.5 Pro), `Seedance 2.0 Fast`,
  `Seedance 2.0` and `Seedance 2.5`. The other 1.x models ignore the flag.
- Every tool result names the asset id (`img_...` or `vid_...`) and the
  absolute file path on the bb server. Open the file with your file reading
  tool when you need to look at it.

## What it costs

Comfy Cloud bills in credits. **211 credits are one US dollar.** Every tool
result and every `bb comfy show` prints what a generation was expected to cost
and what it was actually billed, so check before an expensive run.

The tables below cover the ten legacy Seedream and Seedance ids, priced from
Comfy's published figures. Every other model carries its vendor's published
price in the registry, and `comfy_models` prints it. Where nothing is
published, the estimate says the cost is unknown and the plugin learns it from
this account's own bills.

Images, credits each. Aspect ratio never changes the price; only pixel count
does, and only on 5.0 Pro:

| model | credits | USD |
| --- | --- | --- |
| `seedream 5.0 pro` up to 2.61 MP (every 1K preset) | 9.50 | $0.045 |
| `seedream 5.0 pro` above that (every 2K preset) | 18.99 | $0.09 |
| `seedream 5.0 lite`, any size up to 4K | 7.39 | $0.035 |
| `seedream-4-5-251128`, any size | 8.44 | $0.04 |
| `seedream-4-0-250828`, any size | 6.33 | $0.03 |

Video is billed per million tokens, so it is linear in length and scales with
pixels. **The models differ by two orders of magnitude, so read this before
picking one:**

| model | credits per second at 480p | at 1080p |
| --- | --- | --- |
| `seedance-1-0-pro-fast-251015` | 2.05 | 10.25 |
| `seedance-1-5-pro-251215` (doubled with audio) | 2.46 | 12.31 |
| `seedance-1-0-pro-250528` | 5.13 | 25.64 |
| `Seedance 2.0 Fast` (480p and 720p only) | 16.42 | not offered |
| `Seedance 2.0` | 20.53 | 112.91 |
| `Seedance 2.5` | 31.38 | 171.57 |

A 5 second 480p `seedance-1-0-pro-fast` clip is about 10.3 credits ($0.05). A 5
second 1080p `Seedance 2.5` clip is about 865 credits ($4.10), which is 90
images. Ask before spending that; `bb comfy costs` says how many credits are
left. `bb comfy models` prints the price note for each model.

## Prompt tips

- Seedream (images) likes concrete nouns, the lighting, and the style:
  "a stone harbour at dusk, wide shot, oil painting". Name anything that
  must stay out of the picture, such as lettering. For a flat logo ask for
  "two flat colours, simple shapes, plain background, no shading".
- Seedance (videos) likes one subject, one camera move, and an explicit
  duration: "a windmill turning slowly on a hill at dawn, slow push-in,
  5 seconds". Keep it to one action.
- Use the same seed to keep a composition while changing the prompt; drop
  the seed (or `--new-seed` on retry) to explore variations.

## Where the files live

Asset directory: shown by `bb comfy status` (default
`~/.bb/plugins/comfy-cloud/assets`). Layout per asset, in a date folder:

- `<YYYY-MM-DD>/<id>.png|jpg|webp|mp4|webm` the media
- `<YYYY-MM-DD>/<id>.workflow.json` the exact graph that was submitted
- `<YYYY-MM-DD>/<id>.job.json` the sanitized Comfy job record

## Regenerate with tweaks

1. `comfy_asset({ id, workflow: true })` (or `bb comfy show <id> --workflow`)
   to get the graph.
2. Edit inputs in the JSON: the prompt, `seed`, `duration`, `resolution`, and
   for images `model.size_preset` only. Leave `model.width` and `model.height`
   at 1024 or more. The preset decides the output size, but Comfy Cloud still
   validates those two numbers (minimum 1024, even steps), so copying a
   preset's own pixel size such as 736 into them fails. The plugin clamps them
   for you on submit; the safe hand edit is to not touch them.
3. `comfy_run_workflow({ workflow_json, parent_id: id })` so the new asset
   is linked to the original in the browser. `bb comfy retry <id> --new-seed`
   is the shortcut for "same graph, new seed".

## Rules

- Never print, copy, or ask for the Comfy Cloud API key. The plugin reads it
  server side; `comfy_status` only reports which source it came from. If the
  plugin says it is not configured, tell the user which options exist
  (the `apiKey` setting, a `.env` in the plugin folder, or the `keyFile`
  setting) and stop.
- Do not poll in a loop yourself: the generate tools wait for the result.
  Use `wait: false` only when the user wants to continue with other work,
  then check back with `comfy_asset`.
- Comfy Cloud has no cancel endpoint. `bb comfy cancel` stops tracking a
  job locally; the remote job may still finish and be billed.
- Video costs real money. Anything above a few seconds at 480p on the
  `pro-fast` model, and anything at all on `Seedance 2.0` or `2.5`, is worth
  one sentence of confirmation from the user first. The same rule holds for
  every other vendor: **confirm before spending more than about 100 credits.**
- One model, Gemini's `Omni Flash 1.1`, takes its clip length from the prompt
  rather than a control, and is billed per second. The estimate says the cost
  is unknown for it on purpose. Say a length in the prompt and expect the
  default of 10 seconds otherwise, which is about 300 credits at 720p.
