// ============================================================
// BASKET / INDEX ENGINE
// ------------------------------------------------------------
// Implements the index methodology described in
// `doc/index-implementation.pdf` (Parts 1–8), layered on top
// of the per-constituent Pauv bonding-curve markets in
// src/market/pauv-engine.ts.
//
// Two weighting modes are supported:
//
//   "equal"  — Pauv's launch methodology (PDF Parts 4, 6, 7).
//              Every constituent is 1/N of the index. The index
//              tracks the AVERAGE return since the last baseline:
//
//                  return_i   = price_i / baseline_i − 1
//                  avgReturn  = (1/N) · Σ return_i
//                  indexValue = anchorValue · (1 + avgReturn)
//
//              "anchorValue" is the index value captured at the
//              last rebaseline (launch / rebalance / composition
//              change). No explicit divisor is needed because
//              returns are already normalized (PDF Part 5).
//
//   "mcap"   — Market-cap weighting (PDF Parts 4, 5) for contrast.
//                  indexValue = Σ(price_i · supply_i) / divisor
//              Composition changes adjust the divisor so the value
//              is continuous:
//                  newDivisor = oldDivisor · (newTotal / oldTotal)
//
// Every state-changing entry point (launch / rebalance /
// add / remove) "rebaselines": it snapshots the CURRENT index
// value and re-anchors from there, so the displayed number never
// jumps on a non-market event — only real trading moves it.
// ============================================================

import {
  type PauvConfig,
  type PauvState,
  defaultConfig,
  defaultState,
  currentPrice as marketPrice,
} from "@/market/pauv-engine";

export type WeightingMode = "equal" | "mcap";

export interface Constituent {
  /** Stable id for the person/asset. */
  id: string;
  /** Display name. */
  name: string;
  /** This constituent's own bonding-curve market state. */
  market: PauvState;
  /** This constituent's curve parameters. */
  config: PauvConfig;
  /** Price captured at the last rebaseline (launch / rebalance / add). */
  baselinePrice: number;
  /** When this constituent joined the basket. */
  addedAt: string;
}

export type IndexEventType =
  | "launch"
  | "trade"
  | "rebalance"
  | "add"
  | "remove";

export interface IndexPoint {
  /** Monotonic sequence number (0 = launch). */
  seq: number;
  /** ISO timestamp. */
  t: string;
  /** Index value at this point. */
  value: number;
  /** What produced this point. */
  event: IndexEventType;
  /** Human-readable note (e.g. "added Grace", "weekly rebalance"). */
  note?: string;
  /** Number of constituents at this point. */
  n: number;
}

