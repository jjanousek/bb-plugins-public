// The controls under the model row, drawn from the chosen model's own schema.
//
// One mechanism, no bespoke code per vendor: `formModel` in model-form.ts turns
// a model summary plus the current wishes into option lists, and everything
// here is a rendering of that. A model with no size control draws no Size row;
// a model whose vendor refuses 1080p at 5 seconds draws that chip greyed out
// with the vendor's own sentence in its title. Anything the registry could not
// give a role to lands in "More options" and is rendered by type.
import type { ReactNode } from "react";
import { Fragment, useId } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ModelExtra, ModelSummary } from "../../contract";
import { CheckBox, Chip, ChipGroup, FieldLabel, Select } from "./kit";
import { extraLabel, extraOptionLabel, extraValue, presetAspect, presetForTier, sizeHint, tierOf, visibleExtras } from "./model-form";
import type { ExtraValue, FormShape, FormValues, Option } from "./model-form";

/** Above this many options a list of chips becomes a wall, so it becomes a select. */
const CHIP_LIMIT = 10;

export type Patch = (patch: Partial<FormValues>) => void;

/** One labelled row: the 10 px line, the controls, then an optional muted note. */
export function Row({ label, hint, htmlFor, note, children }: { label: string; hint?: ReactNode; htmlFor?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <FieldLabel hint={hint} htmlFor={htmlFor}>
        {label}
      </FieldLabel>
      {children}
      {note === undefined || note === null ? null : <p className="text-[11px] leading-4 text-muted-foreground">{note}</p>}
    </div>
  );
}

function chips(options: readonly Option[], value: string | null, ariaLabel: string, onSelect: (value: string) => void) {
  return (
    <ChipGroup ariaLabel={ariaLabel}>
      {options.map((option) => (
        <Chip key={option.value} active={option.value === value} disabled={option.disabled} title={option.reason ?? undefined} onClick={() => onSelect(option.value)}>
          {option.label}
        </Chip>
      ))}
    </ChipGroup>
  );
}

function selectOptions(options: readonly Option[]) {
  return options.map((option) => ({ value: option.value, label: option.label, disabled: option.disabled, title: option.reason ?? undefined }));
}

export interface ControlProps {
  summary: ModelSummary;
  shape: FormShape;
  set: Patch;
}

/**
 * Size, in whichever of the four shapes the model speaks: tier and aspect chips
 * over a tagged preset list, a plain preset list, resolution and aspect chips,
 * or free width and height. A model with none of those draws nothing.
 */
