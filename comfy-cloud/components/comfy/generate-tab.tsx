// Generate tab: the form, in the darkroom idiom. The prompt is the hero (a
// hairline card holding a borderless auto-growing textarea); under it a model
// row that opens the picker, then the controls that model actually has, and
// the one loud control is the full width button at the bottom with the time
// and the price inside it.
//
// Nothing here knows a model by name. The `models` RPC returns one summary per
// entry in the registry; `formModel` turns the chosen summary plus the current
// wishes into the option lists this file renders, so a model with no length
// control simply draws no Length row and a combination its vendor refuses is
// greyed out rather than sent. Changing the model keeps the prompt and every
// setting the new model also has.
//
// No host Select or Checkbox: both draw glyphs from the host icon set, and this
// plugin owns every glyph on its own surfaces.
import { useEffect, useMemo, useRef, useState } from "react";
import { UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { costNote, estimateCredits } from "../../contract";
import type { Asset, AssetKind, ModelSummary } from "../../contract";
import { costHint, estimateCreditsText, usdText } from "./cost";
import { estimateLabel, estimateSeconds, firstLine, mediaUrl, modelLabel } from "./format";
import { Glyph } from "./glyphs";
import { Card, Disclosure, GhostButton, PrimaryButton, Segmented, Chip, ChipGroup } from "./kit";
import { LengthControls, MoreOptions, Row, SizeControls, SoundControls, extraCount } from "./model-controls";
import { batchesInOneRun, carryOver, draftOf, durationOf, formModel, generateFields, pixelsOf, qualityOf, valuesFromParams } from "./model-form";
import type { FormValues } from "./model-form";
import {
  MAX_SEED,
  attachReference,
  formSession,
  randomSeedValue,
  referenceLimit,
  referenceModel,
  droppedReferenceCount,
  referencesFromParams,
  removeReference,
  saveSession,
  sentReferences,
  showsReferences,
} from "./form-session";
import type { KindState } from "./form-session";
import { findModel } from "./model-list";
import { ModelPicker, ModelRow } from "./model-picker";
import { COMFY_PANEL_PATH, SETTINGS_HREF, assetSubPath } from "./tabs";
import {
  errorText,
  useAssetDetail,
  useComfyRpc,
  useFinger,
  useModelPrefs,
  useModels,
  useOpenJobsTab,
  usePreviewBase,
  useReferenceRequest,
  useStatus,
  useTweakRequest,
} from "./use-comfy";
import type { PreviewBase, TweakRequest } from "./use-comfy";

const KIND_OPTIONS = [
  { id: "image", label: "Image", glyph: "image" },
  { id: "video", label: "Video", glyph: "video" },
] as const;

const SEED_OPTIONS = [
  { id: "random", label: "Random" },
  { id: "fixed", label: "Fixed" },
] as const;

/** The last tweak this tab applied, kept across mounts so a reopened tab does not replay an old one. */
let lastAppliedTweak = 0;
/** The same, for "Use as reference". */
let lastAppliedReference = 0;

export function GenerateTab() {
  const rpc = useComfyRpc();
  const navigate = useBbNavigate();
  const status = useStatus();
  const tweak = useTweakRequest();
  const referenceRequest = useReferenceRequest();
  const finger = useFinger();

  // Everything the form holds starts from the session, not from a blank slate.
  const start = formSession();
  const [kind, setKind] = useState<AssetKind>(start.kind);
  const [prompt, setPrompt] = useState(start.prompt);
  const [image, setImage] = useState<KindState>(start.image);
  const [video, setVideo] = useState<KindState>(start.video);
  const [randomSeed, setRandomSeed] = useState(start.randomSeed);
  const [seedText, setSeedText] = useState(start.seedText);
  const [parentId, setParentId] = useState<string | null>(start.parentId);
  const [references, setReferences] = useState<string[]>(start.references);
  /** One muted line when a reference made the tab change model, or could not be added. */
  const [referenceNote, setReferenceNote] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [promptTouched, setPromptTouched] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const modelRowRef = useRef<HTMLButtonElement | null>(null);
  const openJobs = useOpenJobsTab();
  const preview = usePreviewBase();
  const models = useModels(kind);
  const prefs = useModelPrefs();
  const parent = useAssetDetail(parentId);
  const parentAsset = parent.data?.asset ?? null;
  const parentThumb = parentAsset !== null ? mediaUrl(preview.data, parentAsset, "thumb") : null;

  const state = kind === "image" ? image : video;
  const setState = kind === "image" ? setImage : setVideo;
  // Written on every render rather than in an effect, so a switch to Jobs that
  // unmounts this tab mid-keystroke still keeps what was typed.
  saveSession({ ...formSession(), kind, prompt, image, video, randomSeed, seedText, parentId, references });
  // What this account has already been billed, keyed the way `estimateCredits`
  // keys it. The server prices the row it stores from the same samples, so
  // without this the button and the row it creates quote different numbers.
  const observed = useMemo(() => {
    const seen = new Map((models.data?.observed ?? []).map((row) => [row.signature, { credits: row.credits, samples: row.samples }]));
    return (signature: string) => seen.get(signature) ?? null;
  }, [models.data]);
  const rows = useMemo(() => models.data?.models ?? [], [models.data]);
  const summary = useMemo(() => findModel(rows, state.key), [rows, state.key]);
  const shape = useMemo(() => (summary === null ? null : formModel(summary, state.values)), [summary, state.values]);
  // References belong to images: the server refuses a video as a reference, and
  // only the image form draws the row.
  const referenceCap = kind === "image" ? referenceLimit(summary) : 0;
  const sending = kind === "image" ? sentReferences(references, summary) : [];

  // The key the form starts on is a legacy id or a default from the settings;
  // the registry is what turns it into an entry. Until that has happened the
  // form is still holding a wish, so this runs once per kind and again only
  // when the chosen model changes.
  useEffect(() => {
    const data = models.data;
    if (data === null) return;
    // A page reload starts a fresh session, so the model the user last chose
    // comes back off the server before the registry settles anything. Waiting
    // costs one tick and stops the tab resolving the shipped default and then
    // visibly jumping to the stored one.
    if (!prefs.loaded) return;
    const apply = kind === "image" ? setImage : setVideo;
    const stored = formSession().restored ? null : (prefs.chosen?.[kind] ?? null);
    apply((previous) => {
      const wanted =
        (stored === null ? null : findModel(data.models, stored)) ??
        findModel(data.models, previous.key) ??
        findModel(data.models, kind === "image" ? data.defaults.image : data.defaults.video) ??
        data.models[0] ??
        null;
      if (wanted === null) return previous;
      if (previous.ready && previous.key === wanted.key) return previous;
      return { key: wanted.key, values: carryOver(previous.values, wanted), ready: true };
    });
  }, [models.data, kind, prefs.loaded, prefs.chosen]);

  // A tweak from the viewer (or the example prompt) replaces the whole form.
  useEffect(() => {
    const request = tweak.request;
    if (request === null || tweak.sequence <= lastAppliedTweak) return;
    lastAppliedTweak = tweak.sequence;
    applyTweak(request);
    setPromptTouched(request.prompt.trim() !== "");
    setTimeout(focusPrompt, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tweak]);

  // "Use as reference" from the viewer adds to the form rather than replacing
  // it: the prompt somebody was writing stays. It waits for the model list,
  // because whether the current model can take a reference is the registry's
  // answer, and switching to one that can is part of honouring the request.
  useEffect(() => {
    const request = referenceRequest;
    const incoming = request.asset;
    if (incoming === null || request.sequence <= lastAppliedReference) return;
    if (kind !== "image") {
      setKind("image");
      return;
    }
    const data = models.data;
    if (data === null || !image.ready) return;
    lastAppliedReference = request.sequence;
    applyReference(incoming, data.models);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceRequest, kind, models.data, image.ready]);

  // The tab mounts when it is brought forward (header button, palette action or
  // Tweak), so this is where the caret belongs.
  const focusPrompt = () => {
    const element = promptRef.current;
    if (element === null) return;
    element.focus();
    const end = element.value.length;
    element.setSelectionRange(end, end);
  };
  useEffect(() => {
    const timer = setTimeout(focusPrompt, 0);
    return () => clearTimeout(timer);
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The prompt box grows with its text.
  useEffect(() => {
    const element = promptRef.current;
    if (element === null || pickerOpen) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(320, Math.max(96, element.scrollHeight))}px`;
  }, [prompt, kind, pickerOpen]);

  function applyReference(incoming: Asset, available: readonly ModelSummary[]): void {
    const current = findModel(available, image.key);
    let target = current;
    let note: string | null = null;
    if (!showsReferences(current)) {
      const able = referenceModel(available);
      if (able === null) {
        setReferenceNote("None of the image models on offer takes a reference image.");
        return;
      }
      target = able;
      setImage((previous) => ({ key: able.key, values: carryOver(previous.values, able), ready: true }));
      prefs.setChosen("image", able.key);
      note = `${current?.label ?? "That model"} takes no reference images, so this switched to ${able.label}.`;
    }
    const limit = referenceLimit(target);
    if (references.includes(incoming.id)) {
      setReferenceNote(note ?? `${incoming.id} is already attached.`);
      return;
    }
    if (references.length >= limit) {
      setReferenceNote(`${target?.label ?? "This model"} takes at most ${limit}. Remove one to add ${incoming.id}.`);
      return;
    }
    setReferences((previous) => attachReference(previous, incoming.id, limit));
    setReferenceNote(note);
  }

  function applyTweak(request: TweakRequest): void {
    setKind(request.kind);
    setPrompt(request.prompt);
    setParentId(request.parentId);
    // A tweak of a row that worked from references works from them again.
    setReferences(referencesFromParams(request.params));
    const dropped = droppedReferenceCount(request.params);
    setReferenceNote(
      dropped === 0 ? null : `${dropped === 1 ? "One reference was a file" : `${dropped} references were files`} on disk, not in the Library, so ${dropped === 1 ? "it is" : "they are"} not attached here.`,
    );
    const seed = request.params.seed;
    if (typeof seed === "number" && Number.isInteger(seed)) {
      setSeedText(String(seed));
      setRandomSeed(false);
    } else {
      setRandomSeed(true);
    }
    const wish = { key: request.model, values: valuesFromParams(request.params), ready: false };
    if (request.kind === "image") setImage(wish);
    else setVideo(wish);
  }

  // Both kinds have had the stored choice offered to them once the tab has
  // settled a model, so a later switch to Video does not re-apply an old key
  // over one the user has since picked.
  useEffect(() => {
    if (image.ready && video.ready) formSession().restored = true;
  }, [image.ready, video.ready]);

  const chooseModel = (chosen: ModelSummary) => {
    setState((previous) => ({ key: chosen.key, values: carryOver(previous.values, chosen), ready: true }));
    prefs.setChosen(chosen.kind, chosen.key);
    setPickerOpen(false);
    // The trigger is where the eye is, so that is where the focus goes back to.
    setTimeout(() => modelRowRef.current?.focus(), 0);
  };

  const closePicker = () => {
    setPickerOpen(false);
    setTimeout(() => modelRowRef.current?.focus(), 0);
  };

  const patch = (next: Partial<FormValues>) => {
    setState((previous) => ({ ...previous, values: { ...previous.values, ...next } }));
  };

  const values = shape?.values ?? state.values;
  const batched = summary !== null && batchesInOneRun(summary);
  const count = values.count;
  const unconfigured = status.data !== null && !status.data.configured;
  const emptyPrompt = prompt.trim() === "";
  const seedNumber = Number(seedText);
  const hasSeed = summary === null || summary.capabilities.seed;
  const badSeed = hasSeed && !randomSeed && (seedText.trim() === "" || !Number.isInteger(seedNumber) || seedNumber < 0 || seedNumber > MAX_SEED);
  const sizeProblem = shape?.dimensionError ?? null;
  const reason = unconfigured
    ? "Add an API key first"
    : emptyPrompt
      ? "Write a prompt first"
      : badSeed
        ? `Seed must be a whole number from 0 to ${MAX_SEED}`
        : sizeProblem;
  const canSubmit = !submitting && reason === null && summary !== null;
  // An untouched empty prompt needs no telling off; the disabled button says it.
  const showReason = reason !== null && !(emptyPrompt && !promptTouched);

  // The price tables are keyed by the model id Comfy bills under, so the
  // estimate asks by id and hands the registry price over for everything the
  // two legacy tables do not cover.
  const priceModel = summary?.modelId ?? summary?.key ?? state.key;
  const pixels = summary === null ? null : pixelsOf(summary, values);
  const estimateParams = {
    sizePreset: values.sizePreset,
    resolution: values.resolution,
    // Kling spells the length inside its `mode` extra and charges double for
    // the 10 s option, so the length comes from the form, not from the role.
    // A model with no length control at all (Gemini Omni Flash: the prompt sets
    // it) still returns a documented default, and on a per second price that
    // number is the whole bill, so the button quotes it rather than the generic
    // five second fallback buried in `priceCredits`.
    duration: summary === null ? values.duration : (durationOf(values, summary) ?? summary.capabilities.promptDurationDefault ?? null),
    generateAudio: values.audio,
    width: pixels?.width ?? null,
    height: pixels?.height ?? null,
    quality: summary === null ? null : qualityOf(values, summary),
    draft: summary === null ? null : draftOf(values, summary),
    // A reference is billed, and a price that says nothing about references
    // refuses to quote rather than quoting low (contract.ts, priceCredits).
    references: sending.length,
  };
  const estimate = estimateSeconds(kind, priceModel, { ...estimateParams, count });
  // A model that batches charges once for the whole run; one that does not is
  // submitted that many times, so the estimate multiplies whole runs.
  const single = estimateCredits(kind, priceModel, { ...estimateParams, count: batched ? count : 1 }, observed, summary?.price ?? null);
  const credits =
    batched || count === 1 || single.credits === null
      ? single
      : { credits: Number((single.credits * count).toFixed(2)), confidence: single.confidence };
  const creditRate = status.data?.creditRate ?? null;
  const timeHint = estimateLabel(estimate);
  // With a reference attached and no reference price anywhere, the honest
  // answer is that nobody knows; "cost unknown" alone would read as a fault.
  const costWords = estimateCreditsText(credits) ?? (sending.length > 0 ? "price unknown with a reference" : "cost unknown");
  const costUsd = credits.credits === null ? null : usdText(credits.credits, creditRate);
  // The meta gives way in the plugin's usual order rather than squeezing the
  // label: in a 290 px panel the price survives on its own, the time comes
  // back at 22rem and the dollars at 26rem. The title always has all three.
  const buttonMeta = (
    <span>
      <span className="hidden @[22rem]:inline">{`${timeHint} · `}</span>
      {costWords}
      {costUsd === null ? null : <span className="hidden @[26rem]:inline">{` ${costUsd}`}</span>}
    </span>
  );
  const buttonTitle = `${timeHint} · ${costHint(credits, creditRate)}${summary === null ? "" : `\n${costNote(kind, priceModel, summary.price) ?? ""}`}`;
  // Only the combinations the controls do not already show. A single fixed seed
  // is printed in the seed field, so repeating it here says nothing.
  const seedHint = count === 1 || batched ? null : randomSeed ? `${count} random seeds.` : `Seeds ${seedNumber} to ${seedNumber + count - 1}.`;
  const countMax = shape?.countMax ?? 1;

  const submit = async () => {
    if (!canSubmit || summary === null || shape === null) return;
    const text = prompt.trim();
    setSubmitting(true);
    try {
      const fields = generateFields(summary, shape);
      const runs = batched ? 1 : count;
      const seeds: (number | undefined)[] = !hasSeed
        ? Array.from({ length: runs }, () => undefined)
        : randomSeed
          ? Array.from({ length: runs }, () => undefined)
          : Array.from({ length: runs }, (_, index) => (seedNumber + index) % (MAX_SEED + 1));
      const results = await Promise.all(
        seeds.map((seed) => {
          const shared = {
            prompt: text,
            model: summary.key,
            ...fields,
            ...(seed === undefined ? {} : { seed }),
            ...(parentId === null ? {} : { parentId }),
            ...(sending.length === 0 ? {} : { references: sending }),
            source: "panel" as const,
          };
          if (kind === "image") {
            const { generateAudio: _audio, ...image } = shared;
            return rpc.call("generate_image", image);
          }
          return rpc.call("generate_video", shared);
        }),
      );
      const first = results[0]?.asset;
      if (results.length === 1 && first !== undefined) {
        toast.success(`Queued ${kind} ${first.id}`);
        navigate.toPluginPanel(COMFY_PANEL_PATH, { subPath: assetSubPath(first.id), replace: true });
      } else {
        toast.success(`Queued ${results.length} ${kind === "image" ? "images" : "videos"}`);
      }
      status.refetch();
      // The server pushes the model that just ran onto the recent list.
      prefs.refetch();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const outputs = count;
  const buttonLabel = submitting
    ? "Queuing"
    : outputs === 1
      ? kind === "image"
        ? "Generate image"
        : "Generate video"
      : `Generate ${outputs} ${kind === "image" ? "images" : "videos"}`;

  if (pickerOpen) {
    return (
      <ModelPicker
        kind={kind}
        models={rows}
        current={state.key}
        favourites={prefs.favourites}
        recent={prefs.recent}
        loading={models.loading && rows.length === 0}
        onChoose={chooseModel}
        onClose={closePicker}
        onToggleFavourite={prefs.toggleFavourite}
      />
    );
  }

  // A flex column rather than space-y: the button bar below has to be a direct
  // child of this full height block, because `sticky` is bounded by its parent.
  return (
    <div className="flex flex-col gap-4">
      {parentId === null ? null : (
        <Card padded={false} className="flex items-center gap-2 p-2">
          <button
            type="button"
            aria-label={`Open ${parentId}`}
            title={`Open ${parentId}`}
            onClick={() => navigate.toPluginPanel(COMFY_PANEL_PATH, { subPath: assetSubPath(parentId), replace: true })}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/40 ring-1 ring-border/60">
              {parentThumb === null ? (
                <Glyph.image className="size-3.5 text-muted-foreground" />
              ) : parentAsset?.kind === "video" ? (
                <video src={parentThumb} muted playsInline preload="metadata" className="size-full object-cover" aria-hidden />
              ) : (
                <img src={parentThumb} alt="" className="size-full object-cover" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                {/* FieldLabel renders a <p>, which cannot sit inside this button, so the label line is spelled out here. */}
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Based on</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">{parentId}</span>
              </span>
              <span className="block truncate text-[12px] leading-5 text-foreground">
                {parentAsset === null ? "Loading" : firstLine(parentAsset.prompt, 80)}
              </span>
            </span>
          </button>
          <GhostButton className="shrink-0" onClick={() => setParentId(null)} title="Forget this parent">
            Clear
          </GhostButton>
        </Card>
      )}

      {unconfigured ? (
        <Card padded={false} className="flex items-start gap-2 border-destructive/30 p-2.5">
          <Glyph.alert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <p className="min-w-0 break-words text-[12px] leading-5 text-foreground [overflow-wrap:anywhere]">
            {status.data?.configureHint ?? "No Comfy Cloud API key is configured."}{" "}
            <UrlLink href={SETTINGS_HREF} className="underline underline-offset-2">
              Open settings
            </UrlLink>
          </p>
        </Card>
      ) : null}

      {/* The kind switch and the prompt are one block; the controls under them are another. */}
      <div className="space-y-2">
        <Segmented
          ariaLabel="What to generate"
          options={KIND_OPTIONS}
          value={kind}
          onSelect={(id) => setKind(id === "video" ? "video" : "image")}
        />

        {/* The prompt is the hero: the card is the field, the textarea has no chrome of its own. */}
        <Card padded={false} className="px-3 py-2.5 focus-within:border-foreground/25">
          <label htmlFor="comfy-prompt" className="sr-only">
            Prompt
          </label>
          <textarea
            id="comfy-prompt"
            ref={promptRef}
            rows={4}
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              setPromptTouched(true);
            }}
            placeholder={
              kind === "image"
                ? "For example: a brass compass on a folded map, overhead photo"
                : "For example: a windmill turning slowly on a hill, one slow pan, dawn light"
            }
            className="block min-h-[96px] w-full resize-none border-0 bg-transparent p-0 text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/60 max-md:pointer-coarse:text-base"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </Card>
      </div>

      <div className="space-y-3">
        <Row label="Model">
          <ModelRow
            model={summary}
            fallback={modelLabel(state.key)}
            loading={models.loading}
            buttonRef={modelRowRef}
            onOpen={() => setPickerOpen(true)}
          />
        </Row>

        {kind === "image" && (referenceCap > 0 || referenceNote !== null) ? (
          <ReferencesRow
            ids={references}
            limit={referenceCap}
            preview={preview.data}
            note={referenceNote}
            finger={finger}
            onRemove={(id) => {
              setReferences((previous) => removeReference(previous, id));
              setReferenceNote(null);
            }}
          />
        ) : null}

        {summary === null || shape === null ? null : (
          <>
            <SizeControls summary={summary} shape={shape} set={patch} />
            <LengthControls summary={summary} shape={shape} set={patch} />
            <SoundControls shape={shape} set={patch} />

            {hasSeed ? (
              <Row label="Seed">
                {/* Wraps rather than clips when the host panel gets very narrow. */}
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
                    ariaLabel="Seed"
                    options={SEED_OPTIONS}
                    value={randomSeed ? "random" : "fixed"}
                    onSelect={(id) => setRandomSeed(id === "random")}
                  />
                  {randomSeed ? null : (
                    <>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={seedText}
                        aria-label="Seed"
                        aria-invalid={badSeed}
                        onChange={(event) => setSeedText(event.target.value)}
                        className={cn(
                          "h-7 w-24 min-w-0 rounded-md border bg-transparent px-2 text-[12px] tabular-nums text-foreground max-md:pointer-coarse:h-10 max-md:pointer-coarse:text-base",
                          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                          badSeed ? "border-destructive/50" : "border-border/60",
                        )}
                      />
                      <GhostButton iconOnly ariaLabel="New random seed" title="New random seed" onClick={() => setSeedText(String(randomSeedValue()))}>
                        <Glyph.dice className="size-3.5 max-md:pointer-coarse:size-5" />
                      </GhostButton>
                    </>
                  )}
                </div>
              </Row>
            ) : null}

            {countMax <= 1 ? null : (
              <Row label="Count" note={seedHint}>
                <ChipGroup ariaLabel="How many variants">
                  {shape.counts.map((option) => (
                    <Chip
                      key={option}
                      active={option === count}
                      onClick={() => patch({ count: option })}
                      ariaLabel={option === 1 ? "One variant" : `${option} variants`}
                    >
                      {option}
                    </Chip>
                  ))}
                </ChipGroup>
              </Row>
            )}

            {extraCount(summary) === 0 ? null : (
              <Disclosure label="More options" meta={extraCount(summary) === 1 ? "1 setting" : `${extraCount(summary)} settings`}>
                <MoreOptions summary={summary} shape={shape} set={patch} />
              </Disclosure>
            )}
          </>
        )}
      </div>

      {/* On a phone the button sticks to the bottom of the drawer, over a
          hairline, with the safe area under it, so it is always one thumb away
          while the controls scroll. It bleeds through the host's own padding
          (16 px at the sides, 12 px under) to reach the drawer's edges. The
          reason it cannot submit rides with it; the caption scrolls. The bar is a
          direct child of the form: sticky only travels inside its parent. */}
      <div
        data-generate-bar
        className={cn(
          "@container space-y-1.5 pt-1",
          "max-md:sticky max-md:-bottom-3 max-md:z-10 max-md:-mx-4 max-md:border-t max-md:border-border/60 max-md:bg-background max-md:px-4 max-md:pt-3 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        )}
      >
        <PrimaryButton block glyph="spark" busy={submitting} disabled={!canSubmit} meta={buttonMeta} title={buttonTitle} onClick={() => void submit()}>
          {buttonLabel}
        </PrimaryButton>
        {showReason ? <p className="text-[11px] leading-4 text-foreground">{reason}</p> : null}
      </div>
      {/* 6 px under the button on a wide screen. On a phone the bar sticks over
          it while the form scrolls and lets it show at the very end. */}
      <p className="-mt-2.5 text-[11px] leading-4 text-muted-foreground max-md:-mt-1">
          <span className="max-md:pointer-coarse:hidden">Cmd+Enter or Ctrl+Enter submits. </span>New tiles show up at the top of the Library, and{" "}
          <button
            type="button"
            className="cursor-pointer underline underline-offset-2 hover:text-foreground max-md:pointer-coarse:-mx-3 max-md:pointer-coarse:-my-3.5 max-md:pointer-coarse:px-3 max-md:pointer-coarse:py-3.5"
            onClick={() => {
              if (!openJobs()) navigate.toPluginPanel(COMFY_PANEL_PATH, { subPath: "", replace: true });
            }}
          >
            Jobs
          </button>{" "}
          shows what is waiting, running or failed.
      </p>
    </div>
  );
}

/**
 * The pictures a generation works from, as thumbs with a remove glyph each.
 * Only drawn for a model that takes references; the ids stay in the session
 * while another model is chosen and come back with one that can take them.
 * An empty row says how to fill it, because the way in is on another surface.
 */
function ReferencesRow({
  ids,
  limit,
  preview,
  note,
  finger,
  onRemove,
}: {
  ids: readonly string[];
  limit: number;
  preview: PreviewBase | null;
  note: string | null;
  finger: boolean;
  onRemove: (id: string) => void;
}) {
  const shown = limit > 0 ? ids.slice(0, limit) : [];
  const over = limit > 0 ? ids.length - shown.length : 0;
  const hint = limit > 0 ? `${shown.length} of ${limit}` : undefined;
  return (
    <Row label="References" hint={hint} note={note}>
      {limit === 0 ? null : shown.length === 0 ? (
        <p className="text-[11px] leading-4 text-muted-foreground">Open a picture in the Library and choose Use as reference to work from it.</p>
      ) : (
        <ul className="flex flex-wrap gap-2 pr-3 pt-1" aria-label="Reference images">
          {shown.map((id) => (
            <ReferenceThumb key={id} id={id} preview={preview} finger={finger} onRemove={onRemove} />
          ))}
        </ul>
      )}
      {over > 0 ? (
        <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
          {over === 1 ? "One more is attached" : `${over} more are attached`}, but this model takes {limit}, so {over === 1 ? "it stays" : "they stay"} out of the request.
        </p>
      ) : null}
    </Row>
  );
}

function ReferenceThumb({ id, preview, finger, onRemove }: { id: string; preview: PreviewBase | null; finger: boolean; onRemove: (id: string) => void }) {
  const detail = useAssetDetail(id);
  const asset = detail.data?.asset ?? null;
  const url = asset === null || asset.file === null ? null : mediaUrl(preview, asset, "thumb");
  const label = asset === null ? id : firstLine(asset.prompt, 60) || id;
  // 56 px with a 24 px remove target on a mouse; 64 px with a 44 px target on a
  // finger, which hangs off the thumb's corner rather than covering half of it.
  return (
    <li className={cn("relative shrink-0", finger ? "size-16" : "size-14")} title={`${id}: ${label}`}>
      <span className="flex size-full items-center justify-center overflow-hidden rounded-md bg-muted ring-1 ring-border/60">
        {url === null ? <Glyph.image className="size-4 text-muted-foreground" /> : <img src={url} alt={label} decoding="async" className="size-full object-cover" />}
      </span>
      <button
        type="button"
        aria-label={`Remove reference ${id}`}
        onClick={() => onRemove(id)}
        className={cn(
          "absolute flex cursor-pointer items-center justify-center rounded-md text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          finger ? "-right-3 -top-3 size-11" : "-right-1.5 -top-1.5 size-6",
        )}
      >
        <span className="flex size-5 items-center justify-center rounded-md bg-background ring-1 ring-border">
          <Glyph.close className="size-3" />
        </span>
      </button>
    </li>
  );
}
