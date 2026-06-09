// ============================================================
// SIMULATION HARNESS
// ------------------------------------------------------------
// Framework-agnostic bot logic that trades on the constituents'
// individual bonding curves, then records the resulting index
// value. Used by both the web UI (driven on a timer) and the
// headless CLI runner (scripts/run-sim.ts).
//
// Trading style mirrors DTM4.1's SimulationSidebar bots: on each
// tick a bot either closes an open position (~30% of the time) or
// opens a new long/short on a random constituent, sized randomly
// within a configured range and skewed by a global sentiment bias.
// ============================================================

import {
  buy,
  sell,
  shortOpen,
  shortClose,
  getPositions,
  type PauvPosition,
} from "@/market/pauv-engine";
import {
  type Basket,
  type Constituent,
  recordTick,
  indexValue,
  isRebalanceDue,
  rebalance,
} from "./basket-engine";

export const BOT_IDS = ["bot-1", "bot-2", "bot-3", "bot-4", "bot-5"] as const;
export type BotId = (typeof BOT_IDS)[number];

export const BOT_STARTING_CASH = 100_000;

export interface SimConfig {
  /** Min USD per opened position. */
  minTrade: number;
  /** Max USD per opened position. */
  maxTrade: number;
  /** −1 (max bear) … +1 (max bull): skews long/short choice. */
  bias: number;
  /** Probability a tick tries to close an existing position first. */
  closeChance: number;
  /** Auto-rebalance when the basket's interval elapses. */
  autoRebalance: boolean;
}

export function defaultSimConfig(overrides?: Partial<SimConfig>): SimConfig {
  return {
    minTrade: 200,
    maxTrade: 1000,
    bias: 0,
    closeChance: 0.3,
    autoRebalance: true,
    ...overrides,
  };
}

export interface SimState {
  basket: Basket;
  botCash: Record<string, number>;
  config: SimConfig;
  /** Total ticks executed. */
  ticks: number;
}

export interface SimEvent {
  tick: number;
  botId: string;
  action: "buy" | "sell" | "short_open" | "short_close" | "rebalance" | "skip";
  constituentId?: string;
  constituentName?: string;
  amount?: number;
  indexValue: number;
  note?: string;
}

export function createSim(basket: Basket, config?: Partial<SimConfig>): SimState {
  const botCash: Record<string, number> = {};
  for (const id of BOT_IDS) botCash[id] = BOT_STARTING_CASH;
  return { basket, botCash, config: defaultSimConfig(config), ticks: 0 };
}

function randBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** All open positions belonging to a bot across every constituent. */
function botOpenPositions(
  sim: SimState,
  botId: string,
): Array<{ c: Constituent; pos: PauvPosition }> {
  const out: Array<{ c: Constituent; pos: PauvPosition }> = [];
  for (const c of sim.basket.constituents) {
    for (const pos of Object.values(c.market.positions)) {
      if (pos.userId === botId) out.push({ c, pos });
    }
  }
  return out;
}

/**
 * Execute one bot tick. Mutates the basket's constituent markets and records
 * the index value afterward. Returns a description of what happened.
 */
export function botTick(sim: SimState, botId: BotId = pick(BOT_IDS)): SimEvent {
  sim.ticks++;
  const { config, basket } = sim;

  // Auto-rebalance if due (PDF Part 6) — happens at most once per tick.
  if (config.autoRebalance && isRebalanceDue(basket)) {
    rebalance(basket, "auto weekly rebalance");
    return {
      tick: sim.ticks,
      botId,
      action: "rebalance",
      indexValue: indexValue(basket),
      note: "auto rebalance",
    };
  }

  if (basket.constituents.length === 0) {
    return { tick: sim.ticks, botId, action: "skip", indexValue: indexValue(basket), note: "no constituents" };
  }

  // Try to close an existing position first.
  const open = botOpenPositions(sim, botId);
  if (open.length > 0 && Math.random() < config.closeChance) {
    const { c, pos } = pick(open);
    try {
      if (pos.type === "long") {
        const res = sell(c.market, c.config, pos.id);
        c.market = res.state;
        sim.botCash[botId] += res.netProceeds;
        const v = recordTick(basket);
        return { tick: sim.ticks, botId, action: "sell", constituentId: c.id, constituentName: c.name, indexValue: v };
      } else {
        const res = shortClose(c.market, c.config, pos.id);
        c.market = res.state;
        sim.botCash[botId] += res.netReturn;
        const v = recordTick(basket);
        return { tick: sim.ticks, botId, action: "short_close", constituentId: c.id, constituentName: c.name, indexValue: v };
      }
    } catch {
      // fall through to opening a new position
    }
  }

  // Open a new position.
  const cash = sim.botCash[botId] ?? 0;
  if (cash < config.minTrade) {
    return { tick: sim.ticks, botId, action: "skip", indexValue: indexValue(basket), note: "insufficient cash" };
  }
  const amount = randBetween(config.minTrade, Math.min(config.maxTrade, Math.floor(cash)));
  const c = pick(basket.constituents);
  const goLong = Math.random() < 0.5 + config.bias * 0.5;

  try {
    if (goLong) {
      const res = buy(c.market, c.config, botId, amount);
      c.market = res.state;
      sim.botCash[botId] -= amount;
      const v = recordTick(basket);
      return { tick: sim.ticks, botId, action: "buy", constituentId: c.id, constituentName: c.name, amount, indexValue: v };
    } else {
      const res = shortOpen(c.market, c.config, botId, amount);
      c.market = res.state;
      sim.botCash[botId] -= amount; // stake; escrow is funded from the curve
      const v = recordTick(basket);
      return { tick: sim.ticks, botId, action: "short_open", constituentId: c.id, constituentName: c.name, amount, indexValue: v };
    }
  } catch (e) {
    return {
      tick: sim.ticks,
      botId,
      action: "skip",
      constituentId: c.id,
      constituentName: c.name,
      indexValue: indexValue(basket),
      note: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Close every open position across all constituents (any user). Mutates the
 * basket's constituent markets in place. Returns the number of positions closed.
 */
export function closeAllPositions(sim: SimState): number {
  let closed = 0;
  for (const c of sim.basket.constituents) {
    for (const pos of Object.values(c.market.positions)) {
      try {
        if (pos.type === "long") c.market = sell(c.market, c.config, pos.id).state;
        else c.market = shortClose(c.market, c.config, pos.id).state;
        closed++;
      } catch {
        /* skip positions that cannot currently be closed */
      }
    }
  }
  if (closed > 0) recordTick(sim.basket);
  return closed;
}

export interface BotPortfolio {
  botId: string;
  cash: number;
  openValue: number;
  portfolio: number;
  pnl: number;
}

export function botPortfolios(sim: SimState): BotPortfolio[] {
  return BOT_IDS.map((botId) => {
    let openValue = 0;
    for (const c of sim.basket.constituents) {
      for (const p of getPositions(c.market, c.config, botId)) {
        openValue += p.currentValue;
      }
    }
    const cash = sim.botCash[botId] ?? 0;
    const portfolio = cash + openValue;
    return { botId, cash, openValue, portfolio, pnl: portfolio - BOT_STARTING_CASH };
  });
}
