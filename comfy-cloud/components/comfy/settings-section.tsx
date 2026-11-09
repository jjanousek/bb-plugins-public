// Settings page section: where the key comes from, where assets live, what has
// been generated, and what it has all cost. It never shows the key itself.
// Same type scale as the panel: 10 px uppercase labels, 12 px values, 11 px
// meta, hairlines instead of boxes.
//
// This is the one place the full cost breakdown belongs: the balance, the
// spend, and the per model table from the costs RPC. Every other surface shows
// a single figure.
import { cn } from "@/lib/utils";
import { formatCredits, registryAge, registryAgeText } from "../../contract";
import type { Costs } from "../../contract";
import { Art } from "./art";
import { creditsText, usdOnly, usdText } from "./cost";
import { KEY_SOURCE_LABEL, dayKey, modelLabel } from "./format";
import { Glyph } from "./glyphs";
import { CopyButton, FieldLabel, GhostButton, Hairline, LABEL_CLASS } from "./kit";
import { errorText, useCosts, useModelLabels, useStatus } from "./use-comfy";

const CONFIGURE_HINT =
  "Set the apiKey setting above, or put COMFY_API_KEY=... in a git-ignored .env in the plugin folder, or point the keyFile setting at a dotenv file that has it.";

/** One line of the fact list: the label column, then the value. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <FieldLabel className="pt-1">{label}</FieldLabel>
      <div className="min-w-0 text-[12px] leading-5 text-foreground">{children}</div>
    </>
  );
}

export function SettingsSection() {
  const status = useStatus();
  const costs = useCosts();
  // The By model table names a model, so it needs the registry's labels.
  useModelLabels();
  if (status.data === null) {
    return (
      <p className="text-[12px] text-muted-foreground">
        {status.error === null ? "Loading" : `Could not read the plugin status: ${errorText(status.error)}`}
      </p>
    );
  }
  const { configured, keySource, configureHint, assetDir, counts, imageModel, videoModel, catalogLoaded, registry } = status.data;
  const assetDirError = status.data.assetDirError ?? null;
  const rate = status.data.creditRate ?? null;
  const balance = status.data.balanceCredits ?? null;
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex items-center gap-2 text-[13px] text-foreground">
            <span className={configured ? "size-2 shrink-0 rounded-full bg-foreground" : "size-2 shrink-0 rounded-full bg-destructive"} aria-hidden />
            {configured && keySource !== null ? `API key found in ${KEY_SOURCE_LABEL[keySource]}.` : "No Comfy Cloud API key is configured."}
          </p>
          {configured ? null : <p className="text-[12px] leading-5 text-muted-foreground">{configureHint ?? CONFIGURE_HINT}</p>}
          <p className="text-[12px] leading-5 text-muted-foreground">The key stays on the server and is never shown here.</p>
        </div>
        {configured ? null : <Art name="no-key" className="h-14 w-24 text-muted-foreground/60" />}
      </div>

      <Hairline />

      <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-4 gap-y-2">
        <Fact label="Asset folder">
          <span className="flex min-w-0 items-start gap-1">
            <span className="min-w-0 break-all font-mono text-[11px] leading-5">{assetDir}</span>
            <CopyButton text={assetDir} label="Copy the asset folder path" done="Path copied" className="-mt-0.5" />
          </span>
          {assetDirError === null ? null : <span className="mt-0.5 block text-[12px] text-destructive">Could not be prepared: {assetDirError}</span>}
        </Fact>
        <Fact label="Assets">
          {counts.total} total, {counts.images} {counts.images === 1 ? "image" : "images"}, {counts.videos} {counts.videos === 1 ? "video" : "videos"}
          {counts.running > 0 ? `, ${counts.running} in progress` : ""}
          {counts.failed > 0 ? `, ${counts.failed} failed` : ""}
          {/* The lifetime figure is the library's inventory; the recent one is
              what the sidebar badge is showing, so the two never disagree. */}
          {counts.failedRecent > 0 ? ` (${counts.failedRecent} in the last day)` : ""}
        </Fact>
        <Fact label="Image model">{modelLabel(imageModel)}</Fact>
        <Fact label="Video model">{modelLabel(videoModel)}</Fact>
        <Fact label="Node catalog">{catalogLoaded ? "Cached" : "Not fetched yet, so the graph view shows class names until it is"}</Fact>
        <Fact label="Model list">{registryAgeText(registryAge(registry, dayKey(Date.now())))}</Fact>
      </div>

      {balance === null && costs.data === null ? null : (
        <>
          <Hairline />
          <Spend balance={balance} rate={rate} costs={costs.data} />
        </>
      )}

      <GhostButton
        onClick={() => {
          status.refetch();
          costs.refetch();
        }}
        disabled={status.loading}
        className="-ml-2"
      >
        <Glyph.refresh className="size-3.5" />
        Refresh
      </GhostButton>
    </div>
  );
}

