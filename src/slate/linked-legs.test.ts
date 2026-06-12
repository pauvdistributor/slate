import { describe, it, expect } from "vitest";
import {
  defaultConfig,
  defaultState,
  type PauvConfig,
  type PauvState,
} from "@/market/pauv-engine";
import {
  createSlate,
  investInPerson,
  shortPerson,
  closePersonPosition,
  personPositions,
  personOrders,
  slateLinkedPositionIds,
  totalFeesPaid,
  DIRECT_FEE_RATE,
  type Slate,
} from "./slate-engine";

const CFG: PauvConfig = defaultConfig({ P0: 1, b: 0.001, alpha: 100, feeRate: 0 });

function qForPrice(target: number, cfg = CFG): number {
  const r0 = cfg.P0 / cfg.alpha;
  const rawP0 = r0 > 40 ? cfg.P0 : cfg.alpha * Math.log(Math.exp(r0) - 1);
  const x = target / cfg.alpha;
  const lnExpM1 = x > 40 ? target : cfg.alpha * Math.log(Math.exp(x) - 1);
  return (lnExpM1 - rawP0) / cfg.b;
}

function marketAtPrice(target: number): PauvState {
  const s = defaultState();
  s.Q = qForPrice(target);
  return s;
}

function freshSlate(): Slate {
  return createSlate({
    name: "Linked",
    baseValue: 1000,
    constituents: ["A", "B", "C", "D", "E"].map((id) => ({
      id,
      name: id,
      market: marketAtPrice(1),
      config: { ...CFG },
    })),
  });
}

const YOU = "you";

describe("linked slate legs — long invests", () => {
  it("investInPerson links the minted units to the direct position", () => {
    const b = freshSlate();
    const res = investInPerson(b, "A", 1000, { primaryPct: 0.95, investorId: YOU });
    expect(res.positionId).toBeTruthy();
    expect(res.units).toBeGreaterThan(0);
    expect(b.linkedLegs?.[res.positionId!]?.units).toBeCloseTo(res.units, 9);
  });

  it("closing the direct long also sells the linked slate units", () => {
    const b = freshSlate();
    const res = investInPerson(b, "A", 1000, { primaryPct: 0.95, investorId: YOU });
    expect(b.ledger.holders[YOU]).toBeCloseTo(res.units, 9);

    const close = closePersonPosition(b, "A", res.positionId!);
    expect(close.closedSlateLegs).toBe(1);
    expect(close.slateProceeds).toBeGreaterThan(0);
    expect(close.proceeds).toBeCloseTo(close.directProceeds + close.slateProceeds, 9);
    // Units are gone and the linkage entry is cleaned up.
    expect(b.ledger.holders[YOU]).toBeCloseTo(0, 9);
    expect(b.linkedLegs?.[res.positionId!]).toBeUndefined();
    // The direct position is gone too.
    expect(personPositions(b, "A", YOU)).toHaveLength(0);
  });

  it("primaryPct=1 leaves no slate leg and no linkage", () => {
    const b = freshSlate();
    const res = investInPerson(b, "A", 1000, { primaryPct: 1, investorId: YOU });
    expect(res.units).toBe(0);
    expect(b.linkedLegs?.[res.positionId!]).toBeUndefined();
    const close = closePersonPosition(b, "A", res.positionId!);
    expect(close.closedSlateLegs).toBe(0);
    expect(close.slateProceeds).toBe(0);
  });
});

