import { describe, it, expect } from "vitest";
import {
  defaultConfig,
  defaultState,
  type PauvConfig,
  type PauvState,
} from "@/market/pauv-engine";
import {
  createSlate,
  slateValue,
  rebalance,
  addConstituent,
  removeConstituent,
  constituentReturn,
  recordTick,
  snapshotConstituents,
  previewInvestment,
  investInPerson,
  closePersonPosition,
  holderValue,
  advanceTime,
  nextRebalanceAfter,
  defaultSchedule,
  simDateLabel,
  constituentPrice,
  getConstituent,
  DAY_MS,
  DEFAULT_START_MS,
  type Slate,
} from "./slate-engine";

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
function setPrice(slate: Slate, id: string, target: number): void {
  const c = slate.constituents.find((x) => x.id === id)!;
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
  it("equal-weight slate launches at the base value (1000)", () => {
    const b = createSlate({ name: "Launch", constituents: fivePeople(), baseValue: 1000 });
    expect(slateValue(b)).toBeCloseTo(1000, 9);
    expect(b.history[0].event).toBe("launch");
    expect(b.history[0].value).toBeCloseTo(1000, 9);
  });

  it("records each constituent's launch price as baseline → return starts at 0", () => {
    const b = createSlate({ name: "Launch", constituents: fivePeople() });
    for (const c of b.constituents) expect(constituentReturn(c)).toBeCloseTo(0, 9);
  });
});

describe("creator-set initial slate value", () => {
  it("launches exactly at the chosen value", () => {
    const b = createSlate({ name: "EqInit", baseValue: 250, constituents: fivePeople() });
    expect(b.baseValue).toBe(250);
    expect(slateValue(b)).toBeCloseTo(250, 9);
  });

  it("defaults to 1000 when no initial value is given", () => {
    const b = createSlate({ name: "Def", constituents: fivePeople() });
    expect(b.baseValue).toBe(1000);
  });
});

