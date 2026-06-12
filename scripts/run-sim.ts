// ============================================================
// HEADLESS SIMULATION RUNNER
// ------------------------------------------------------------
//   npm run sim                 # 200 ticks
//   npm run sim -- --ticks 500
//   npm run sim -- --days-per-tick 1 --base 10
//
// Drives the bots against the seeded slate with no browser /
// localStorage, advancing the simulated calendar (auto-rebalancing
// every Friday) and printing the slate trajectory and bot P&L.
// Bots always trade single-style (95/5 person invests) regardless
// of --mode; the flag only labels/keys the seeded sim.
// ============================================================

import { seedSim } from "../src/slate/slate-store";
import { botTick, botPortfolios, type SimMode } from "../src/slate/simulation";
import {
  slateValue,
  summarize,
  snapshotConstituents,
  simDateLabel,
  DAY_MS,
} from "../src/slate/slate-engine";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ticks = parseInt(arg("--ticks", "200"), 10);
const bias = parseFloat(arg("--bias", "0"));
const mode = arg("--mode", "slate") as SimMode;
const daysPerTick = parseFloat(arg("--days-per-tick", "1"));
// The creator-set INITIAL slate value (the CLI stands in for "Set the Slates").
const base = parseFloat(arg("--base", "1000"));

const sim = seedSim({ baseValue: base, mode });
sim.config.bias = bias;
sim.config.simMsPerTick = daysPerTick * DAY_MS;

console.log(`\n=== Slate Simulation ===`);
console.log(`category=${sim.slate.name}  mode=${mode}  bias=${bias}  ticks=${ticks}`);
console.log(`start ${simDateLabel(sim.slate.clockMs)} · auto-rebalance ${sim.slate.schedule.frequency} (Fri) · launch ${slateValue(sim.slate).toFixed(2)}\n`);

let min = Infinity;
let max = -Infinity;
for (let i = 1; i <= ticks; i++) {
  botTick(sim);
  const v = slateValue(sim.slate);
  min = Math.min(min, v);
  max = Math.max(max, v);
  if (i % Math.max(1, Math.floor(ticks / 20)) === 0) {
    console.log(`tick ${String(i).padStart(4)}  ${simDateLabel(sim.slate.clockMs)}  slate=${v.toFixed(2)}  units=${sim.slate.ledger.unitsOutstanding.toFixed(2)}`);
  }
}

const s = summarize(sim.slate);
const rebalances = sim.slate.history.filter((h) => h.event === "rebalance").length;
console.log(`\n--- Final (${simDateLabel(sim.slate.clockMs)}) ---`);
console.log(`slate value : ${s.value.toFixed(2)}  (total return ${(s.totalReturn * 100).toFixed(2)}%)`);
console.log(`range       : [${min.toFixed(2)}, ${max.toFixed(2)}]`);
console.log(`rebalances  : ${rebalances}  ·  slate units outstanding: ${sim.slate.ledger.unitsOutstanding.toFixed(2)}`);
console.log(`history pts  : ${sim.slate.history.length}`);

console.log(`\nConstituents:`);
for (const c of snapshotConstituents(sim.slate)) {
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
