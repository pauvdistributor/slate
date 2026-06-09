// ============================================================
// SERVER-SIDE STORE (in-memory)
// ------------------------------------------------------------
// A minimal example of running the SAME pure engine on the
// server instead of in the browser. Here state lives in a
// module-level Map; in production you would replace get/set
// with database reads/writes — the engine calls are identical.
//
// NOTE: Next.js dev hot-reload resets module state, and each
// serverless instance has its own memory. This is for local
// testing of the API surface, not durable storage.
// ============================================================

import type { Basket } from "@/basket/basket-engine";
import { seedSim } from "@/basket/basket-store";
import type { SimState } from "@/basket/simulation";

const baskets = new Map<string, SimState>();

/** Ensure at least one demo basket exists; return it. */
export function getDefaultSim(): SimState {
  if (baskets.size === 0) {
    const sim = seedSim();
    baskets.set(sim.basket.id, sim);
  }
  return baskets.values().next().value as SimState;
}

export function getSim(id: string): SimState | undefined {
  return baskets.get(id);
}

export function listBaskets(): Basket[] {
  return [...baskets.values()].map((s) => s.basket);
}

export function putSim(sim: SimState): void {
  baskets.set(sim.basket.id, sim);
}

export function createSeeded(opts?: Parameters<typeof seedSim>[0]): SimState {
  const sim = seedSim(opts);
  baskets.set(sim.basket.id, sim);
  return sim;
}

export function deleteSim(id: string): boolean {
  return baskets.delete(id);
}