export function SizeControls({ summary, shape, set }: ControlProps) {
  const values = shape.values;
  const hint = sizeHint(summary, values);
  const ignoredAspect = shape.ignored.aspect;
  const pixels = shape.sizeMode === "dimensions" || shape.customSize;

  if (shape.sizeMode === "none") return null;

  // One entry per control. A named entry is a select and gets a label column,
  // because two unlabelled selects reading "Auto" and "1:1" say nothing about
  // which is which; chips carry their own meaning and span the row.
  const entries: { key: string; label: string | null; node: ReactNode }[] = [];

  if (shape.sizeMode === "tiers") {
    const tier = tierOf(values.sizePreset) ?? values.sizePreset ?? shape.tiers[0]?.value ?? "";
    const currentAspect = presetAspect(values.sizePreset);
    if (shape.tiers.length > 1) {
      entries.push({
        key: "tiers",
        label: null,
        node: chips(shape.tiers, tier, "Resolution tier", (next) => set({ sizePreset: presetForTier(summary, next, currentAspect) ?? next })),
      });
    }
    if (shape.tierAspects.length > 0) {
      entries.push({
        key: "tier-aspects",
        label: null,
        node: chips(shape.tierAspects, currentAspect, "Aspect ratio", (next) => set({ sizePreset: presetForTier(summary, tier, next) })),
      });
    }
  } else if (shape.sizeMode === "presets") {
    entries.push(
      shape.presets.length > CHIP_LIMIT
        ? {
            key: "presets",
            label: "size",
            node: (
              <Select ariaLabel="Size" className="w-full" value={values.sizePreset ?? ""} options={selectOptions(shape.presets)} onSelect={(next) => set({ sizePreset: next })} />
            ),
          }
        : { key: "presets", label: null, node: chips(shape.presets, values.sizePreset, "Size", (next) => set({ sizePreset: next })) },
    );
  }

  // A control with one option is not a choice: Krea's three models offer "1K"
  // and nothing else, and a single chip labelled Resolution reads as a control
  // that has failed rather than as a fact. The tier row above is guarded the
  // same way, and the size hint on the Row still names the resolution.
  if (shape.resolutions.length > 1) {
    entries.push(
      shape.resolutions.length > CHIP_LIMIT
        ? {
            key: "resolutions",
            label: "resolution",
            node: (
              <Select
                ariaLabel="Resolution"
                className="w-full"
                value={values.resolution ?? ""}
                options={selectOptions(shape.resolutions)}
                onSelect={(next) => set({ resolution: next })}
              />
            ),
          }
        : { key: "resolutions", label: null, node: chips(shape.resolutions, values.resolution, "Resolution", (next) => set({ resolution: next })) },
    );
  }

  if (shape.aspects.length > 0 && shape.sizeMode !== "tiers") {
    const disabled = ignoredAspect !== undefined;
    entries.push(
      shape.aspects.length > CHIP_LIMIT
        ? {
            key: "aspects",
            label: "ratio",
            node: (
              <Select
                ariaLabel="Aspect ratio"
                className="w-full"
                disabled={disabled}
                title={ignoredAspect}
                value={values.aspect ?? ""}
                options={selectOptions(shape.aspects)}
                onSelect={(next) => set({ aspect: next })}
              />
            ),
          }
        : {
            key: "aspects",
            label: null,
            node: <div className={cn(disabled && "pointer-events-none opacity-50")}>{chips(shape.aspects, values.aspect, "Aspect ratio", (next) => set({ aspect: next }))}</div>,
          },
    );
  }

  if (pixels && shape.dimensions !== null) {
    const rule = shape.dimensions;
    entries.push({
      key: "pixels",
      label: null,
      node: (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="number"
            aria-label="Width"
            value={values.width ?? ""}
            min={rule.widthMin}
            max={rule.widthMax}
            step={rule.step}
            onChange={(event) => set({ width: Number(event.target.value) })}
            className="h-7 w-24 border-border/60 text-[12px] tabular-nums max-md:pointer-coarse:h-10 max-md:pointer-coarse:text-base"
          />
          <span className="text-[11px] text-muted-foreground">by</span>
          <Input
            type="number"
            aria-label="Height"
            value={values.height ?? ""}
            min={rule.heightMin}
            max={rule.heightMax}
            step={rule.step}
            onChange={(event) => set({ height: Number(event.target.value) })}
            className="h-7 w-24 border-border/60 text-[12px] tabular-nums max-md:pointer-coarse:h-10 max-md:pointer-coarse:text-base"
          />
        </div>
      ),
    });
  }

  const notes: string[] = [];
  if (pixels && shape.dimensions !== null) {
    const rule = shape.dimensions;
    notes.push(`${rule.widthMin} to ${rule.widthMax} wide, ${rule.heightMin} to ${rule.heightMax} tall${rule.step > 1 ? `, in steps of ${rule.step}` : ""}.`);
  }
  for (const note of shape.notes.size) if (!notes.includes(note)) notes.push(note);

  return (
    <Row
      label="Size"
      hint={hint ?? undefined}
      note={shape.dimensionError === null ? (notes.length === 0 ? null : notes.join(" ")) : <span className="text-destructive">{shape.dimensionError}</span>}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
        {entries.map((entry) =>
          entry.label === null ? (
            <div key={entry.key} className="col-span-2 min-w-0">
              {entry.node}
            </div>
          ) : (
            <Fragment key={entry.key}>
              <span className="text-[11px] text-muted-foreground">{entry.label}</span>
              {entry.node}
            </Fragment>
          ),
        )}
      </div>
    </Row>
  );
}

