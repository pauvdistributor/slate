// ============================================================
// CLIENT STORE
// ------------------------------------------------------------
// Browser persistence for the simulation, mirroring DTM4.1's
// localStorage approach. The engine modules are pure; this file
// is the only place that touches localStorage.
//
// Constituents are seeded from the REAL Pauv roster snapshot in
// src/data/roster.json (people with their current prices). Re-pull
// it with `npm run refresh-roster`. Each person's free-form Pauv
// subcategory is rolled up into exactly one launch SLATE (see
// slates.ts); `category` on a RosterPerson is the slate name, the
// raw subcategory is kept in `subcategory`.
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
import { SLATE_NAMES, slateFor } from "./slates";
import rosterJson from "@/data/roster.json";

// ONE simulation per slate, keyed by slate name and SHARED by both tabs:
// an order placed on the Single tab moves the same world the Slate tab
// charts, and vice versa.
// v6: equal weighting only (the "price" mode and its divisor were removed).
// v7: categories became launch slates (13 roll-ups of raw subcategories),
//     so old sims reference compositions that no longer exist.
// v8: per-slate keys replaced the per-tab ("slate"/"single") split that
//     kept each tab in its own parallel world.
// v9: Golf split out of Influencers into its own slate, so persisted
//     Influencers sims carry a stale roster.
// v10: slates gained the slateLegIds registry that tags short slate legs
//      in the order log; older sims would mis-tag them as direct.
const STORE_KEY_BASE = "slate_sim_state_v10";
function storeKey(category: string): string {
  return `${STORE_KEY_BASE}:${category}`;
}

export interface RosterPerson {
  id: string;
  ticker: string;
  name: string;
  /** The launch slate this person belongs to (e.g. "Music"). */
  category: string;
  /** The raw Pauv subcategory (e.g. "Rapper"). */
  subcategory: string;
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

// roster.json's `category` is the raw subcategory; roll it up into the
// person's slate. An unmapped subcategory surfaces as its own slate
// (visible in the UI, person stays tradeable) — slates.test.ts fails
// until it's added to slates.ts.
const roster: Roster = (() => {
  const raw = rosterJson as Omit<Roster, "people"> & {
    people: Array<Omit<RosterPerson, "subcategory">>;
  };
  const people: RosterPerson[] = raw.people.map((p) => ({
    ...p,
    category: slateFor(p.category, p.ticker) ?? p.category,
    subcategory: p.category,
  }));
  const counts = new Map<string, number>();
  for (const p of people) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const categories = [
    ...SLATE_NAMES.filter((s) => counts.has(s)),
    ...[...counts.keys()].filter((c) => !SLATE_NAMES.includes(c as never)),
  ].map((name) => ({ name, count: counts.get(name)! }));
  return { fetchedAt: raw.fetchedAt, source: raw.source, categories, people };
})();

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
// Last-viewed selection (per tab)
// ------------------------------------------------------------
// Each tab remembers what you were looking at — the Single tab its
// person, the Slate tab its slate — so jumping between tabs (or
// reloading) brings the same view back up.

const LAST_VIEWED_KEY = "last_viewed_v1";

interface LastViewed {
  /** Ticker of the person focused on the Single tab. */
  single?: string;
  /** Slate (category) active on the Slate tab. */
  slate?: string;
}

function getLastViewed(): LastViewed {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(LAST_VIEWED_KEY) ?? "{}") as LastViewed;
  } catch {
    return {};
  }
}

function patchLastViewed(patch: LastViewed): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LAST_VIEWED_KEY, JSON.stringify({ ...getLastViewed(), ...patch }));
  } catch { /* non-fatal */ }
}

export function getLastViewedPerson(): string | null {
  return getLastViewed().single ?? null;
}
export function setLastViewedPerson(ticker: string): void {
  patchLastViewed({ single: ticker });
}
export function getLastViewedSlate(): string | null {
  return getLastViewed().slate ?? null;
}
export function setLastViewedSlate(category: string): void {
  patchLastViewed({ slate: category });
}

// ------------------------------------------------------------
// Your wallet
// ------------------------------------------------------------
// You start with $10M. Every open debits it and every close credits the
// proceeds back, so after closing everything the drift from $10M is
// exactly fees paid (when on) plus liquidation losses — anything else
// is a conservation leak in the engine.

/** The human investor's account id on positions (bots are bot-1…bot-5). */
export const USER_ID = "you";

export const WALLET_STARTING_CASH = 10_000_000;
const WALLET_KEY = "user_wallet_v1";
const WALLET_EVENT = "wallet-changed";

export function getWallet(): number {
  if (typeof window === "undefined") return WALLET_STARTING_CASH;
  try {
    const raw = localStorage.getItem(WALLET_KEY);
    if (raw == null) return WALLET_STARTING_CASH;
    const n = Number(raw);
    return Number.isFinite(n) ? n : WALLET_STARTING_CASH;
  } catch {
    return WALLET_STARTING_CASH;
  }
}

function setWallet(value: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(WALLET_KEY, String(value));
  } catch { /* non-fatal */ }
  window.dispatchEvent(new Event(WALLET_EVENT));
}

/** Debit (delta < 0) or credit (delta > 0) the wallet. Returns the new balance. */
export function adjustWallet(delta: number): number {
  const next = getWallet() + delta;
  setWallet(next);
  return next;
}

export function resetWallet(): void {
  setWallet(WALLET_STARTING_CASH);
}

/**
 * Notify on wallet changes — same-tab writes (custom event) and other
 * browser tabs (storage event). Returns the unsubscribe function.
 */
export function onWalletChange(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === WALLET_KEY) cb();
  };
  window.addEventListener(WALLET_EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(WALLET_EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
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

export function loadSim(category: string): SimState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(storeKey(category));
    if (!raw) return null;
    return JSON.parse(raw) as SimState;
  } catch {
    return null;
  }
}

/** Persist a sim under its slate's key (the slate is named after its category). */
export function saveSim(sim: SimState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(storeKey(sim.slate.name), JSON.stringify(sim));
  } catch {
    /* quota / serialization errors are non-fatal for a sim */
  }
}

export function resetSim(category: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(storeKey(category));
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

/** Load the slate's existing sim or seed a fresh one and persist it. */
export function loadOrSeed(category: string, opts?: Omit<SeedOptions, "category">): SimState {
  const existing = loadSim(category);
  if (isValidSim(existing)) return existing;
  const seeded = seedSim({ ...opts, category });
  saveSim(seeded);
  return seeded;
}
