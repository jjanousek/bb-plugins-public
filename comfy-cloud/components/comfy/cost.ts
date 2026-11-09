// What a generation costs, in words. The price tables, `estimateCredits` and
// the credit to dollar conversion all live in contract.ts (one source, shared
// with the server, the CLI and the tools); this module is the phrasing layer
// the surfaces read, the way format.ts owns times and model names. A model's
// own rate is `priceLine` on its registry row, which the picker renders.
//
// One rule holds every phrase together: a billed figure is printed exactly as
// billed, an estimate is rounded to something worth saying out loud, and a
// dollar figure appears only when the creditRate setting is known.
import { estimateCredits, estimateParamsOf, formatCredits, formatUsd, usdForCredits } from "../../contract";
import type { Asset, CostConfidence, CostEstimate } from "../../contract";

// ---------- saying a number of credits ----------

/**
 * An estimate, without the fake precision a billed figure earns. Under a
 * hundred credits it is written out exactly, because the image prices are
 * published to the cent (9.5, 18.99); above it the video formula is only good
 * to a few percent, so "about 870 credits" is honest where "869.83" is not.
 */
export function formatEstimateCredits(credits: number): string {
  return credits >= 100 ? String(Math.round(credits)) : formatCredits(credits);
}

function creditsWord(credits: number): string {
  return credits === 1 ? "credit" : "credits";
}

/** "9.5 credits": a billed figure, exactly as billed. */
export function creditsText(credits: number): string {
  return `${formatCredits(credits)} ${creditsWord(credits)}`;
}

/** "about 10.4 credits", or no "about" when this account's own bills measured this exact shape. */
export function estimateCreditsText(estimate: CostEstimate): string | null {
  if (estimate.credits === null) return null;
  const body = `${formatEstimateCredits(estimate.credits)} ${creditsWord(estimate.credits)}`;
  return estimate.confidence === "measured" ? body : `about ${body}`;
}

/**
 * The dollar companion. Null when the rate is unknown, and then no dollar
 * figure may be drawn anywhere.
 */
export function usdText(credits: number, rate: number | null | undefined): string | null {
  const usd = usdForCredits(credits, rate);
  return usd === null ? null : `≈ ${formatUsd(usd)}`;
}

/** The bare dollar figure, for a column already headed USD. Null when the rate is unknown. */
export function usdOnly(credits: number, rate: number | null | undefined): string | null {
  const usd = usdForCredits(credits, rate);
  return usd === null ? null : formatUsd(usd);
}

/**
 * What the Generate button says beside the time: "9.5 credits ≈ $0.05",
 * "about 104 credits", or "cost unknown" when the shape has no price.
 */
export function costHint(estimate: CostEstimate, rate: number | null | undefined): string {
  const words = estimateCreditsText(estimate);
  if (words === null || estimate.credits === null) return "cost unknown";
  const usd = usdText(estimate.credits, rate);
  return usd === null ? words : `${words} ${usd}`;
}

// ---------- what one asset cost ----------

export interface AssetCost {
  /** Credits Comfy billed, once the billing event has been found. */
  actual: number | null;
  /** Credits expected: the figure stored at submit time, else the price table. */
  estimate: number | null;
  confidence: CostConfidence;
}

export function assetCost(asset: Asset): AssetCost {
  const table = estimateCredits(asset.kind, asset.model, estimateParamsOf(asset));
  const stored = asset.estimatedCredits ?? null;
  return {
    actual: asset.actualCredits ?? null,
    estimate: stored ?? table.credits,
    // A stored estimate the table cannot reproduce came from a price that has
    // since moved, so it is no better than inferred.
    confidence: stored !== null && table.credits === null ? "inferred" : table.confidence,
  };
}

/** Estimate and actual are far enough apart to be worth pointing at. */
const COST_GAP = 0.2;

function costGap(cost: AssetCost): number | null {
  if (cost.actual === null || cost.estimate === null || cost.estimate <= 0) return null;
  return (cost.actual - cost.estimate) / cost.estimate;
}

export interface CostCell {
  /** The figure the cell leads with. */
  main: string;
  /**
   * The muted half, punctuation included so the cell can print it straight
   * after `main`: the estimate takes a comma ("9.5 credits, est 6.2"), the
   * dollar companion only a space ("9.5 credits ≈ $0.04").
   */
  note: string | null;
  /** True when there is nothing to show, so the cell can go grey. */
  unknown: boolean;
}