/** Length: chips when the model offers a handful of lengths, a slider when it offers a span. */
export function LengthControls({ summary, shape, set }: ControlProps) {
  const id = useId();
  const values = shape.values;
  const note = shape.notes.length.length === 0 ? null : shape.notes.length.join(" ");
  // A model whose length comes out of the prompt has no control to draw, but it
  // still has a length, and on a per second price that length is the whole
  // bill. Gemini Omni Flash 1.1 returns 10 seconds when the prompt does not
  // say, so the row says which number the button is quoting.
  const promptLength = summary.capabilities.promptDurationDefault ?? null;
  if (shape.durations === null && shape.durationRange === null) {
    if (promptLength === null) return null;
    return (
      <Row
        label="Length"
        hint={`about ${promptLength} s`}
        note={`This model has no length control: write it into the prompt ("a 6 second clip"). Without one it returns about ${promptLength} s, which is what the price below quotes.`}
      >
        <span className="sr-only">The prompt sets the length.</span>
      </Row>
    );
  }
  if (shape.durations !== null) {
    return (
      <Row label="Length" note={note} hint={values.duration === null ? undefined : `${values.duration} s`}>
        <ChipGroup ariaLabel="Length">
          {shape.durations.map((option) => (
            <Chip
              key={option.value}
              active={Number(option.value) === values.duration}
              disabled={option.disabled}
              title={option.reason ?? undefined}
              onClick={() => set({ duration: Number(option.value) })}
            >
              {`${option.value} s`}
            </Chip>
          ))}
        </ChipGroup>
      </Row>
    );
  }
  const range = shape.durationRange;
  if (range === null) return null;
  return (
    <Row label="Length" note={note} hint={values.duration === null ? undefined : `${values.duration} s`} htmlFor={id}>
      <div className="flex items-center gap-2">
        <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{range.min}</span>
        <input
          id={id}
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={values.duration ?? range.min}
          onChange={(event) => set({ duration: Number(event.target.value) })}
          className={cn(
            // A hairline track and one solid dot, so the control reads like the rest of
            // the chrome instead of a browser default. The value is on the label line.
            "h-7 min-w-0 flex-1 cursor-pointer appearance-none bg-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:h-11",
            "[&::-webkit-slider-runnable-track]:h-0.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-border",
            "[&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground",
            "max-md:pointer-coarse:[&::-webkit-slider-thumb]:size-5",
            "[&::-moz-range-track]:h-0.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-border",
            "[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-foreground",
            "max-md:pointer-coarse:[&::-moz-range-thumb]:size-5",
          )}
        />
        <span className="w-6 shrink-0 text-[11px] tabular-nums text-muted-foreground">{range.max}</span>
      </div>
    </Row>
  );
}

export function SoundControls({ shape, set }: Omit<ControlProps, "summary">) {
  if (!shape.audioAllowed) return null;
  return (
    <Row label="Sound" note={shape.audioLocked ? shape.audioReason : shape.notes.sound.length === 0 ? null : shape.notes.sound.join(" ")}>
      <ChipGroup ariaLabel="Sound">
        <Chip active={!shape.values.audio} disabled={shape.audioLocked} title={shape.audioLocked ? (shape.audioReason ?? undefined) : undefined} onClick={() => set({ audio: false })}>
          Silent
        </Chip>
        <Chip active={shape.values.audio} onClick={() => set({ audio: true })}>
          With audio
        </Chip>
      </ChipGroup>
    </Row>
  );
}

/**
 * Everything the registry could not name: rendered by type, with the node's own
 * tooltip on the label. This one mechanism is what lets Ideogram's rendering
 * speed and Kling's mode work without a line of code per vendor.
 */
