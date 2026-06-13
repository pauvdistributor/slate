"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import SlateChart from "@/components/SlateChart";
import ConstituentsTable from "@/components/ConstituentsTable";
import SlateSimSidebar from "@/components/SlateSimSidebar";
import InfoTooltip from "@/components/InfoTooltip";
import Nav from "@/components/Nav";
import SimControls from "@/components/SimControls";
import SlateSearch from "@/components/SlateSearch";
import {
  slateValue,
  summarize,
  snapshotConstituents,
  rebalance,
  addConstituent,
  removeConstituent,
  advanceTime,
  setSchedule,
  nextRebalanceMs,
  simDateLabel,
  totalFeesPaid,
  DAY_MS,
  DIRECT_FEE_RATE,
  type SlateSummary,
  type ConstituentSnapshot,
  type SlatePoint,
  type RebalanceSchedule,
  type CascadeClosure,
} from "@/slate/slate-engine";
import {
  botTick,
  botPortfolios,
  closeAllPositions,
  closeAccountPositions,
  type SimState,
  type BotPortfolio,
} from "@/slate/simulation";
import {
  loadOrSeed,
  saveSim,
  resetSim,
  seedSim,
  allPeople,
  findPerson,
  constituentFromPerson,
  getSlatePrice,
  getFeesEnabled,
  getLastViewedSlate,
  setLastViewedSlate,
  adjustWallet,
  USER_ID,
  DEFAULT_CATEGORY,
} from "@/slate/slate-store";

interface View {
  summary: SlateSummary;
  value: number;
  rows: ConstituentSnapshot[];
  portfolios: BotPortfolio[];
  history: SlatePoint[];
  memberIds: Set<string>;
  schedule: RebalanceSchedule;
  dateLabel: string;
  startDateValue: string;
  nextRebalanceLabel: string;
  feesPaid: number;
}

/**
 * Credit YOUR share of liquidation cascades to the wallet — bot owners are
 * credited inside the sim layer (botTick / closeAllPositions).
 */
function settleYourCascades(cascades: CascadeClosure[] | undefined): void {
  const mine = (cascades ?? [])
    .filter((c) => c.userId === USER_ID)
    .reduce((s, c) => s + c.proceeds, 0);
  if (mine > 0) adjustWallet(mine);
}

function deriveView(sim: SimState): View {
  const b = sim.slate;
  return {
    summary: summarize(b),
    value: slateValue(b),
    rows: snapshotConstituents(b),
    portfolios: botPortfolios(sim),
    history: b.history.slice(),
    memberIds: new Set(b.constituents.map((c) => c.id)),
    schedule: b.schedule,
    dateLabel: simDateLabel(b.clockMs),
    startDateValue: new Date(b.startMs).toISOString().slice(0, 10),
    nextRebalanceLabel: simDateLabel(nextRebalanceMs(b)),
    feesPaid: totalFeesPaid(b),
  };
}

