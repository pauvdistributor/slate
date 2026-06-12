import { describe, it, expect } from "vitest";
import {
  defaultConfig,
  defaultState,
  buy,
  sell,
  shortOpen,
  shortClose,
  getClosedPositions,
  type PauvConfig,
} from "./pauv-engine";

// DTM4.1's closed-positions table, as a pure engine view. The assertions
// mirror the page-level derivation in DTM4.1 (src/app/dtm4/page.tsx):
// paid = open.amountIn − open.fee, received = close.amountOut + close.fee,
// realizedPnL = received − paid (fee-excluded: fees reported separately).

const FEE = 0.018;
const cfg: PauvConfig = defaultConfig({ P0: 1, b: 0.001, alpha: 100, feeRate: FEE });
const noFeeCfg: PauvConfig = defaultConfig({ P0: 1, b: 0.001, alpha: 100, feeRate: 0 });

describe("getClosedPositions — DTM4.1 record shape", () => {
  it("open positions produce no record", () => {
    const s = buy(defaultState(), cfg, "alice", 1000).state;
    expect(getClosedPositions(s)).toHaveLength(0);
  });

  it("buy → sell yields a long record matching the txLog rows", () => {
    const bought = buy(defaultState(), cfg, "alice", 1000);
    const sold = sell(bought.state, cfg, bought.positionId);
    const records = getClosedPositions(sold.state);
    expect(records).toHaveLength(1);

    const r = records[0];
    const open = sold.state.txLog.find((t) => t.type === "buy")!;
    const close = sold.state.txLog.find((t) => t.type === "sell")!;
    expect(r.id).toBe(bought.positionId);
    expect(r.type).toBe("long");
    expect(r.userId).toBe("alice");
    expect(r.tokens).toBeCloseTo(open.tokens, 9);
    expect(r.paid).toBeCloseTo(open.amountIn - open.fee, 9);
    expect(r.fees).toBeCloseTo(open.fee + close.fee, 9);
    expect(r.amountOut).toBeCloseTo(close.amountOut + close.fee, 9);
    expect(r.realizedPnL).toBeCloseTo(r.amountOut - r.paid, 9);
    expect(r.openPrice).toBeCloseTo(open.priceBefore, 12);
    expect(r.closePrice).toBeCloseTo(close.priceAfter, 12);
    expect(r.closedAt).toBe(close.timestamp);
    expect(r.wasLiquidated).toBe(false);
  });

  it("realized P&L is fee-excluded: an immediate round trip realizes ~0, not −2×fee", () => {
    const bought = buy(defaultState(), cfg, "alice", 1000);
    const sold = sell(bought.state, cfg, bought.positionId);
    const [r] = getClosedPositions(sold.state);
    // $18 went in as open fee and ~$17.7 out as close fee, but P&L only
    // measures the curve: net-in equals gross-out when the price is unmoved.
    expect(r.realizedPnL).toBeCloseTo(0, 6);
    expect(r.fees).toBeGreaterThan(30);
  });

  it("short open → close yields a short record", () => {
    const seeded = buy(defaultState(), noFeeCfg, "seed", 50_000).state;
    const opened = shortOpen(seeded, noFeeCfg, "bob", 1000);
    const closed = shortClose(opened.state, noFeeCfg, opened.positionId);
    const r = getClosedPositions(closed.state).find((x) => x.userId === "bob")!;
    expect(r.type).toBe("short");
    expect(r.wasLiquidated).toBe(false);
    const open = closed.state.txLog.find((t) => t.type === "short_open")!;
    const close = closed.state.txLog.find((t) => t.type === "short_close")!;
    expect(r.paid).toBeCloseTo(open.amountIn - open.fee, 9);
    expect(r.amountOut).toBeCloseTo(close.amountOut + close.fee, 9);
  });

  it("a liquidated short is flagged wasLiquidated", () => {
    const seeded = buy(defaultState(), noFeeCfg, "seed", 50_000).state;
    const opened = shortOpen(seeded, noFeeCfg, "bob", 500);
    // A large enough buy walks Q past bob's trip point and fires the
    // liquidation mid-walk.
    const pumped = buy(opened.state, noFeeCfg, "whale", 500_000).state;
    const r = getClosedPositions(pumped).find((x) => x.userId === "bob");
    expect(r).toBeDefined();
    expect(r!.type).toBe("short");
    expect(r!.wasLiquidated).toBe(true);
  });

  it("filters by userId when given", () => {
    const a = buy(defaultState(), noFeeCfg, "alice", 1000);
    const b = buy(a.state, noFeeCfg, "bob", 1000);
    const s1 = sell(b.state, noFeeCfg, a.positionId);
    const s2 = sell(s1.state, noFeeCfg, b.positionId);
    expect(getClosedPositions(s2.state)).toHaveLength(2);
    expect(getClosedPositions(s2.state, "alice")).toHaveLength(1);
    expect(getClosedPositions(s2.state, "alice")[0].userId).toBe("alice");
  });
});