describe("linked slate legs — shorts", () => {
  it("shortPerson opens a direct short plus spread shorts across every member", () => {
    const b = freshSlate();
    const res = shortPerson(b, "A", 1000, { primaryPct: 0.95, investorId: YOU });
    expect(res.positionId).toBeTruthy();
    expect(res.slateAmount).toBeCloseTo(50, 9);
    // Equal weighting: one slate short per member (including A itself).
    expect(res.slateShortCount).toBe(5);
    const link = b.linkedLegs?.[res.positionId];
    expect(link?.shorts).toHaveLength(5);
    // Every linked short exists on its member's curve and belongs to the investor.
    for (const s of link!.shorts!) {
      const c = b.constituents.find((x) => x.id === s.constituentId)!;
      const pos = c.market.positions[s.positionId];
      expect(pos?.type).toBe("short");
      expect(pos?.userId).toBe(YOU);
    }
    // The person's own curve carries the direct short and its slate slice.
    expect(personPositions(b, "A", YOU)).toHaveLength(2);
    expect(slateLinkedPositionIds(b, "A").size).toBe(1);
  });

  it("closing the direct short closes all linked member shorts", () => {
    const b = freshSlate();
    const res = shortPerson(b, "A", 1000, { primaryPct: 0.95, investorId: YOU });
    const close = closePersonPosition(b, "A", res.positionId);
    expect(close.closedSlateLegs).toBe(5);
    expect(close.slateProceeds).toBeGreaterThan(0);
    expect(b.linkedLegs?.[res.positionId]).toBeUndefined();
    // No shorts remain anywhere.
    for (const c of b.constituents) {
      expect(Object.keys(c.market.positions)).toHaveLength(0);
    }
  });

  it("a rejected leg aborts the whole short (two-phase commit)", () => {
    const b = freshSlate();
    // Stake far beyond what a $1 curve can pay out forces a rejection on the
    // direct leg; the slate must be left untouched.
    const before = b.constituents.map((c) => c.market.Q);
    expect(() => shortPerson(b, "A", 50_000_000, { primaryPct: 0.95, investorId: YOU })).toThrow();
    b.constituents.forEach((c, i) => expect(c.market.Q).toBe(before[i]));
    expect(Object.keys(b.linkedLegs ?? {})).toHaveLength(0);
  });
});

describe("personOrders — one combined entry per trade", () => {
  it("a long invest is one order whose cost/value/pnl combine both legs", () => {
    const b = freshSlate();
    investInPerson(b, "A", 1000, { primaryPct: 0.95, investorId: YOU });

    const orders = personOrders(b, "A", YOU);
    expect(orders).toHaveLength(1);
    const o = orders[0];
    expect(o.position.type).toBe("long");
    expect(o.slateLeg?.kind).toBe("units");
    expect(o.slateLeg?.cost).toBeCloseTo(50, 6);   // the 5% leg
    expect(o.totalCost).toBeCloseTo(1000, 4);       // 950 direct + 50 slate
    expect(o.totalValue).toBeCloseTo(o.position.currentValue + o.slateLeg!.currentValue, 9);
    expect(o.totalPnl).toBeCloseTo(o.totalValue - o.totalCost, 9);
  });

  it("a short is one order; its slate-leg shorts are folded in, not listed standalone", () => {
    const b = freshSlate();
    shortPerson(b, "A", 1000, { primaryPct: 0.95, investorId: YOU });

    // A's curve carries the direct short AND its own slate slice, but the
    // orders view folds the slice into the parent.
    expect(personPositions(b, "A", YOU)).toHaveLength(2);
    const orders = personOrders(b, "A", YOU);
    expect(orders).toHaveLength(1);
    const o = orders[0];
    expect(o.position.type).toBe("short");
    expect(o.slateLeg?.kind).toBe("shorts");
    expect(o.slateLeg?.memberLegs).toHaveLength(5);
    expect(o.slateLeg?.cost).toBeCloseTo(50, 4);    // 5 member stakes of $10
    expect(o.totalCost).toBeCloseTo(1000, 4);

    // Viewing another member: the leg on B's curve belongs to A's parent.
    expect(personOrders(b, "B", YOU)).toHaveLength(0);
  });

  it("a 100% direct trade has no slate leg", () => {
    const b = freshSlate();
    investInPerson(b, "A", 1000, { primaryPct: 1, investorId: YOU });
    const orders = personOrders(b, "A", YOU);
    expect(orders).toHaveLength(1);
    expect(orders[0].slateLeg).toBeNull();
    expect(orders[0].totalCost).toBeCloseTo(1000, 4);
  });

  it("closing the parent clears the order and both legs", () => {
    const b = freshSlate();
    const res = shortPerson(b, "A", 1000, { primaryPct: 0.95, investorId: YOU });
    closePersonPosition(b, "A", res.positionId);
    expect(personOrders(b, "A", YOU)).toHaveLength(0);
    for (const c of b.constituents) {
      expect(Object.keys(c.market.positions)).toHaveLength(0);
    }
  });
});