export default function SlatePage() {
  const simRef = useRef<SimState | null>(null);
  const [view, setView] = useState<View | null>(null);
  // Set when the active slate has no creator-set initial value yet — trading is blocked.
  const [blockedCat, setBlockedCat] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [addId, setAddId] = useState("");

  const refresh = useCallback((persist = true) => {
    const sim = simRef.current;
    if (!sim) return;
    if (persist) saveSim(sim);
    setView(deriveView(sim));
  }, []);

  // Show a slate: load its SHARED sim (the same world the Single tab trades
  // in, so its orders show up here) or seed one. Blocks if the slate has no
  // creator-set initial value yet.
  const switchTo = useCallback((category: string) => {
    setLastViewedSlate(category);
    if (getSlatePrice(category) == null) {
      simRef.current = null;
      setView(null);
      setBlockedCat(category);
      return;
    }
    const sim = loadOrSeed(category);
    simRef.current = sim;
    setBlockedCat(null);
    setView(deriveView(sim));
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    // Restore the slate you were last looking at (kept even when blocked).
    // localStorage is only readable client-side, hence the effect.
    switchTo(getLastViewedSlate() ?? DEFAULT_CATEGORY);
  }, [switchTo]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Restart the CURRENT slate's sim from scratch (also wipes what the Single
  // tab did to it — same world), preserving settings not overridden.
  const reseed = useCallback((o: { startMs?: number } = {}) => {
    const b = simRef.current?.slate;
    if (!b) return;
    // Cash YOUR positions out first so the wipe doesn't strand wallet money.
    const { proceeds, cascades } = closeAccountPositions(b, USER_ID, getFeesEnabled() ? DIRECT_FEE_RATE : 0);
    if (proceeds) adjustWallet(proceeds);
    settleYourCascades(cascades);
    resetSim(b.name);
    const sim = seedSim({
      category: b.name,
      startMs: o.startMs ?? b.startMs,
    });
    simRef.current = sim;
    saveSim(sim);
    setView(deriveView(sim));
  }, []);

  const onSetStartDate = useCallback((ms: number) => reseed({ startMs: ms }), [reseed]);

  const onTick = useCallback(() => {
    if (!simRef.current) return;
    // Bot invests pay the direct-leg fee, honoring the Nav toggle.
    simRef.current.config.feeRate = getFeesEnabled() ? DIRECT_FEE_RATE : 0;
    const ev = botTick(simRef.current);
    // A bot trade can liquidate YOUR parent short; its slate leg auto-closes
    // and the proceeds belong in your wallet (bots are credited in botTick).
    settleYourCascades(ev.cascades);
    refresh();
  }, [refresh]);

  const onConfig = useCallback((c: { bias?: number; minTrade?: number; maxTrade?: number }) => {
    if (!simRef.current) return;
    Object.assign(simRef.current.config, c);
  }, []);

  const doRebalance = useCallback(() => {
    if (!simRef.current) return;
    rebalance(simRef.current.slate, "manual rebalance");
    refresh();
  }, [refresh]);

  const onAdvanceDays = useCallback((n: number) => {
    if (!simRef.current) return;
    advanceTime(simRef.current.slate, n * DAY_MS);
    refresh();
  }, [refresh]);

  const onSetSchedule = useCallback((p: Partial<RebalanceSchedule>) => {
    if (!simRef.current) return;
    setSchedule(simRef.current.slate, p);
    refresh();
  }, [refresh]);

  const doAdd = useCallback(() => {
    if (!simRef.current || !addId) return;
    const person = findPerson(addId);
    if (!person) return;
    const c = constituentFromPerson(person);
    addConstituent(simRef.current.slate, c);
    setAddId("");
    refresh();
  }, [addId, refresh]);

  const doRemove = useCallback((id: string) => {
    if (!simRef.current) return;
    removeConstituent(simRef.current.slate, id);
    refresh();
  }, [refresh]);

  const closeAll = useCallback(() => {
    if (!simRef.current) return;
    simRef.current.config.feeRate = getFeesEnabled() ? DIRECT_FEE_RATE : 0;
    // Bots only — YOUR positions stay open (close them from the Single tab),
    // though a buyback can liquidate one; that cascade is yours to pocket.
    const { cascades } = closeAllPositions(simRef.current);
    settleYourCascades(cascades);
    refresh();
  }, [refresh]);

  if (!view) {
    if (blockedCat) {
      // Trading is blocked until the slate's initial value is set.
      return (
        <div className="flex flex-col h-screen">
          <Nav />
          <div className="flex-1">
            <div className="max-w-xl mx-auto px-6 pt-24 text-center">
              <div className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-6">
                <div className="text-amber-300 font-semibold mb-1">Please set the initial slate price</div>
                <p className="text-xs text-zinc-400 mb-4">
                  The <span className="text-zinc-200 font-medium">{blockedCat}</span> slate has no initial value yet.
                  Trading is blocked until you set one.
                </p>
                <Link
                  href="/set-slates"
                  className="inline-block rounded-md bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium text-white"
                >
                  Set the Slates →
                </Link>
              </div>
              <div className="mt-4 text-xs text-zinc-500 flex items-center justify-center gap-2">
                <span>Or switch to another slate:</span>
                <SlateSearch onPick={switchTo} className="w-56 text-left" />
              </div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col h-screen">
        <Nav />
        <div className="p-8 text-zinc-500">Loading simulation…</div>
      </div>
    );
  }

  const {
    summary, value, rows, portfolios, history, memberIds,
    schedule, dateLabel, startDateValue, nextRebalanceLabel, feesPaid,
  } = view;
  const totalReturn = summary.totalReturn;
  const available = allPeople().filter((p) => !memberIds.has(p.ticker));

  return (
    <div className="flex flex-col h-screen">
      <Nav onToggleBots={() => setSidebarOpen((v) => !v)} feesPaid={feesPaid} />
      <div className="flex flex-1 overflow-hidden">
        <SlateSimSidebar
          open={sidebarOpen}
          onToggle={() => setSidebarOpen((v) => !v)}
          portfolios={portfolios}
          onTick={onTick}
          onConfig={onConfig}
          onCloseAll={closeAll}
        />

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-6 py-6">
            {/* Header */}
            <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
              <div>
                <h1 className="text-xl font-bold text-zinc-100">{summary.name} Slate</h1>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Equal-weight slate over the {summary.name} category · real Pauv roster
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div
                  className="flex items-center gap-1.5"
                  title="Switching slates keeps each slate's simulation — including orders placed on the Single tab"
                >
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500">Slate</span>
                  <SlateSearch onPick={switchTo} className="w-56" />
                </div>
              </div>
            </div>

            {/* Simulated calendar */}
            <SimControls
              dateLabel={dateLabel}
              startDateValue={startDateValue}
              nextRebalanceLabel={nextRebalanceLabel}
              schedule={schedule}
              baseValue={summary.baseValue}
              onAdvanceDays={onAdvanceDays}
              onSetSchedule={onSetSchedule}
              onSetStartDate={onSetStartDate}
            />

            {/* Slate value hero */}
            <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-5 mb-4 flex items-end justify-between">
              <div>
                <div className="flex items-center text-[10px] uppercase tracking-wide text-zinc-500">
                  Slate Value
                  <InfoTooltip text="anchorValue × (1 + average return since last rebaseline). Only real trades move it; rebalances and roster changes are absorbed." />
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
                  {summary.n} constituents · 1/N each at rebalance
                </div>
                <button
                  onClick={doRebalance}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium text-white ${summary.rebalanceDue ? "bg-amber-600 hover:bg-amber-500" : "bg-zinc-700 hover:bg-zinc-600"}`}
                  title="Reset every baseline to the current price (re-equalizes weights). Slate value is unchanged at the instant of rebalance."
                >
                  Rebalance{summary.rebalanceDue ? " (due)" : ""}
                </button>
              </div>
            </div>

            {/* Chart */}
            <div className="mb-4">
              <SlateChart history={history} baseValue={summary.baseValue} title={`${summary.name} — Slate Value`} />
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
            <ConstituentsTable rows={rows} onRemove={doRemove} />

            <p className="text-[10px] text-zinc-600 mt-4">
              Adding or removing a constituent re-anchors the slate so the value does not jump (PDF Part 7).
              Orders placed on the Single tab trade this same slate, so they show up in the chart above.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
