import { describe, it, expect } from "vitest";
import {
  defaultConfig,
  defaultState,
  buy,
  sell,
  shortOpen,
  shortClose,
  currentPrice,
  costIntegral,
  price,
  type PauvConfig,
} from "./pauv-engine";

const cfg: PauvConfig = defaultConfig({ P0: 1, b: 0.001, alpha: 100, feeRate: 0 });

describe("pauv-engine core math", () => {
  it("price at Q=0 equals P0", () => {
    expect(price(0, cfg.P0, cfg.b, cfg.alpha)).toBeCloseTo(cfg.P0, 6);
  });

  it("price is monotonic increasing in Q", () => {
    expect(price(100, cfg.P0, cfg.b, cfg.alpha)).toBeGreaterThan(
      price(0, cfg.P0, cfg.b, cfg.alpha),
    );
  });

  it("costIntegral is anti-symmetric", () => {
    const a = costIntegral(0, 500, cfg.P0, cfg.b, cfg.alpha);
    const b = costIntegral(500, 0, cfg.P0, cfg.b, cfg.alpha);
    expect(a).toBeCloseTo(-b, 6);
  });
});

describe("pauv-engine operations are pure", () => {
  it("buy does not mutate the input state", () => {
    const s0 = defaultState();
    const res = buy(s0, cfg, "alice", 1000);
    expect(s0.Q).toBe(0); // input untouched
    expect(res.state.Q).toBeGreaterThan(0); // new state advanced
    expect(res.newPrice).toBeGreaterThan(cfg.P0);
  });

  it("buy then sell round-trips with zero fees (price returns to P0)", () => {
    const s0 = defaultState();
    const bought = buy(s0, cfg, "alice", 5000);
    const pos = Object.values(bought.state.positions)[0];
    const sold = sell(bought.state, cfg, pos.id);
    expect(currentPrice(sold.state, cfg)).toBeCloseTo(cfg.P0, 4);
    // No fees → proceeds ≈ amount spent.
    expect(sold.netProceeds).toBeCloseTo(5000, 2);
  });

  it("short open then close round-trips", () => {
    const s0 = buy(defaultState(), cfg, "seed", 50_000).state; // lift price first
    const opened = shortOpen(s0, cfg, "bob", 1000);
    expect(opened.escrow).toBeCloseTo(2000, 6); // escrow = 2× netStake
    const shortId = Object.keys(opened.state.positions).find(
      (id) => opened.state.positions[id].type === "short",
    )!;
    const closed = shortClose(opened.state, cfg, shortId);
    expect(closed.netReturn).toBeGreaterThan(0);
  });
});
