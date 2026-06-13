// ============================================================
// SIMULATION HARNESS
// ------------------------------------------------------------
// Framework-agnostic bot logic. Used by both the web UI (driven
// on a timer) and the headless CLI runner (scripts/run-sim.ts).
//
// Bots trade exactly like a standard user on the Single tab, and
// only on the person being traded (the page passes the profile
// currently being viewed). Each tick a bot either closes one of
// its open positions on that person — closePersonPosition, which
// also unwinds the linked slate legs — or opens a new long
// (investInPerson) or short (shortPerson) with the primaryPct
// split (default 95% direct, 5% slate). They never trade curves
// raw and never buy the slate outright.
// ============================================================

import { getPositions, type PauvPosition } from "@/market/pauv-engine";
import {
  type Slate,
  type Constituent,
  recordTick,
  slateValue,
  advanceTime,
  getConstituent,
  investInPerson,
  shortPerson,
  closePersonPosition,
  slateLinkedPositionIds,
  holderValue,
  DAY_MS,
  DIRECT_FEE_RATE,
  type CascadeClosure,
} from "./slate-engine";

export const BOT_IDS = ["bot-1", "bot-2", "bot-3", "bot-4", "bot-5"] as const;
export type BotId = (typeof BOT_IDS)[number];

export const BOT_STARTING_CASH = 100_000;

/**
 * Which tab seeded the sim (storage/UI concern only). Bot behavior is
 * identical in both modes: standard-user trades, never direct slate trades.
 */
export type SimMode = "slate" | "single";

export interface SimConfig {
  /** Min USD per opened position. */
  minTrade: number;
  /** Max USD per opened position. */
  maxTrade: number;
  /** −1 (max bear) … +1 (max bull): skews the long/short choice. */
  bias: number;
  /** Probability a tick closes one of the bot's open positions instead. */
  closeChance: number;
  /** Advance the sim calendar and fire scheduled rebalances each tick. */
  autoRebalance: boolean;
  /** How much simulated time each tick advances (default 1 day). */
  simMsPerTick: number;
  /** Direct fraction for single-mode invests (default 0.95). */
  primaryPct: number;
  /** Fee on direct-leg opens (0 when the fees toggle is off). */
  feeRate: number;
}

export function defaultSimConfig(overrides?: Partial<SimConfig>): SimConfig {
  return {
    minTrade: 500,
    maxTrade: 2000,
    bias: 0,
    closeChance: 0.3,
    autoRebalance: true,
    simMsPerTick: DAY_MS,
    primaryPct: 0.95,
    feeRate: DIRECT_FEE_RATE,
    ...overrides,
  };
}

export interface SimState {
  slate: Slate;
  botCash: Record<string, number>;
  config: SimConfig;
  /** Which tab seeded the sim (storage key only — bots behave the same). */
  mode: SimMode;
  /** Total ticks executed. */
  ticks: number;
}

export interface SimEvent {
  tick: number;
  botId: string;
  action: "invest" | "short" | "close" | "rebalance" | "skip";
  constituentId?: string;
  constituentName?: string;
  amount?: number;
  slateValue: number;
  note?: string;
  /**
   * Slate legs the trade auto-closed because it liquidated their parent
   * positions. Bot owners are already credited in botCash; callers must
   * credit any wallet they track elsewhere (e.g. the user's).
   */
  cascades?: CascadeClosure[];
}

/**
 * Credit cascade proceeds to the bots that own them (other owners — e.g. the
 * user — are the caller's wallets to credit). Returns the closures untouched
 * for chaining.
 */
export function creditBotCascades(sim: SimState, cascades: CascadeClosure[]): CascadeClosure[] {
  for (const c of cascades) {
    if (c.userId in sim.botCash) sim.botCash[c.userId] += c.proceeds;
  }
  return cascades;
}

export function createSim(slate: Slate, config?: Partial<SimConfig>, mode: SimMode = "slate"): SimState {
  const botCash: Record<string, number> = {};
  for (const id of BOT_IDS) botCash[id] = BOT_STARTING_CASH;
  return { slate, botCash, config: defaultSimConfig(config), mode, ticks: 0 };
}

function randBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * One account's DIRECT (parent) positions on one person's curve — excludes
 * slate legs (those belong to a parent position and are unwound with it),
 * exactly the list a standard user sees on the profile page.
 */
function directPositions(slate: Slate, person: Constituent, userId: string): PauvPosition[] {
  const legIds = slateLinkedPositionIds(slate, person.id);
  return Object.values(person.market.positions).filter(
    (p) => p.userId === userId && !legIds.has(p.id),
  );
}

/**
 * Execute one bot tick. Mutates the slate's constituent markets and records
 * the slate value afterward. Returns a description of what happened.
 *
 * `personId` focuses the bot on one person — the page passes the profile
 * currently being viewed so bots trade exactly what the user is watching.
 * Without it (headless CLI), a random person is picked per tick.
 *
 * A tick is what a standard user would do on that profile: sometimes close
 * an open position (closePersonPosition — also unwinds its slate legs),
 * otherwise open a long (investInPerson) or short (shortPerson) with the
 * primaryPct split, skewed by the sentiment bias.
 */
