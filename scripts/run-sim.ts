// ============================================================
// HEADLESS SIMULATION RUNNER
// ------------------------------------------------------------
//   npm run sim                 # 200 ticks, equal weight, index mode
//   npm run sim -- --ticks 500 --weighting mcap --bias 0.3
//   npm run sim -- --mode single --days-per-tick 1
//
// Drives the bots against the seeded basket with no browser /
// localStorage, advancing the simulated calendar (auto-rebalancing
// every Friday) and printing the index trajectory and bot P&L.
// ============================================================

import { seedSim } from "../src/basket/basket-store";
import { botTick, botPortfolios, type SimMode } from "../src/basket/simulation";
import {
  indexValue,
  summarize,
  snapshotConstituents,
  simDateLabel,
  DAY_MS,
  type WeightingMode,
} from "../src/basket/basket-engine";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ticks = parseInt(arg("--ticks", "200"), 10);
const weighting = arg("--weighting", "equal") as WeightingMode;
const bias = parseFloat(arg("--bias", "0"));
const mode = arg("--mode", "index") as SimMode;
const daysPerTick = parseFloat(arg("--days-per-tick", "1"));

const sim = seedSim({ weighting, baseValue: 1000, mode });
sim.config.bias = bias;
sim.config.simMsPerTick = daysPerTick * DAY_MS;

console.log(`\n=== Basket Index Simulation ===`);
console.log(`category=${sim.basket.name}  mode=${mode}  weighting=${weighting}  bias=${bias}  ticks=${ticks}`);
console.log(`start ${simDateLabel(sim.basket.clockMs)} · auto-rebalance ${sim.basket.schedule.frequency} (Fri) · launch ${indexValue(sim.basket).toFixed(2)}\n`);

let min = Infinity;
let max = -Infinity;
for (let i = 1; i <= ticks; i++) {
  botTick(sim);
  const v = indexValue(sim.basket);
  min = Math.min(min, v);
  max = Math.max(max, v);
  if (i % Math.max(1, Math.floor(ticks / 20)) === 0) {
    console.log(`tick ${String(i).padStart(4)}  ${simDateLabel(sim.basket.clockMs)}  index=${v.toFixed(2)}  units=${sim.basket.ledger.unitsOutstanding.toFixed(2)}`);
  }
}

const s = summarize(sim.basket);
const rebalances = sim.basket.history.filter((h) => h.event === "rebalance").length;
console.log(`\n--- Final (${simDateLabel(sim.basket.clockMs)}) ---`);
console.log(`index value : ${s.value.toFixed(2)}  (total return ${(s.totalReturn * 100).toFixed(2)}%)`);
console.log(`range       : [${min.toFixed(2)}, ${max.toFixed(2)}]`);
console.log(`rebalances  : ${rebalances}  ·  index units outstanding: ${sim.basket.ledger.unitsOutstanding.toFixed(2)}`);
console.log(`history pts  : ${sim.basket.history.length}`);

console.log(`\nConstituents:`);
for (const c of snapshotConstituents(sim.basket)) {
  console.log(
    `  ${c.name.padEnd(18)} price=$${c.price.toFixed(4)}  ret=${(c.return * 100).toFixed(2)}%  weight=${(c.weight * 100).toFixed(1)}%`,
  );
}

console.log(`\nBots:`);
for (const p of botPortfolios(sim)) {
  console.log(
    `  ${p.botId}  portfolio=$${p.portfolio.toFixed(0)}  (cash $${p.cash.toFixed(0)} · positions $${p.openValue.toFixed(0)} · units $${p.unitsValue.toFixed(0)})  pnl=${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(0)}`,
  );
}
console.log();
