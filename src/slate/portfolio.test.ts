import { describe, it, expect } from "vitest";
import { buy } from "@/market/pauv-engine";
import {
  createSlate,
  investInPerson,
  shortPerson,
  closePersonPosition,
  getPortfolio,
  personClosedPositions,
  DIRECT_FEE_RATE,
  type Slate,
} from "./slate-engine";

// The DTM4.1 portfolio contract ({ userId, balance, positions,
// closedPositions }) served from slate world: positions span every person
// market, slate legs point at their parent order, and the slate vehicle
// shows up as additive slateHoldings.

function threePeople(): Slate {
  return createSlate({
    name: "Test slate",
    baseValue: 1000,
    constituents: ["A", "B", "C"].map((id) => ({
      id,
      name: `Person ${id}`,
      config: { P0: 1, b: 0.001, alpha: 100, feeRate: 0 },
    })),
  });
}

describe("getPortfolio — DTM4.1 contract + index additions", () => {
  it("a long invest yields one direct position plus slate units", () => {
    const slate = threePeople();
    investInPerson(slate, "A", 1000, { investorId: "u1", feeRate: DIRECT_FEE_RATE });

    const p = getPortfolio([slate], "u1", 5000);
    // DTM4.1 contract fields, verbatim.
    expect(p.userId).toBe("u1");
    expect(p.balance).toBe(5000);
    expect(Array.isArray(p.positions)).toBe(true);
    expect(Array.isArray(p.closedPositions)).toBe(true);

    // The 95% direct leg is the only position row (the 5% slate leg mints
    // units, which are ledger holdings, not curve positions).
    expect(p.positions).toHaveLength(1);
    expect(p.positions[0].type).toBe("long");
    expect(p.positions[0].marketId).toBe("A");
    expect(p.positions[0].marketName).toBe("Person A");
    expect(p.positions[0].slateId).toBe(slate.id);
    expect(p.positions[0].slateLegOf).toBeUndefined();

    expect(p.slateHoldings).toHaveLength(1);
    expect(p.slateHoldings[0].units).toBeGreaterThan(0);
    expect(p.slateHoldings[0].value).toBeGreaterThan(0);

    expect(p.openPositions).toBe(1);
    expect(p.positionValue).toBeCloseTo(p.positions[0].currentValue, 9);
    expect(p.unrealizedPnL).toBeCloseTo(p.positions[0].pnl, 9);
  });

  it("a short's spread legs carry slateLegOf pointing at the direct short", () => {
    const slate = threePeople();
    // Lift every curve so shorts have room (engine-level seed; the slate
    // itself is only tradeable through the auto-spread).
    for (const c of slate.constituents) c.market = buy(c.market, c.config, "seed", 20_000).state;
    const res = shortPerson(slate, "B", 600, { investorId: "u2", feeRate: DIRECT_FEE_RATE });

    const p = getPortfolio([slate], "u2");
    // 1 direct short on B + one small short per member (A, B, C).
    expect(p.positions).toHaveLength(4);
    const direct = p.positions.find((x) => x.slateLegOf === undefined)!;
    expect(direct.id).toBe(res.positionId);
    expect(direct.marketId).toBe("B");
    const legs = p.positions.filter((x) => x.slateLegOf === res.positionId);
    expect(legs).toHaveLength(3);
    expect(new Set(legs.map((l) => l.marketId))).toEqual(new Set(["A", "B", "C"]));
  });

  it("closing a position moves it into closedPositions with market context", () => {
    const slate = threePeople();
    const inv = investInPerson(slate, "A", 1000, { investorId: "u1", feeRate: DIRECT_FEE_RATE });
    closePersonPosition(slate, "A", inv.positionId!, { feeRate: DIRECT_FEE_RATE });

    const p = getPortfolio([slate], "u1");
    expect(p.positions).toHaveLength(0);
    expect(p.closedPositions.length).toBeGreaterThanOrEqual(1);
    const r = p.closedPositions.find((x) => x.id === inv.positionId)!;
    expect(r.marketId).toBe("A");
    expect(r.marketName).toBe("Person A");
    expect(r.slateId).toBe(slate.id);
    // Fees were paid on both direct legs (open + close).
    expect(r.fees).toBeGreaterThan(0);
    expect(p.realizedPnL).toBeCloseTo(
      p.closedPositions.reduce((s, x) => s + x.realizedPnL, 0),
      9,
    );
    // The linked slate units were sold back with the close.
    expect(p.slateHoldings).toHaveLength(0);
  });

  it("personClosedPositions scopes records to one person market", () => {
    const slate = threePeople();
    const inv = investInPerson(slate, "A", 1000, { investorId: "u1" });
    closePersonPosition(slate, "A", inv.positionId!);
    expect(personClosedPositions(slate, "A", "u1")).toHaveLength(1);
    expect(personClosedPositions(slate, "B", "u1")).toHaveLength(0);
  });
});
