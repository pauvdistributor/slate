"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import IndexChart from "@/components/IndexChart";
import ConstituentsTable from "@/components/ConstituentsTable";
import BasketSimSidebar from "@/components/BasketSimSidebar";
import InfoTooltip from "@/components/InfoTooltip";
import Nav from "@/components/Nav";
import {
  indexValue,
  summarize,
  snapshotConstituents,
  rebalance,
  addConstituent,
  removeConstituent,
  type WeightingMode,
  type BasketSummary,
  type ConstituentSnapshot,
  type IndexPoint,
} from "@/basket/basket-engine";
import {
  botTick,
  botPortfolios,
  closeAllPositions,
  type SimState,
  type BotPortfolio,
} from "@/basket/simulation";
import {
  loadOrSeed,
  saveSim,
  resetSim,
  seedSim,
  listCategories,
  allPeople,
  findPerson,
  constituentFromPerson,
} from "@/basket/basket-store";

interface View {
  summary: BasketSummary;
  value: number;
  rows: ConstituentSnapshot[];
  portfolios: BotPortfolio[];
  history: IndexPoint[];
  weighting: WeightingMode;
  memberIds: Set<string>;
}

function deriveView(sim: SimState): View {
  return {
    summary: summarize(sim.basket),
    value: indexValue(sim.basket),
    rows: snapshotConstituents(sim.basket),
    portfolios: botPortfolios(sim),
    history: sim.basket.history.slice(),
    weighting: sim.basket.weighting,
    memberIds: new Set(sim.basket.constituents.map((c) => c.id)),
  };
}

