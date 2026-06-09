// ============================================================
// HEADLESS SIMULATION RUNNER
// ------------------------------------------------------------
//   npm run sim                 # 200 ticks, equal weight
//   npm run sim -- --ticks 500 --weighting mcap --bias 0.3
//
// Drives the bots against the seeded basket with no browser /
// localStorage, printing the index trajectory and final bot
// P&L. This is the fastest way for a backend dev to exercise the
// engine end-to-end.
// ============================================================

import { seedSim } from "../src/basket/basket-store";
import { botTick, botPortfolios } from "../src/basket/simulation";
import {
  indexValue,
  summarize,
  snapshotConstituents,
  rebalance,
  type WeightingMode,
} from "../src/basket/basket-engine";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ticks = parseInt(arg("--ticks", "200"), 10);
const weighting = arg("--weighting", "equal") as WeightingMode;
const bias = parseFloat(arg("--bias", "0"));
const rebalanceEvery = parseInt(arg("--rebalance-every", "50"), 10);

const sim = seedSim({ weighting, baseValue: 1000 });
sim.config.bias = bias;
sim.config.autoRebalance = false; // we drive rebalances manually below

console.log(`\n=== Basket Index Simulation ===`);
console.log(`weighting=${weighting}  bias=${bias}  ticks=${ticks}  rebalanceEvery=${rebalanceEvery}`);
console.log(`launch value: ${indexValue(sim.basket).toFixed(2)}\n`);

let min = Infinity;
let max = -Infinity;
for (let i = 1; i <= ticks; i++) {
  botTick(sim);
  if (rebalanceEvery > 0 && i % rebalanceEvery === 0) {
    rebalance(sim.basket, `manual rebalance @tick ${i}`);
  }
  const v = indexValue(sim.basket);
  min = Math.min(min, v);
  max = Math.max(max, v);
  if (i % Math.max(1, Math.floor(ticks / 20)) === 0) {
    console.log(`tick ${String(i).padStart(4)}  index=${v.toFixed(2)}  n=${sim.basket.constituents.length}`);
  }
}

const s = summarize(sim.basket);
console.log(`\n--- Final ---`);
console.log(`index value : ${s.value.toFixed(2)}  (total return ${(s.totalReturn * 100).toFixed(2)}%)`);
console.log(`range       : [${min.toFixed(2)}, ${max.toFixed(2)}]`);
console.log(`history pts  : ${sim.basket.history.length}`);

console.log(`\nConstituents:`);
for (const c of snapshotConstituents(sim.basket)) {
  console.log(
    `  ${c.name.padEnd(8)} price=$${c.price.toFixed(4)}  ret=${(c.return * 100).toFixed(2)}%  weight=${(c.weight * 100).toFixed(1)}%`,
  );
}

console.log(`\nBots:`);
for (const p of botPortfolios(sim)) {
  console.log(
    `  ${p.botId}  portfolio=$${p.portfolio.toFixed(0)}  pnl=${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(0)}`,
  );
}
console.log();
