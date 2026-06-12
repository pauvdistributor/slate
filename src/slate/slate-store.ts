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
  type PauvConfig,
  type PauvState,
} from "@/market/pauv-engine";
import { createSlate, type RebalanceSchedule } from "./slate-engine";
import { createSim, type SimState, type SimMode } from "./simulation";
import rosterJson from "@/data/roster.json";

// Each UI tab keeps its OWN simulation under a separate key, so trades,
// category, and history on one tab never affect the other.
export type SimScope = "slate" | "single";
// v6: equal weighting only (the "price" mode and its divisor were removed).
const STORE_KEY_BASE = "slate_sim_state_v6";
// `sub` namespaces multiple sims within one scope — the Single tab keeps one
// sim per category, so looking up someone new never wipes another category's
// trades and history.
function storeKey(scope: SimScope, sub?: string): string {
  return sub ? `${STORE_KEY_BASE}:${scope}:${sub}` : `${STORE_KEY_BASE}:${scope}`;
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
 * Build one constituent from a roster person. The market starts at Q=0 so
 * its spot price == the person's real price (the slate is supply-free: it
 * averages returns).
 */
export function constituentFromPerson(p: RosterPerson) {
  const config = configForPerson(p);
  const market: PauvState = defaultState();
  return { id: p.ticker, name: p.name, market, config };
}

// ------------------------------------------------------------
// Initial slate values ("Set the Slates")
// ------------------------------------------------------------
// Trading is blocked until the creator sets each slate's INITIAL value;
// the slate launches anchored at it.

const SLATE_PRICES_KEY = "slate_initial_prices_v1";

/** category → creator-chosen initial slate value. */
export function getSlatePrices(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(SLATE_PRICES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** The initial value set for one slate, or null if not set yet. */
export function getSlatePrice(category: string): number | null {
  return getSlatePrices()[category] ?? null;
}

export function setSlatePrice(category: string, value: number): void {
  if (typeof window === "undefined") return;
  if (!(Number.isFinite(value) && value > 0)) return;
  const all = getSlatePrices();
  all[category] = value;
  try {
    localStorage.setItem(SLATE_PRICES_KEY, JSON.stringify(all));
  } catch { /* non-fatal */ }
}

/** Auto-populate: every slate (roster category) starts at `value`. */
export function setAllSlatePrices(value: number): void {
  if (typeof window === "undefined") return;
  if (!(Number.isFinite(value) && value > 0)) return;
  const all = getSlatePrices();
  for (const c of roster.categories) all[c.name] = value;
  try {
    localStorage.setItem(SLATE_PRICES_KEY, JSON.stringify(all));
  } catch { /* non-fatal */ }
}

// ------------------------------------------------------------
// Fees toggle
// ------------------------------------------------------------
// Global on/off for the direct-leg fee (DIRECT_FEE_RATE). Read at
// trade time so flipping the Nav toggle applies immediately.

const FEES_ENABLED_KEY = "fees_enabled_v1";

/** Whether the direct-leg fee is charged (default on). */
export function getFeesEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(FEES_ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setFeesEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(FEES_ENABLED_KEY, enabled ? "1" : "0");
  } catch { /* non-fatal */ }
}

export interface SeedOptions {
  category?: string;
  /** The creator-set initial slate value (defaults to the stored "Set the Slates" value). */
  baseValue?: number;
  schedule?: Partial<RebalanceSchedule>;
  mode?: SimMode;
  /** Simulated start date (ms since epoch). */
  startMs?: number;
}

/** Seed a fresh simulation for one category (the active slate). */
export function seedSim(opts?: SeedOptions): SimState {
  const category = opts?.category ?? DEFAULT_CATEGORY;
  let members = peopleInCategory(category);
  if (members.length === 0) members = peopleInCategory(DEFAULT_CATEGORY);

  const slate = createSlate({
    name: category,
    baseValue: opts?.baseValue ?? getSlatePrice(category) ?? 1000,
    schedule: opts?.schedule,
    startMs: opts?.startMs,
    constituents: members.map((p) => constituentFromPerson(p)),
  });

  return createSim(slate, undefined, opts?.mode ?? "slate");
}

export function loadSim(scope: SimScope, sub?: string): SimState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(storeKey(scope, sub));
    if (!raw) return null;
    return JSON.parse(raw) as SimState;
  } catch {
    return null;
  }
}

export function saveSim(sim: SimState, scope: SimScope, sub?: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(storeKey(scope, sub), JSON.stringify(sim));
  } catch {
    /* quota / serialization errors are non-fatal for a sim */
  }
}

export function resetSim(scope: SimScope, sub?: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(storeKey(scope, sub));
}

/**
 * Wipe EVERY saved sim — both tabs, all categories — so each slate reseeds
 * fresh at its creator-set initial value. The "Set the Slates" values are kept.
 */
export function resetAllSims(): void {
  if (typeof window === "undefined") return;
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    // Version-less prefixes also sweep out stale keys from older schemas
    // (including the pre-rename "basket_sim_state*" keys).
    if (k && (k.startsWith("slate_sim_state") || k.startsWith("basket_sim_state"))) doomed.push(k);
  }
  for (const k of doomed) localStorage.removeItem(k);
}

/** A persisted sim is usable only if it has the current schema fields. */
function isValidSim(s: SimState | null): s is SimState {
  return !!(
    s &&
    s.slate &&
    s.slate.constituents?.length > 0 &&
    s.slate.schedule &&
    s.slate.ledger &&
    typeof s.slate.clockMs === "number" &&
    typeof s.slate.baseValue === "number"
  );
}

/** Load this tab's existing sim or seed a fresh one and persist it. */
export function loadOrSeed(scope: SimScope, opts?: SeedOptions, sub?: string): SimState {
  const existing = loadSim(scope, sub);
  if (isValidSim(existing)) return existing;
  const seeded = seedSim(opts);
  saveSim(seeded, scope, sub);
  return seeded;
}
