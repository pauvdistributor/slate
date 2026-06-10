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
  buy,
  buyValue,
  sellTokens,
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
  /** Rebalance schedule over the SIMULATED calendar (PDF Part 6). */
  schedule: RebalanceSchedule;
  /** Simulated-time clock (ms since epoch) — when the sim "is". */
  clockMs: number;
  /** Simulated start time (ms). */
  startMs: number;
  /** The tradeable index vehicle (ETF): units, holders, pooled holdings. */
  ledger: IndexLedger;
  /** Index value time series. */
  history: IndexPoint[];
  /** Internal sequence counter for history points. */
  seq: number;
  createdAt: string;
}

export type RebalanceFrequency = "daily" | "weekly" | "monthly";

export interface RebalanceSchedule {
  frequency: RebalanceFrequency;
  /** 0=Sun … 6=Sat — used by "weekly" (default 5 = Friday). */
  weekday: number;
  /** 1..28 — used by "monthly". */
  dayOfMonth: number;
  /** Simulated time (ms) of the last rebalance. */
  lastRebalanceMs: number;
}

/**
 * The index vehicle ledger (ETF creation/redemption). Buying the index mints
 * units (price = index value) and deploys cash into the members' curves; the
 * pool holds the resulting tokens. Selling burns units and redeems pro-rata.
 */
