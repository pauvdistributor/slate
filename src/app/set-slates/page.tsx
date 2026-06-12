"use client";

import { useCallback, useEffect, useState } from "react";
import Nav from "@/components/Nav";
import {
  listCategories,
  getSlatePrices,
  setSlatePrice,
  setAllSlatePrices,
} from "@/slate/slate-store";

// ============================================================
// SET THE SLATES
// ------------------------------------------------------------
// Before anything can be traded, the creator sets each slate's
// INITIAL value here. The slate is anchored to this value at
// seed time, so it launches exactly at the number chosen on
// this page. Until a slate has a value, the trading pages stay
// blocked.
// ============================================================

function draftsFrom(prices: Record<string, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, String(v)]));
}

export default function SetSlatesPage() {
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [autoVal, setAutoVal] = useState("10");
  const [loaded, setLoaded] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const p = getSlatePrices();
    setPrices(p);
    setDrafts(draftsFrom(p));
    setLoaded(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const commit = useCallback((cat: string) => {
    const v = parseFloat(drafts[cat] ?? "");
    if (Number.isFinite(v) && v > 0) {
      setSlatePrice(cat, v);
      setPrices((p) => ({ ...p, [cat]: v }));
      setDrafts((d) => ({ ...d, [cat]: String(v) }));
    } else {
      // Invalid → revert the draft to the stored value (or empty).
      setDrafts((d) => ({ ...d, [cat]: prices[cat] != null ? String(prices[cat]) : "" }));
    }
  }, [drafts, prices]);

  const autoPopulate = useCallback(() => {
    const v = parseFloat(autoVal);
    if (!(Number.isFinite(v) && v > 0)) return;
    setAllSlatePrices(v);
    const p = getSlatePrices();
    setPrices(p);
    setDrafts(draftsFrom(p));
  }, [autoVal]);

  const cats = listCategories();
  const setCount = cats.filter((c) => prices[c.name] != null).length;
  const allSet = setCount === cats.length;

  return (
    <div className="flex flex-col h-screen">
      <Nav />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-6">
          {/* Header */}
          <div className="mb-5">
            <h1 className="text-xl font-bold text-zinc-100">Set the Slates</h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              Pick each slate&apos;s initial value. Trading stays blocked until a slate has one —
              the slate launches exactly at your number.
            </p>
          </div>

          {/* Status + auto-populate */}
          <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-4 mb-4 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs">
              <span className={allSet ? "text-emerald-400" : "text-amber-400"}>
                {setCount}/{cats.length} slates set
              </span>
              {!allSet && <span className="text-zinc-500"> — unset slates can&apos;t be traded</span>}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">Auto populate with</span>
              <span className="text-zinc-500 text-sm">$</span>
              <input
                value={autoVal}
                onChange={(e) => setAutoVal(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") autoPopulate(); }}
                inputMode="decimal"
                className="w-20 rounded border border-zinc-700 bg-zinc-900 text-sm text-zinc-200 px-2 py-1.5"
              />
              <button
                onClick={autoPopulate}
                className="rounded-md bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white"
                title="Set every slate's initial value to this number"
              >
                Apply to all
              </button>
            </div>
          </div>

          {/* Slate list */}
          <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-zinc-500 border-b border-zinc-700">
                  <th className="text-left font-medium px-3 py-2">Slate</th>
                  <th className="text-right font-medium px-3 py-2">Members</th>
                  <th className="text-right font-medium px-3 py-2">Status</th>
                  <th className="text-right font-medium px-3 py-2">Initial value</th>
                </tr>
              </thead>
              <tbody>
                {cats.map((c) => {
                  const isSet = prices[c.name] != null;
                  return (
                    <tr key={c.name} className="border-b border-zinc-800 last:border-0">
                      <td className="px-3 py-2 text-zinc-200 font-medium">{c.name}</td>
                      <td className="px-3 py-2 text-right text-zinc-400 tabular-nums">{c.count}</td>
                      <td className="px-3 py-2 text-right">
                        {isSet
                          ? <span className="text-[10px] uppercase tracking-wide text-emerald-400">set</span>
                          : <span className="text-[10px] uppercase tracking-wide text-amber-400">not set</span>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className="text-zinc-500 text-sm mr-1">$</span>
                        <input
                          value={drafts[c.name] ?? ""}
                          placeholder="—"
                          disabled={!loaded}
                          onChange={(e) => setDrafts((d) => ({ ...d, [c.name]: e.target.value }))}
                          onBlur={() => commit(c.name)}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          inputMode="decimal"
                          className="w-24 rounded border border-zinc-700 bg-zinc-900 text-sm text-zinc-200 px-2 py-1 text-right tabular-nums"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[10px] text-zinc-600 mt-4">
            Values apply when a slate&apos;s simulation is (re)seeded. Changing a value here does not
            rewrite a running sim&apos;s history — restart that slate&apos;s sim to relaunch at the new value.
          </p>
        </div>
      </div>
    </div>
  );
}