export default function BasketPage() {
  const simRef = useRef<SimState | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [addId, setAddId] = useState("");

  const categories = useMemo(() => listCategories(), []);

  const refresh = useCallback((persist = true) => {
    const sim = simRef.current;
    if (!sim) return;
    if (persist) saveSim(sim, "index");
    setView(deriveView(sim));
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const sim = loadOrSeed("index");
    simRef.current = sim;
    setView(deriveView(sim));
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const reseed = useCallback((category: string, weighting: WeightingMode) => {
    resetSim("index");
    const sim = seedSim({ category, weighting });
    simRef.current = sim;
    saveSim(sim, "index");
    setView(deriveView(sim));
  }, []);

  const onTick = useCallback(() => {
    if (!simRef.current) return;
    botTick(simRef.current);
    refresh();
  }, [refresh]);

  const onConfig = useCallback((c: { bias?: number; minTrade?: number; maxTrade?: number }) => {
    if (!simRef.current) return;
    Object.assign(simRef.current.config, c);
  }, []);

  const doRebalance = useCallback(() => {
    if (!simRef.current) return;
    rebalance(simRef.current.basket, "manual rebalance");
    refresh();
  }, [refresh]);

  const doAdd = useCallback(() => {
    if (!simRef.current || !addId) return;
    const person = findPerson(addId);
    if (!person) return;
    const c = constituentFromPerson(person, simRef.current.basket.weighting);
    addConstituent(simRef.current.basket, c);
    setAddId("");
    refresh();
  }, [addId, refresh]);

  const doRemove = useCallback((id: string) => {
    if (!simRef.current) return;
    removeConstituent(simRef.current.basket, id);
    refresh();
  }, [refresh]);

  const doRestart = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    if (!window.confirm("Restart the simulation? This clears all trades, positions, and history.")) return;
    reseed(sim.basket.name, sim.basket.weighting);
  }, [reseed]);

  const closeAll = useCallback(() => {
    if (!simRef.current) return;
    closeAllPositions(simRef.current);
    refresh();
  }, [refresh]);

  if (!view) {
    return (
      <div className="flex flex-col h-screen">
        <Nav />
        <div className="p-8 text-zinc-500">Loading simulation…</div>
      </div>
    );
  }

  const { summary, value, rows, portfolios, history, weighting, memberIds } = view;
  const totalReturn = summary.totalReturn;
  const available = allPeople().filter((p) => !memberIds.has(p.ticker));

  return (
    <div className="flex flex-col h-screen">
      <Nav />
      <div className="flex flex-1 overflow-hidden">
        <BasketSimSidebar
          open={sidebarOpen}
          onToggle={() => setSidebarOpen((v) => !v)}
          portfolios={portfolios}
          onTick={onTick}
          onConfig={onConfig}
          onCloseAll={closeAll}
        />

        <div className="flex-1 overflow-y-auto">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="fixed left-0 top-1/2 -translate-y-1/2 z-10 bg-zinc-800 border border-zinc-700 border-l-0 rounded-r-md px-2 py-3 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              ▶ Bots
            </button>
          )}

          <div className="max-w-4xl mx-auto px-6 py-6">
            {/* Header */}
            <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
              <div>
                <h1 className="text-xl font-bold text-zinc-100">{summary.name} Index</h1>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Equal-weight index over the {summary.name} category · real Pauv roster
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1">
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500">Category</span>
                  <select
                    value={summary.name}
                    onChange={(e) => reseed(e.target.value, weighting)}
                    className="rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-200 px-2 py-1 max-w-[160px]"
                    title="Switching category reseeds the simulation"
                  >
                    {categories.map((c) => (
                      <option key={c.name} value={c.name}>{c.name} ({c.count})</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500">Weighting</span>
                  <select
                    value={weighting}
                    onChange={(e) => reseed(summary.name, e.target.value as WeightingMode)}
                    className="rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-200 px-2 py-1"
                  >
                    <option value="equal">Equal (Pauv)</option>
                    <option value="mcap">Market-cap</option>
                  </select>
                </div>
                <button
                  onClick={doRestart}
                  className="rounded-md bg-red-700 hover:bg-red-600 px-3 py-1 text-xs font-medium text-white"
                  title="Wipe all trades, positions, and history; reseed a fresh basket"
                >
                  Restart Sim
                </button>
              </div>
            </div>

            {/* Index value hero */}
            <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-5 mb-4 flex items-end justify-between">
              <div>
                <div className="flex items-center text-[10px] uppercase tracking-wide text-zinc-500">
                  Index Value
                  <InfoTooltip text="Equal weight: anchorValue × (1 + average return since last rebaseline). Market-cap: Σ(price×supply) / divisor. Only real trades move it; rebalances and roster changes are absorbed." />
                </div>
                <div className="text-4xl font-bold text-zinc-100 tabular-nums">
                  {value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div className={`text-sm mt-1 ${totalReturn >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {totalReturn >= 0 ? "+" : ""}{(totalReturn * 100).toFixed(2)}% since launch (base {summary.baseValue})
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                <div className="text-[10px] text-zinc-500">
                  {summary.n} constituents · {weighting === "equal" ? "1/N each at rebalance" : "market-cap weighted"}
                </div>
                <button
                  onClick={doRebalance}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium text-white ${summary.rebalanceDue ? "bg-amber-600 hover:bg-amber-500" : "bg-zinc-700 hover:bg-zinc-600"}`}
                  title="Reset every baseline to the current price (re-equalizes weights). Index value is unchanged at the instant of rebalance."
                >
                  Rebalance{summary.rebalanceDue ? " (due)" : ""}
                </button>
              </div>
            </div>

            {/* Chart */}
            <div className="mb-4">
              <IndexChart history={history} baseValue={summary.baseValue} title={`${summary.name} — Index Value`} />
            </div>

            {/* Constituents */}
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-zinc-200">Constituents</h2>
              <div className="flex items-center gap-2">
                <select
                  value={addId}
                  onChange={(e) => setAddId(e.target.value)}
                  className="rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-200 px-2 py-1 max-w-[200px]"
                >
                  <option value="">Add person…</option>
                  {available.map((p) => (
                    <option key={p.id} value={p.ticker}>{p.name} — {p.category}</option>
                  ))}
                </select>
                <button onClick={doAdd} disabled={!addId} className="rounded-md bg-sky-700 hover:bg-sky-600 disabled:opacity-40 px-3 py-1 text-xs font-medium text-white">
                  Add
                </button>
              </div>
            </div>
            <ConstituentsTable rows={rows} weighting={weighting} onRemove={doRemove} />

            <p className="text-[10px] text-zinc-600 mt-4">
              Adding or removing a constituent re-anchors the index so the value does not jump (PDF Part 7).
              Switch categories or weighting above to reseed from the real Pauv roster.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
