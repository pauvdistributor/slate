import { describe, it, expect } from "vitest";
import {
  defaultConfig,
  defaultState,
  buy,
  type PauvConfig,
  type PauvState,
} from "@/market/pauv-engine";
import {
  createBasket,
  indexValue,
  rebalance,
  addConstituent,
  removeConstituent,
  constituentReturn,
  recordTick,
  snapshotConstituents,
  previewInvestment,
  investInPerson,
  investInIndex,
  buyIndexUnits,
  sellIndexUnits,
  holderValue,
  advanceTime,
  nextRebalanceAfter,
  defaultSchedule,
  simDateLabel,
  constituentPrice,
  getConstituent,
  DAY_MS,
  DEFAULT_START_MS,
  type Basket,
} from "./basket-engine";

const CFG: PauvConfig = defaultConfig({ P0: 1, b: 0.001, alpha: 100, feeRate: 0 });

// Invert the softplus curve: find Q such that price(Q) == target.
function qForPrice(target: number, cfg = CFG): number {
  const r0 = cfg.P0 / cfg.alpha;
  const rawP0 = r0 > 40 ? cfg.P0 : cfg.alpha * Math.log(Math.exp(r0) - 1);
  const x = target / cfg.alpha;
  const lnExpM1 = x > 40 ? target : cfg.alpha * Math.log(Math.exp(x) - 1);
  return (lnExpM1 - rawP0) / cfg.b;
}

// A market whose current spot price is exactly `target`.
function marketAtPrice(target: number): PauvState {
  const s = defaultState();
  s.Q = qForPrice(target);
  return s;
}

// Force an existing constituent's market to a given spot price.
function setPrice(basket: Basket, id: string, target: number): void {
  const c = basket.constituents.find((x) => x.id === id)!;
  c.market.Q = qForPrice(target, c.config);
}

function fivePeople() {
  return ["A", "B", "C", "D", "E"].map((id) => ({
    id,
    name: id,
    market: marketAtPrice(1), // everyone starts at $1
    config: { ...CFG },
  }));
}

describe("PDF Part 7 — launch", () => {
  it("equal-weight index launches at the base value (1000)", () => {
    const b = createBasket({ name: "Launch", constituents: fivePeople(), baseValue: 1000 });
    expect(indexValue(b)).toBeCloseTo(1000, 9);
    expect(b.history[0].event).toBe("launch");
    expect(b.history[0].value).toBeCloseTo(1000, 9);
  });

  it("records each constituent's launch price as baseline → return starts at 0", () => {
    const b = createBasket({ name: "Launch", constituents: fivePeople() });
    for (const c of b.constituents) expect(constituentReturn(c)).toBeCloseTo(0, 9);
  });
});

describe("base value modes (supply-free, data-driven launch)", () => {
  it("avgPrice launches at the average constituent price (no supply)", () => {
    const b = createBasket({
      name: "Avg", baseValueMode: "avgPrice",
      constituents: [
        { id: "A", name: "A", market: marketAtPrice(10), config: { ...CFG } },
        { id: "B", name: "B", market: marketAtPrice(20), config: { ...CFG } },
        { id: "C", name: "C", market: marketAtPrice(30), config: { ...CFG } },
      ],
    });
    expect(b.baseValue).toBeCloseTo(20, 4); // (10+20+30)/3
    expect(indexValue(b)).toBeCloseTo(20, 4);
    expect(b.baseMode).toBe("avgPrice");
  });

  it("sumPrice launches at the total of constituent prices", () => {
    const b = createBasket({
      name: "Sum", baseValueMode: "sumPrice",
      constituents: [
        { id: "A", name: "A", market: marketAtPrice(10), config: { ...CFG } },
        { id: "B", name: "B", market: marketAtPrice(20), config: { ...CFG } },
      ],
    });
    expect(b.baseValue).toBeCloseTo(30, 4);
  });

  it("fixed keeps the chosen arbitrary number", () => {
    const b = createBasket({ name: "Fix", baseValueMode: "fixed", baseValue: 1000, constituents: fivePeople() });
    expect(b.baseValue).toBe(1000);
  });
});

