"use client";

import type { InvestAllocation } from "@/basket/basket-engine";

function fmtUSD(n: number, d = 2): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export interface FlowLeg {
  label: string;
  amount: number;
  tone: "primary" | "index";
}

/**
 * Visualizes how an investment's dollars flow:
 *  - a top stacked bar splitting the total into its legs (direct vs index),
 *  - a per-constituent list of bars showing each member's slice and, once
 *    executed, the resulting price move.
 */
export default function FlowBreakdown({
  total,
  legs,
  allocations,
  title = "Money flow",
}: {
  total: number;
  legs: FlowLeg[];
  allocations: InvestAllocation[];
  title?: string;
}) {
  if (!(total > 0) || allocations.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-4 text-xs text-zinc-500">
        Enter an amount to see how the money flows.
      </div>
    );
  }

  const executed = allocations.some((a) => a.priceAfter !== a.priceBefore);
  const maxAmt = Math.max(...allocations.map((a) => a.amount), 1e-9);
  const rows = allocations.slice().sort((a, b) => b.amount - a.amount);

  const toneBar: Record<FlowLeg["tone"], string> = {
    primary: "bg-emerald-500",
    index: "bg-sky-500",
  };
  const toneText: Record<FlowLeg["tone"], string> = {
    primary: "text-emerald-300",
    index: "text-sky-300",
  };

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
        <span className="text-xs text-zinc-400">{fmtUSD(total)} total</span>
      </div>

      {/* Top routing bar */}
      <div className="flex w-full h-6 rounded overflow-hidden mb-1.5 bg-zinc-800">
        {legs.filter((l) => l.amount > 0).map((l) => (
          <div
            key={l.label}
            className={`${toneBar[l.tone]} h-full`}
            style={{ width: `${(l.amount / total) * 100}%` }}
            title={`${l.label}: ${fmtUSD(l.amount)}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 mb-4 text-[11px]">
        {legs.filter((l) => l.amount > 0).map((l) => (
          <span key={l.label} className={toneText[l.tone]}>
            ● {l.label}: <span className="text-zinc-200">{fmtUSD(l.amount)}</span>{" "}
            <span className="text-zinc-500">({((l.amount / total) * 100).toFixed(1)}%)</span>
          </span>
        ))}
      </div>

      {/* Per-constituent flow */}
      <div className="max-h-72 overflow-y-auto pr-1 space-y-1.5">
        {rows.map((a) => {
          const ret = a.priceBefore > 0 ? a.priceAfter / a.priceBefore - 1 : 0;
          return (
            <div key={a.id} className="text-xs">
              <div className="flex items-center justify-between mb-0.5">
                <span className={a.isPrimary ? "text-emerald-300 font-medium" : "text-zinc-300"}>
                  {a.name}{a.isPrimary ? " ★" : ""}
                </span>
                <span className="text-zinc-400 tabular-nums">
                  {fmtUSD(a.amount)}
                  {executed && (
                    <span className={`ml-2 ${ret >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {fmtUSD(a.priceBefore, a.priceBefore < 10 ? 4 : 2)}→{fmtUSD(a.priceAfter, a.priceAfter < 10 ? 4 : 2)}
                      {ret !== 0 ? ` (${ret >= 0 ? "+" : ""}${(ret * 100).toFixed(2)}%)` : ""}
                    </span>
                  )}
                </span>
              </div>
              {/* stacked bar: index slice (sky) + primary slice (emerald) */}
              <div className="flex w-full h-2 rounded overflow-hidden bg-zinc-800" style={{ maxWidth: `${(a.amount / maxAmt) * 100}%` }}>
                {a.indexAmount > 0 && (
                  <div className="bg-sky-500/80 h-full" style={{ width: `${(a.indexAmount / a.amount) * 100}%` }} />
                )}
                {a.primaryAmount > 0 && (
                  <div className="bg-emerald-500 h-full" style={{ width: `${(a.primaryAmount / a.amount) * 100}%` }} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