export interface Basket {
  id: string;
  name: string;
  weighting: WeightingMode;
  /** Base value chosen at launch (e.g. 1000) — PDF Part 5. */
  baseValue: number;
  /**
   * Index value at the last rebaseline. Equal-weight returns are
   * measured relative to this. (Unused by "mcap" mode.)
   */
  anchorValue: number;
  /** Divisor for "mcap" mode — PDF Part 5. (Unused by "equal" mode.) */
  divisor: number;
  constituents: Constituent[];
  /** Rebalance cadence in ms (weekly by default — PDF Part 6). */
  rebalanceIntervalMs: number;
  /** Timestamp (ms) of the last rebalance. */
  lastRebalanceAt: number;
  /** Index value time series. */
  history: IndexPoint[];
  /** Internal sequence counter for history points. */
  seq: number;
  createdAt: string;
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let basketIdCounter = 0;
function genBasketId(): string {
  basketIdCounter = (basketIdCounter + 1) % 1_000_000;
  return `basket_${Date.now()}_${basketIdCounter}`;
}

/** Spot price of a constituent's market right now. */
export function constituentPrice(c: Constituent): number {
  return marketPrice(c.market, c.config);
}

/**
 * "Supply" of a constituent for market-cap weighting. On a bonding curve
 * the live token supply is Q (PDF Part 2). Q can go slightly negative when
 * net shorting dominates; we floor at 0 so market cap stays well-defined.
 */
export function constituentSupply(c: Constituent): number {
  return Math.max(0, c.market.Q);
}

/** price × supply — PDF Part 2. */
export function constituentMarketCap(c: Constituent): number {
  return constituentPrice(c) * constituentSupply(c);
}

function totalMarketCap(constituents: Constituent[]): number {
  return constituents.reduce((s, c) => s + constituentMarketCap(c), 0);
}

/** return_i = price_i / baseline_i − 1  (PDF Part 3). */
export function constituentReturn(c: Constituent): number {
  if (!(c.baselinePrice > 0)) return 0;
  return constituentPrice(c) / c.baselinePrice - 1;
}

// ------------------------------------------------------------
// Core index-value computation (read-only)
// ------------------------------------------------------------

/**
 * The live index value, given the current constituent prices.
 *
 *  equal: anchorValue · (1 + averageReturn)      (PDF Parts 4, 7)
 *  mcap:  Σ(price·supply) / divisor              (PDF Parts 4, 5)
 */
export function indexValue(basket: Basket): number {
  if (basket.constituents.length === 0) return basket.anchorValue;

  if (basket.weighting === "mcap") {
    if (!(basket.divisor > 0)) return basket.anchorValue;
    return totalMarketCap(basket.constituents) / basket.divisor;
  }

  // equal weight
  const n = basket.constituents.length;
  const avgReturn =
    basket.constituents.reduce((s, c) => s + constituentReturn(c), 0) / n;
  return basket.anchorValue * (1 + avgReturn);
}

/** Per-constituent breakdown for UI / reporting. */
export interface ConstituentSnapshot {
  id: string;
  name: string;
  price: number;
  baselinePrice: number;
  return: number;
  supply: number;
  marketCap: number;
  /** Realized weight in the index right now (drifts between rebalances). */
  weight: number;
}

export function snapshotConstituents(basket: Basket): ConstituentSnapshot[] {
  const totMcap = totalMarketCap(basket.constituents);
  const n = basket.constituents.length;
  return basket.constituents.map((c) => {
    const price = constituentPrice(c);
    const mcap = constituentMarketCap(c);
    let weight: number;
    if (basket.weighting === "mcap") {
      weight = totMcap > 0 ? mcap / totMcap : 1 / Math.max(1, n);
    } else {
      // Realized equal-weight drift: a constituent's share of the basket is
      // proportional to its growth factor since the last rebaseline (PDF Part 6).
      const growth = c.baselinePrice > 0 ? price / c.baselinePrice : 1;
      const totalGrowth = basket.constituents.reduce(
        (s, x) => s + (x.baselinePrice > 0 ? constituentPrice(x) / x.baselinePrice : 1),
        0,
      );
      weight = totalGrowth > 0 ? growth / totalGrowth : 1 / Math.max(1, n);
    }
    return {
      id: c.id,
      name: c.name,
      price,
      baselinePrice: c.baselinePrice,
      return: constituentReturn(c),
      supply: constituentSupply(c),
      marketCap: mcap,
      weight,
    };
  });
}

// ------------------------------------------------------------
// History recording
// ------------------------------------------------------------

function pushPoint(
  basket: Basket,
  event: IndexEventType,
  note?: string,
): void {
  basket.history.push({
    seq: basket.seq++,
    t: new Date().toISOString(),
    value: indexValue(basket),
    event,
    note,
    n: basket.constituents.length,
  });
}

/**
 * Record the current index value as a "trade" point. Call this after any
 * constituent market trade so the index time series captures the move.
 * Returns the value recorded.
 */
export function recordTick(basket: Basket): number {
  pushPoint(basket, "trade");
  return basket.history[basket.history.length - 1].value;
}

// ------------------------------------------------------------
// Rebaseline — the shared mechanism behind launch / rebalance /
// composition change (PDF Part 5 "rebaseline" + Part 6 rebalance).
// ------------------------------------------------------------

/**
 * Re-anchor the index to a target value `v` without moving the displayed
 * number, then reset every constituent's baseline to its current price:
 *  - equal: anchorValue := v, baselines reset → all return clocks restart
 *           at 0 together, so indexValue stays at v.
 *  - mcap:  divisor := Σmcap / v, so Σmcap/divisor == v.
 *
 * The caller is responsible for capturing `v` at the right moment. For a
 * pure rebalance, `v` is the current value (no composition change). For a
 * composition change, `v` must be snapshotted BEFORE the constituent set is
 * mutated (PDF Part 7: "snapshot current index value" comes first).
 */
function reanchorTo(basket: Basket, v: number): void {
  if (basket.weighting === "mcap") {
    const totMcap = totalMarketCap(basket.constituents);
    basket.divisor = v > 0 ? totMcap / v : basket.divisor;
  }
  for (const c of basket.constituents) {
    c.baselinePrice = constituentPrice(c);
  }
  basket.anchorValue = v;
}

// ------------------------------------------------------------
// Lifecycle (PDF Part 7)
// ------------------------------------------------------------

export interface CreateBasketOptions {
  name: string;
  weighting?: WeightingMode;
  baseValue?: number;
  rebalanceIntervalMs?: number;
  constituents: Array<{
    id: string;
    name: string;
    market?: PauvState;
    config?: Partial<PauvConfig>;
  }>;
}

/**
 * Launch (T = 0) — PDF Part 7:
 *  [1] pick constituents  [2] pick base value (e.g. 1000)
 *  [3] record each current price as baseline  [4] weights = 1/N
 *  [5] index value = base value.
 */
export function createBasket(opts: CreateBasketOptions): Basket {
  const baseValue = opts.baseValue ?? 1000;
  const weighting = opts.weighting ?? "equal";

  const constituents: Constituent[] = opts.constituents.map((c) => {
    const config = defaultConfig(c.config);
    const market = c.market ?? defaultState();
    return {
      id: c.id,
      name: c.name,
      market,
      config,
      baselinePrice: marketPrice(market, config),
      addedAt: new Date().toISOString(),
    };
  });

  const now = Date.now();
  const basket: Basket = {
    id: genBasketId(),
    name: opts.name,
    weighting,
    baseValue,
    anchorValue: baseValue,
    divisor: 1, // set below for mcap
    constituents,
    rebalanceIntervalMs: opts.rebalanceIntervalMs ?? WEEK_MS,
    lastRebalanceAt: now,
    history: [],
    seq: 0,
    createdAt: new Date().toISOString(),
  };

  if (weighting === "mcap") {
    const totMcap = totalMarketCap(constituents);
    // Divisor = total_market_cap / base_value (PDF Part 5).
    basket.divisor = totMcap > 0 ? totMcap / baseValue : 1;
  }

  pushPoint(basket, "launch", `launched at ${baseValue}`);
  return basket;
}

/**
 * Rebalance (PDF Part 6): re-equalize weights by snapshotting the current
 * value and resetting every baseline to the current price. The index value
 * is unchanged at the instant of rebalance — only future trades move it.
 */
export function rebalance(basket: Basket, note = "rebalance"): Basket {
  // No composition change → current value is unchanged by the re-anchor.
  reanchorTo(basket, indexValue(basket));
  basket.lastRebalanceAt = Date.now();
  pushPoint(basket, "rebalance", note);
  return basket;
}

/** True if at least one rebalance interval has elapsed since the last one. */
export function isRebalanceDue(basket: Basket, now = Date.now()): boolean {
  return now - basket.lastRebalanceAt >= basket.rebalanceIntervalMs;
}

/**
 * Composition change — add a constituent (PDF Part 7 "Composition change"):
 *  [1] snapshot current index value  [2] update constituent list
 *  [3] recompute N  [4] set the newcomer's baseline to its current price
 *  [5] continue from the snapshot — the change is invisible to the value.
 */
export function addConstituent(
  basket: Basket,
  c: { id: string; name: string; market?: PauvState; config?: Partial<PauvConfig> },
): Basket {
  if (basket.constituents.some((x) => x.id === c.id)) {
    throw new Error(`Constituent ${c.id} already in basket`);
  }
  // [1] Snapshot the current value BEFORE the set changes (PDF Part 7).
  const v = indexValue(basket);
  const config = defaultConfig(c.config);
  const market = c.market ?? defaultState();
  // [2] Update the constituent list. [3] N recomputes implicitly.
  basket.constituents.push({
    id: c.id,
    name: c.name,
    market,
    config,
    baselinePrice: marketPrice(market, config),
    addedAt: new Date().toISOString(),
  });
  // [4] reset baselines (incl. newcomer) [5] continue from the snapshot.
  reanchorTo(basket, v);
  pushPoint(basket, "add", `added ${c.name}`);
  return basket;
}

/** Composition change — remove a constituent. Index value is continuous. */
export function removeConstituent(basket: Basket, id: string): Basket {
  const idx = basket.constituents.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`Constituent ${id} not in basket`);
  const removed = basket.constituents[idx];

  // Snapshot the value WITH the old set, then drop the member and re-anchor
  // so the displayed number does not jump.
  const v = indexValue(basket);
  basket.constituents.splice(idx, 1);
  reanchorTo(basket, v);

  pushPoint(basket, "remove", `removed ${removed.name}`);
  return basket;
}

// ------------------------------------------------------------
// Lookups
// ------------------------------------------------------------

export function getConstituent(basket: Basket, id: string): Constituent | undefined {
  return basket.constituents.find((c) => c.id === id);
}

export interface BasketSummary {
  id: string;
  name: string;
  weighting: WeightingMode;
  value: number;
  baseValue: number;
  /** Total return since launch. */
  totalReturn: number;
  n: number;
  rebalanceDue: boolean;
}

export function summarize(basket: Basket): BasketSummary {
  const value = indexValue(basket);
  return {
    id: basket.id,
    name: basket.name,
    weighting: basket.weighting,
    value,
    baseValue: basket.baseValue,
    totalReturn: basket.baseValue > 0 ? value / basket.baseValue - 1 : 0,
    n: basket.constituents.length,
    rebalanceDue: isRebalanceDue(basket),
  };
}
