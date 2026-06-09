// ============================================================
// PAUV TRADING ENGINE — pure / multi-instance port of DTM4.1
// Single-Curve Softplus Bonding Model with Escrow-Based Shorting
// ------------------------------------------------------------
// This is the SAME bonding-curve math as Pauv-Inc/DTM4.1's
// src/market/pauv-engine.ts, with one structural change:
//
//   DTM4.1 stored ONE market in localStorage (singleton).
//   Here every operation is a PURE function over an explicit
//   (state, cfg) pair, so you can run N independent markets at
//   once — one per index constituent. Operations clone the
//   input state, mutate the clone, and return the new state;
//   on a thrown rejection the caller simply keeps the old state
//   (same rollback guarantee DTM4.1 got from "don't save").
//
// The basket/index layer (src/basket/basket-engine.ts) reads
// each constituent's current price off its own PauvState.
// ============================================================

// ---- Config ----
export interface PauvConfig {
  P0: number;                   // Starting price in USD (e.g. 100)
  b: number;                    // Step-up per token (e.g. 1)
  alpha: number;                // Softplus transition parameter (e.g. 0.015)
  feeRate: number;              // Fee as decimal (e.g. 0.018)
  liquidationThreshold: number; // Fraction of escrow at which liq triggers (e.g. 0.95)
}

// ---- Data Model ----
export interface PauvPosition {
  id: string;
  userId: string;
  type: "long" | "short";
  tokens: number;    // always positive magnitude
  escrow?: number;   // shorts only
  openCost?: number; // shorts only: netStake at open
  openQ: number;
  openPrice: number;
  openedAt: string;
}

export interface PauvTxLog {
  id: string;
  type: "buy" | "sell" | "short_open" | "short_close" | "liquidation";
  positionId: string;
  userId: string;
  amountIn: number;
  amountOut: number;
  tokens: number;
  fee: number;
  qBefore: number;
  qAfter: number;
  priceBefore: number;
  priceAfter: number;
  timestamp: string;
}

export interface PauvState {
  Q: number;
  positions: Record<string, PauvPosition>;
  treasury: { balance: number };
  txLog: PauvTxLog[];
}

export class UnderwaterRejection extends Error {
  readonly shortId: string;
  readonly costToClose: number;
  readonly escrow: number;
  readonly deficit: number;
  constructor(shortId: string, costToClose: number, escrow: number) {
    const deficit = costToClose - escrow;
    super(
      `Operation rejected: would trigger an underfunded liquidation cascade. ` +
      `Short ${shortId} would fire with $${costToClose.toFixed(2)} buyback cost ` +
      `against $${escrow.toFixed(2)} escrow (deficit $${deficit.toFixed(2)}). ` +
      `Try a smaller amount or wait for the market to stabilize.`
    );
    this.name = "UnderwaterRejection";
    this.shortId = shortId;
    this.costToClose = costToClose;
    this.escrow = escrow;
    this.deficit = deficit;
  }
}

// ============================================================
// CORE MATH FUNCTIONS  (verbatim from DTM4.1)
// ============================================================

// Adjust the internal curve parameter so that P(0) == P0 exactly, regardless of alpha.
// Solves: alpha * ln(1 + exp(rp0/alpha)) = P0  →  rp0 = alpha * ln(exp(P0/alpha) - 1)
function rawP0(P0: number, alpha: number): number {
  const r = P0 / alpha;
  if (r > 40) return P0; // exp(r) >> 1, correction is negligible
  return alpha * Math.log(Math.exp(r) - 1);
}

export function price(Q: number, P0: number, b: number, alpha: number): number {
  const x = (rawP0(P0, alpha) + b * Q) / alpha;
  if (x > 40) return rawP0(P0, alpha) + b * Q;
  if (x < -40) return alpha * Math.exp(x);
  return alpha * Math.log(1 + Math.exp(x));
}

const PI2_6 = (Math.PI * Math.PI) / 6;

// Li_2(-e^{-x}) for x >= 0 via the alternating series in v=e^{-x}.
function liNeg(x: number): number {
  if (x > 700) return 0;
  const v = Math.exp(-x);
  let sum = 0;
  let zk = 1;
  for (let k = 1; k <= 80; k++) {
    zk *= -v;
    const term = zk / (k * k);
    sum += term;
    if (Math.abs(term) < 1e-20) break;
  }
  return sum;
}