export function botTick(sim: SimState, botId: BotId = pick(BOT_IDS), personId?: string): SimEvent {
  sim.ticks++;
  const { config, slate } = sim;

  // Advance the simulated calendar. Scheduled rebalances (e.g. every Friday)
  // fire inside advanceTime at their true dates.
  if (config.autoRebalance) advanceTime(slate, config.simMsPerTick);
  else slate.clockMs += config.simMsPerTick;

  if (slate.constituents.length === 0) {
    return { tick: sim.ticks, botId, action: "skip", slateValue: slateValue(slate), note: "no constituents" };
  }

  const person = personId ? getConstituent(slate, personId) : pick(slate.constituents);
  if (!person) {
    return { tick: sim.ticks, botId, action: "skip", slateValue: slateValue(slate), note: `person ${personId} not in slate` };
  }

  // Sometimes close an existing position on this person first.
  const open = directPositions(slate, person, botId);
  if (open.length > 0 && Math.random() < config.closeChance) {
    const pos = pick(open);
    try {
      const res = closePersonPosition(slate, person.id, pos.id, { feeRate: config.feeRate ?? 0 });
      sim.botCash[botId] += res.proceeds; // direct close + unwound slate legs
      creditBotCascades(sim, res.cascadeClosures);
      return {
        tick: sim.ticks, botId, action: "close",
        constituentId: person.id, constituentName: person.name, amount: res.proceeds,
        slateValue: slateValue(slate),
        ...(res.cascadeClosures.length > 0 ? { cascades: res.cascadeClosures } : {}),
      };
    } catch {
      // fall through to opening a new position
    }
  }

  // Open a new position.
  const cash = sim.botCash[botId] ?? 0;
  if (cash < config.minTrade) {
    return { tick: sim.ticks, botId, action: "skip", slateValue: slateValue(slate), note: "insufficient cash" };
  }
  const amount = randBetween(config.minTrade, Math.min(config.maxTrade, Math.floor(cash)));
  const goLong = Math.random() < 0.5 + config.bias * 0.5;
  const opts = { primaryPct: config.primaryPct, investorId: botId, feeRate: config.feeRate ?? 0 };
  try {
    const res = goLong
      ? investInPerson(slate, person.id, amount, opts)
      : shortPerson(slate, person.id, amount, opts);
    sim.botCash[botId] -= amount;
    creditBotCascades(sim, res.cascadeClosures);
    return {
      tick: sim.ticks, botId, action: goLong ? "invest" : "short",
      constituentId: person.id, constituentName: person.name, amount,
      slateValue: slateValue(slate),
      ...(res.cascadeClosures.length > 0 ? { cascades: res.cascadeClosures } : {}),
    };
  } catch (e) {
    return {
      tick: sim.ticks, botId, action: "skip", constituentId: person.id, constituentName: person.name,
      slateValue: slateValue(slate), note: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Close every DIRECT (parent) position one account owns across all
 * constituents, via closePersonPosition — so each close also unwinds the
 * slate legs that were opened with it (sells the units / closes the linked
 * shorts). The parent pays the close fee (`feeRate`); slate legs stay
 * fee-free. Returns the parent count closed and total proceeds (direct +
 * unwound slate legs), plus any liquidation cascades the closes set off
 * (short buybacks push prices up) — those proceeds belong to the cascaded
 * positions' owners, not `userId`, and are NOT in `proceeds`.
 */
export function closeAccountPositions(
  slate: Slate,
  userId: string,
  feeRate = 0,
): { closed: number; proceeds: number; cascades: CascadeClosure[] } {
  let closed = 0;
  let proceeds = 0;
  const cascades: CascadeClosure[] = [];
  for (const c of slate.constituents) {
    for (const pos of directPositions(slate, c, userId)) {
      try {
        const res = closePersonPosition(slate, c.id, pos.id, { feeRate });
        proceeds += res.proceeds;
        cascades.push(...res.cascadeClosures);
        closed++;
      } catch {
        /* skip positions that cannot currently be closed */
      }
    }
  }
  if (closed > 0) recordTick(slate);
  return { closed, proceeds, cascades };
}

/**
 * Close all the BOTS' positions (parents, each unwinding its slate legs).
 * The user's positions are untouched — unless a close liquidates one; the
 * returned cascades carry those proceeds for the caller to credit (bot-owned
 * cascades are already credited here).
 */
export function closeAllPositions(sim: SimState): {
  closed: number;
  cascades: CascadeClosure[];
} {
  let closed = 0;
  const cascades: CascadeClosure[] = [];
  for (const botId of BOT_IDS) {
    const res = closeAccountPositions(sim.slate, botId, sim.config.feeRate ?? 0);
    sim.botCash[botId] += res.proceeds;
    closed += res.closed;
    cascades.push(...res.cascades);
  }
  creditBotCascades(sim, cascades);
  return { closed, cascades };
}

export interface BotPortfolio {
  botId: string;
  cash: number;
  /** Value of direct positions in the constituents. */
  openValue: number;
  /** Value of slate units held (single/slate investing). */
  unitsValue: number;
  portfolio: number;
  pnl: number;
}

export function botPortfolios(sim: SimState): BotPortfolio[] {
  return BOT_IDS.map((botId) => {
    let openValue = 0;
    for (const c of sim.slate.constituents) {
      for (const p of getPositions(c.market, c.config, botId)) {
        openValue += p.currentValue;
      }
    }
    const unitsValue = holderValue(sim.slate, botId);
    const cash = sim.botCash[botId] ?? 0;
    const portfolio = cash + openValue + unitsValue;
    return { botId, cash, openValue, unitsValue, portfolio, pnl: portfolio - BOT_STARTING_CASH };
  });
}