describe("PDF Part 3/4 — returns & equal weighting", () => {
  it("return_i = price/baseline − 1", () => {
    const b = createBasket({ name: "R", constituents: fivePeople() });
    setPrice(b, "A", 1.4); // launched at 1.0 → +40%
    expect(constituentReturn(b.constituents.find((c) => c.id === "A")!)).toBeCloseTo(0.4, 6);
  });

  it("half +10% / half −10% leaves the index unchanged (avg return 0)", () => {
    const b = createBasket({
      name: "Wash",
      baseValue: 1000,
      constituents: ["A", "B", "C", "D"].map((id) => ({
        id, name: id, market: marketAtPrice(1), config: { ...CFG },
      })),
    });
    setPrice(b, "A", 1.1);
    setPrice(b, "B", 1.1);
    setPrice(b, "C", 0.9);
    setPrice(b, "D", 0.9);
    expect(indexValue(b)).toBeCloseTo(1000, 6);
  });

  it("A +50% and B −50% leaves a 2-name equal-weight index unchanged", () => {
    const b = createBasket({
      name: "Drift",
      baseValue: 1000,
      constituents: [
        { id: "A", name: "A", market: marketAtPrice(1), config: { ...CFG } },
        { id: "B", name: "B", market: marketAtPrice(1), config: { ...CFG } },
      ],
    });
    setPrice(b, "A", 1.5);
    setPrice(b, "B", 0.5);
    expect(indexValue(b)).toBeCloseTo(1000, 6);
  });

  it("index = baseValue × (1 + average return)", () => {
    const b = createBasket({ name: "Avg", baseValue: 1000, constituents: fivePeople() });
    setPrice(b, "A", 1.2); // +20
    setPrice(b, "B", 1.1); // +10
    setPrice(b, "C", 1.0); //   0
    setPrice(b, "D", 0.9); // −10
    setPrice(b, "E", 1.3); // +30
    const avg = (0.2 + 0.1 + 0 - 0.1 + 0.3) / 5; // = 0.10
    expect(indexValue(b)).toBeCloseTo(1000 * (1 + avg), 4);
  });
});

describe("PDF Part 6 — rebalancing", () => {
  it("is value-continuous (no jump) but resets baselines", () => {
    const b = createBasket({ name: "Reb", baseValue: 1000, constituents: fivePeople() });
    setPrice(b, "A", 2.0); // +100
    const before = indexValue(b);
    rebalance(b);
    expect(indexValue(b)).toBeCloseTo(before, 6); // continuous
    // After rebalance every return clock is back to zero.
    for (const c of b.constituents) expect(constituentReturn(c)).toBeCloseTo(0, 6);
    // anchor moved up to the rebalanced value.
    expect(b.anchorValue).toBeCloseTo(before, 6);
  });

  it("re-equalizes weights (post-rebalance realized weights are equal)", () => {
    const b = createBasket({ name: "Reb2", baseValue: 1000, constituents: fivePeople() });
    setPrice(b, "A", 3.0);
    setPrice(b, "B", 0.5);
    rebalance(b);
    const weights = snapshotConstituents(b).map((s) => s.weight);
    for (const w of weights) expect(w).toBeCloseTo(1 / 5, 6);
  });
});

describe("PDF Part 7 — composition change is invisible to the index value", () => {
  it("adding a constituent does not move the index value", () => {
    const b = createBasket({ name: "Add", baseValue: 1000, constituents: fivePeople() });
    setPrice(b, "A", 1.5);
    const before = indexValue(b);
    addConstituent(b, { id: "F", name: "F", market: marketAtPrice(7.3), config: { ...CFG } });
    expect(indexValue(b)).toBeCloseTo(before, 6); // no jump despite F at $7.30
    expect(b.constituents.length).toBe(6);
  });

  it("removing a constituent does not move the index value", () => {
    const b = createBasket({ name: "Rem", baseValue: 1000, constituents: fivePeople() });
    setPrice(b, "A", 2.0);
    setPrice(b, "B", 0.7);
    const before = indexValue(b);
    removeConstituent(b, "A");
    expect(indexValue(b)).toBeCloseTo(before, 6);
    expect(b.constituents.length).toBe(4);
  });

  it("after add, only real price moves change the index", () => {
    const b = createBasket({ name: "Add2", baseValue: 1000, constituents: fivePeople() });
    addConstituent(b, { id: "F", name: "F", market: marketAtPrice(10), config: { ...CFG } });
    const before = indexValue(b);
    setPrice(b, "F", 20); // F doubles → +100% on 1/6 of the book
    const after = indexValue(b);
    expect(after).toBeCloseTo(before * (1 + 1.0 / 6), 4);
  });
});

