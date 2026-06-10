"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import IndexChart from "@/components/IndexChart";
import ConstituentsTable from "@/components/ConstituentsTable";
import BasketSimSidebar from "@/components/BasketSimSidebar";
import InfoTooltip from "@/components/InfoTooltip";
import Nav from "@/components/Nav";
import FlowBreakdown from "@/components/FlowBreakdown";
import SimControls from "@/components/SimControls";
import {
  indexValue,
  summarize,
  snapshotConstituents,
  rebalance,
  addConstituent,
  removeConstituent,
  buyIndexUnits,
  sellIndexUnits,
  holderValue,
  advanceTime,
  setSchedule,
  nextRebalanceMs,
  simDateLabel,
  DAY_MS,
  type WeightingMode,
  type BasketSummary,
  type ConstituentSnapshot,
  type IndexPoint,
  type InvestAllocation,
  type IndexInvestResult,
  type RebalanceSchedule,
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

function fmtUSD(n: number, d = 2): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtUSDi(total: number, n: number): string {
  return fmtUSD(n > 0 ? total / n : 0);
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`font-semibold tabular-nums ${accent ? "text-emerald-300" : "text-zinc-200"}`}>{value}</div>
    </div>
  );
}

const YOU = "you";

interface View {
  summary: BasketSummary;
  value: number;
  rows: ConstituentSnapshot[];
  portfolios: BotPortfolio[];
  history: IndexPoint[];
  weighting: WeightingMode;
  memberIds: Set<string>;
  schedule: RebalanceSchedule;
  dateLabel: string;
  startDateValue: string;
  nextRebalanceLabel: string;
  yourUnits: number;
  yourUnitsValue: number;
  unitsOutstanding: number;
}

function deriveView(sim: SimState): View {
  const b = sim.basket;
  return {
    summary: summarize(b),
    value: indexValue(b),
    rows: snapshotConstituents(b),
    portfolios: botPortfolios(sim),
    history: b.history.slice(),
    weighting: b.weighting,
    memberIds: new Set(b.constituents.map((c) => c.id)),
    schedule: b.schedule,
    dateLabel: simDateLabel(b.clockMs),
    startDateValue: new Date(b.startMs).toISOString().slice(0, 10),
    nextRebalanceLabel: simDateLabel(nextRebalanceMs(b)),
    yourUnits: b.ledger.holders[YOU] ?? 0,
    yourUnitsValue: holderValue(b, YOU),
    unitsOutstanding: b.ledger.unitsOutstanding,
  };
}