describe("direct-leg fees", () => {
  it("a long invest pays the fee on the direct leg only", () => {
    const b = freshSlate();
    investInPerson(b, "A", 1000, { primaryPct: 0.95, investorId: YOU, feeRate: DIRECT_FEE_RATE });
    // 1.8% of the $950 direct leg; the $50 slate leg is fee-free.
    expect(totalFeesPaid(b)).toBeCloseTo(950 * DIRECT_FEE_RATE, 6);
  });

  it("a short pays the fee on the direct stake only", () => {
    const b = freshSlate();
    shortPerson(b, "A", 1000, { primaryPct: 0.95, investorId: YOU, feeRate: DIRECT_FEE_RATE });
    expect(totalFeesPaid(b)).toBeCloseTo(950 * DIRECT_FEE_RATE, 6);
  });

  it("no feeRate passed (toggle off) → no fees", () => {
    const b = freshSlate();
    investInPerson(b, "A", 1000, { primaryPct: 0.95, investorId: YOU });
    shortPerson(b, "B", 1000, { primaryPct: 0.95, investorId: YOU });
    expect(totalFeesPaid(b)).toBe(0);
  });

  it("fees accumulate across accounts", () => {
    const b = freshSlate();
    investInPerson(b, "A", 1000, { primaryPct: 0.95, investorId: "alice", feeRate: DIRECT_FEE_RATE });
    investInPerson(b, "B", 2000, { primaryPct: 0.95, investorId: "bob", feeRate: DIRECT_FEE_RATE });
    expect(totalFeesPaid(b)).toBeCloseTo((950 + 1900) * DIRECT_FEE_RATE, 6);
  });

  it("closing a long pays the fee on the direct leg; the slate-leg unwind is fee-free", () => {
    const b = freshSlate();
    const res = investInPerson(b, "A", 1000, { primaryPct: 0.95, investorId: YOU }); // open fee-free
    expect(totalFeesPaid(b)).toBe(0);
    const close = closePersonPosition(b, "A", res.positionId!, { feeRate: DIRECT_FEE_RATE });
    expect(close.closedSlateLegs).toBe(1);
    // sell charges fee on gross proceeds: fee = net × r/(1−r); only the
    // direct leg is fee'd, so the total must match it exactly.
    const expected = close.directProceeds * (DIRECT_FEE_RATE / (1 - DIRECT_FEE_RATE));
    expect(totalFeesPaid(b)).toBeCloseTo(expected, 6);
  });

  it("closing a short pays the fee on the direct leg only", () => {
    const b = freshSlate();
    const res = shortPerson(b, "A", 1000, { primaryPct: 0.95, investorId: YOU }); // open fee-free
    const close = closePersonPosition(b, "A", res.positionId, { feeRate: DIRECT_FEE_RATE });
    expect(close.closedSlateLegs).toBe(5);
    const expected = close.directProceeds * (DIRECT_FEE_RATE / (1 - DIRECT_FEE_RATE));
    expect(totalFeesPaid(b)).toBeCloseTo(expected, 6);
  });

  it("no feeRate on close (toggle off) → closing stays free", () => {
    const b = freshSlate();
    const res = investInPerson(b, "A", 1000, { primaryPct: 0.95, investorId: YOU });
    closePersonPosition(b, "A", res.positionId!);
    expect(totalFeesPaid(b)).toBe(0);
  });
});
