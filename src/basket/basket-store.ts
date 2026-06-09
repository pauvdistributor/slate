// ============================================================
// CLIENT STORE
// ------------------------------------------------------------
// Browser persistence for the simulation, mirroring DTM4.1's
// localStorage approach. The engine modules are pure; this file
// is the only place that touches localStorage. The whole
// SimState (basket + per-constituent markets + bot cash) is one
// JSON blob — fine for a single-user simulation.
//
// For a real backend, swap this out for the same pure engine
// calls against a database. See src/app/api/* for a server-side
// in-memory example.
// ============================================================

import {
  defaultState,
  defaultConfig,
  buy,
  type PauvConfig,
} from "@/market/pauv-engine";
import {
  createBasket,
  type WeightingMode,
} from "./basket-engine";
import {
  createSim,
  type SimState,
} from "./simulation";

const STORE_KEY = "basket_sim_state_v1";

// ---- Demo roster (themed group, PDF Part 8) ----
const DEMO_PEOPLE = [
  "Ada", "Bao", "Cira", "Diego", "Esme",
] as const;

const SEED_CFG: PauvConfig = defaultConfig({
  P0: 1,
  b: 0.001,
  alpha: 100,
  feeRate: 0,
});

/**
 * Build a fresh simulation: 5 themed constituents, each seeded with a small
 * initial buy so prices and supply are non-zero (needed for market-cap mode).
 */
export function seedSim(opts?: {
  name?: string;
  weighting?: WeightingMode;
  baseValue?: number;
  rebalanceIntervalMs?: number;
}): SimState {
  const constituents = DEMO_PEOPLE.map((name, i) => {
    // Stagger the seed buys so they don't all launch at exactly the same price.
    const seedUsd = 2_000 + i * 1_500;
    const market = buy(defaultState(), SEED_CFG, "seed", seedUsd).state;
    return { id: name.toLowerCase(), name, market, config: { ...SEED_CFG } };
  });

  const basket = createBasket({
    name: opts?.name ?? "Rising Talent",
    weighting: opts?.weighting ?? "equal",
    baseValue: opts?.baseValue ?? 1000,
    rebalanceIntervalMs: opts?.rebalanceIntervalMs,
    constituents,
  });

  return createSim(basket);
}

export function loadSim(): SimState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SimState;
  } catch {
    return null;
  }
}

export function saveSim(sim: SimState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(sim));
  } catch {
    /* quota / serialization errors are non-fatal for a sim */
  }
}

export function resetSim(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORE_KEY);
}

/** Load existing sim or seed a fresh one and persist it. */
export function loadOrSeed(): SimState {
  const existing = loadSim();
  if (existing && existing.basket && existing.basket.constituents.length > 0) {
    return existing;
  }
  const seeded = seedSim();
  saveSim(seeded);
  return seeded;
}