export default function BasketPage() {
  const simRef = useRef<SimState | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [addId, setAddId] = useState("");
  const [investAmt, setInvestAmt] = useState("1000");
  const [lastInvest, setLastInvest] = useState<IndexInvestResult | null>(null);

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

  const reseed = useCallback((category: string, weighting: WeightingMode, startMs?: number) => {
    resetSim("index");
    const sim = seedSim({ category, weighting, startMs });
    simRef.current = sim;
    saveSim(sim, "index");
    setView(deriveView(sim));
  }, []);

  const onSetStartDate = useCallback((ms: number) => {
    const b = simRef.current?.basket;
    if (!b) return;
    reseed(b.name, b.weighting, ms);
  }, [reseed]);

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

  const doInvestIndex = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    const a = parseFloat(investAmt) || 0;
    if (a <= 0) return;
    const res = buyIndexUnits(sim.basket, YOU, a);
    setLastInvest(res);
    refresh();
  }, [investAmt, refresh]);

  const doRedeem = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    const units = sim.basket.ledger.holders[YOU] ?? 0;
    if (units <= 0) return;
    sellIndexUnits(sim.basket, YOU, units);
    setLastInvest(null);
    refresh();
  }, [refresh]);

  const onAdvanceDays = useCallback((n: number) => {
    if (!simRef.current) return;
    advanceTime(simRef.current.basket, n * DAY_MS);
    refresh();
  }, [refresh]);

  const onSetSchedule = useCallback((p: Partial<RebalanceSchedule>) => {
    if (!simRef.current) return;
    setSchedule(simRef.current.basket, p);
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

  // Live preview of how an index investment fans out to the constituents.
  const indexPreview: InvestAllocation[] = useMemo(() => {
    const rows = view?.rows ?? [];
    const w = view?.weighting ?? "equal";
    const a = parseFloat(investAmt) || 0;
    if (rows.length === 0 || a <= 0) return [];
    const tot = rows.reduce((s, r) => s + r.marketCap, 0);
    return rows.map((r) => {
      const slice = w === "mcap"
        ? (tot > 0 ? a * (r.marketCap / tot) : a / rows.length)
        : a / rows.length;
      return {
        id: r.id, name: r.name, amount: slice, primaryAmount: 0, indexAmount: slice,
        pct: slice / a, isPrimary: false, tokens: 0, priceBefore: r.price, priceAfter: r.price,
      };
    });
  }, [view, investAmt]);

  if (!view) {
    return (
      <div className="flex flex-col h-screen">
        <Nav />
        <div className="p-8 text-zinc-500">Loading simulation…</div>
      </div>
    );
  }

  const {
    summary, value, rows, portfolios, history, weighting, memberIds,
    schedule, dateLabel, startDateValue, nextRebalanceLabel, yourUnits, yourUnitsValue, unitsOutstanding,
  } = view;
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

            {/* Simulated calendar */}
            <SimControls
              dateLabel={dateLabel}
              startDateValue={startDateValue}
              nextRebalanceLabel={nextRebalanceLabel}
              schedule={schedule}
              onAdvanceDays={onAdvanceDays}
              onSetSchedule={onSetSchedule}
              onSetStartDate={onSetStartDate}
            />

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

            {/* Invest in the index */}
            <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-4 mb-4">
              <div className="flex items-start justify-between mb-3 gap-2 flex-wrap">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-200 flex items-center">
                    Invest in the index
                    <InfoTooltip text="Buying the index sends money into the constituents by weight. Equal weight = equal dollars ($X/N each); market-cap = pro-rata by market cap. The index value moves with the resulting prices." />
                  </h2>
                  <p className="text-[11px] text-zinc-500 mt-0.5">
                    {weighting === "equal"
                      ? `Equal weight — ${fmtUSDi(parseFloat(investAmt) || 0, summary.n)} into each of the ${summary.n} members`
                      : "Market-cap — pro-rata by each member's market cap"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-zinc-500 text-sm">$</span>
                  <input
                    value={investAmt}
                    onChange={(e) => setInvestAmt(e.target.value)}
                    inputMode="decimal"
                    className="w-28 rounded border border-zinc-700 bg-zinc-900 text-sm text-zinc-200 px-2 py-1.5"
                  />
                  <button onClick={doInvestIndex} className="rounded-md bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white">
                    Buy units
                  </button>
                </div>
              </div>

              {/* Holdings (the ETF vehicle) */}
              <div className="flex items-center justify-between rounded-md border border-zinc-700 bg-zinc-800/50 px-3 py-2 mb-3 text-xs flex-wrap gap-2">
                <div className="flex gap-5">
                  <span className="text-zinc-500">Your units: <span className="text-zinc-200 tabular-nums">{yourUnits.toFixed(4)}</span></span>
                  <span className="text-zinc-500">Value: <span className="text-emerald-300 tabular-nums">{fmtUSD(yourUnitsValue)}</span></span>
                  <span className="text-zinc-500">Unit price: <span className="text-zinc-300 tabular-nums">{fmtUSD(value)}</span></span>
                  <span className="text-zinc-500">Units outstanding: <span className="text-zinc-300 tabular-nums">{unitsOutstanding.toFixed(4)}</span></span>
                </div>
                <button
                  onClick={doRedeem}
                  disabled={yourUnits <= 0}
                  className="rounded-md bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 px-3 py-1 text-xs font-medium text-white"
                >
                  Redeem all
                </button>
              </div>

              <FlowBreakdown
                total={parseFloat(investAmt) || 0}
                legs={[{ label: `Index → all ${summary.n} members (${weighting === "equal" ? "equal" : "by market cap"})`, amount: parseFloat(investAmt) || 0, tone: "index" }]}
                allocations={indexPreview}
                title="Money flow (preview)"
              />

              {lastInvest && (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-3 gap-3 text-xs rounded-lg border border-emerald-700/50 bg-emerald-950/20 p-3">
                    <Stat label="Index before" value={lastInvest.indexBefore.toFixed(2)} />
                    <Stat label="Index after" value={lastInvest.indexAfter.toFixed(2)} accent />
                    <Stat label="Invested" value={fmtUSD(lastInvest.amount)} />
                  </div>
                  <FlowBreakdown
                    total={lastInvest.amount}
                    legs={[{ label: "Index → all members", amount: lastInvest.amount, tone: "index" }]}
                    allocations={lastInvest.allocations}
                    title="Money flow (executed)"
                  />
                </div>
              )}
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
