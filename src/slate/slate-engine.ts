// ============================================================
// SLATE ENGINE
// ------------------------------------------------------------
// Implements the slate methodology described in
// `doc/index-implementation.pdf` (Parts 1–8), layered on top
// of the per-constituent Pauv bonding-curve markets in
// src/market/pauv-engine.ts.
//
// Slates are equal-weight (Pauv's launch methodology, PDF
// Parts 4, 6, 7). Every constituent is 1/N of the slate. The
// slate tracks the AVERAGE return since the last baseline:
//
//     return_i   = price_i / baseline_i − 1
//     avgReturn  = (1/N) · Σ return_i
//     slateValue = anchorValue · (1 + avgReturn)
//
// "anchorValue" is the slate value captured at the last
// rebaseline (launch / rebalance / composition change). No
// explicit divisor is needed because returns are already
// normalized (PDF Part 5).
//
// Every state-changing entry point (launch / rebalance /
// add / remove) "rebaselines": it snapshots the CURRENT slate
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
  sell,
  shortOpen,
  shortClose,
  getPositions,
  getClosedPositions,
  getTreasuryBalance,
  type PositionWithMetrics,
  type ClosedPositionRecord,
} from "@/market/pauv-engine";

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
  /** When this constituent joined the slate. */
  addedAt: string;
}

export type SlateEventType =
  | "launch"
  | "trade"
  | "rebalance"
  | "add"
  | "remove";

export interface SlatePoint {
  /** Monotonic sequence number (0 = launch). */
  seq: number;
  /** ISO timestamp. */
  t: string;
  /** Slate value at this point. */
  value: number;
  /** What produced this point. */
  event: SlateEventType;
  /** Human-readable note (e.g. "added Grace", "weekly rebalance"). */
  note?: string;
  /** Number of constituents at this point. */
  n: number;
}

export interface Slate {
  id: string;
  name: string;
  /** The creator-chosen INITIAL slate value (the launch value). */
  baseValue: number;
  /**
   * Slate value at the last rebaseline. Returns are measured
   * relative to this.
   */
  anchorValue: number;
  constituents: Constituent[];
  /** Rebalance schedule over the SIMULATED calendar (PDF Part 6). */
  schedule: RebalanceSchedule;
  /** Simulated-time clock (ms since epoch) — when the sim "is". */
  clockMs: number;
  /** Simulated start time (ms). */
  startMs: number;
  /** The tradeable slate vehicle (ETF): units, holders, pooled holdings. */
  ledger: SlateLedger;
  /**
   * Direct-position id → the slate leg its invest/short auto-opened, so
   * closing the direct position unwinds the slate side too. Optional for
   * backward compatibility with persisted slates.
   */
  linkedLegs?: Record<string, LinkedSlateLeg>;
  /**
   * Every position id EVER opened as a slate leg (the member shorts of a
   * person order). linkedLegs entries are deleted when a leg unwinds, but
   * the txLog keeps its history — this registry lets reads tag those txs
   * as slate flows forever. (Long legs need no entry: the pool buys under
   * userId "slate-pool".) Optional for persisted slates from before it.
   */
  slateLegIds?: Record<string, true>;
  /** Slate value time series. */
  history: SlatePoint[];
  /** Internal sequence counter for history points. */
  seq: number;
  createdAt: string;
}

