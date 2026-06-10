// ============================================================
// CLIENT STORE
// ------------------------------------------------------------
// Browser persistence for the simulation, mirroring DTM4.1's
// localStorage approach. The engine modules are pure; this file
// is the only place that touches localStorage.
//
// Constituents are seeded from the REAL Pauv roster snapshot in
// src/data/roster.json (people grouped by category, with their
// current prices). Re-pull it with `npm run refresh-roster`.
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
  type PauvState,
} from "@/market/pauv-engine";
import { createBasket, type WeightingMode, type RebalanceSchedule } from "./basket-engine";
import { createSim, type SimState, type SimMode } from "./simulation";
import rosterJson from "@/data/roster.json";

// Each UI tab keeps its OWN simulation under a separate key, so trades,
// category, and history on one tab never affect the other.
export type SimScope = "index" | "single";
// v3: added the sim clock, rebalance schedule, and ETF ledger to the basket.
const STORE_KEY_BASE = "basket_sim_state_v3";
function storeKey(scope: SimScope): string {
  return `${STORE_KEY_BASE}:${scope}`;
}

export interface RosterPerson {
  id: string;
  ticker: string;
  name: string;
  category: string;
  priceUsd: number;
  p0Usd: number | null;
  holders: number;
  volumeUsd: number;
  frozen: boolean;
  photoUrl: string | null;
  industry: string | null;
}
interface Roster {
  fetchedAt: string;
  source: string;
  categories: Array<{ name: string; count: number }>;
  people: RosterPerson[];
}

const roster = rosterJson as Roster;

/** Category to seed by default — Pauv's "Basketball" is the NBA-All-Stars analog. */
export const DEFAULT_CATEGORY =
  roster.categories.find((c) => c.name === "Basketball")?.name ??
  roster.categories[0]?.name ??
  "Basketball";

export function listCategories(): Array<{ name: string; count: number }> {
  return roster.categories;
}

export function peopleInCategory(category: string): RosterPerson[] {
  return roster.people.filter((p) => p.category === category);
}

export function allPeople(): RosterPerson[] {
  return roster.people;
}

export function findPerson(id: string): RosterPerson | undefined {
  return roster.people.find((p) => p.id === id || p.ticker === id);
}

// A per-person curve whose spot price (at Q=0) is the person's real price.
function configForPerson(p: RosterPerson): PauvConfig {
  return defaultConfig({
    P0: Math.max(p.priceUsd, 0.01),
    b: 0.001,
    alpha: 100,
    feeRate: 0,
  });
}

/**
 * Build one constituent from a roster person.
 *  - equal weight (default): market starts at Q=0 so price == real price.
 *  - mcap: seed a buy proportional to holders+1 so bigger names carry more
 *    market cap (supply differs). Launch baseline still normalizes returns.
 */
export function constituentFromPerson(p: RosterPerson, weighting: WeightingMode) {
  const config = configForPerson(p);
  let market: PauvState = defaultState();
  if (weighting === "mcap") {
    const seedUsd = 500 + (p.holders ?? 0) * 250 + (p.volumeUsd ?? 0);
    if (seedUsd > 0) market = buy(market, config, "seed", seedUsd).state;
  }
  return { id: p.ticker, name: p.name, market, config };
}

export interface SeedOptions {
  category?: string;
  weighting?: WeightingMode;
  baseValue?: number;
  schedule?: Partial<RebalanceSchedule>;
  mode?: SimMode;
  /** Simulated start date (ms since epoch). */
  startMs?: number;
}

/** Seed a fresh simulation for one category (the active basket). */
export function seedSim(opts?: SeedOptions): SimState {
  const category = opts?.category ?? DEFAULT_CATEGORY;
  const weighting = opts?.weighting ?? "equal";
  let members = peopleInCategory(category);
  if (members.length === 0) members = peopleInCategory(DEFAULT_CATEGORY);

  const basket = createBasket({
    name: category,
    weighting,
    baseValue: opts?.baseValue ?? 1000,
    schedule: opts?.schedule,
    startMs: opts?.startMs,
    constituents: members.map((p) => constituentFromPerson(p, weighting)),
  });

  return createSim(basket, undefined, opts?.mode ?? "index");
}

export function loadSim(scope: SimScope): SimState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(storeKey(scope));
    if (!raw) return null;
    return JSON.parse(raw) as SimState;
  } catch {
    return null;
  }
}

export function saveSim(sim: SimState, scope: SimScope): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(storeKey(scope), JSON.stringify(sim));
  } catch {
    /* quota / serialization errors are non-fatal for a sim */
  }
}

export function resetSim(scope: SimScope): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(storeKey(scope));
}

/** A persisted sim is usable only if it has the current schema fields. */
function isValidSim(s: SimState | null): s is SimState {
  return !!(
    s &&
    s.basket &&
    s.basket.constituents?.length > 0 &&
    s.basket.schedule &&
    s.basket.ledger &&
    typeof s.basket.clockMs === "number"
  );
}

/** Load this tab's existing sim or seed a fresh one and persist it. */
export function loadOrSeed(scope: SimScope, opts?: SeedOptions): SimState {
  const existing = loadSim(scope);
  if (isValidSim(existing)) return existing;
  const seeded = seedSim(opts);
  saveSim(seeded, scope);
  return seeded;
}