/** "9.5 credits ≈ $0.05", or just the credits when no rate is set. */
function Credits({ credits, rate }: { credits: number; rate: number | null }) {
  const usd = usdText(credits, rate);
  return (
    <span className="tabular-nums">
      {creditsText(credits)}
      {usd === null ? null : <span className="text-muted-foreground">{` ${usd}`}</span>}
    </span>
  );
}

/** Credits left, what has been spent, and where it went. */
function Spend({ balance, rate, costs }: { balance: number | null; rate: number | null; costs: Costs | null }) {
  const spend = costs?.spend ?? null;
  const byModel = costs?.byModel ?? [];
  const days = typeof costs?.days === "number" && costs.days > 0 ? costs.days : null;
  // The dollar column only exists when the creditRate setting is set; without
  // it the table is three columns and no figure is guessed at.
  const columns = rate === null ? "grid-cols-[minmax(0,1fr)_3.5rem_5.5rem]" : "grid-cols-[minmax(0,1fr)_3.5rem_5.5rem_5rem]";
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-4 gap-y-2">
        <Fact label="Credits left">
          {balance === null ? <span className="text-muted-foreground">not known yet</span> : <Credits credits={balance} rate={rate} />}
        </Fact>
        {spend === null ? null : (
          <>
            <Fact label="Spent today">
              <Credits credits={spend.today} rate={rate} />
            </Fact>
            <Fact label="Last 7 days">
              <Credits credits={spend.week} rate={rate} />
            </Fact>
            <Fact label="All time">
              <Credits credits={spend.total} rate={rate} />
            </Fact>
          </>
        )}
      </div>

      {byModel.length === 0 ? null : (
        <div>
          {/* The table covers the costs RPC's own window, and "All time" sits
              right above it, so the window has to be on the line. */}
          <FieldLabel hint={days === null ? undefined : `last ${days} days`}>By model</FieldLabel>
          <div className="mt-1 divide-y divide-border/60">
            <div className={cn("grid gap-x-3 py-1", columns)}>
              <span className={LABEL_CLASS}>Model</span>
              <span className={cn(LABEL_CLASS, "text-right")}>Runs</span>
              <span className={cn(LABEL_CLASS, "text-right")}>Credits</span>
              {rate === null ? null : <span className={cn(LABEL_CLASS, "text-right")}>USD</span>}
            </div>
            {byModel.map((row) => (
              <div key={`${row.kind}:${row.model}`} className={cn("grid items-baseline gap-x-3 py-1 text-[11px] leading-4 text-foreground", columns)}>
                <span className="min-w-0 truncate" title={row.model}>
                  {modelLabel(row.model)}
                </span>
                <span className="text-right tabular-nums text-muted-foreground">{row.count}</span>
                <span className="text-right tabular-nums">{formatCredits(row.credits)}</span>
                {rate === null ? null : <span className="text-right tabular-nums text-muted-foreground">{usdOnly(row.credits, rate) ?? ""}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
