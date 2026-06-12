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

import type { Slate } from "@/slate/slate-engine";
import { seedSim } from "@/slate/slate-store";
import type { SimState } from "@/slate/simulation";

const slates = new Map<string, SimState>();

/** Ensure at least one demo slate exists; return it. */
export function getDefaultSim(): SimState {
  if (slates.size === 0) {
    const sim = seedSim();
    slates.set(sim.slate.id, sim);
  }
  return slates.values().next().value as SimState;
}

export function getSim(id: string): SimState | undefined {
  return slates.get(id);
}

export function listSlates(): Slate[] {
  return [...slates.values()].map((s) => s.slate);
}

export function listSims(): SimState[] {
  return [...slates.values()];
}

/** Find the slate holding a given constituent (person market). */
export function findSimByConstituent(
  constituentId: string,
): SimState | undefined {
  return [...slates.values()].find((s) =>
    s.slate.constituents.some((c) => c.id === constituentId),
  );
}

export function putSim(sim: SimState): void {
  slates.set(sim.slate.id, sim);
}

export function createSeeded(opts?: Parameters<typeof seedSim>[0]): SimState {
  const sim = seedSim(opts);
  slates.set(sim.slate.id, sim);
  return sim;
}

export function deleteSim(id: string): boolean {
  return slates.delete(id);
}