describe("PDF Part 3/4 — returns & equal weighting", () => {
  it("return_i = price/baseline − 1", () => {
    const b = createSlate({ name: "R", constituents: fivePeople() });
    setPrice(b, "A", 1.4); // launched at 1.0 → +40%
    expect(constituentReturn(b.constituents.find((c) => c.id === "A")!)).toBeCloseTo(0.4, 6);
  });

  it("half +10% / half −10% leaves the slate unchanged (avg return 0)", () => {
    const b = createSlate({
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
    expect(slateValue(b)).toBeCloseTo(1000, 6);
  });

  it("A +50% and B −50% leaves a 2-name equal-weight slate unchanged", () => {
    const b = createSlate({
      name: "Drift",
      baseValue: 1000,
      constituents: [
        { id: "A", name: "A", market: marketAtPrice(1), config: { ...CFG } },
        { id: "B", name: "B", market: marketAtPrice(1), config: { ...CFG } },
      ],
    });
    setPrice(b, "A", 1.5);
    setPrice(b, "B", 0.5);
    expect(slateValue(b)).toBeCloseTo(1000, 6);
  });

  it("slate = baseValue × (1 + average return)", () => {
    const b = createSlate({ name: "Avg", baseValue: 1000, constituents: fivePeople() });
    setPrice(b, "A", 1.2); // +20
    setPrice(b, "B", 1.1); // +10
    setPrice(b, "C", 1.0); //   0
    setPrice(b, "D", 0.9); // −10
    setPrice(b, "E", 1.3); // +30
    const avg = (0.2 + 0.1 + 0 - 0.1 + 0.3) / 5; // = 0.10
    expect(slateValue(b)).toBeCloseTo(1000 * (1 + avg), 4);
  });
});

describe("PDF Part 6 — rebalancing", () => {
  it("is value-continuous (no jump) but resets baselines", () => {
    const b = createSlate({ name: "Reb", baseValue: 1000, constituents: fivePeople() });
    setPrice(b, "A", 2.0); // +100
    const before = slateValue(b);
    rebalance(b);
    expect(slateValue(b)).toBeCloseTo(before, 6); // continuous
    // After rebalance every return clock is back to zero.
    for (const c of b.constituents) expect(constituentReturn(c)).toBeCloseTo(0, 6);
    // anchor moved up to the rebalanced value.
    expect(b.anchorValue).toBeCloseTo(before, 6);
  });

  it("re-equalizes weights (post-rebalance realized weights are equal)", () => {
    const b = createSlate({ name: "Reb2", baseValue: 1000, constituents: fivePeople() });
    setPrice(b, "A", 3.0);
    setPrice(b, "B", 0.5);
    rebalance(b);
    const weights = snapshotConstituents(b).map((s) => s.weight);
    for (const w of weights) expect(w).toBeCloseTo(1 / 5, 6);
  });
});

describe("PDF Part 7 — composition change is invisible to the slate value", () => {
  it("adding a constituent does not move the slate value", () => {
    const b = createSlate({ name: "Add", baseValue: 1000, constituents: fivePeople() });
    setPrice(b, "A", 1.5);
    const before = slateValue(b);
    addConstituent(b, { id: "F", name: "F", market: marketAtPrice(7.3), config: { ...CFG } });
    expect(slateValue(b)).toBeCloseTo(before, 6); // no jump despite F at $7.30
    expect(b.constituents.length).toBe(6);
  });

  it("removing a constituent does not move the slate value", () => {
    const b = createSlate({ name: "Rem", baseValue: 1000, constituents: fivePeople() });
    setPrice(b, "A", 2.0);
    setPrice(b, "B", 0.7);
    const before = slateValue(b);
    removeConstituent(b, "A");
    expect(slateValue(b)).toBeCloseTo(before, 6);
    expect(b.constituents.length).toBe(4);
  });

  it("after add, only real price moves change the slate", () => {
    const b = createSlate({ name: "Add2", baseValue: 1000, constituents: fivePeople() });
    addConstituent(b, { id: "F", name: "F", market: marketAtPrice(10), config: { ...CFG } });
    const before = slateValue(b);
    setPrice(b, "F", 20); // F doubles → +100% on 1/6 of the book
    const after = slateValue(b);
    expect(after).toBeCloseTo(before * (1 + 1.0 / 6), 4);
  });
});

describe("single-person investing (95/5 split)", () => {
  it("preview: primary gets 95% + 5%/N, others get 5%/N, sums to amount", () => {
    const b = createSlate({ name: "Inv", constituents: fivePeople() });
    const rows = previewInvestment(b, "A", 1000, 0.95);
    const a = rows.find((r) => r.id === "A")!;
    const other = rows.find((r) => r.id === "B")!;
    expect(a.amount).toBeCloseTo(950 + 50 / 5, 6); // 960
    expect(other.amount).toBeCloseTo(50 / 5, 6);    // 10
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(1000, 6);
    expect(a.isPrimary).toBe(true);
  });

  it("execute: primary price rises most, everyone rises, slate goes up", () => {
    const b = createSlate({ name: "Inv2", baseValue: 1000, constituents: fivePeople() });
    const before = slateValue(b);
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
    expect(res.slateAfter).toBeGreaterThan(before);
    // slate value continues from the trade; matches live computation
    expect(res.slateAfter).toBeCloseTo(slateValue(b), 9);
  });

  it("the 5% routes through the slate: each member's slate slice is equal (incl. primary)", () => {
    const b = createSlate({ name: "Idx5", baseValue: 1000, constituents: fivePeople() });
    const res = investInPerson(b, "A", 10_000, { primaryPct: 0.95 });
    const slateSlices = res.allocations.map((a) => a.slateAmount);
    // every member (A included) gets the same slate slice = 5%*10000/5 = 100
    for (const s of slateSlices) expect(s).toBeCloseTo(100, 6);
    const primary = res.allocations.find((a) => a.isPrimary)!;
    expect(primary.primaryAmount).toBeCloseTo(9_500, 6); // direct 95%
    expect(primary.amount).toBeCloseTo(9_600, 6);         // direct + slate slice
    expect(res.slateAmount).toBeCloseTo(500, 6);
  });

  it("100% primary (primaryPct=1) buys only the chosen person", () => {
    const b = createSlate({ name: "Inv3", constituents: fivePeople() });
    investInPerson(b, "C", 5_000, { primaryPct: 1 });
    expect(constituentPrice(getConstituent(b, "C")!)).toBeGreaterThan(1);
    expect(constituentPrice(getConstituent(b, "A")!)).toBeCloseTo(1, 9); // untouched
  });
});

describe("the slate leg (auto-spread money flow)", () => {
  it("the slate leg flows in equal dollar slices to every member", () => {
    const b = createSlate({ name: "II", baseValue: 1000, constituents: fivePeople() });
    const before = slateValue(b);
    const res = investInPerson(b, "A", 10_000, { primaryPct: 0.95 });
    // The $500 slate leg splits $100 into each of the 5 members.
    for (const a of res.allocations) expect(a.slateAmount).toBeCloseTo(100, 6);
    expect(res.allocations.reduce((s, a) => s + a.slateAmount, 0)).toBeCloseTo(500, 4);
    expect(res.slateAfter).toBeGreaterThan(before);
  });
});

describe("slate vehicle (ETF units — mintable only via the auto-spread)", () => {
  it("a person invest mints units; closing the position burns them and returns the cash", () => {
    const b = createSlate({ name: "ETF", baseValue: 1000, constituents: fivePeople() });
    const r = investInPerson(b, "A", 10_000, { primaryPct: 0.95, investorId: "alice" });
    expect(r.units).toBeGreaterThan(0);
    expect(b.ledger.unitsOutstanding).toBeCloseTo(r.units, 9);
    expect(b.ledger.holders["alice"]).toBeCloseTo(r.units, 9);
    // unit price = slate value, so the 5% leg is worth ~ its $500 cost.
    expect(holderValue(b, "alice")).toBeCloseTo(500, 2);

    // Closing the direct position unwinds the units too — every curve fully
    // unwound on zero fees, so the round trip returns the full $10,000.
    const close = closePersonPosition(b, "A", r.positionId!);
    expect(close.proceeds).toBeCloseTo(10_000, 2);
    expect(b.ledger.unitsOutstanding).toBeCloseTo(0, 6);
    expect(holderValue(b, "alice")).toBeCloseTo(0, 6);
  });

  it("single-person invest mints slate units (5% leg) AND a direct position (95%)", () => {
    const b = createSlate({ name: "ETF2", baseValue: 1000, constituents: fivePeople() });
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
    const b = createSlate({ name: "Cal", constituents: fivePeople() });
    const fired = advanceTime(b, 21 * DAY_MS);
    expect(fired).toBe(3);
    const rebs = b.history.filter((h) => h.event === "rebalance");
    expect(rebs.map((r) => r.t.slice(0, 10))).toEqual(["2024-01-05", "2024-01-12", "2024-01-19"]);
    expect(new Date(b.clockMs).toISOString().slice(0, 10)).toBe("2024-01-22");
  });

  it("monthly schedule fires on the configured day of month", () => {
    const b = createSlate({ name: "Cal2", schedule: { frequency: "monthly", dayOfMonth: 1 }, constituents: fivePeople() });
    const fired = advanceTime(b, 70 * DAY_MS); // ~2.3 months from Jan 1
    expect(fired).toBe(2); // Feb 1, Mar 1
  });
});

describe("history recording", () => {
  it("recordTick appends a slate point reflecting the live value", () => {
    const b = createSlate({ name: "H", baseValue: 1000, constituents: fivePeople() });
    setPrice(b, "A", 1.5);
    const v = recordTick(b);
    const last = b.history[b.history.length - 1];
    expect(last.event).toBe("trade");
    expect(last.value).toBeCloseTo(v, 9);
    expect(v).toBeCloseTo(slateValue(b), 9);
  });
});
