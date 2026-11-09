// Choosing one of about a hundred models: the closed row on the Generate tab,
// and the sheet it opens.
//
// A sheet, not a menu: the host panel is 560 px wide, so the picker takes the
// whole tab area, keeps its search and its sort pinned at the top and scrolls
// vendor by vendor under sticky headers. It is drawn with the same kit, the
// same gutter and the same type scale as everything else, because it is the
// same product; the only thing that is new here is how much there is to say
// about each row.
//
// The price is not decoration. The catalog runs from under a credit to over
// three thousand, so every row carries a figure and one click sorts by it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import type { AssetKind, ModelSummary } from "../../contract";
import { Glyph } from "./glyphs";
import { Art } from "./art";
import { BAR, Chip, ChipGroup, EmptyState, GhostButton, Hairline, LABEL_CLASS, Segmented, Shimmer } from "./kit";
import { SORT_OPTIONS, filtersFor, findModel, flatten, groupModels, listedModels, matchesQuery, sortModels } from "./model-list";
import type { ModelSort } from "./model-list";
import { useElementSize } from "./use-comfy";

const GUTTER = "px-3";

/** The scrolling ancestor the sheet sits in, which is the host tab body. */
function scrollParent(from: HTMLElement | null): HTMLElement | null {
  for (let element = from?.parentElement ?? null; element !== null; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowY;
    if (overflow === "auto" || overflow === "scroll") return element;
  }
  return null;
}

// ---------- the closed row ----------

export interface ModelRowProps {
  model: ModelSummary | null;
  /** The key the form holds, shown while the registry is still loading. */
  fallback: string;
  loading: boolean;
  onOpen: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}

/**
 * What the Generate tab shows when the picker is closed: the model, its vendor
 * and what it can do, its price, and a chevron. Two lines, so the price never
 * fights the capability line for the same right edge.
 */