describe("PDF Parts 4/5 — market-cap weighting & divisor", () => {
  function mcapBasket(): Basket {
    // Seed each market with a buy so supply (Q) and market cap are non-zero.
    const mk = (usd: number) => buy(defaultState(), CFG, "seed", usd).state;
    return createBasket({
      name: "MCAP",
      weighting: "mcap",
      baseValue: 1000,
      constituents: [
        { id: "A", name: "A", market: mk(100_000), config: { ...CFG } },
        { id: "B", name: "B", market: mk(20_000), config: { ...CFG } },
        { id: "C", name: "C", market: mk(5_000), config: { ...CFG } },
      ],
    });
  }

  it("divisor = total_market_cap / base_value, index launches at base value", () => {
    const b = mcapBasket();
    expect(indexValue(b)).toBeCloseTo(1000, 4);
    expect(b.divisor).toBeGreaterThan(0);
  });

  it("composition change adjusts the divisor to keep value continuous", () => {
    const b = mcapBasket();
    const before = indexValue(b);
    const oldDivisor = b.divisor;
    addConstituent(b, {
      id: "D",
      name: "D",
      market: buy(defaultState(), CFG, "seed", 50_000).state,
      config: { ...CFG },
    });
    expect(indexValue(b)).toBeCloseTo(before, 4); // no jump
    expect(b.divisor).toBeGreaterThan(oldDivisor); // divisor grew with mcap
  });

  it("bigger names dominate: moving the largest name moves the index more", () => {
    const b = mcapBasket();
    const v0 = indexValue(b);
    const big = b.constituents.find((c) => c.id === "A")!;
    const small = b.constituents.find((c) => c.id === "C")!;
    // Push the small name's price up a lot.
    small.market = buy(small.market, CFG, "x", 5_000).state;
    const vSmall = indexValue(b);
    // Reset and push the big name by the same dollar trade.
    const b2 = mcapBasket();
    const big2 = b2.constituents.find((c) => c.id === "A")!;
    big2.market = buy(big2.market, CFG, "x", 5_000).state;
    const vBig = indexValue(b2);
    expect(vBig - v0).toBeGreaterThan(vSmall - v0);
    expect(big.market.Q).toBeGreaterThan(small.market.Q);
  });
});

