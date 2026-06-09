"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import IndexChart from "@/components/IndexChart";
import InfoTooltip from "@/components/InfoTooltip";
import Nav from "@/components/Nav";
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
    saveSim(sim);
    setView(deriveView(sim));
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const sim = loadOrSeed();
    simRef.current = sim;
    setView(deriveView(sim));
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const reseed = useCallback((category: string, weighting: WeightingMode) => {
    resetSim();
    const sim = seedSim({ category, weighting });
    simRef.current = sim;
    saveSim(sim);
    setLastResult(null);
    setPerson("");
    setView(deriveView(sim));
  }, []);

  const amt = parseFloat(amount) || 0;
  const primaryPct = Math.min(100, Math.max(0, parseFloat(primary) || 0)) / 100;

  // Default the selected person to LeBron if present, else the first member.
  const members = useMemo(() => view?.rows ?? [], [view]);
  const selected =
    person && members.some((m) => m.id === person)
      ? person
      : members.find((m) => m.id === "lebron")?.id ?? members[0]?.id ?? "";

  const n = members.length;

  // Pure preview from the rendered rows (same arithmetic as
  // basket-engine.previewInvestment, but without touching the ref in render).
  const preview = useMemo(() => {
    if (!selected || amt <= 0 || n === 0) return [];
    const primaryAmt = amt * primaryPct;
    const perMember = (amt * (1 - primaryPct)) / n;
    return members.map((m) => {
      const isPrimary = m.id === selected;
      const a = perMember + (isPrimary ? primaryAmt : 0);
      return { id: m.id, name: m.name, amount: a, pct: a / amt, isPrimary };
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

  const { summary, value, rows, history, weighting } = view;
  const selectedRow = rows.find((r) => r.id === selected);

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
                {Math.round(primaryPct * 100)}% goes to the person, {Math.round((1 - primaryPct) * 100)}% is split
                across all {summary.n} {summary.name} members (the person included).
              </p>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">Category</span>
              <select
                value={summary.name}
                onChange={(e) => reseed(e.target.value, weighting)}
                className="rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-200 px-2 py-1 max-w-[160px]"
                title="Switching category reseeds the simulation (shared with the Index tab)"
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
                  <label className="block text-[10px] uppercase tracking-wide text-zinc-500 mb-1 flex items-center">
                    Primary %
                    <InfoTooltip text="Share routed straight to the chosen person. The remainder is split evenly across all category members (including the person), so their effective share is a bit higher." />
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
                <div>Effective share to {selectedRow?.name ?? "person"}: <span className="text-zinc-200 font-medium">{(effectivePrimary * 100).toFixed(2)}%</span></div>
                <div>Each member&apos;s even slice: <span className="text-zinc-200">{fmtUSD((amt * (1 - primaryPct)) / Math.max(1, n))}</span></div>
              </div>

              <button
                onClick={doInvest}
                disabled={!selected || amt <= 0}
                className="w-full rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-3 py-2 text-sm font-medium text-white"
              >
                Invest {amt > 0 ? fmtUSD(amt) : ""}
              </button>
            </div>

            {/* Allocation preview */}
            <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-4">
              <h2 className="text-sm font-semibold text-zinc-200 mb-3">Allocation preview</h2>
              {preview.length === 0 ? (
                <p className="text-xs text-zinc-500">Enter an amount to see the split.</p>
              ) : (
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-zinc-500">
                        <th className="text-left font-medium py-1">Member</th>
                        <th className="text-right font-medium py-1">Amount</th>
                        <th className="text-right font-medium py-1">Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview
                        .slice()
                        .sort((a, b) => b.amount - a.amount)
                        .map((r) => (
                          <tr key={r.id} className={r.isPrimary ? "text-emerald-300" : "text-zinc-300"}>
                            <td className="py-1">{r.name}{r.isPrimary ? " ★" : ""}</td>
                            <td className="py-1 text-right tabular-nums">{fmtUSD(r.amount)}</td>
                            <td className="py-1 text-right tabular-nums">{(r.pct * 100).toFixed(2)}%</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Result */}
          {lastResult && (
            <div className="rounded-lg border border-emerald-700/50 bg-emerald-950/20 p-4 mt-4">
              <h2 className="text-sm font-semibold text-emerald-300 mb-2">
                Invested {fmtUSD(lastResult.amount)} — primary {lastResult.allocations.find((a) => a.isPrimary)?.name}
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <Stat label="Index before" value={lastResult.indexBefore.toFixed(2)} />
                <Stat label="Index after" value={lastResult.indexAfter.toFixed(2)} accent />
                <Stat
                  label={`${lastResult.allocations.find((a) => a.isPrimary)?.name} price`}
                  value={`${fmtUSD(lastResult.allocations.find((a) => a.isPrimary)!.priceBefore)} → ${fmtUSD(lastResult.allocations.find((a) => a.isPrimary)!.priceAfter)}`}
                />
                <Stat label="Effective primary %" value={`${(lastResult.effectivePrimaryPct * 100).toFixed(2)}%`} />
              </div>
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
