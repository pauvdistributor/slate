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