describe("single-person investing (95/5 split)", () => {
  it("preview: primary gets 95% + 5%/N, others get 5%/N, sums to amount", () => {
    const b = createBasket({ name: "Inv", constituents: fivePeople() });
    const rows = previewInvestment(b, "A", 1000, 0.95);
    const a = rows.find((r) => r.id === "A")!;
    const other = rows.find((r) => r.id === "B")!;
    expect(a.amount).toBeCloseTo(950 + 50 / 5, 6); // 960
    expect(other.amount).toBeCloseTo(50 / 5, 6);    // 10
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(1000, 6);
    expect(a.isPrimary).toBe(true);
  });

  it("execute: primary price rises most, everyone rises, index goes up", () => {
    const b = createBasket({ name: "Inv2", baseValue: 1000, constituents: fivePeople() });
    const before = indexValue(b);
    const res = investInPerson(b, "A", 10_000, { primaryPct: 0.95 });

    expect(res.effectivePrimaryPct).toBeCloseTo(0.95 + 0.05 / 5, 9); // 0.96
    // allocations sum to the invested amount
    expect(res.allocations.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(10_000, 4);

    const primary = res.allocations.find((x) => x.id === "A")!;
    const other = res.allocations.find((x) => x.id === "B")!;
    const primaryGain = primary.priceAfter - primary.priceBefore;
    const otherGain = other.priceAfter - other.priceBefore;
    expect(primaryGain).toBeGreaterThan(otherGain);
    expect(otherGain).toBeGreaterThan(0); // the 5% still lifts everyone
    expect(res.indexAfter).toBeGreaterThan(before);
    // index value continues from the trade; matches live computation
    expect(res.indexAfter).toBeCloseTo(indexValue(b), 9);
  });

  it("the 5% routes through the index: each member's index slice is equal (incl. primary)", () => {
    const b = createBasket({ name: "Idx5", baseValue: 1000, constituents: fivePeople() });
    const res = investInPerson(b, "A", 10_000, { primaryPct: 0.95 });
    const indexSlices = res.allocations.map((a) => a.indexAmount);
    // every member (A included) gets the same index slice = 5%*10000/5 = 100
    for (const s of indexSlices) expect(s).toBeCloseTo(100, 6);
    const primary = res.allocations.find((a) => a.isPrimary)!;
    expect(primary.primaryAmount).toBeCloseTo(9_500, 6); // direct 95%
    expect(primary.amount).toBeCloseTo(9_600, 6);         // direct + index slice
    expect(res.indexAmount).toBeCloseTo(500, 6);
  });

  it("100% primary (primaryPct=1) buys only the chosen person", () => {
    const b = createBasket({ name: "Inv3", constituents: fivePeople() });
    investInPerson(b, "C", 5_000, { primaryPct: 1 });
    expect(constituentPrice(getConstituent(b, "C")!)).toBeGreaterThan(1);
    expect(constituentPrice(getConstituent(b, "A")!)).toBeCloseTo(1, 9); // untouched
  });
});

describe("investing in the index (money flow to constituents)", () => {
  it("equal weight: $X flows in equal dollar slices to every member", () => {
    const b = createBasket({ name: "II", baseValue: 1000, constituents: fivePeople() });
    const before = indexValue(b);
    const res = investInIndex(b, 5_000);
    for (const a of res.allocations) expect(a.amount).toBeCloseTo(1_000, 6); // 5000/5
    expect(res.allocations.reduce((s, a) => s + a.amount, 0)).toBeCloseTo(5_000, 4);
    // everyone rose by the same return → index up, weights stay equal
    expect(res.indexAfter).toBeGreaterThan(before);
    const weights = snapshotConstituents(b).map((w) => w.weight);
    for (const w of weights) expect(w).toBeCloseTo(1 / 5, 4);
  });

  it("market-cap weight: bigger names receive proportionally more", () => {
    const mk = (usd: number) => buy(defaultState(), CFG, "seed", usd).state;
    const b = createBasket({
      name: "IIm", weighting: "mcap", baseValue: 1000,
      constituents: [
        { id: "A", name: "A", market: mk(100_000), config: { ...CFG } },
        { id: "B", name: "B", market: mk(10_000), config: { ...CFG } },
      ],
    });
    const res = investInIndex(b, 1_000);
    const a = res.allocations.find((x) => x.id === "A")!;
    const bb = res.allocations.find((x) => x.id === "B")!;
    expect(a.amount).toBeGreaterThan(bb.amount); // pro-rata by market cap
    expect(a.amount + bb.amount).toBeCloseTo(1_000, 4);
  });
});

describe("index vehicle (ETF units)", () => {
  it("buying mints units worth the amount; selling redeems the cash back", () => {
    const b = createBasket({ name: "ETF", baseValue: 1000, constituents: fivePeople() });
    const r = buyIndexUnits(b, "alice", 10_000);
    expect(r.units).toBeGreaterThan(0);
    expect(b.ledger.unitsOutstanding).toBeCloseTo(r.units, 9);
    expect(b.ledger.holders["alice"]).toBeCloseTo(r.units, 9);
    // unit price = index value, so holding is worth ~ the amount paid.
    expect(holderValue(b, "alice")).toBeCloseTo(10_000, 2);

    const sold = sellIndexUnits(b, "alice", r.units);
    expect(sold.cashOut).toBeCloseTo(10_000, 2); // round-trip on a zero-fee curve
    expect(b.ledger.unitsOutstanding).toBeCloseTo(0, 6);
    expect(holderValue(b, "alice")).toBeCloseTo(0, 6);
  });

  it("single-person invest mints index units (5% leg) AND a direct position (95%)", () => {
    const b = createBasket({ name: "ETF2", baseValue: 1000, constituents: fivePeople() });
    const r = investInPerson(b, "A", 10_000, { primaryPct: 0.95 });
    expect(r.units).toBeGreaterThan(0);
    expect(b.ledger.holders["investor"]).toBeCloseTo(r.units, 9);
    const aPositions = Object.values(getConstituent(b, "A")!.market.positions)
      .filter((p) => p.userId === "investor");
    expect(aPositions.length).toBe(1); // the 95% direct buy
  });
});

describe("simulated calendar & scheduled rebalances", () => {
  it("the first weekly-Friday rebalance after Mon 2024-01-01 is Fri 2024-01-05", () => {
    expect(simDateLabel(nextRebalanceAfter(DEFAULT_START_MS, defaultSchedule()))).toBe("Fri 2024-01-05");
  });

  it("advancing 3 weeks fires 3 Friday rebalances at the right dates", () => {
    const b = createBasket({ name: "Cal", constituents: fivePeople() });
    const fired = advanceTime(b, 21 * DAY_MS);
    expect(fired).toBe(3);
    const rebs = b.history.filter((h) => h.event === "rebalance");
    expect(rebs.map((r) => r.t.slice(0, 10))).toEqual(["2024-01-05", "2024-01-12", "2024-01-19"]);
    expect(new Date(b.clockMs).toISOString().slice(0, 10)).toBe("2024-01-22");
  });

  it("monthly schedule fires on the configured day of month", () => {
    const b = createBasket({ name: "Cal2", schedule: { frequency: "monthly", dayOfMonth: 1 }, constituents: fivePeople() });
    const fired = advanceTime(b, 70 * DAY_MS); // ~2.3 months from Jan 1
    expect(fired).toBe(2); // Feb 1, Mar 1
  });
});

describe("history recording", () => {
  it("recordTick appends an index point reflecting the live value", () => {
    const b = createBasket({ name: "H", baseValue: 1000, constituents: fivePeople() });
    setPrice(b, "A", 1.5);
    const v = recordTick(b);
    const last = b.history[b.history.length - 1];
    expect(last.event).toBe("trade");
    expect(last.value).toBeCloseTo(v, 9);
    expect(v).toBeCloseTo(indexValue(b), 9);
  });
});