export function MoreOptions({ summary, shape, set }: ControlProps) {
  const values = shape.values;
  const extras = visibleExtras(summary);
  const negative = summary.capabilities.negativePrompt;
  const count = extras.length + (negative ? 1 : 0);
  if (count === 0) return null;
  const setExtra = (name: string, value: ExtraValue) => set({ extras: { ...values.extras, [name]: value } });
  return (
    <div className="min-w-0">
      <div className="grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-[11px]">
        {negative ? (
          <>
            <label htmlFor="comfy-negative" className="min-w-0 truncate text-muted-foreground" title="What the model should keep out of the picture">
              negative prompt
            </label>
            <Textarea
              id="comfy-negative"
              rows={2}
              value={values.negativePrompt}
              onChange={(event) => set({ negativePrompt: event.target.value })}
              className="min-h-0 border-border/60 py-1 text-[11px] leading-4"
            />
          </>
        ) : null}
        {extras.map((extra) => (
          <ExtraControl key={extra.name} extra={extra} values={values} options={shape.extraOptions[extra.name] ?? null} note={shape.extraNotes[extra.name] ?? null} onChange={setExtra} />
        ))}
      </div>
    </div>
  );
}

/** How many rows "More options" holds, for the disclosure's own summary line. */
export function extraCount(summary: ModelSummary): number {
  return visibleExtras(summary).length + (summary.capabilities.negativePrompt ? 1 : 0);
}

function ExtraControl({
  extra,
  values,
  options,
  note,
  onChange,
}: {
  extra: ModelExtra;
  values: FormValues;
  /** Set when a documented constraint narrows this input; carries the greyed out values. */
  options: Option[] | null;
  note: string | null;
  onChange: (name: string, value: ExtraValue) => void;
}) {
  const id = useId();
  const value = extraValue(extra, values);
  const title = [extra.name, extra.tooltip].filter((part) => part !== undefined && part !== "").join(": ");
  // A note makes the row two lines tall, and the grid centres its cells, so the
  // name would drift down beside the sentence instead of beside the control.
  const label = (
    <label htmlFor={id} className={cn("min-w-0 truncate text-muted-foreground", note !== null && "self-start pt-1.5")} title={title}>
      {extraLabel(extra.name)}
    </label>
  );
  if (extra.options !== undefined && extra.options.length > 0) {
    return (
      <>
        {label}
        <span className="block min-w-0">
          <Select
            id={id}
            className="w-full"
            title={extra.tooltip}
            value={String(value)}
            // A vendor's own slug is not a label: VERY_LOW, ALLOW and MINIMAL
            // are the only values on this form that arrive shouting.
            options={(options ?? extra.options.map((option) => ({ value: option, label: option, disabled: false, reason: null }))).map((option) => ({
              value: option.value,
              label: extraOptionLabel(option.label),
              disabled: option.disabled,
              title: option.reason ?? undefined,
            }))}
            onSelect={(next) => onChange(extra.name, next)}
          />
          {note === null ? null : <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{note}</span>}
        </span>
      </>
    );
  }
  if (extra.type === "BOOLEAN") {
    return (
      <>
        {label}
        <span className="flex items-center gap-2">
          <CheckBox checked={value === true} ariaLabel={extraLabel(extra.name)} onChange={(next) => onChange(extra.name, next)} />
          <span className="text-muted-foreground">{value === true ? "on" : "off"}</span>
        </span>
      </>
    );
  }
  if (extra.type === "INT" || extra.type === "FLOAT") {
    return (
      <>
        {label}
        {/* No width here: the grid cell decides it, so every control on this form shares one right edge. */}
        <Input
          id={id}
          type="number"
          title={extra.tooltip}
          value={typeof value === "number" ? value : ""}
          min={extra.min}
          max={extra.max}
          step={extra.step ?? (extra.type === "INT" ? 1 : "any")}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (event.target.value.trim() !== "" && Number.isFinite(next)) onChange(extra.name, next);
          }}
          className="h-7 border-border/60 text-[11px] tabular-nums"
        />
      </>
    );
  }
  if (extra.multiline === true) {
    return (
      <>
        {label}
        <Textarea
          id={id}
          rows={2}
          title={extra.tooltip}
          value={String(value)}
          onChange={(event) => onChange(extra.name, event.target.value)}
          className="min-h-0 border-border/60 py-1 text-[11px] leading-4"
        />
      </>
    );
  }
  return (
    <>
      {label}
      <Input
        id={id}
        title={extra.tooltip}
        value={String(value)}
        onChange={(event) => onChange(extra.name, event.target.value)}
        className="h-7 border-border/60 text-[11px]"
      />
    </>
  );
}