export interface IndexLedger {
  unitsOutstanding: number;
  /** userId → index units held. */
  holders: Record<string, number>;
  /** constituentId → tokens the index pool holds on that curve. */
  poolTokens: Record<string, number>;
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Default simulated start: Monday, 1 Jan 2024 (so weekdays line up cleanly). */
export const DEFAULT_START_MS = Date.UTC(2024, 0, 1);
export const FRIDAY = 5;

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let basketIdCounter = 0;
function genBasketId(): string {
  basketIdCounter = (basketIdCounter + 1) % 1_000_000;
  return `basket_${Date.now()}_${basketIdCounter}`;
}

export function defaultSchedule(overrides?: Partial<RebalanceSchedule>): RebalanceSchedule {
  return {
    frequency: "weekly",
    weekday: FRIDAY,
    dayOfMonth: 1,
    lastRebalanceMs: DEFAULT_START_MS,
    ...overrides,
  };
}

function midnightUTC(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The next scheduled rebalance instant strictly after `afterMs`. */
export function nextRebalanceAfter(afterMs: number, s: RebalanceSchedule): number {
  if (s.frequency === "daily") {
    return midnightUTC(afterMs) + DAY_MS;
  }
  if (s.frequency === "weekly") {
    let t = midnightUTC(afterMs) + DAY_MS; // start at next day's midnight
    for (let i = 0; i < 8; i++) {
      if (new Date(t).getUTCDay() === s.weekday) return t;
      t += DAY_MS;
    }
    return t;
  }
  // monthly
  const d = new Date(afterMs);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  let t = Date.UTC(y, m, s.dayOfMonth);
  if (t <= afterMs) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
    t = Date.UTC(y, m, s.dayOfMonth);
  }
  return t;
}

function scheduleLabel(s: RebalanceSchedule): string {
  if (s.frequency === "weekly") return `weekly (${WEEKDAY_NAMES[s.weekday]})`;
  if (s.frequency === "monthly") return `monthly (day ${s.dayOfMonth})`;
  return "daily";
}

/** Human date for a sim instant, e.g. "Fri 2024-01-05". */
export function simDateLabel(ms: number): string {
  const d = new Date(ms);
  const day = WEEKDAY_NAMES[d.getUTCDay()];
  return `${day} ${d.toISOString().slice(0, 10)}`;
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
    t: new Date(basket.clockMs).toISOString(),
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
  schedule?: Partial<RebalanceSchedule>;
  startMs?: number;
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

  const startMs = opts.startMs ?? DEFAULT_START_MS;
  const basket: Basket = {
    id: genBasketId(),
    name: opts.name,
    weighting,
    baseValue,
    anchorValue: baseValue,
    divisor: 1, // set below for mcap
    constituents,
    schedule: defaultSchedule({ ...opts.schedule, lastRebalanceMs: startMs }),
    clockMs: startMs,
    startMs,
    ledger: { unitsOutstanding: 0, holders: {}, poolTokens: {} },
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
  basket.schedule.lastRebalanceMs = basket.clockMs;
  pushPoint(basket, "rebalance", note);
  return basket;
}

/** True if a scheduled rebalance is due at or before the current sim time. */
export function isRebalanceDue(basket: Basket): boolean {
  return nextRebalanceAfter(basket.schedule.lastRebalanceMs, basket.schedule) <= basket.clockMs;
}

/** The next scheduled rebalance instant (sim ms) for this basket. */
export function nextRebalanceMs(basket: Basket): number {
  return nextRebalanceAfter(basket.schedule.lastRebalanceMs, basket.schedule);
}

/**
 * Advance the simulated clock by `deltaMs`, firing any scheduled rebalances
 * whose instant falls within the elapsed window (each at its true date). This
 * is how "auto-rebalance every Friday" happens over the sim calendar.
 * Returns the number of rebalances fired.
 */
export function advanceTime(basket: Basket, deltaMs: number): number {
  if (!(deltaMs > 0)) return 0;
  const to = basket.clockMs + deltaMs;
  let fired = 0;
  let t = nextRebalanceAfter(basket.schedule.lastRebalanceMs, basket.schedule);
  while (t <= to) {
    basket.clockMs = t;
    reanchorTo(basket, indexValue(basket));
    basket.schedule.lastRebalanceMs = t;
    pushPoint(basket, "rebalance", `scheduled ${scheduleLabel(basket.schedule)} rebalance`);
    fired += 1;
    t = nextRebalanceAfter(t, basket.schedule);
  }
  basket.clockMs = to;
  return fired;
}

/** Change the rebalance schedule (re-anchors the "last" marker to now). */
export function setSchedule(basket: Basket, next: Partial<RebalanceSchedule>): Basket {
  basket.schedule = { ...basket.schedule, ...next, lastRebalanceMs: basket.clockMs };
  return basket;
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
// The index vehicle (ETF) — buy/sell index UNITS
// ------------------------------------------------------------
// Buying the index mints units (price = the index value) and DEPLOYS the cash
// into the members' bonding curves; the pool holds the resulting tokens.
// Selling burns units and redeems pro-rata (sells the pool's tokens back).
//
//   investInIndex / buyIndexUnits(basket, user, $X)
//       deploy $X by weight (equal ⇒ $X/N each; market-cap ⇒ pro-rata),
//       mint units = $X / indexValueAfter to `user`.
//
//   sellIndexUnits(basket, user, units)
//       sell that fraction of the pool's holdings, return cash, burn units.
//
//   investInPerson(basket, person, $X)
//       95% buys the person directly (a normal long position); the remaining
//       5% buys index UNITS for the investor (which deploys across the members).

export interface InvestAllocation {
  id: string;
  name: string;
  /** Net dollars sent to this constituent's curve (negative on redemption). */
  amount: number;
  /** Dollars from the direct/primary leg (single-person invest only). */
  primaryAmount: number;
  /** Dollars from the index leg. */
  indexAmount: number;
  /** Share of the total invested amount (0..1). */
  pct: number;
  isPrimary: boolean;
  tokens: number;
  priceBefore: number;
  priceAfter: number;
}

/**
 * Dollar split of `amount` across constituents by index weight:
 *  - equal weight ⇒ amount/N each
 *  - market-cap   ⇒ amount × marketCap_i / Σ marketCap   (pro-rata)
 */
function indexAllocationSplit(basket: Basket, amount: number): Map<string, number> {
  const cons = basket.constituents;
  const out = new Map<string, number>();
  if (cons.length === 0 || !(amount > 0)) {
    for (const c of cons) out.set(c.id, 0);
    return out;
  }
  if (basket.weighting === "mcap") {
    const tot = totalMarketCap(cons);
    for (const c of cons) {
      out.set(c.id, tot > 0 ? amount * (constituentMarketCap(c) / tot) : amount / cons.length);
    }
  } else {
    const per = amount / cons.length;
    for (const c of cons) out.set(c.id, per);
  }
  return out;
}

export interface IndexInvestResult {
  basket: Basket;
  amount: number;
  /** Index units minted to the holder. */
  units: number;
  /** Price paid per unit (= index value after deployment). */
  unitPrice: number;
  holder: string;
  allocations: InvestAllocation[];
  indexBefore: number;
  indexAfter: number;
}

/**
 * Buy `amount` of the index for `userId`: deploy into the members' curves and
 * mint index units. Mutates the basket in place.
 */
export function buyIndexUnits(
  basket: Basket,
  userId: string,
  amount: number,
  opts?: { primaryMap?: Map<string, number> },
): IndexInvestResult {
  if (basket.constituents.length === 0) throw new Error("basket has no constituents");
  if (!(amount > 0)) throw new Error("amount must be positive");

  const indexBefore = indexValue(basket);
  const indexSplit = indexAllocationSplit(basket, amount);
  const primaryMap = opts?.primaryMap ?? new Map<string, number>();

  const allocations: InvestAllocation[] = [];
  for (const c of basket.constituents) {
    const indexAmount = indexSplit.get(c.id) ?? 0;
    const primaryAmount = primaryMap.get(c.id) ?? 0;
    const a = indexAmount + primaryAmount;
    const priceBefore = constituentPrice(c);
    let tokens = 0;
    let priceAfter = priceBefore;
    if (a > 0) {
      // The index leg goes to the pool (positionless); a primary leg, if any,
      // is a direct user position handled by investInPerson — not here.
      const res = buyValue(c.market, c.config, a, "index-pool");
      c.market = res.state;
      tokens = res.tokens;
      priceAfter = res.newPrice;
      basket.ledger.poolTokens[c.id] = (basket.ledger.poolTokens[c.id] ?? 0) + tokens;
    }
    allocations.push({
      id: c.id, name: c.name, amount: a, primaryAmount, indexAmount,
      pct: amount > 0 ? a / amount : 0, isPrimary: false, tokens, priceBefore, priceAfter,
    });
  }

  const unitPrice = indexValue(basket); // mint at post-deployment index value
  const units = unitPrice > 0 ? amount / unitPrice : 0;
  basket.ledger.unitsOutstanding += units;
  basket.ledger.holders[userId] = (basket.ledger.holders[userId] ?? 0) + units;

  const indexAfter = recordTick(basket);
  return { basket, amount, units, unitPrice, holder: userId, allocations, indexBefore, indexAfter };
}

/** Alias: invest in the index as a whole (mints units to `investorId`). */
export function investInIndex(
  basket: Basket,
  amount: number,
  opts?: { investorId?: string },
): IndexInvestResult {
  return buyIndexUnits(basket, opts?.investorId ?? "index-investor", amount);
}

export interface IndexRedeemResult {
  basket: Basket;
  units: number;
  cashOut: number;
  holder: string;
  allocations: InvestAllocation[];
  indexBefore: number;
  indexAfter: number;
}

/**
 * Redeem `units` of the index for `userId`: sell that fraction of the pool's
 * holdings pro-rata and return the cash. Mutates the basket in place.
 */
export function sellIndexUnits(
  basket: Basket,
  userId: string,
  units: number,
): IndexRedeemResult {
  const held = basket.ledger.holders[userId] ?? 0;
  const u = Math.min(units, held);
  if (!(u > 0)) throw new Error("no units to redeem");
  const totalUnits = basket.ledger.unitsOutstanding;
  const f = totalUnits > 0 ? u / totalUnits : 0;

  const indexBefore = indexValue(basket);
  const allocations: InvestAllocation[] = [];
  let cashOut = 0;
  for (const c of basket.constituents) {
    const poolTk = basket.ledger.poolTokens[c.id] ?? 0;
    const tk = poolTk * f;
    const priceBefore = constituentPrice(c);
    let proceeds = 0;
    let priceAfter = priceBefore;
    if (tk > 0) {
      const res = sellTokens(c.market, c.config, tk, "index-pool");
      c.market = res.state;
      proceeds = res.netProceeds;
      priceAfter = res.newPrice;
      basket.ledger.poolTokens[c.id] = poolTk - tk;
    }
    cashOut += proceeds;
    allocations.push({
      id: c.id, name: c.name, amount: -proceeds, primaryAmount: 0, indexAmount: -proceeds,
      pct: 0, isPrimary: false, tokens: -tk, priceBefore, priceAfter,
    });
  }

  basket.ledger.unitsOutstanding = Math.max(0, totalUnits - u);
  basket.ledger.holders[userId] = held - u;

  const indexAfter = recordTick(basket);
  return { basket, units: u, cashOut, holder: userId, allocations, indexBefore, indexAfter };
}

export interface InvestResult {
  basket: Basket;
  personId: string;
  amount: number;
  /** Fraction routed directly to the primary (e.g. 0.95). */
  primaryPct: number;
  /** Effective fraction the primary actually received (direct + its index slice). */
  effectivePrimaryPct: number;
  /** Dollars sent through the index leg (the "5%"). */
  indexAmount: number;
  /** Index units minted to the investor from the index leg. */
  units: number;
  allocations: InvestAllocation[];
  indexBefore: number;
  indexAfter: number;
}

/**
 * Preview the per-constituent dollar allocation for a single-person invest,
 * without executing anything. Returns the direct, index, and total legs.
 */
export function previewInvestment(
  basket: Basket,
  personId: string,
  amount: number,
  primaryPct = 0.95,
): InvestAllocation[] {
  const n = basket.constituents.length;
  if (n === 0 || !(amount > 0)) return [];
  const primaryAmt = amount * primaryPct;
  const indexSplit = indexAllocationSplit(basket, amount * (1 - primaryPct));
  return basket.constituents.map((c) => {
    const isPrimary = c.id === personId;
    const indexAmount = indexSplit.get(c.id) ?? 0;
    const primaryAmount = isPrimary ? primaryAmt : 0;
    const a = indexAmount + primaryAmount;
    return {
      id: c.id, name: c.name, amount: a, primaryAmount, indexAmount,
      pct: a / amount, isPrimary, tokens: 0, priceBefore: constituentPrice(c), priceAfter: constituentPrice(c),
    };
  });
}

/**
 * Execute a single-person investment: `primaryPct` (95%) buys the person
 * directly as a long position; the rest buys index UNITS for the investor
 * (which deploys across the members). Mutates the basket in place.
 */
export function investInPerson(
  basket: Basket,
  personId: string,
  amount: number,
  opts?: { primaryPct?: number; investorId?: string },
): InvestResult {
  const primaryPct = opts?.primaryPct ?? 0.95;
  const investorId = opts?.investorId ?? "investor";
  const person = getConstituent(basket, personId);
  if (basket.constituents.length === 0) throw new Error("basket has no constituents");
  if (!person) throw new Error(`person ${personId} not in basket`);
  if (!(amount > 0)) throw new Error("amount must be positive");

  const indexBefore = indexValue(basket);
  const primaryAmt = amount * primaryPct;
  const indexAmt = amount * (1 - primaryPct);

  // 95% — direct long position in the person.
  const personPriceBefore = constituentPrice(person);
  let personTokens = 0;
  if (primaryAmt > 0) {
    const res = buy(person.market, person.config, investorId, primaryAmt);
    person.market = res.state;
    personTokens = res.tokens;
  }

  // 5% — buy index units for the investor (deploys across the members + records the tick).
  const idx = indexAmt > 0 ? buyIndexUnits(basket, investorId, indexAmt) : null;

  // Merge allocations: start from the index leg, patch in the person's direct buy.
  const allocations: InvestAllocation[] = (idx?.allocations ?? basket.constituents.map((c) => ({
    id: c.id, name: c.name, amount: 0, primaryAmount: 0, indexAmount: 0,
    pct: 0, isPrimary: false, tokens: 0, priceBefore: constituentPrice(c), priceAfter: constituentPrice(c),
  }))).map((a) => {
    if (a.id !== personId) return a;
    return {
      ...a,
      amount: a.amount + primaryAmt,
      primaryAmount: primaryAmt,
      isPrimary: true,
      tokens: a.tokens + personTokens,
      priceBefore: personPriceBefore,
      priceAfter: constituentPrice(person),
      pct: amount > 0 ? (a.amount + primaryAmt) / amount : 0,
    };
  });

  // If there was no index leg (primaryPct=1) we still must record a tick.
  const indexAfter = idx ? idx.indexAfter : recordTick(basket);
  const personIndexSlice = idx?.allocations.find((a) => a.id === personId)?.indexAmount ?? 0;

  return {
    basket,
    personId,
    amount,
    primaryPct,
    effectivePrimaryPct: (primaryAmt + personIndexSlice) / amount,
    indexAmount: indexAmt,
    units: idx?.units ?? 0,
    allocations,
    indexBefore,
    indexAfter,
  };
}

// ------------------------------------------------------------
// Vehicle holdings views
// ------------------------------------------------------------

/** Current price of one index unit (= the index value). */
export function unitPrice(basket: Basket): number {
  return indexValue(basket);
}

/** Dollar value of a holder's index units right now. */
export function holderValue(basket: Basket, userId: string): number {
  return (basket.ledger.holders[userId] ?? 0) * unitPrice(basket);
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