// Computes G(u2) - G(u1) where G is the antiderivative of ln(1 + e^u).
function Gdiff(u1: number, u2: number): number {
  if (u1 >= 0 && u2 >= 0) {
    return ((u2 - u1) * (u2 + u1)) / 2 + liNeg(u2) - liNeg(u1);
  }
  if (u1 < 0 && u2 < 0) {
    return liNeg(-u1) - liNeg(-u2);
  }
  if (u1 < 0 && u2 >= 0) {
    return PI2_6 + (u2 * u2) / 2 + liNeg(u2) + liNeg(-u1);
  }
  return -(PI2_6 + (u1 * u1) / 2 + liNeg(u1) + liNeg(-u2));
}

export function costIntegral(
  Q1: number,
  Q2: number,
  P0: number,
  b: number,
  alpha: number
): number {
  if (Q1 === Q2) return 0;
  const rp0 = rawP0(P0, alpha);
  const u1 = (rp0 + b * Q1) / alpha;
  const u2 = (rp0 + b * Q2) / alpha;
  return ((alpha * alpha) / b) * Gdiff(u1, u2);
}

// Bisection: Q2 > Q1, costIntegral(Q1, Q2) = W > 0
function bisectQ2ForCost(
  Q1: number,
  W: number,
  P0: number,
  b: number,
  alpha: number
): number {
  let lo = Q1;
  let hi = Q1 + Math.max(1, W / price(Q1, P0, b, alpha));
  for (let i = 0; i < 64 && costIntegral(Q1, hi, P0, b, alpha) < W; i++) hi = Q1 + (hi - Q1) * 2;
  for (let i = 0; i < 128; i++) {
    const mid = (lo + hi) / 2;
    if (costIntegral(Q1, mid, P0, b, alpha) < W) lo = mid; else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

// Bisection: Q2 < Q1, costIntegral(Q1, Q2) = W < 0
function bisectQ2ForCostLeft(
  Q1: number,
  W: number,
  P0: number,
  b: number,
  alpha: number
): number {
  const pQ1 = price(Q1, P0, b, alpha);
  let lo = Q1 - Math.max(1, Math.abs(W) / pQ1);
  let hi = Q1;
  for (let i = 0; i < 64 && costIntegral(Q1, lo, P0, b, alpha) > W; i++) lo = Q1 - (Q1 - lo) * 2;
  for (let i = 0; i < 128; i++) {
    const mid = (lo + hi) / 2;
    if (costIntegral(Q1, mid, P0, b, alpha) < W) lo = mid; else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

// Solve costIntegral(Q1, Q2) = W for Q2.
// W > 0: buy direction (Q2 > Q1). W < 0: short/sell direction (Q2 < Q1).
export function solveQ2ForCost(
  Q1: number,
  W: number,
  P0: number,
  b: number,
  alpha: number
): number {
  if (W === 0) return Q1;

  const rp0 = rawP0(P0, alpha);
  const P1 = rp0 + b * Q1;

  const pCur = price(Q1, P0, b, alpha);
  let Q2 = Q1 + W / pCur;
  const disc0 = P1 * P1 + 2 * b * W;
  if (disc0 >= 0) {
    const sqrtDisc = Math.sqrt(disc0);
    const dQ = W > 0 ? (-P1 + sqrtDisc) / b : (-P1 - sqrtDisc) / b;
    if (W > 0 && dQ > 0) Q2 = Q1 + dQ;
    if (W < 0 && dQ < 0) Q2 = Q1 + dQ;
  }

  const linearEstimate = Q2;
  const maxDrift = 2 * Math.abs(W) / Math.max(pCur, 1e-12);
  let prevErr = Infinity;
  for (let i = 0; i < 30; i++) {
    const cost = costIntegral(Q1, Q2, P0, b, alpha);
    const p = price(Q2, P0, b, alpha);
    if (p <= 0) break;
    const err = cost - W;
    if (Math.abs(err) < 1e-10 * Math.max(1, Math.abs(W))) break;
    if (Math.abs(err) > Math.abs(prevErr) * 2 && i > 3) { Q2 = linearEstimate; break; }
    prevErr = err;
    let step = err / p;
    const maxStep = 2 * Math.max(Math.abs(Q2 - Q1), maxDrift, 1);
    if (Math.abs(step) > maxStep) step = Math.sign(step) * maxStep;
    Q2 -= step;
    if (W > 0 && Q2 <= Q1) Q2 = Q1 + 1e-8;
    if (W < 0 && Q2 >= Q1) Q2 = Q1 - 1e-8;
    if (Math.abs(Q2 - Q1) > maxDrift * 10) { Q2 = linearEstimate; break; }
  }

  const finalCost = costIntegral(Q1, Q2, P0, b, alpha);
  if (Math.abs(finalCost - W) > Math.max(1e-6, Math.abs(W) * 1e-6)) {
    Q2 = W > 0
      ? bisectQ2ForCost(Q1, W, P0, b, alpha)
      : bisectQ2ForCostLeft(Q1, W, P0, b, alpha);
  }

  return Q2;
}

// Find Q where closing `short` would cost exactly threshold * escrow.
export function solveTripPoint(
  short: PauvPosition,
  cfg: PauvConfig,
  threshold: number = cfg.liquidationThreshold
): number {
  const escrow = short.escrow ?? 0;
  const tokens = short.tokens;
  if (escrow <= 0 || tokens <= 0) {
    console.warn(
      `[PAUV] solveTripPoint: degenerate short ${short.id} ` +
      `(escrow=${escrow}, tokens=${tokens}). Upstream bug — returning +Infinity.`
    );
    return Infinity;
  }
  const target = threshold * escrow;
  const f = (Q: number) =>
    costIntegral(Q, Q + tokens, cfg.P0, cfg.b, cfg.alpha) - target;
  const fp = (Q: number) =>
    price(Q + tokens, cfg.P0, cfg.b, cfg.alpha) -
    price(Q, cfg.P0, cfg.b, cfg.alpha);

  let Q = short.openQ;
  let prevErr = Infinity;
  let newtonOk = false;
  for (let i = 0; i < 30; i++) {
    const err = f(Q);
    if (Math.abs(err) < 1e-10 * Math.max(1, target)) { newtonOk = true; break; }
    const deriv = fp(Q);
    if (deriv <= 0) break;
    if (i > 3 && Math.abs(err) > Math.abs(prevErr) * 2) break;
    Q -= err / deriv;
    prevErr = err;
  }
  if (newtonOk) return Q;

  // Bisection fallback.
  let lo = short.openQ - tokens;
  for (let i = 0; i < 32 && f(lo) >= 0; i++) {
    lo -= Math.max(1000, 10 * Math.abs(lo));
  }
  let hi = short.openQ;
  const hiCap = hi + Math.max(1000, 10 * Math.abs(hi));
  for (let i = 0; i < 64 && f(hi) < 0; i++) {
    hi = hi + Math.max(1, (hi - lo) * 2);
    if (hi > hiCap) return Infinity;
  }
  for (let i = 0; i < 128; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid; else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

// ============================================================
// STATE FACTORIES  (storage is the caller's job — see basket-store.ts)
// ============================================================

export function defaultConfig(overrides?: Partial<PauvConfig>): PauvConfig {
  return {
    P0: 0.10,
    b: 0.001,
    alpha: 100,
    feeRate: 0,
    liquidationThreshold: 0.95,
    ...overrides,
  };
}

export function defaultState(): PauvState {
  return {
    Q: 0,
    positions: {},
    treasury: { balance: 0 },
    txLog: [],
  };
}

function cloneState(state: PauvState): PauvState {
  return structuredClone(state);
}

let idCounter = 0;
function genId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now()}_${idCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================
// INTERLEAVED LIQUIDATION (walk)  — verbatim logic from DTM4.1
// ============================================================

const EMPTY_EXCLUDE_SET: ReadonlySet<string> = new Set();
const LIVE_TRIP_PASSES = 3;

export function effectiveThreshold(currentPrice: number, cfg: PauvConfig): number {
  const cap = cfg.liquidationThreshold;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return cap;
  const lp = Math.log10(currentPrice);
  let raw: number;
  if (lp <= -2) raw = 0.65;
  else if (lp <= -1) raw = 0.65 + (lp + 2) * 0.05;
  else if (lp <= 0)  raw = 0.70 + (lp + 1) * 0.20;
  else if (lp <= 1)  raw = 0.90 + lp * 0.05;
  else raw = 0.95;
  return Math.min(cap, raw);
}

function tripTieBreak(a: PauvPosition, b: PauvPosition): number {
  if (a.openedAt !== b.openedAt) return a.openedAt < b.openedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function computeAllLiveTripQs(
  state: PauvState,
  cfg: PauvConfig,
  excludeIds: ReadonlySet<string> = EMPTY_EXCLUDE_SET,
): Map<string, number> {
  const positions: PauvPosition[] = [];
  for (const p of Object.values(state.positions)) {
    if (p.type !== "short") continue;
    if (excludeIds.has(p.id)) continue;
    if ((p.escrow ?? 0) <= 0 || p.tokens <= 0) continue;
    positions.push(p);
  }
  const result = new Map<string, number>();
  if (positions.length === 0) return result;

  const currentPrice = price(state.Q, cfg.P0, cfg.b, cfg.alpha);
  const effThr = effectiveThreshold(currentPrice, cfg);

  const Q1s = new Map<string, number>();
  const standalones = new Map<string, number>();
  for (const p of positions) {
    Q1s.set(p.id, solveTripPoint(p, cfg, 1.0));
    standalones.set(p.id, solveTripPoint(p, cfg, effThr));
  }

  for (const p of positions) result.set(p.id, standalones.get(p.id)!);

  for (let pass = 0; pass < LIVE_TRIP_PASSES; pass++) {
    const next = new Map<string, number>();
    for (const pos of positions) {
      const myQ1 = Q1s.get(pos.id)!;
      const myStandalone = standalones.get(pos.id)!;

      const nestedIds = new Set<string>();
      let nestedSum = 0;
      let grew = true;
      while (grew) {
        grew = false;
        const rangeStart = myQ1 - nestedSum;
        const rangeEnd = myQ1 + pos.tokens;
        for (const other of positions) {
          if (other.id === pos.id) continue;
          if (nestedIds.has(other.id)) continue;
          const otherTripQ = result.get(other.id)!;
          if (otherTripQ > rangeStart && otherTripQ < rangeEnd) {
            nestedIds.add(other.id);
            nestedSum += other.tokens;
            grew = true;
          }
        }
      }

      next.set(pos.id, Math.min(myStandalone, myQ1 - nestedSum));
    }
    for (const [id, q] of next) result.set(id, q);
  }
  return result;
}

function executeLiquidation(
  state: PauvState,
  cfg: PauvConfig,
  short: PauvPosition,
  liquidations: { userId: string; netReturn: number }[],
  outerExcludeIds: ReadonlySet<string> = EMPTY_EXCLUDE_SET,
): void {
  const qBefore = state.Q;
  const escrow = short.escrow ?? 0;
  const priceBefore = price(qBefore, cfg.P0, cfg.b, cfg.alpha);

  const innerExcludes = new Set(outerExcludeIds);
  innerExcludes.add(short.id);
  const inner = walk(
    state, cfg, qBefore,
    Infinity, short.tokens,
    innerExcludes,
  );
  const costToClose = inner.callerSpent;
  for (const liq of inner.liquidations) liquidations.push(liq);

  if (costToClose > escrow + Math.max(1e-6, escrow * 1e-9)) {
    throw new UnderwaterRejection(short.id, costToClose, escrow);
  }
  const remaining = Math.max(0, escrow - costToClose);
  const liqFee = remaining > 0 ? remaining * cfg.feeRate : 0;
  const netReturn = Math.max(0, remaining - liqFee);

  state.treasury.balance += liqFee;

  const priceAfter = price(state.Q, cfg.P0, cfg.b, cfg.alpha);
  state.txLog.push({
    id: genId("tx"),
    type: "liquidation",
    positionId: short.id,
    userId: short.userId,
    amountIn: escrow,
    amountOut: netReturn,
    tokens: short.tokens,
    fee: liqFee,
    qBefore,
    qAfter: state.Q,
    priceBefore,
    priceAfter,
    timestamp: new Date().toISOString(),
  });
  if (netReturn > 0) liquidations.push({ userId: short.userId, netReturn });
  delete state.positions[short.id];
}

function walk(
  state: PauvState,
  cfg: PauvConfig,
  qStart: number,
  budget: number,
  targetTokens: number,
  excludePositionIds: ReadonlySet<string> = EMPTY_EXCLUDE_SET,
): {
  qEnd: number;
  callerSpent: number;
  callerTokens: number;
  liquidations: { userId: string; netReturn: number }[];
} {
  if (!Number.isFinite(budget) && !Number.isFinite(targetTokens)) {
    throw new Error("walk: at least one of budget or targetTokens must be finite");
  }

  let qCursor = qStart;
  let budgetLeft = budget;
  let tokensLeft = targetTokens;
  let callerSpent = 0;
  let callerTokens = 0;
  const liquidations: { userId: string; netReturn: number }[] = [];

  const shortCount = Object.values(state.positions).filter((p) => p.type === "short").length;
  const maxIter = shortCount + 2;

  for (let iter = 0; iter <= maxIter; iter++) {
    if (budgetLeft <= 1e-12 || tokensLeft <= 1e-12) break;

    let liveTripQs = computeAllLiveTripQs(state, cfg, excludePositionIds);

    for (;;) {
      let stranded: PauvPosition | null = null;
      for (const pos of Object.values(state.positions)) {
        if (pos.type !== "short") continue;
        if (excludePositionIds.has(pos.id)) continue;
        const qTrip = liveTripQs.get(pos.id) ?? Infinity;
        if (qTrip > qCursor) continue;
        if (!stranded || tripTieBreak(pos, stranded) < 0) stranded = pos;
      }
      if (!stranded) break;
      executeLiquidation(state, cfg, stranded, liquidations, excludePositionIds);
      qCursor = state.Q;
      liveTripQs = computeAllLiveTripQs(state, cfg, excludePositionIds);
    }

    const qByBudget = Number.isFinite(budgetLeft)
      ? solveQ2ForCost(qCursor, budgetLeft, cfg.P0, cfg.b, cfg.alpha)
      : Infinity;
    const qByTokens = qCursor + tokensLeft;
    const qPlannedEnd = Math.min(qByBudget, qByTokens);

    let nextShort: PauvPosition | null = null;
    let nextQTrip = Infinity;
    for (const pos of Object.values(state.positions)) {
      if (pos.type !== "short") continue;
      if (excludePositionIds.has(pos.id)) continue;
      const qTrip = liveTripQs.get(pos.id) ?? Infinity;
      if (qTrip <= qCursor || qTrip >= qPlannedEnd) continue;
      if (
        qTrip < nextQTrip ||
        (qTrip === nextQTrip && nextShort && tripTieBreak(pos, nextShort) < 0)
      ) {
        nextShort = pos;
        nextQTrip = qTrip;
      }
    }

    if (!nextShort) {
      const segmentCost = costIntegral(qCursor, qPlannedEnd, cfg.P0, cfg.b, cfg.alpha);
      state.Q = qPlannedEnd;
      callerSpent += segmentCost;
      callerTokens += qPlannedEnd - qCursor;
      break;
    }

    const partialCost = costIntegral(qCursor, nextQTrip, cfg.P0, cfg.b, cfg.alpha);
    state.Q = nextQTrip;
    callerSpent += partialCost;
    callerTokens += nextQTrip - qCursor;
    budgetLeft -= partialCost;
    tokensLeft -= nextQTrip - qCursor;
    qCursor = nextQTrip;

    executeLiquidation(state, cfg, nextShort, liquidations, excludePositionIds);
    qCursor = state.Q;
  }

  return { qEnd: state.Q, callerSpent, callerTokens, liquidations };
}

function assertReserveSufficiency(
  state: PauvState,
  cfg: PauvConfig,
  opLabel: string
): void {
  for (const pos of Object.values(state.positions)) {
    if (pos.type !== "short") continue;
    const escrow = pos.escrow ?? 0;
    const costToClose = costIntegral(
      state.Q, state.Q + pos.tokens, cfg.P0, cfg.b, cfg.alpha
    );
    const tol = Math.max(1e-6, escrow * 1e-9);
    if (costToClose > escrow + tol) {
      const msg =
        `[PAUV] ${opLabel}: reserve-sufficiency violated. ` +
        `Short ${pos.id} costToClose=${costToClose} > escrow=${escrow} ` +
        `at Q=${state.Q}. Deficit ${costToClose - escrow}.`;
      throw new Error(msg);
    }
  }
}

// ============================================================
// READ-ONLY VIEWS
// ============================================================

export interface MarketSnapshot {
  Q: number;
  currentPrice: number;
  sentimentScore: number;
}

export function getMarket(state: PauvState, cfg: PauvConfig): MarketSnapshot {
  const currentPrice = price(state.Q, cfg.P0, cfg.b, cfg.alpha);
  const sentimentScore =
    state.Q >= 0
      ? costIntegral(0, state.Q, cfg.P0, cfg.b, cfg.alpha)
      : -costIntegral(state.Q, 0, cfg.P0, cfg.b, cfg.alpha);
  return { Q: state.Q, currentPrice, sentimentScore };
}

/** Convenience: just the current spot price of a market. */
export function currentPrice(state: PauvState, cfg: PauvConfig): number {
  return price(state.Q, cfg.P0, cfg.b, cfg.alpha);
}

export interface PositionWithMetrics extends PauvPosition {
  currentValue: number;
  pnl: number;
  escrowUtilization?: number;
}

export function getPositions(
  state: PauvState,
  cfg: PauvConfig,
  userId?: string,
): PositionWithMetrics[] {
  return Object.values(state.positions)
    .filter((pos) => !userId || pos.userId === userId)
    .map((pos) => {
      if (pos.type === "long") {
        const q1 = state.Q - pos.tokens;
        const currentValue = costIntegral(q1, state.Q, cfg.P0, cfg.b, cfg.alpha);
        const openTx = state.txLog.find(
          (tx) => tx.positionId === pos.id && tx.type === "buy"
        );
        const originalCost = openTx ? openTx.amountIn - openTx.fee : 0;
        return { ...pos, currentValue, pnl: currentValue - originalCost };
      }

      const escrow = pos.escrow ?? 0;
      const openCost = pos.openCost ?? 0;
      const costToClose = costIntegral(
        state.Q, state.Q + pos.tokens, cfg.P0, cfg.b, cfg.alpha
      );
      const currentValue = Math.max(0, escrow - costToClose);
      const escrowUtilization = escrow > 0 ? costToClose / escrow : 0;
      return { ...pos, currentValue, pnl: currentValue - openCost, escrowUtilization };
    });
}

export function getTransactionLog(
  state: PauvState,
  userId?: string,
  limit?: number,
): PauvTxLog[] {
  let log = state.txLog.slice().reverse();
  if (userId) log = log.filter((tx) => tx.userId === userId);
  if (limit) log = log.slice(0, limit);
  return log;
}

export function getTreasuryBalance(state: PauvState): number {
  return state.treasury.balance;
}

// ============================================================
// OPERATIONS  (pure: clone in, mutate clone, return new state)
// ============================================================

interface Liq { userId: string; netReturn: number }

export interface BuyResult {
  state: PauvState;
  positionId: string;
  tokens: number;
  newPrice: number;
  fee: number;
  liquidations: Liq[];
}

export function buy(
  prevState: PauvState,
  cfg: PauvConfig,
  userId: string,
  amountUSD: number,
): BuyResult {
  const state = cloneState(prevState);

  const fee = amountUSD * cfg.feeRate;
  const netUSD = amountUSD - fee;
  const qBefore = state.Q;
  const priceBefore = price(qBefore, cfg.P0, cfg.b, cfg.alpha);

  const walkRes = walk(state, cfg, qBefore, netUSD, Infinity);
  const Q2 = walkRes.qEnd;
  const tokens = walkRes.callerTokens;

  state.treasury.balance += fee;

  const positionId = genId("long");
  state.positions[positionId] = {
    id: positionId,
    userId,
    type: "long",
    tokens,
    openQ: qBefore,
    openPrice: priceBefore,
    openedAt: new Date().toISOString(),
  };

  const priceAfter = price(Q2, cfg.P0, cfg.b, cfg.alpha);
  state.txLog.push({
    id: genId("tx"),
    type: "buy",
    positionId,
    userId,
    amountIn: amountUSD,
    amountOut: 0,
    tokens,
    fee,
    qBefore,
    qAfter: Q2,
    priceBefore,
    priceAfter,
    timestamp: new Date().toISOString(),
  });

  assertReserveSufficiency(state, cfg, "buy");

  return {
    state,
    positionId,
    tokens,
    newPrice: price(state.Q, cfg.P0, cfg.b, cfg.alpha),
    fee,
    liquidations: walkRes.liquidations,
  };
}

export interface SellResult {
  state: PauvState;
  netProceeds: number;
  fee: number;
  newPrice: number;
  liquidations: Liq[];
}

export function sell(
  prevState: PauvState,
  cfg: PauvConfig,
  positionId: string,
  tokensToSell?: number,
): SellResult {
  const state = cloneState(prevState);
  const pos = state.positions[positionId];
  if (!pos || pos.type !== "long") throw new Error("Position not found or not a long");

  const tokens = tokensToSell ?? pos.tokens;
  if (tokens > pos.tokens + 1e-9) throw new Error("Not enough tokens");

  const qBefore = state.Q;
  const priceBefore = price(qBefore, cfg.P0, cfg.b, cfg.alpha);
  const Q2 = qBefore - tokens;

  const grossProceeds = costIntegral(Q2, qBefore, cfg.P0, cfg.b, cfg.alpha);
  const fee = grossProceeds * cfg.feeRate;
  const netProceeds = grossProceeds - fee;

  state.Q = Q2;
  state.treasury.balance += fee;

  const isPartial = tokens < pos.tokens - 1e-9;
  if (isPartial) {
    pos.tokens -= tokens;
  } else {
    delete state.positions[positionId];
  }

  const priceAfter = price(Q2, cfg.P0, cfg.b, cfg.alpha);
  state.txLog.push({
    id: genId("tx"),
    type: "sell",
    positionId,
    userId: pos.userId,
    amountIn: 0,
    amountOut: netProceeds,
    tokens,
    fee,
    qBefore,
    qAfter: Q2,
    priceBefore,
    priceAfter,
    timestamp: new Date().toISOString(),
  });

  assertReserveSufficiency(state, cfg, "sell");

  return { state, netProceeds, fee, newPrice: price(state.Q, cfg.P0, cfg.b, cfg.alpha), liquidations: [] };
}

export interface ShortOpenResult {
  state: PauvState;
  positionId: string;
  tokens: number;
  newPrice: number;
  fee: number;
  escrow: number;
  liquidations: Liq[];
}

export function shortOpen(
  prevState: PauvState,
  cfg: PauvConfig,
  userId: string,
  amountUSD: number,
): ShortOpenResult {
  const state = cloneState(prevState);

  const fee = amountUSD * cfg.feeRate;
  const netStake = amountUSD - fee;

  const qBefore = state.Q;
  const priceBefore = price(qBefore, cfg.P0, cfg.b, cfg.alpha);

  const Q2 = solveQ2ForCost(qBefore, -netStake, cfg.P0, cfg.b, cfg.alpha);
  const tokens = qBefore - Q2;
  if (!(tokens > 0) || !Number.isFinite(tokens)) {
    throw new Error("netStake too large for current price");
  }
  const actualCost = -costIntegral(qBefore, Q2, cfg.P0, cfg.b, cfg.alpha);
  if (Math.abs(actualCost - netStake) > Math.max(1e-6, netStake * 1e-6)) {
    throw new Error("Short open rejected: solver could not match stake");
  }

  const escrow = 2 * netStake;
  const candidate: PauvPosition = {
    id: "__cascade_check__",
    userId,
    type: "short",
    tokens,
    escrow,
    openCost: netStake,
    openQ: qBefore,
    openPrice: priceBefore,
    openedAt: new Date().toISOString(),
  };

  const openShorts: Array<{ pos: PauvPosition; tripQ: number }> = [];
  for (const other of Object.values(state.positions)) {
    if (other.type !== "short") continue;
    openShorts.push({ pos: other, tripQ: solveTripPoint(other, cfg) });
  }

  const Q1 = solveTripPoint(candidate, cfg, 1.0);

  const nestedIds = new Set<string>();
  let nestedTokensTotal = 0;
  let grew = true;
  while (grew) {
    grew = false;
    const rangeStart = Q1 - nestedTokensTotal;
    const rangeEnd = Q1 + tokens;
    for (const { pos, tripQ } of openShorts) {
      if (nestedIds.has(pos.id)) continue;
      if (tripQ > rangeStart && tripQ < rangeEnd) {
        nestedIds.add(pos.id);
        nestedTokensTotal += pos.tokens;
        grew = true;
      }
    }
  }

  const QStar = Q1 - nestedTokensTotal;
  const equivalentThreshold = Math.max(
    0,
    costIntegral(QStar, QStar + tokens, cfg.P0, cfg.b, cfg.alpha)
  ) / escrow;

  const MIN_USEFUL_THRESHOLD = 0.30;
  if (equivalentThreshold < MIN_USEFUL_THRESHOLD) {
    throw new Error(
      `Short open rejected: this market currently has too many short positions ` +
      `stacked to open a new one safely. The cascade-aware liquidation threshold ` +
      `would be ${equivalentThreshold.toFixed(3)} (below the ${MIN_USEFUL_THRESHOLD} minimum). ` +
      `${nestedIds.size} existing short(s) would nest into this position's buyback.`
    );
  }

  state.Q = Q2;
  state.treasury.balance += fee;

  const positionId = genId("short");
  state.positions[positionId] = {
    id: positionId,
    userId,
    type: "short",
    tokens,
    escrow,
    openCost: netStake,
    openQ: qBefore,
    openPrice: priceBefore,
    openedAt: new Date().toISOString(),
  };

  const priceAfter = price(Q2, cfg.P0, cfg.b, cfg.alpha);
  state.txLog.push({
    id: genId("tx"),
    type: "short_open",
    positionId,
    userId,
    amountIn: amountUSD,
    amountOut: 0,
    tokens,
    fee,
    qBefore,
    qAfter: Q2,
    priceBefore,
    priceAfter,
    timestamp: new Date().toISOString(),
  });

  assertReserveSufficiency(state, cfg, "shortOpen");

  return {
    state,
    positionId,
    tokens,
    newPrice: price(state.Q, cfg.P0, cfg.b, cfg.alpha),
    fee,
    escrow,
    liquidations: [],
  };
}

export interface ShortCloseResult {
  state: PauvState;
  netReturn: number;
  fee: number;
  costToClose: number;
  newPrice: number;
  liquidations: Liq[];
}

export function shortClose(
  prevState: PauvState,
  cfg: PauvConfig,
  positionId: string,
  tokensToClose?: number,
): ShortCloseResult {
  const state = cloneState(prevState);
  const pos = state.positions[positionId];
  if (!pos || pos.type !== "short") throw new Error("Position not found or not a short");

  const tokens = tokensToClose ?? pos.tokens;
  if (tokens > pos.tokens + 1e-9) throw new Error("Not enough tokens");

  const fraction = tokens / pos.tokens;
  const escrowUsed = (pos.escrow ?? 0) * fraction;

  const qBefore = state.Q;
  const priceBefore = price(qBefore, cfg.P0, cfg.b, cfg.alpha);

  const walkRes = walk(state, cfg, qBefore, Infinity, tokens, new Set([positionId]));
  const Q2 = walkRes.qEnd;
  const costToClose = walkRes.callerSpent;

  const overshoot = costToClose - escrowUsed;
  const underwater = overshoot > Math.max(1e-6, escrowUsed * 1e-9);
  if (underwater) {
    throw new UnderwaterRejection(positionId, costToClose, escrowUsed);
  }

  const remaining = Math.max(0, escrowUsed - costToClose);
  const fee = remaining > 0 ? remaining * cfg.feeRate : 0;
  const netReturn = Math.max(0, remaining - fee);

  state.treasury.balance += fee;

  const isPartial = tokens < pos.tokens - 1e-9;
  if (isPartial) {
    pos.tokens -= tokens;
    if (pos.escrow !== undefined) pos.escrow -= escrowUsed;
  } else {
    delete state.positions[positionId];
  }

  const priceAfter = price(Q2, cfg.P0, cfg.b, cfg.alpha);
  state.txLog.push({
    id: genId("tx"),
    type: "short_close",
    positionId,
    userId: pos.userId,
    amountIn: costToClose,
    amountOut: netReturn,
    tokens,
    fee,
    qBefore,
    qAfter: Q2,
    priceBefore,
    priceAfter,
    timestamp: new Date().toISOString(),
  });

  assertReserveSufficiency(state, cfg, "shortClose");

  return {
    state,
    netReturn,
    fee,
    costToClose,
    newPrice: price(state.Q, cfg.P0, cfg.b, cfg.alpha),
    liquidations: walkRes.liquidations,
  };
}