export function ModelRow({ model, fallback, loading, onOpen, buttonRef }: ModelRowProps) {
  const label = model?.label ?? fallback;
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Model: ${label}. Choose another`}
      title={model?.notes ?? undefined}
      className={cn(
        "@container flex w-full cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-card px-2.5 py-2 text-left",
        "transition-colors duration-150 hover:border-foreground/25 motion-reduce:transition-none",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-foreground">{label}</span>
          {/* In a narrow panel the label matters more than the price, and the
              Generate button under the form already quotes the chosen shape. */}
          {model === null ? null : <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground @[20rem]:inline">{model.priceLine}</span>}
        </span>
        {loading && model === null ? (
          <Shimmer className="mt-1 h-3 w-40" />
        ) : (
          <span className="mt-0.5 block min-w-0 truncate text-[11px] leading-4 text-muted-foreground">
            {model === null ? "Choose a model" : `${model.vendor} · ${model.capabilityLine}`}
          </span>
        )}
      </span>
      <Glyph.forward className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

// ---------- the sheet ----------

export interface ModelPickerProps {
  kind: AssetKind;
  models: readonly ModelSummary[];
  /** The key the form is on, so the row can carry the check and the ring. */
  current: string;
  favourites: readonly string[];
  recent: readonly string[];
  loading: boolean;
  onChoose: (model: ModelSummary) => void;
  onClose: () => void;
  onToggleFavourite: (key: string) => void;
}

export function ModelPicker({ kind, models, current, favourites, recent, loading, onChoose, onClose, onToggleFavourite }: ModelPickerProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ModelSort>("recommended");
  const [active, setActive] = useState<string[]>([]);
  const [showFavourites, setShowFavourites] = useState(true);
  const [showRecent, setShowRecent] = useState(true);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // The vendor headers stick under the search bar, so they follow its real
  // height rather than a number that only holds until the sort row wraps.
  const [headRef, headSize] = useElementSize<HTMLDivElement>();
  const filters = filtersFor(kind);

  // The search field is the keyboard's home: it opens focused, every printable
  // key comes back to it, and the arrows leave it for the rows. The sheet also
  // opens at its top, whatever the form under it had been scrolled to, and the
  // focus itself must not scroll or the first row starts under the header.
  //
  // Then the model the form is on is brought into view, because in a long
  // list the checked row can sit far below the fold and the sheet would open
  // with no visible answer to "which one am I on". A row already near the top
  // (Favourites, Recent, the first vendor) is left where it is, so the usual
  // case still opens at the top.
  const settled = useRef(false);
  // The measured header, kept in a ref so the timeout below reads the value of
  // the pass it actually runs after rather than the one it closed over.
  const headHeight = useRef(0);
  headHeight.current = headSize.height;
  useEffect(() => {
    if (settled.current) return;
    const timer = setTimeout(() => {
      const box = scrollParent(rootRef.current);
      if (box !== null) box.scrollTop = 0;
      searchRef.current?.focus({ preventScroll: true });
      if (models.length === 0) return;
      settled.current = true;
      const row = listRef.current?.querySelector<HTMLElement>('[data-model-row][aria-current="true"]') ?? null;
      if (row === null || box === null) return;
      const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      // A row that is already on screen under the header is left exactly where
      // it is, so the usual case still opens at the top with Favourites and
      // Recent in view. Only a row below the fold is scrolled to, and then to
      // the middle rather than the edge.
      const under = box.scrollTop + Math.max(headHeight.current, row.offsetHeight);
      if (top >= under && top + row.offsetHeight <= box.scrollTop + box.clientHeight) return;
      box.scrollTop = Math.max(0, top - Math.max(0, (box.clientHeight - row.offsetHeight) / 2));
    }, 0);
    return () => clearTimeout(timer);
  }, [models, current]);

  const visible = useMemo(() => {
    const chosen = filters.filter((filter) => active.includes(filter.id));
    return models.filter((model) => matchesQuery(model, query) && chosen.every((filter) => filter.matches(model)));
  }, [models, query, active, filters]);

  // `listedModels` says why a hidden entry is in `visible` but not in a vendor section.
  const listed = useMemo(() => listedModels(visible, current), [visible, current]);
  const groups = useMemo(() => groupModels(sortModels(listed, sort), sort), [listed, sort]);
  // Two entries can carry the same label (one model offered by two nodes). The
  // node class is the only thing that tells them apart, so it goes on the row.
  const ambiguous = useMemo(() => {
    const seen = new Map<string, number>();
    for (const model of models) seen.set(model.label, (seen.get(model.label) ?? 0) + 1);
    return new Set([...seen].filter(([, count]) => count > 1).map(([label]) => label));
  }, [models]);
  const favouriteRows = useMemo(
    () => favourites.map((key) => findModel(visible, key)).filter((model): model is ModelSummary => model !== null),
    [favourites, visible],
  );
  const recentRows = useMemo(
    () => recent.map((key) => findModel(visible, key)).filter((model): model is ModelSummary => model !== null && !favourites.includes(model.key)),
    [recent, visible, favourites],
  );

  /** Every row in drawing order, which is the order the arrows walk. */
  const order = useMemo(() => [...favouriteRows, ...recentRows, ...flatten(groups)], [favouriteRows, recentRows, groups]);

  const focusRow = (index: number) => {
    const root = listRef.current;
    if (root === null) return;
    const buttons = root.querySelectorAll<HTMLButtonElement>("[data-model-row]");
    const target = buttons[Math.min(Math.max(0, index), buttons.length - 1)];
    target?.focus();
  };

  const rowKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(index + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) searchRef.current?.focus();
      else focusRow(index - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusRow(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusRow(order.length - 1);
      return;
    }
    // Type to filter from anywhere in the list.
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      setQuery((previous) => previous + event.key);
      searchRef.current?.focus();
    }
  };

  let drawn = 0;
  const nextIndex = () => {
    const index = drawn;
    drawn += 1;
    return index;
  };

  const row = (model: ModelSummary, showVendor: boolean) => {
    const index = nextIndex();
    return (
      <ModelPickerRow
        key={`${index}:${model.key}`}
        model={model}
        index={index}
        current={model.key === current}
        favourite={favourites.includes(model.key)}
        showVendor={showVendor}
        cheapest={sort === "cheapest"}
        suffix={ambiguous.has(model.label) ? model.node : null}
        onChoose={onChoose}
        onToggleFavourite={onToggleFavourite}
        onKeyDown={rowKeyDown}
      />
    );
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={`Choose ${kind === "image" ? "an" : "a"} ${kind} model`}
      // The sheet bleeds to the tab's own edges. It does not pull up into the
      // 16 px the host pads above, because a sticky bar parks at the scrollport
      // edge whatever its own margin says: the bar paints that strip instead.
      className="-mx-4 -mb-3 flex min-h-full flex-col bg-background"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      {/* The tab body has 16 px of padding above this, which content would
          otherwise scroll through, so the bar paints that strip as well. */}
      <div ref={headRef} className="sticky top-0 z-20 bg-background before:absolute before:inset-x-0 before:bottom-full before:h-4 before:bg-background before:content-['']">
        <div className={BAR}>
          <div className="relative min-w-0 flex-1">
            <Glyph.search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown") return;
                event.preventDefault();
                focusRow(0);
              }}
              placeholder={`Search ${models.length} ${kind === "video" ? "video" : "image"} models`}
              aria-label="Search models"
              className="h-7 rounded-md border-border/60 pl-7 pr-7 text-[12px] [&::-webkit-search-cancel-button]:appearance-none"
            />
            {query === "" ? null : (
              <GhostButton iconOnly ariaLabel="Clear search" className="absolute right-0.5 top-1/2 size-6 -translate-y-1/2" onClick={() => setQuery("")}>
                <Glyph.close className="size-3" />
              </GhostButton>
            )}
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" title={`${visible.length} of ${models.length} shown`}>
            {visible.length}
          </span>
          <GhostButton iconOnly ariaLabel="Close model picker" title="Close (Escape)" onClick={onClose}>
            <Glyph.close className="size-3.5" />
          </GhostButton>
        </div>
        <div className={cn("flex flex-wrap items-center gap-2 border-b border-border/60 py-1.5", GUTTER)}>
          <Segmented ariaLabel="Sort models" options={SORT_OPTIONS} value={sort} onSelect={(id) => setSort(id as ModelSort)} />
          <ChipGroup ariaLabel="Model filters">
            {filters.map((filter) => (
              <Chip
                key={filter.id}
                active={active.includes(filter.id)}
                title={filter.hint}
                onClick={() => setActive((previous) => (previous.includes(filter.id) ? previous.filter((id) => id !== filter.id) : [...previous, filter.id]))}
              >
                {filter.label}
              </Chip>
            ))}
          </ChipGroup>
        </div>
      </div>

      <div ref={listRef} className={cn("min-w-0 flex-1 pb-6", GUTTER)}>
        {visible.length === 0 ? (
          loading ? (
            <div className="space-y-2 pt-3">
              {[0, 1, 2, 3, 4].map((index) => (
                <Shimmer key={index} className="h-[72px] w-full" />
              ))}
            </div>
          ) : (
            <EmptyState
              art={<Art name="empty-search" className="h-24 w-52 text-muted-foreground/70" />}
              title="No models match"
              action={
                <GhostButton
                  onClick={() => {
                    setQuery("");
                    setActive([]);
                  }}
                >
                  Clear search and filters
                </GhostButton>
              }
            >
              <p>Nothing in the catalog answers to that. Search by model, vendor or id.</p>
            </EmptyState>
          )
        ) : (
          <>
            {favouriteRows.length === 0 ? null : (
              <PickerSection label="Favourites" count={favouriteRows.length} top={headSize.height} open={showFavourites} onToggle={() => setShowFavourites((value) => !value)}>
                {favouriteRows.map((model) => row(model, true))}
              </PickerSection>
            )}
            {recentRows.length === 0 ? null : (
              <PickerSection label="Recent" count={recentRows.length} top={headSize.height} open={showRecent} onToggle={() => setShowRecent((value) => !value)}>
                {recentRows.map((model) => row(model, true))}
              </PickerSection>
            )}
            {groups.map((group) => (
              <PickerSection key={group.key} label={group.label} count={group.models.length} top={headSize.height}>
                {group.models.map((model) => row(model, !group.vendorHeader))}
              </PickerSection>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

interface PickerSectionProps {
  label: string;
  count: number;
  /** Where the header parks: the measured height of the search and sort block. */
  top: number;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}

/** The sticky header over a run of rows: the plugin's 10 px uppercase line and a rule. */
function PickerSection({ label, count, top, open = true, onToggle, children }: PickerSectionProps) {
  const head = (
    <>
      {onToggle === undefined ? null : open ? <Glyph.down className="size-3 shrink-0" /> : <Glyph.forward className="size-3 shrink-0" />}
      <span className={cn(LABEL_CLASS, "shrink-0")}>{label}</span>
      <Hairline />
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{count}</span>
    </>
  );
  return (
    <section aria-label={label} className="mt-3 first:mt-0">
      <div style={{ top }} className={cn("sticky z-10 -mx-3 flex items-center gap-2 bg-background pb-1.5 pt-2 text-muted-foreground", GUTTER)}>
        {onToggle === undefined ? (
          head
        ) : (
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {head}
          </button>
        )}
      </div>
      {open ? <div className="flex flex-col">{children}</div> : null}
    </section>
  );
}

interface ModelPickerRowProps {
  model: ModelSummary;
  index: number;
  current: boolean;
  favourite: boolean;
  showVendor: boolean;
  /** The node class, when the label alone does not tell two entries apart. */
  suffix: string | null;
  /** True under the Cheapest sort, where the row prints the figure it is ordered by. */
  cheapest: boolean;
  onChoose: (model: ModelSummary) => void;
  onToggleFavourite: (key: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
}

/**
 * One model: the name, the one phrase that would make someone pick it, what it
 * can do, and what it costs. The star is its own control, so it sits beside the
 * row rather than inside it.
 */
function ModelPickerRow({ model, index, current, favourite, showVendor, cheapest, suffix, onChoose, onToggleFavourite, onKeyDown }: ModelPickerRowProps) {
  const meta = [showVendor ? model.vendor : null, model.capabilityLine, suffix].filter((part) => part !== null && part !== "").join(" · ");
  // Under the Cheapest sort every row shows the number the list is ordered by,
  // which for a video model is a whole clip rather than its rate per second.
  const price = cheapest ? model.cheapestLine : model.priceLine;
  // An image price is a figure ("9.5 credits, about $0.05"), so it sits beside
  // the name. A video price is a sentence with a shape in it ("about 41.64
  // credits for 4 s at 480p, about $0.20") and beside the name it leaves no
  // room to read the name, so a video price takes its own line at every width.
  const priceInline = model.kind === "image";
  return (
    <div className={cn("group relative flex items-start gap-1 rounded-md", current && "bg-foreground/[0.04] ring-1 ring-ring")}>
      <button
        type="button"
        data-model-row
        data-model-key={model.key}
        aria-current={current ? "true" : undefined}
        title={[suffix === null ? null : `Node ${suffix}`, model.notes].filter((part) => part !== null && part !== "").join("\n") || undefined}
        onKeyDown={(event) => onKeyDown(event, index)}
        onClick={() => onChoose(model)}
        className={cn(
          "@container min-w-0 flex-1 cursor-pointer rounded-md px-2 py-2 text-left",
          "hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          {current ? <Glyph.check className="size-3.5 shrink-0 self-center text-foreground" /> : null}
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-foreground">{model.label}</span>
          {/* Under 20rem the price takes its own line rather than eating the name. */}
          <span className={cn("hidden min-w-0 truncate text-[11px] leading-4 tabular-nums text-muted-foreground", priceInline && "@[20rem]:inline")}>{price}</span>
        </span>
        {model.strengths === null ? null : <span className="mt-0.5 block truncate text-[11px] leading-4 text-foreground/70">{model.strengths}</span>}
        <span className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[11px] leading-4 text-muted-foreground">
          <span className="min-w-0 truncate">{meta}</span>
          {/* Every schema-derived entry is unsupported today, so this suffix
              draws only if a model with no documentation on file ever becomes
              offerable. It is the honest label for that day, not dead weight:
              `bb comfy models --all` says the same thing about them now. */}
          {model.capabilities.schemaDerived ? (
            <span className="shrink-0 text-muted-foreground/70" title="No vendor documentation covers this one, so this list is the node schema alone.">
              · unverified
            </span>
          ) : null}
        </span>
        <span className={cn("mt-0.5 block truncate text-[11px] leading-4 tabular-nums text-muted-foreground", priceInline && "@[20rem]:hidden")}>{price}</span>
      </button>
      <GhostButton
        iconOnly
        ariaLabel={favourite ? `Remove ${model.label} from favourites` : `Add ${model.label} to favourites`}
        title={favourite ? "In favourites" : "Add to favourites"}
        ariaPressed={favourite}
        className="mt-1.5 shrink-0"
        onClick={() => onToggleFavourite(model.key)}
      >
        {favourite ? <Glyph.starFilled className="size-3.5 text-foreground" /> : <Glyph.star className="size-3.5 opacity-40 group-hover:opacity-100" />}
      </GhostButton>
    </div>
  );
}