/** What a direct position's auto-spread slate leg opened alongside it. */
export interface LinkedSlateLeg {
  /** Slate units minted by a long invest's slate leg. */
  units?: number;
  /** Dollars the slate leg cost at open (longs; used for the leg's P&L). */
  cost?: number;
  /** Per-member short positions opened by a short's slate leg. */
  shorts?: Array<{ constituentId: string; positionId: string }>;
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
 * The slate vehicle ledger (ETF creation/redemption). Buying the slate mints
 * units (price = slate value) and deploys cash into the members' curves; the
 * pool holds the resulting tokens. Selling burns units and redeems pro-rata.
 */
export interface SlateLedger {
  unitsOutstanding: number;
  /** userId → slate units held. */
  holders: Record<string, number>;
  /** constituentId → tokens the slate pool holds on that curve. */
  poolTokens: Record<string, number>;
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Fee charged on the DIRECT leg of a single-person order (long or short),
 * both when it opens and when it closes. Slate buys and the auto-spread
 * slate legs are always fee-free.
 */
export const DIRECT_FEE_RATE = 0.018;

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Default simulated start: Monday, 1 Jan 2024 (so weekdays line up cleanly). */
export const DEFAULT_START_MS = Date.UTC(2024, 0, 1);
export const FRIDAY = 5;

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let slateIdCounter = 0;
function genSlateId(): string {
  slateIdCounter = (slateIdCounter + 1) % 1_000_000;
  return `slate_${Date.now()}_${slateIdCounter}`;
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
 * "Supply" of a constituent (informational). On a bonding curve the live
 * token supply is Q (PDF Part 2). Q can go slightly negative when net
 * shorting dominates; we floor at 0 so market cap stays well-defined.
 */
export function constituentSupply(c: Constituent): number {
  return Math.max(0, c.market.Q);
}

/** price × supply — PDF Part 2 (informational; not used in valuation). */
export function constituentMarketCap(c: Constituent): number {
  return constituentPrice(c) * constituentSupply(c);
}

/** return_i = price_i / baseline_i − 1  (PDF Part 3). */
export function constituentReturn(c: Constituent): number {
  if (!(c.baselinePrice > 0)) return 0;
  return constituentPrice(c) / c.baselinePrice - 1;
}

// ------------------------------------------------------------
// Core slate-value computation (read-only)
// ------------------------------------------------------------

/**
 * The live slate value, given the current constituent prices:
 * anchorValue · (1 + averageReturn)      (PDF Parts 4, 7)
 */
export function slateValue(slate: Slate): number {
  if (slate.constituents.length === 0) return slate.anchorValue;

  const n = slate.constituents.length;
  const avgReturn =
    slate.constituents.reduce((s, c) => s + constituentReturn(c), 0) / n;
  return slate.anchorValue * (1 + avgReturn);
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
  /** Realized weight in the slate right now (drifts between rebalances). */
  weight: number;
}

export function snapshotConstituents(slate: Slate): ConstituentSnapshot[] {
  const n = slate.constituents.length;
  return slate.constituents.map((c) => {
    const price = constituentPrice(c);
    const mcap = constituentMarketCap(c);
    // Realized equal-weight drift: a constituent's share of the slate is
    // proportional to its growth factor since the last rebaseline (PDF Part 6).
    const growth = c.baselinePrice > 0 ? price / c.baselinePrice : 1;
    const totalGrowth = slate.constituents.reduce(
      (s, x) => s + (x.baselinePrice > 0 ? constituentPrice(x) / x.baselinePrice : 1),
      0,
    );
    const weight = totalGrowth > 0 ? growth / totalGrowth : 1 / Math.max(1, n);
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
  slate: Slate,
  event: SlateEventType,
  note?: string,
): void {
  slate.history.push({
    seq: slate.seq++,
    t: new Date(slate.clockMs).toISOString(),
    value: slateValue(slate),
    event,
    note,
    n: slate.constituents.length,
  });
}

/**
 * Record the current slate value as a "trade" point. Call this after any
 * constituent market trade so the slate time series captures the move.
 * Returns the value recorded.
 */
export function recordTick(slate: Slate): number {
  pushPoint(slate, "trade");
  return slate.history[slate.history.length - 1].value;
}

// ------------------------------------------------------------
// Rebaseline — the shared mechanism behind launch / rebalance /
// composition change (PDF Part 5 "rebaseline" + Part 6 rebalance).
// ------------------------------------------------------------

/**
 * Re-anchor the slate to a target value `v` without moving the displayed
 * number, then reset every constituent's baseline to its current price:
 * anchorValue := v, baselines reset → all return clocks restart at 0
 * together, so slateValue stays at v.
 *
 * The caller is responsible for capturing `v` at the right moment. For a
 * pure rebalance, `v` is the current value (no composition change). For a
 * composition change, `v` must be snapshotted BEFORE the constituent set is
 * mutated (PDF Part 7: "snapshot current slate value" comes first).
 */
function reanchorTo(slate: Slate, v: number): void {
  for (const c of slate.constituents) {
    c.baselinePrice = constituentPrice(c);
  }
  slate.anchorValue = v;
}

// ------------------------------------------------------------
// Lifecycle (PDF Part 7)
// ------------------------------------------------------------

export interface CreateSlateOptions {
  name: string;
  /** The INITIAL slate value, chosen by the creator (default 1000). */
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
 *  [1] pick constituents  [2] the creator SETS the initial slate value
 *  [3] record each current price as baseline  [4] weights = 1/N
 *  [5] slate value = the chosen initial value.
 */
export function createSlate(opts: CreateSlateOptions): Slate {
  const baseValue = opts.baseValue ?? 1000;

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
  const slate: Slate = {
    id: genSlateId(),
    name: opts.name,
    baseValue,
    anchorValue: baseValue,
    constituents,
    schedule: defaultSchedule({ ...opts.schedule, lastRebalanceMs: startMs }),
    clockMs: startMs,
    startMs,
    ledger: { unitsOutstanding: 0, holders: {}, poolTokens: {} },
    history: [],
    seq: 0,
    createdAt: new Date().toISOString(),
  };

  pushPoint(slate, "launch", `launched at ${baseValue}`);
  return slate;
}

/**
 * Rebalance (PDF Part 6): re-equalize weights by snapshotting the current
 * value and resetting every baseline to the current price. The slate value
 * is unchanged at the instant of rebalance — only future trades move it.
 */
export function rebalance(slate: Slate, note = "rebalance"): Slate {
  // No composition change → current value is unchanged by the re-anchor.
  reanchorTo(slate, slateValue(slate));
  slate.schedule.lastRebalanceMs = slate.clockMs;
  pushPoint(slate, "rebalance", note);
  return slate;
}

/** True if a scheduled rebalance is due at or before the current sim time. */
export function isRebalanceDue(slate: Slate): boolean {
  return nextRebalanceAfter(slate.schedule.lastRebalanceMs, slate.schedule) <= slate.clockMs;
}

/** The next scheduled rebalance instant (sim ms) for this slate. */
export function nextRebalanceMs(slate: Slate): number {
  return nextRebalanceAfter(slate.schedule.lastRebalanceMs, slate.schedule);
}

/**
 * Advance the simulated clock by `deltaMs`, firing any scheduled rebalances
 * whose instant falls within the elapsed window (each at its true date). This
 * is how "auto-rebalance every Friday" happens over the sim calendar.
 * Returns the number of rebalances fired.
 */
export function advanceTime(slate: Slate, deltaMs: number): number {
  if (!(deltaMs > 0)) return 0;
  const to = slate.clockMs + deltaMs;
  let fired = 0;
  let t = nextRebalanceAfter(slate.schedule.lastRebalanceMs, slate.schedule);
  while (t <= to) {
    slate.clockMs = t;
    reanchorTo(slate, slateValue(slate));
    slate.schedule.lastRebalanceMs = t;
    pushPoint(slate, "rebalance", `scheduled ${scheduleLabel(slate.schedule)} rebalance`);
    fired += 1;
    t = nextRebalanceAfter(t, slate.schedule);
  }
  slate.clockMs = to;
  return fired;
}

/** Change the rebalance schedule (re-anchors the "last" marker to now). */
export function setSchedule(slate: Slate, next: Partial<RebalanceSchedule>): Slate {
  slate.schedule = { ...slate.schedule, ...next, lastRebalanceMs: slate.clockMs };
  return slate;
}

/**
 * Composition change — add a constituent (PDF Part 7 "Composition change"):
 *  [1] snapshot current slate value  [2] update constituent list
 *  [3] recompute N  [4] set the newcomer's baseline to its current price
 *  [5] continue from the snapshot — the change is invisible to the value.
 */
export function addConstituent(
  slate: Slate,
  c: { id: string; name: string; market?: PauvState; config?: Partial<PauvConfig> },
): Slate {
  if (slate.constituents.some((x) => x.id === c.id)) {
    throw new Error(`Constituent ${c.id} already in slate`);
  }
  // [1] Snapshot the current value BEFORE the set changes (PDF Part 7).
  const v = slateValue(slate);
  const config = defaultConfig(c.config);
  const market = c.market ?? defaultState();
  // [2] Update the constituent list. [3] N recomputes implicitly.
  slate.constituents.push({
    id: c.id,
    name: c.name,
    market,
    config,
    baselinePrice: marketPrice(market, config),
    addedAt: new Date().toISOString(),
  });
  // [4] reset baselines (incl. newcomer) [5] continue from the snapshot.
  reanchorTo(slate, v);
  pushPoint(slate, "add", `added ${c.name}`);
  return slate;
}

/** Composition change — remove a constituent. Slate value is continuous. */
export function removeConstituent(slate: Slate, id: string): Slate {
  const idx = slate.constituents.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`Constituent ${id} not in slate`);
  const removed = slate.constituents[idx];

  // Snapshot the value WITH the old set, then drop the member and re-anchor
  // so the displayed number does not jump.
  const v = slateValue(slate);
  slate.constituents.splice(idx, 1);
  reanchorTo(slate, v);

  pushPoint(slate, "remove", `removed ${removed.name}`);
  return slate;
}

// ------------------------------------------------------------
// The slate vehicle (ETF) — slate UNITS, auto-spread only
// ------------------------------------------------------------
// The slate is NOT directly tradeable. Units are minted only by the slate
// leg of a person order (investInPerson's 5%) and burned only by the linked
// unwind when that direct position closes (closePersonPosition). The pool
// mechanics live in the private helpers below:
//
//   buySlateUnits(slate, user, $X)        [internal]
//       deploy $X/N into each member's curve,
//       mint units = $X / slateValueAfter to `user`.
//
//   sellSlateUnits(slate, user, units)    [internal]
//       sell that fraction of the pool's holdings, return cash, burn units.
//
//   investInPerson(slate, person, $X)     [the public entry point]
//       95% buys the person directly (a normal long position); the remaining
//       5% mints slate units for the investor (deploys across the members).

export interface InvestAllocation {
  id: string;
  name: string;
  /** Net dollars sent to this constituent's curve (negative on redemption). */
  amount: number;
  /** Dollars from the direct/primary leg (single-person invest only). */
  primaryAmount: number;
  /** Dollars from the slate leg. */
  slateAmount: number;
  /** Share of the total invested amount (0..1). */
  pct: number;
  isPrimary: boolean;
  tokens: number;
  priceBefore: number;
  priceAfter: number;
}

/** Dollar split of `amount` across constituents: amount/N each. */
function slateAllocationSplit(slate: Slate, amount: number): Map<string, number> {
  const cons = slate.constituents;
  const out = new Map<string, number>();
  if (cons.length === 0 || !(amount > 0)) {
    for (const c of cons) out.set(c.id, 0);
    return out;
  }
  const per = amount / cons.length;
  for (const c of cons) out.set(c.id, per);
  return out;
}

interface SlateInvestResult {
  slate: Slate;
  amount: number;
  /** Slate units minted to the holder. */
  units: number;
  /** Price paid per unit (= slate value after deployment). */
  unitPrice: number;
  holder: string;
  allocations: InvestAllocation[];
  slateBefore: number;
  slateAfter: number;
}

/**
 * INTERNAL — the auto-spread's mint: deploy `amount` into the members' curves
 * and mint slate units to `userId`. Only reachable through investInPerson's
 * slate leg; there is deliberately no public way to buy units.
 */
function buySlateUnits(
  slate: Slate,
  userId: string,
  amount: number,
  opts?: { primaryMap?: Map<string, number> },
): SlateInvestResult {
  if (slate.constituents.length === 0) throw new Error("slate has no constituents");
  if (!(amount > 0)) throw new Error("amount must be positive");

  const slateBefore = slateValue(slate);
  const slateSplit = slateAllocationSplit(slate, amount);
  const primaryMap = opts?.primaryMap ?? new Map<string, number>();

  const allocations: InvestAllocation[] = [];
  for (const c of slate.constituents) {
    const slateAmount = slateSplit.get(c.id) ?? 0;
    const primaryAmount = primaryMap.get(c.id) ?? 0;
    const a = slateAmount + primaryAmount;
    const priceBefore = constituentPrice(c);
    let tokens = 0;
    let priceAfter = priceBefore;
    if (a > 0) {
      // The slate leg goes to the pool (positionless); a primary leg, if any,
      // is a direct user position handled by investInPerson — not here.
      const res = buyValue(c.market, c.config, a, "slate-pool");
      c.market = res.state;
      tokens = res.tokens;
      priceAfter = res.newPrice;
      slate.ledger.poolTokens[c.id] = (slate.ledger.poolTokens[c.id] ?? 0) + tokens;
    }
    allocations.push({
      id: c.id, name: c.name, amount: a, primaryAmount, slateAmount,
      pct: amount > 0 ? a / amount : 0, isPrimary: false, tokens, priceBefore, priceAfter,
    });
  }

  const unitPrice = slateValue(slate); // mint at post-deployment slate value
  const units = unitPrice > 0 ? amount / unitPrice : 0;
  slate.ledger.unitsOutstanding += units;
  slate.ledger.holders[userId] = (slate.ledger.holders[userId] ?? 0) + units;

  const slateAfter = recordTick(slate);
  return { slate, amount, units, unitPrice, holder: userId, allocations, slateBefore, slateAfter };
}

interface SlateRedeemResult {
  slate: Slate;
  units: number;
  cashOut: number;
  holder: string;
  allocations: InvestAllocation[];
  slateBefore: number;
  slateAfter: number;
}

/**
 * INTERNAL — the auto-spread's unwind: redeem `units` for `userId` by selling
 * that fraction of the pool's holdings pro-rata. Only reachable through
 * closePersonPosition's linked-leg unwind; there is deliberately no public
 * way to sell units.
 */
function sellSlateUnits(
  slate: Slate,
  userId: string,
  units: number,
): SlateRedeemResult {
  const held = slate.ledger.holders[userId] ?? 0;
  const u = Math.min(units, held);
  if (!(u > 0)) throw new Error("no units to redeem");
  const totalUnits = slate.ledger.unitsOutstanding;
  const f = totalUnits > 0 ? u / totalUnits : 0;

  const slateBefore = slateValue(slate);
  const allocations: InvestAllocation[] = [];
  let cashOut = 0;
  for (const c of slate.constituents) {
    const poolTk = slate.ledger.poolTokens[c.id] ?? 0;
    const tk = poolTk * f;
    const priceBefore = constituentPrice(c);
    let proceeds = 0;
    let priceAfter = priceBefore;
    if (tk > 0) {
      const res = sellTokens(c.market, c.config, tk, "slate-pool");
      c.market = res.state;
      proceeds = res.netProceeds;
      priceAfter = res.newPrice;
      slate.ledger.poolTokens[c.id] = poolTk - tk;
    }
    cashOut += proceeds;
    allocations.push({
      id: c.id, name: c.name, amount: -proceeds, primaryAmount: 0, slateAmount: -proceeds,
      pct: 0, isPrimary: false, tokens: -tk, priceBefore, priceAfter,
    });
  }

  slate.ledger.unitsOutstanding = Math.max(0, totalUnits - u);
  slate.ledger.holders[userId] = held - u;

  const slateAfter = recordTick(slate);
  return { slate, units: u, cashOut, holder: userId, allocations, slateBefore, slateAfter };
}

export interface InvestResult {
  slate: Slate;
  personId: string;
  /** Direct long position id (undefined when primaryPct = 0). */
  positionId?: string;
  amount: number;
  /** Fraction routed directly to the primary (e.g. 0.95). */
  primaryPct: number;
  /** Effective fraction the primary actually received (direct + its slate slice). */
  effectivePrimaryPct: number;
  /** Dollars sent through the slate leg (the "5%"). */
  slateAmount: number;
  /** Slate units minted to the investor from the slate leg. */
  units: number;
  allocations: InvestAllocation[];
  /** Slate legs auto-closed because this buy liquidated their parents. */
  cascadeClosures: CascadeClosure[];
  slateBefore: number;
  slateAfter: number;
}

/**
 * Preview the per-constituent dollar allocation for a single-person invest,
 * without executing anything. Returns the direct, slate, and total legs.
 */
export function previewInvestment(
  slate: Slate,
  personId: string,
  amount: number,
  primaryPct = 0.95,
): InvestAllocation[] {
  const n = slate.constituents.length;
  if (n === 0 || !(amount > 0)) return [];
  const primaryAmt = amount * primaryPct;
  const slateSplit = slateAllocationSplit(slate, amount * (1 - primaryPct));
  return slate.constituents.map((c) => {
    const isPrimary = c.id === personId;
    const slateAmount = slateSplit.get(c.id) ?? 0;
    const primaryAmount = isPrimary ? primaryAmt : 0;
    const a = slateAmount + primaryAmount;
    return {
      id: c.id, name: c.name, amount: a, primaryAmount, slateAmount,
      pct: a / amount, isPrimary, tokens: 0, priceBefore: constituentPrice(c), priceAfter: constituentPrice(c),
    };
  });
}

/**
 * Execute a single-person investment: `primaryPct` (95%) buys the person
 * directly as a long position; the rest buys slate UNITS for the investor
 * (which deploys across the members). Mutates the slate in place.
 */
export function investInPerson(
  slate: Slate,
  personId: string,
  amount: number,
  opts?: { primaryPct?: number; investorId?: string; feeRate?: number },
): InvestResult {
  const primaryPct = opts?.primaryPct ?? 0.95;
  const investorId = opts?.investorId ?? "investor";
  const person = getConstituent(slate, personId);
  if (slate.constituents.length === 0) throw new Error("slate has no constituents");
  if (!person) throw new Error(`person ${personId} not in slate`);
  if (!(amount > 0)) throw new Error("amount must be positive");

  const slateBefore = slateValue(slate);
  const primaryAmt = amount * primaryPct;
  const slateAmt = amount * (1 - primaryPct);

  // 95% — direct long position in the person. Only this leg pays the fee;
  // the slate leg below trades the curves fee-free.
  const personPriceBefore = constituentPrice(person);
  let personTokens = 0;
  let directPositionId: string | undefined;
  if (primaryAmt > 0) {
    const res = buy(person.market, { ...person.config, feeRate: opts?.feeRate ?? 0 }, investorId, primaryAmt);
    person.market = res.state;
    personTokens = res.tokens;
    directPositionId = res.positionId;
  }

  // 5% — buy slate units for the investor (deploys across the members + records the tick).
  const idx = slateAmt > 0 ? buySlateUnits(slate, investorId, slateAmt) : null;

  // Link the minted units to the direct position so closing it unwinds them.
  if (directPositionId && idx && idx.units > 0) {
    (slate.linkedLegs ??= {})[directPositionId] = { units: idx.units, cost: slateAmt };
  }

  // The buys above can liquidate open shorts; auto-close the slate legs of
  // any parent position those liquidations took out.
  const cascadeClosures = sweepLiquidatedParents(slate);

  // Merge allocations: start from the slate leg, patch in the person's direct buy.
  const allocations: InvestAllocation[] = (idx?.allocations ?? slate.constituents.map((c) => ({
    id: c.id, name: c.name, amount: 0, primaryAmount: 0, slateAmount: 0,
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

  // If there was no slate leg (primaryPct=1) we still must record a tick;
  // a cascade unwind moved the curves again, so it needs its own tick too.
  const slateAfter = !idx || cascadeClosures.length > 0 ? recordTick(slate) : idx.slateAfter;
  const personSlateSlice = idx?.allocations.find((a) => a.id === personId)?.slateAmount ?? 0;

  return {
    slate,
    personId,
    positionId: directPositionId,
    amount,
    primaryPct,
    effectivePrimaryPct: (primaryAmt + personSlateSlice) / amount,
    slateAmount: slateAmt,
    units: idx?.units ?? 0,
    allocations,
    cascadeClosures,
    slateBefore,
    slateAfter,
  };
}

// ------------------------------------------------------------
// Vehicle holdings views
// ------------------------------------------------------------

/** Current price of one slate unit (= the slate value). */
export function unitPrice(slate: Slate): number {
  return slateValue(slate);
}

/** Dollar value of a holder's slate units right now. */
export function holderValue(slate: Slate, userId: string): number {
  return (slate.ledger.holders[userId] ?? 0) * unitPrice(slate);
}

/**
 * Total fees collected across every account on this slate. Fees land in each
 * constituent market's treasury, and only direct legs ever pay them, so the
 * sum of treasuries is exactly the fees paid.
 */
export function totalFeesPaid(slate: Slate): number {
  return slate.constituents.reduce((s, c) => s + getTreasuryBalance(c.market), 0);
}

// ------------------------------------------------------------
// Per-person price history & direct trading
// ------------------------------------------------------------
// A constituent's market already logs every trade with priceBefore/priceAfter
// — including the slate pool's legs (userId "slate-pool") — so a per-person
// price series falls straight out of the txLog with no extra storage.

/** Where a price move came from. */
export type PriceMoveSource = "launch" | "order" | "slate" | "liquidation";

export interface PersonPricePoint {
  /** 0 = launch, then one point per market transaction. */
  seq: number;
  /** ISO timestamp of the transaction (wall clock, not sim time). */
  t: string;
  price: number;
  /** Market event ("buy", "sell", "short_open", "short_close", "liquidation"). */
  event: string;
  source: PriceMoveSource;
  userId?: string;
  /** Dollars in (buys / short stakes) or out (sells / closes). */
  amount?: number;
  /** Price before this transaction (for the order log). */
  priceBefore?: number;
  /** Tokens moved by this transaction. */
  tokens?: number;
}

/**
 * The person's full price series: a launch point followed by one point per
 * transaction on their curve. Slate flows are tagged "slate" so the UI can
 * distinguish them from direct orders: a long's leg trades as the pool
 * (userId "slate-pool"); a short's leg opens member shorts under the
 * INVESTOR's id, so those are recognized via the slate's leg registry —
 * pass the slate to tag them.
 */
export function personPriceHistory(c: Constituent, slate?: Slate): PersonPricePoint[] {
  const legIds = slate?.slateLegIds ?? {};
  const log = c.market.txLog;
  const points: PersonPricePoint[] = [{
    seq: 0,
    t: c.addedAt,
    price: log.length > 0 ? log[0].priceBefore : constituentPrice(c),
    event: "launch",
    source: "launch",
  }];
  for (let i = 0; i < log.length; i++) {
    const tx = log[i];
    points.push({
      seq: i + 1,
      t: tx.timestamp,
      price: tx.priceAfter,
      event: tx.type,
      source:
        tx.type === "liquidation" ? "liquidation"
        : tx.userId === "slate-pool" || legIds[tx.positionId] ? "slate"
        : "order",
      userId: tx.userId,
      amount: tx.amountIn > 0 ? tx.amountIn : tx.amountOut,
      priceBefore: tx.priceBefore,
      tokens: tx.tokens,
    });
  }
  return points;
}

/** A user's open positions on one person's curve, with live value/PnL. */
export function personPositions(
  slate: Slate,
  personId: string,
  userId?: string,
): PositionWithMetrics[] {
  const person = getConstituent(slate, personId);
  if (!person) return [];
  return getPositions(person.market, person.config, userId);
}

export interface PersonTradeResult {
  slate: Slate;
  personId: string;
  /** The direct short position id (empty when primaryPct = 0). */
  positionId: string;
  /** Tokens sold short on the person's curve by the direct leg. */
  tokens: number;
  priceBefore: number;
  priceAfter: number;
  /** Fraction shorted directly on the person (mirror of the long's 95%). */
  primaryPct: number;
  /** Dollars spread as small shorts across the slate (the "5%"). */
  slateAmount: number;
  /** How many member shorts the slate leg opened. */
  slateShortCount: number;
  /** Slate legs auto-closed for parents found liquidated (healing sweep). */
  cascadeClosures: CascadeClosure[];
  slateBefore: number;
  slateAfter: number;
}

/**
 * Short a person, mirroring the long's auto-spread: `primaryPct` (95%) opens
 * an escrow-backed short on the person's own curve (verbatim DTM4.1 math);
 * the remainder opens small shorts across every slate member by weight. All
 * legs are computed against pending market states and committed only if
 * every shortOpen succeeds, so a rejection leaves the slate untouched.
 */
export function shortPerson(
  slate: Slate,
  personId: string,
  amount: number,
  opts?: { investorId?: string; primaryPct?: number; feeRate?: number },
): PersonTradeResult {
  const person = getConstituent(slate, personId);
  if (!person) throw new Error(`person ${personId} not in slate`);
  if (!(amount > 0)) throw new Error("amount must be positive");
  const primaryPct = opts?.primaryPct ?? 0.95;
  const investorId = opts?.investorId ?? "investor";

  const slateBefore = slateValue(slate);
  const priceBefore = constituentPrice(person);
  const directAmt = amount * primaryPct;
  const slateAmt = amount * (1 - primaryPct);

  // Phase 1 — compute every leg against pending per-market states.
  const pending = new Map<string, PauvState>();
  const stateOf = (c: Constituent) => pending.get(c.id) ?? c.market;

  let directId = "";
  let directTokens = 0;
  if (directAmt > 0) {
    // Only the direct leg pays the fee; the slate legs below are fee-free.
    const res = shortOpen(stateOf(person), { ...person.config, feeRate: opts?.feeRate ?? 0 }, investorId, directAmt);
    pending.set(person.id, res.state);
    directId = res.positionId;
    directTokens = res.tokens;
  }

  const slateSplit = slateAllocationSplit(slate, slateAmt);
  const slateShorts: Array<{ constituentId: string; positionId: string }> = [];
  for (const c of slate.constituents) {
    const a = slateSplit.get(c.id) ?? 0;
    if (!(a > 0)) continue;
    const res = shortOpen(stateOf(c), c.config, investorId, a);
    pending.set(c.id, res.state);
    slateShorts.push({ constituentId: c.id, positionId: res.positionId });
  }

  // Phase 2 — all legs succeeded; commit.
  for (const c of slate.constituents) {
    const s = pending.get(c.id);
    if (s) c.market = s;
  }
  if (directId && slateShorts.length > 0) {
    (slate.linkedLegs ??= {})[directId] = { shorts: slateShorts };
  }
  // Registered durably (the link above dies with the unwind) so the txLog
  // history of these legs stays taggable as slate flows.
  for (const s of slateShorts) (slate.slateLegIds ??= {})[s.positionId] = true;

  // Opening shorts moves prices down so it cannot liquidate anything itself,
  // but sweeping here heals orphans a persisted slate may carry from before.
  const cascadeClosures = sweepLiquidatedParents(slate);

  const slateAfter = recordTick(slate);
  return {
    slate,
    personId,
    positionId: directId,
    tokens: directTokens,
    priceBefore,
    priceAfter: constituentPrice(person),
    primaryPct,
    slateAmount: slateAmt,
    slateShortCount: slateShorts.length,
    cascadeClosures,
    slateBefore,
    slateAfter,
  };
}

export interface ClosePositionResult {
  slate: Slate;
  personId: string;
  positionId: string;
  /** Total cash returned to the position's owner (direct + slate legs). */
  proceeds: number;
  /** Cash from closing the direct position itself. */
  directProceeds: number;
  /** Cash from unwinding the linked slate leg (units sold / member shorts closed). */
  slateProceeds: number;
  /** Linked slate legs closed alongside the direct position. */
  closedSlateLegs: number;
  /** Linked legs that could not be closed right now (left open, still linked). */
  failedSlateLegs: number;
  /** Slate legs auto-closed because this close liquidated their parents. */
  cascadeClosures: CascadeClosure[];
  priceBefore: number;
  priceAfter: number;
  slateBefore: number;
  slateAfter: number;
}

/**
 * A slate leg auto-closed because its PARENT direct position was liquidated.
 * The liquidation deleted the parent inside the market walk without going
 * through closePersonPosition, so the engine unwinds the orphaned leg itself
 * and reports the cash here for the caller to credit the owner's balance.
 */
export interface CascadeClosure {
  /** The liquidated parent direct position. */
  parentPositionId: string;
  /** Person whose curve carried the parent. */
  personId: string;
  /** Owner of the parent (and of the unwound slate leg). */
  userId: string;
  /** Cash returned to the owner by the unwind. */
  proceeds: number;
  /** Slate legs closed (units sale counts as one). */
  closedSlateLegs: number;
  /** Legs that could not close right now — they stay open and linked for retry. */
  failedSlateLegs: number;
}

/**
 * Unwind the slate leg linked to `parentId` for `owner`: sell minted units
 * back / buy back the spread member shorts. Legs that cannot close right now
 * stay linked so a later unwind can retry them. Shared by the explicit close
 * (closePersonPosition) and the liquidation cascade (sweepLiquidatedParents).
 */
function unwindLinkedLeg(
  slate: Slate,
  parentId: string,
  owner: string,
): { proceeds: number; closed: number; failed: number } {
  let proceeds = 0;
  let closed = 0;
  let failed = 0;
  const link = slate.linkedLegs?.[parentId];
  if (!link) return { proceeds, closed, failed };
  const remaining: LinkedSlateLeg = {};

  if (link.units && link.units > 0) {
    const held = slate.ledger.holders[owner] ?? 0;
    const u = Math.min(link.units, held);
    if (u > 0) {
      try {
        const r = sellSlateUnits(slate, owner, u);
        proceeds += r.cashOut;
        closed += 1;
        if (link.units - u > 1e-9) {
          remaining.units = link.units - u;
          if (link.cost != null) remaining.cost = link.cost * ((link.units - u) / link.units);
        }
      } catch {
        failed += 1;
        remaining.units = link.units;
        remaining.cost = link.cost;
      }
    }
    // Units already redeemed elsewhere → nothing left to unwind.
  }

  for (const s of link.shorts ?? []) {
    const c = getConstituent(slate, s.constituentId);
    const p = c?.market.positions[s.positionId];
    if (!c || !p) continue; // already closed or liquidated
    try {
      const r = shortClose(c.market, c.config, s.positionId);
      c.market = r.state;
      proceeds += r.netReturn;
      closed += 1;
    } catch {
      failed += 1;
      (remaining.shorts ??= []).push(s);
    }
  }

  if (remaining.units || remaining.shorts?.length) {
    slate.linkedLegs![parentId] = remaining;
  } else {
    delete slate.linkedLegs![parentId];
  }
  return { proceeds, closed, failed };
}

/** The liquidation tx that killed `positionId`, if that's how it died. */
function findLiquidationTx(c: Constituent, positionId: string) {
  const log = c.market.txLog;
  for (let i = log.length - 1; i >= 0; i--) {
    const tx = log[i];
    if (tx.positionId === positionId && tx.type === "liquidation") return tx;
  }
  return null;
}

/**
 * Auto-close slate legs whose parent direct position was LIQUIDATED. Normal
 * closes go through closePersonPosition, which unwinds the leg and removes
 * the link; a liquidation deletes the parent mid-walk without that hook, so
 * any link whose parent is gone — confirmed by the liquidation tx on its
 * curve, which also names the owner — gets its leg unwound here. Buying back
 * a member short can itself liquidate further parents, so we loop until no
 * new orphan appears. Does not record a tick; callers fold it into theirs.
 */
function sweepLiquidatedParents(slate: Slate): CascadeClosure[] {
  const out: CascadeClosure[] = [];
  const attempted = new Set<string>();
  for (;;) {
    let orphan: { parentId: string; personId: string; userId: string } | null = null;
    for (const parentId of Object.keys(slate.linkedLegs ?? {})) {
      if (attempted.has(parentId)) continue;
      if (slate.constituents.some((c) => c.market.positions[parentId])) continue; // parent still open
      attempted.add(parentId);
      for (const c of slate.constituents) {
        const tx = findLiquidationTx(c, parentId);
        if (tx) { orphan = { parentId, personId: c.id, userId: tx.userId }; break; }
      }
      // No liquidation tx (e.g. the person was removed from the slate with the
      // position) → leave the link alone rather than guess an owner.
      if (orphan) break;
    }
    if (!orphan) return out;
    const r = unwindLinkedLeg(slate, orphan.parentId, orphan.userId);
    out.push({
      parentPositionId: orphan.parentId,
      personId: orphan.personId,
      userId: orphan.userId,
      proceeds: r.proceeds,
      closedSlateLegs: r.closed,
      failedSlateLegs: r.failed,
    });
  }
}

/**
 * Close a long (sell) or short (buy back) position on a person's curve, then
 * unwind the slate leg that was auto-opened with it: a long invest's minted
 * units are sold back; a short's spread member-shorts are bought back. Legs
 * that cannot close right now (e.g. an underwater member short) stay open and
 * remain linked so a later close can retry them.
 */
export function closePersonPosition(
  slate: Slate,
  personId: string,
  positionId: string,
  opts?: { feeRate?: number },
): ClosePositionResult {
  const person = getConstituent(slate, personId);
  if (!person) throw new Error(`person ${personId} not in slate`);
  const pos = person.market.positions[positionId];
  if (!pos) throw new Error(`position ${positionId} not found on ${personId}`);
  const owner = pos.userId;

  const slateBefore = slateValue(slate);
  const priceBefore = constituentPrice(person);
  // Closing the direct leg pays the fee too (same rate as opening); the
  // slate-leg unwind below stays fee-free.
  const closeCfg = { ...person.config, feeRate: opts?.feeRate ?? 0 };
  let directProceeds: number;
  if (pos.type === "long") {
    const res = sell(person.market, closeCfg, positionId);
    person.market = res.state;
    directProceeds = res.netProceeds;
  } else {
    const res = shortClose(person.market, closeCfg, positionId);
    person.market = res.state;
    directProceeds = res.netReturn;
  }

  // Unwind the linked slate leg.
  const unwound = unwindLinkedLeg(slate, positionId, owner);

  // Buying back shorts (direct or member legs) can liquidate OTHER parents;
  // auto-close the slate legs those liquidations orphaned.
  const cascadeClosures = sweepLiquidatedParents(slate);

  const priceAfter = constituentPrice(person);
  const slateAfter = recordTick(slate);

  return {
    slate,
    personId,
    positionId,
    proceeds: directProceeds + unwound.proceeds,
    directProceeds,
    slateProceeds: unwound.proceeds,
    closedSlateLegs: unwound.closed,
    failedSlateLegs: unwound.failed,
    cascadeClosures,
    priceBefore,
    priceAfter,
    slateBefore,
    slateAfter,
  };
}

/**
 * Position ids on one constituent's curve that are slate legs of some direct
 * position (so the UI can tag them instead of presenting them as standalone).
 */
export function slateLinkedPositionIds(slate: Slate, constituentId: string): Set<string> {
  const out = new Set<string>();
  for (const link of Object.values(slate.linkedLegs ?? {})) {
    for (const s of link.shorts ?? []) {
      if (s.constituentId === constituentId) out.add(s.positionId);
    }
  }
  return out;
}

// ------------------------------------------------------------
// Orders view — one entry per direct position, combined with its
// slate leg, for the "your positions" UI.
// ------------------------------------------------------------

/** Live metrics of an order's slate leg. */
export interface SlateLegSummary {
  kind: "units" | "shorts";
  /** Dollars that went into the slate leg at open. */
  cost: number;
  currentValue: number;
  pnl: number;
  /** Slate units the leg minted (longs only). */
  units?: number;
  /** Member shorts still open under this leg (shorts only). */
  memberLegs?: Array<{
    constituentId: string;
    name: string;
    stake: number;
    currentValue: number;
    pnl: number;
  }>;
}

/** A user's order on a person: the direct position plus its slate leg. */
export interface PersonOrder {
  /** The direct position on the person's curve (the parent). */
  position: PositionWithMetrics;
  /** The auto-opened slate leg (null when primaryPct was 1 or it fully closed). */
  slateLeg: SlateLegSummary | null;
  /** Combined dollars in: direct cost + slate-leg cost. */
  totalCost: number;
  /** Combined live value of both legs. */
  totalValue: number;
  totalPnl: number;
}

function slateLegSummary(slate: Slate, link: LinkedSlateLeg | undefined): SlateLegSummary | null {
  if (!link) return null;
  if (link.units && link.units > 0) {
    const value = link.units * slateValue(slate);
    // Older persisted sims lack cost — assume break-even rather than guessing.
    const cost = link.cost ?? value;
    return { kind: "units", cost, currentValue: value, pnl: value - cost, units: link.units };
  }
  if (link.shorts?.length) {
    const memberLegs: NonNullable<SlateLegSummary["memberLegs"]> = [];
    for (const s of link.shorts) {
      const c = getConstituent(slate, s.constituentId);
      if (!c || !c.market.positions[s.positionId]) continue; // closed or liquidated
      const m = getPositions(c.market, c.config).find((p) => p.id === s.positionId);
      if (!m) continue;
      memberLegs.push({
        constituentId: c.id,
        name: c.name,
        stake: m.openCost ?? 0,
        currentValue: m.currentValue,
        pnl: m.pnl,
      });
    }
    if (memberLegs.length === 0) return null;
    const cost = memberLegs.reduce((x, l) => x + l.stake, 0);
    const value = memberLegs.reduce((x, l) => x + l.currentValue, 0);
    return { kind: "shorts", cost, currentValue: value, pnl: value - cost, memberLegs };
  }
  return null;
}

/**
 * A user's orders on one person: one entry per direct position, combined
 * with the slate leg auto-opened alongside it (cost, value, and P&L of both
 * legs added together). Positions on this curve that are themselves slate
 * legs of another order are excluded — they appear under their own parent.
 * Closing the parent (closePersonPosition) unwinds both legs.
 */
export function personOrders(slate: Slate, personId: string, userId?: string): PersonOrder[] {
  const person = getConstituent(slate, personId);
  if (!person) return [];
  const legIds = slateLinkedPositionIds(slate, personId);
  return getPositions(person.market, person.config, userId)
    .filter((p) => !legIds.has(p.id))
    .map((p) => {
      const slateLeg = slateLegSummary(slate, slate.linkedLegs?.[p.id]);
      // Works for both types: long pnl = value − openCost, short pnl = value − stake.
      const directCost = p.currentValue - p.pnl;
      const totalCost = directCost + (slateLeg?.cost ?? 0);
      const totalValue = p.currentValue + (slateLeg?.currentValue ?? 0);
      return { position: p, slateLeg, totalCost, totalValue, totalPnl: totalValue - totalCost };
    });
}

// ------------------------------------------------------------
// Portfolio view — DTM4.1's /api/portfolio/[userId] contract
// ({ userId, balance, positions, closedPositions }) aggregated
// across every person market, plus the index-feature additions.
// ------------------------------------------------------------

/** Closed positions on one person's curve (exact DTM4.1 record shape). */
export function personClosedPositions(
  slate: Slate,
  personId: string,
  userId?: string,
): ClosedPositionRecord[] {
  const person = getConstituent(slate, personId);
  if (!person) return [];
  return getClosedPositions(person.market, userId);
}

/**
 * A portfolio position row: DTM4.1's PositionWithMetrics plus which person
 * market it lives on (the index feature makes one user span N markets) and,
 * for auto-opened slate legs, the direct position they belong to.
 */
export interface PortfolioPosition extends PositionWithMetrics {
  /** Constituent id — each person IS one DTM4.1 market. */
  marketId: string;
  marketName: string;
  slateId: string;
  /** Parent direct-position id when this row is an auto-opened slate leg. */
  slateLegOf?: string;
}

export interface PortfolioClosedPosition extends ClosedPositionRecord {
  marketId: string;
  marketName: string;
  slateId: string;
}

/** A holder's stake in the slate vehicle itself — additive to DTM4.1. */
export interface SlateHolding {
  slateId: string;
  slateName: string;
  units: number;
  unitPrice: number;
  value: number;
}

/**
 * The portfolio body. The first four fields are DTM4.1's portfolio-route
 * contract verbatim; everything after them is what the index feature adds.
 */
export interface Portfolio {
  userId: string;
  /** Cash balance — owned by the store/DB, passed through by the caller. */
  balance: number;
  positions: PortfolioPosition[];
  /** Newest first across all markets. */
  closedPositions: PortfolioClosedPosition[];
  // --- index-feature additions ---
  slateHoldings: SlateHolding[];
  /** Σ currentValue of open positions (direct + slate legs), all markets. */
  positionValue: number;
  /** Σ pnl of open positions. */
  unrealizedPnL: number;
  /** Σ realizedPnL of closed positions (fee-excluded, DTM4.1 convention). */
  realizedPnL: number;
  openPositions: number;
}

/** positionId → its parent direct-position id, for every linked short leg. */
function slateLegParents(slate: Slate): Map<string, string> {
  const out = new Map<string, string>();
  for (const [parentId, link] of Object.entries(slate.linkedLegs ?? {})) {
    for (const s of link.shorts ?? []) out.set(s.positionId, parentId);
  }
  return out;
}

export function getPortfolio(
  slates: Slate[],
  userId: string,
  balance = 0,
): Portfolio {
  const positions: PortfolioPosition[] = [];
  const closedPositions: PortfolioClosedPosition[] = [];
  const slateHoldings: SlateHolding[] = [];

  for (const slate of slates) {
    const legParents = slateLegParents(slate);
    for (const c of slate.constituents) {
      for (const p of getPositions(c.market, c.config, userId)) {
        positions.push({
          ...p,
          marketId: c.id,
          marketName: c.name,
          slateId: slate.id,
          slateLegOf: legParents.get(p.id),
        });
      }
      for (const cp of getClosedPositions(c.market, userId)) {
        closedPositions.push({
          ...cp,
          marketId: c.id,
          marketName: c.name,
          slateId: slate.id,
        });
      }
    }
    const units = slate.ledger.holders[userId] ?? 0;
    if (units > 0) {
      const up = unitPrice(slate);
      slateHoldings.push({
        slateId: slate.id,
        slateName: slate.name,
        units,
        unitPrice: up,
        value: units * up,
      });
    }
  }

  closedPositions.sort(
    (a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime(),
  );

  return {
    userId,
    balance,
    positions,
    closedPositions,
    slateHoldings,
    positionValue: positions.reduce((s, p) => s + p.currentValue, 0),
    unrealizedPnL: positions.reduce((s, p) => s + p.pnl, 0),
    realizedPnL: closedPositions.reduce((s, p) => s + p.realizedPnL, 0),
    openPositions: positions.length,
  };
}

// ------------------------------------------------------------
// Lookups
// ------------------------------------------------------------

export function getConstituent(slate: Slate, id: string): Constituent | undefined {
  return slate.constituents.find((c) => c.id === id);
}

export interface SlateSummary {
  id: string;
  name: string;
  value: number;
  baseValue: number;
  /** Total return since launch. */
  totalReturn: number;
  n: number;
  rebalanceDue: boolean;
}

export function summarize(slate: Slate): SlateSummary {
  const value = slateValue(slate);
  return {
    id: slate.id,
    name: slate.name,
    value,
    baseValue: slate.baseValue,
    totalReturn: slate.baseValue > 0 ? value / slate.baseValue - 1 : 0,
    n: slate.constituents.length,
    rebalanceDue: isRebalanceDue(slate),
  };
}
