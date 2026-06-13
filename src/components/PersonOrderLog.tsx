"use client";

import { useState } from "react";
import type { PersonPricePoint, PriceMoveSource } from "@/slate/slate-engine";

function fmtUSD(n: number, d?: number): string {
  const digits = d ?? (Math.abs(n) < 10 ? 4 : 2);
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Each row decomposed for the log: which side the position is on
// (long/short), which leg moved the price (a direct order vs the
// auto-spread slate leg), and what happened to it.
function describe(p: { event: string; source: PriceMoveSource }): {
  side: { label: string; cls: string };
  leg: { label: string; cls: string };
  action: { label: string; cls: string };
} {
  const long = { label: "long", cls: "bg-emerald-900/60 text-emerald-300" };
  const short = { label: "short", cls: "bg-red-900/60 text-red-300" };
  const side = p.event === "buy" || p.event === "sell" ? long : short;
  // A liquidation names no leg — the engine fires it on the curve itself.
  const leg = p.source === "liquidation"
    ? { label: "—", cls: "text-zinc-600" }
    : p.source === "slate"
    ? { label: "slate", cls: "bg-sky-900/60 text-sky-300" }
    : { label: "direct", cls: "bg-zinc-800 text-zinc-300" };
  const action =
    p.event === "liquidation" ? { label: "liquidated", cls: "text-amber-300" }
    : p.event === "buy" || p.event === "short_open" ? { label: "open", cls: "text-zinc-300" }
    : { label: "close", cls: "text-zinc-400" };
  return { side, leg, action };
}

const PAGE = 25;

/**
 * Every price-moving event on one person's curve, newest first: direct
 * orders, slate (index-pool) flows, shorts, and liquidations.
 */
export default function PersonOrderLog({
  points,
  you,
}: {
  points: PersonPricePoint[];
  you?: string;
}) {
  const [shown, setShown] = useState(PAGE);
  // Drop the synthetic launch point; newest first.
  const orders = points.filter((p) => p.source !== "launch").reverse();

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-zinc-200">Order log</h3>
        <span className="text-[10px] text-zinc-500">{orders.length} price-moving events</span>
      </div>

      {orders.length === 0 ? (
        <p className="text-xs text-zinc-500">No orders yet — every direct order and slate flow will be logged here.</p>
      ) : (
        <>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-zinc-500 border-b border-zinc-800">
                <th className="text-left font-medium py-1.5 pr-2">#</th>
                <th className="text-left font-medium py-1.5 pr-2">Side</th>
                <th className="text-left font-medium py-1.5 pr-2">Leg</th>
                <th className="text-left font-medium py-1.5 pr-2">Action</th>
                <th className="text-left font-medium py-1.5 pr-2">Who</th>
                <th className="text-right font-medium py-1.5 pr-2">Amount</th>
                <th className="text-right font-medium py-1.5">Price</th>
              </tr>
            </thead>
            <tbody>
              {orders.slice(0, shown).map((p) => {
                const ret = p.priceBefore && p.priceBefore > 0 ? p.price / p.priceBefore - 1 : 0;
                const isYou = you != null && p.userId === you;
                const { side, leg, action } = describe(p);
                return (
                  <tr key={p.seq} className="border-b border-zinc-800/60 last:border-0">
                    <td className="py-1.5 pr-2 text-zinc-600 tabular-nums">{p.seq}</td>
                    <td className="py-1.5 pr-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${side.cls}`}>
                        {side.label}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${leg.cls}`}>
                        {leg.label}
                      </span>
                    </td>
                    <td className={`py-1.5 pr-2 ${action.cls}`}>{action.label}</td>
                    <td className={`py-1.5 pr-2 ${isYou ? "text-emerald-300 font-medium" : "text-zinc-500"}`}>
                      {p.source === "slate" ? "slate pool" : p.userId ?? "—"}
                    </td>
                    <td className="py-1.5 pr-2 text-right text-zinc-300 tabular-nums">
                      {p.amount != null && p.amount > 0 ? fmtUSD(p.amount, 2) : "—"}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {p.priceBefore != null ? (
                        <span>
                          <span className="text-zinc-500">{fmtUSD(p.priceBefore)}</span>
                          <span className="text-zinc-600"> → </span>
                          <span className="text-zinc-200">{fmtUSD(p.price)}</span>
                          {ret !== 0 && (
                            <span className={`ml-1 ${ret >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                              ({ret >= 0 ? "+" : ""}{(ret * 100).toFixed(2)}%)
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-zinc-200">{fmtUSD(p.price)}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {orders.length > shown && (
            <button
              onClick={() => setShown((s) => s + PAGE)}
              className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-800/60 hover:bg-zinc-700 py-1.5 text-[11px] text-zinc-300"
            >
              Show {Math.min(PAGE, orders.length - shown)} more
            </button>
          )}
        </>
      )}
    </div>
  );
}
