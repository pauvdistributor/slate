"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import IndexChart from "@/components/IndexChart";
import InfoTooltip from "@/components/InfoTooltip";
import Nav from "@/components/Nav";
import FlowBreakdown, { type FlowLeg } from "@/components/FlowBreakdown";
import {
  indexValue,
  summarize,
  snapshotConstituents,
  investInPerson,
  type WeightingMode,
  type BasketSummary,
  type ConstituentSnapshot,
  type IndexPoint,
  type InvestResult,
  type InvestAllocation,
} from "@/basket/basket-engine";
import { type SimState } from "@/basket/simulation";
import {
  loadOrSeed,
  saveSim,
  resetSim,
  seedSim,
  listCategories,
} from "@/basket/basket-store";

interface View {
  summary: BasketSummary;
  value: number;
  rows: ConstituentSnapshot[];
  history: IndexPoint[];
  weighting: WeightingMode;
}

function deriveView(sim: SimState): View {
  return {
    summary: summarize(sim.basket),
    value: indexValue(sim.basket),
    rows: snapshotConstituents(sim.basket),
    history: sim.basket.history.slice(),
    weighting: sim.basket.weighting,
  };
}

function fmtUSD(n: number, d = 2): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export default function SinglePage() {
  const simRef = useRef<SimState | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [person, setPerson] = useState("");
  const [amount, setAmount] = useState("1000");
  const [primary, setPrimary] = useState("95");
  const [lastResult, setLastResult] = useState<InvestResult | null>(null);

  const categories = useMemo(() => listCategories(), []);

  const refresh = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    saveSim(sim, "single");
    setView(deriveView(sim));
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const sim = loadOrSeed("single");
    simRef.current = sim;
    setView(deriveView(sim));
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const reseed = useCallback((category: string, weighting: WeightingMode) => {
    resetSim("single");
    const sim = seedSim({ category, weighting });
    simRef.current = sim;
    saveSim(sim, "single");
    setLastResult(null);
    setPerson("");
    setView(deriveView(sim));
  }, []);

  const amt = parseFloat(amount) || 0;
  const primaryPct = Math.min(100, Math.max(0, parseFloat(primary) || 0)) / 100;

  const members = useMemo(() => view?.rows ?? [], [view]);
  const n = members.length;
  const selected =
    person && members.some((m) => m.id === person)
      ? person
      : members.find((m) => m.id === "lebron")?.id ?? members[0]?.id ?? "";

  // Live preview: 95% direct to person, 5% equal-weight across all members.
  const previewAllocs: InvestAllocation[] = useMemo(() => {
    if (!selected || amt <= 0 || n === 0) return [];
    const primaryAmt = amt * primaryPct;
    const perMember = (amt * (1 - primaryPct)) / n; // equal-weight index leg
    return members.map((m) => {
      const isPrimary = m.id === selected;
      const indexAmount = perMember;
      const primaryAmount = isPrimary ? primaryAmt : 0;
      const a = indexAmount + primaryAmount;
      return {
        id: m.id, name: m.name, amount: a, primaryAmount, indexAmount,
        pct: a / amt, isPrimary, tokens: 0, priceBefore: m.price, priceAfter: m.price,
      };
    });
  }, [selected, amt, primaryPct, n, members]);

  const effectivePrimary = n > 0 ? primaryPct + (1 - primaryPct) / n : primaryPct;

  const doInvest = useCallback(() => {
    const sim = simRef.current;
    if (!sim || !selected || amt <= 0) return;
    const res = investInPerson(sim.basket, selected, amt, { primaryPct });
    setLastResult(res);
    refresh();
  }, [selected, amt, primaryPct, refresh]);

  if (!view) {
    return (
      <div className="flex flex-col h-screen">
        <Nav />
        <div className="p-8 text-zinc-500">Loading simulation…</div>
      </div>
    );
  }

  const { summary, value, rows, history } = view;
  const selectedRow = rows.find((r) => r.id === selected);
  const primaryName = selectedRow?.name ?? "person";

  const previewLegs: FlowLeg[] = [
    { label: `Direct → ${primaryName}`, amount: amt * primaryPct, tone: "primary" },
    { label: `Index → all ${n} members`, amount: amt * (1 - primaryPct), tone: "index" },
  ];

  const resultLegs: FlowLeg[] = lastResult
    ? [
        { label: `Direct → ${lastResult.allocations.find((a) => a.isPrimary)?.name ?? "person"}`, amount: lastResult.amount * lastResult.primaryPct, tone: "primary" },
        { label: `Index → all members`, amount: lastResult.indexAmount, tone: "index" },
      ]
    : [];

  return (
    <div className="flex flex-col h-screen">
      <Nav />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6">
          {/* Header */}
          <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
            <div>
              <h1 className="text-xl font-bold text-zinc-100">Invest in a single person</h1>
              <p className="text-xs text-zinc-500 mt-0.5">
                {Math.round(primaryPct * 100)}% buys the person directly · {Math.round((1 - primaryPct) * 100)}% goes
                into the {summary.name} index (spread equally across all {summary.n} members).
              </p>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">Category</span>
              <select
                value={summary.name}
                onChange={(e) => reseed(e.target.value, view.weighting)}
                className="rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-200 px-2 py-1 max-w-[160px]"
                title="Switching category reseeds this tab's simulation"
              >
                {categories.map((c) => (
                  <option key={c.name} value={c.name}>{c.name} ({c.count})</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {/* Invest form */}
            <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-4">
              <h2 className="text-sm font-semibold text-zinc-200 mb-3">Invest</h2>

              <label className="block text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Person</label>
              <select
                value={selected}
                onChange={(e) => setPerson(e.target.value)}
                className="w-full rounded border border-zinc-700 bg-zinc-900 text-sm text-zinc-200 px-2 py-1.5 mb-3"
              >
                {members.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} — {fmtUSD(m.price, 2)}</option>
                ))}
              </select>

              <div className="flex gap-3 mb-3">
                <div className="flex-1">
                  <label className="block text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Amount (USD)</label>
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    className="w-full rounded border border-zinc-700 bg-zinc-900 text-sm text-zinc-200 px-2 py-1.5"
                  />
                </div>
                <div className="w-24">
                  <label className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1 flex items-center">
                    Direct %
                    <InfoTooltip text="Share that buys the chosen person directly. The remainder goes into the index, which spreads it equally across all members (including the person), so their effective share is a bit higher." />
                  </label>
                  <input
                    value={primary}
                    onChange={(e) => setPrimary(e.target.value)}
                    inputMode="decimal"
                    className="w-full rounded border border-zinc-700 bg-zinc-900 text-sm text-zinc-200 px-2 py-1.5"
                  />
                </div>
              </div>

              <div className="text-[11px] text-zinc-400 mb-3 space-y-0.5">
                <div>Direct to {primaryName}: <span className="text-emerald-300">{fmtUSD(amt * primaryPct)}</span></div>
                <div>Into the index: <span className="text-sky-300">{fmtUSD(amt * (1 - primaryPct))}</span> → {fmtUSD((amt * (1 - primaryPct)) / Math.max(1, n))} each</div>
                <div>Effective share to {primaryName}: <span className="text-zinc-200 font-medium">{(effectivePrimary * 100).toFixed(2)}%</span></div>
              </div>

              <button
                onClick={doInvest}
                disabled={!selected || amt <= 0}
                className="w-full rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-3 py-2 text-sm font-medium text-white"
              >
                Invest {amt > 0 ? fmtUSD(amt) : ""}
              </button>
            </div>

            {/* Live flow preview */}
            <FlowBreakdown
              total={amt}
              legs={previewLegs}
              allocations={previewAllocs}
              title="Money flow (preview)"
            />
          </div>

          {/* Executed result */}
          {lastResult && (
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs rounded-lg border border-emerald-700/50 bg-emerald-950/20 p-3">
                <Stat label="Index before" value={lastResult.indexBefore.toFixed(2)} />
                <Stat label="Index after" value={lastResult.indexAfter.toFixed(2)} accent />
                <Stat
                  label={`${lastResult.allocations.find((a) => a.isPrimary)?.name} price`}
                  value={`${fmtUSD(lastResult.allocations.find((a) => a.isPrimary)!.priceBefore)} → ${fmtUSD(lastResult.allocations.find((a) => a.isPrimary)!.priceAfter)}`}
                />
                <Stat label="Effective direct %" value={`${(lastResult.effectivePrimaryPct * 100).toFixed(2)}%`} />
              </div>
              <FlowBreakdown
                total={lastResult.amount}
                legs={resultLegs}
                allocations={lastResult.allocations}
                title="Money flow (executed)"
              />
            </div>
          )}

          {/* Current value + chart */}
          <div className="mt-4 mb-2 flex items-end justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">{summary.name} Index</div>
              <div className="text-2xl font-bold text-zinc-100 tabular-nums">
                {value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            {selectedRow && (
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">{selectedRow.name}</div>
                <div className="text-2xl font-bold text-zinc-100 tabular-nums">{fmtUSD(selectedRow.price)}</div>
              </div>
            )}
          </div>
          <IndexChart history={history} baseValue={summary.baseValue} title={`${summary.name} — Index Value`} />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`font-semibold tabular-nums ${accent ? "text-emerald-300" : "text-zinc-200"}`}>{value}</div>
    </div>
  );
}