/**
 * The viewer's COST cell: the actual when it is known, the estimate otherwise,
 * and a muted "est" only when the two are more than 20 percent apart. The full
 * sentence lives in Details.
 */
export function costCell(asset: Asset, rate: number | null | undefined): CostCell {
  const cost = assetCost(asset);
  if (cost.actual !== null) {
    const gap = costGap(cost);
    const far = gap !== null && Math.abs(gap) > COST_GAP && cost.estimate !== null;
    const estimate = far && cost.estimate !== null ? `, est ${formatEstimateCredits(cost.estimate)}` : "";
    const usd = usdText(cost.actual, rate);
    const note = `${estimate}${usd === null ? "" : ` ${usd}`}`;
    return { main: creditsText(cost.actual), note: note === "" ? null : note, unknown: false };
  }
  if (cost.estimate !== null) {
    // A finished generation with no charge against it is not the same thing as
    // one that is still running: its billing event may not have arrived, and
    // then "about 10 credits" would read as a bill. Say which it is. The
    // estimate keeps the word "about" either way.
    const usd = usdText(cost.estimate, rate);
    const pending = asset.status === "completed";
    const note = pending ? ", not billed yet" : usd === null ? null : ` ${usd}`;
    return {
      main: `about ${formatEstimateCredits(cost.estimate)} ${creditsWord(cost.estimate)}`,
      note,
      unknown: false,
    };
  }
  return { main: "unknown", note: null, unknown: true };
}

/** The one line a Jobs row can afford: the billed figure once it exists, else the estimate. */
export function jobCostText(asset: Asset): string | null {
  const cost = assetCost(asset);
  if (cost.actual !== null) return creditsText(cost.actual);
  if (cost.estimate === null) return null;
  return `est ${formatEstimateCredits(cost.estimate)} ${creditsWord(cost.estimate)}`;
}

/** The whole story, for the Details list: what was billed, what was expected, and the gap. */
export function costSentence(asset: Asset): string | null {
  const cost = assetCost(asset);
  if (cost.actual === null && cost.estimate === null) return null;
  if (cost.actual === null) {
    const estimate = cost.estimate ?? 0;
    const body = `Estimated ${formatEstimateCredits(estimate)} ${creditsWord(estimate)}`;
    return asset.status === "completed" ? `${body}. Comfy has not reported what it billed yet.` : `${body}.`;
  }
  const billed = `Billed ${creditsText(cost.actual)}`;
  if (cost.estimate === null) return `${billed}. No estimate was recorded for this one.`;
  const gap = costGap(cost);
  if (gap === null || Math.abs(gap) < 0.01) return `${billed}, as estimated.`;
  const percent = Math.round(Math.abs(gap) * 100);
  return `${billed}. The estimate was ${formatEstimateCredits(cost.estimate)}, so it cost ${percent} percent ${gap > 0 ? "more" : "less"}.`;
}

/**
 * "9.5 credits" or "about 8.44 credits", for a sentence that has to name what
 * a row cost. Null when neither a bill nor an estimate is known.
 *
 * The delete dialog is the caller: money is the part of a deleted generation
 * that does not come back, so it is the figure that makes the decision real.
 * It hedges the same way every other surface does, so the dialog and the
 * viewer's COST cell cannot quote one row two ways.
 *
 * **A row that produced nothing cost nothing.** `assetCost` falls back to the
 * price table, which answers for any row whatever its status, so a failed
 * generation would otherwise be mourned at the price it would have cost. Comfy
 * bills nothing for a failure: a refused row carries an estimate and no
 * charge at all. So only a billed figure, or a completed row whose
 * bill has not landed yet, is allowed to say a number here.
 */
export function spentText(asset: Asset): string | null {
  const cost = assetCost(asset);
  if (cost.actual !== null) return creditsText(cost.actual);
  if (asset.status !== "completed" || cost.estimate === null) return null;
  const body = `${formatEstimateCredits(cost.estimate)} ${creditsWord(cost.estimate)}`;
  return cost.confidence === "measured" ? body : `about ${body}`;
}

/** "seedream-5-0-pro-260628, standard tier": the id Comfy billed this under. */
export function billedAsText(asset: Asset): string | null {
  const model = asset.billedModel ?? null;
  const tier = asset.outputTier ?? null;
  if (model === null || model === "") return tier === null || tier === "" ? null : `${tier} tier`;
  return tier === null || tier === "" ? model : `${model}, ${tier} tier`;
}
