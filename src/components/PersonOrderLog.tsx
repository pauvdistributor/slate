"use client";

import { useState } from "react";
import type { PersonPricePoint, PriceMoveSource } from "@/slate/slate-engine";

function fmtUSD(n: number, d?: number): string {
  const digits = d ?? (Math.abs(n) < 10 ? 4 : 2);
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const SOURCE_BADGE: Record<PriceMoveSource, { label: string; cls: string }> = {
  launch: { label: "launch", cls: "bg-zinc-800 text-zinc-400" },
  order: { label: "order", cls: "bg-emerald-900/60 text-emerald-300" },
  slate: { label: "slate", cls: "bg-sky-900/60 text-sky-300" },
  liquidation: { label: "liquidation", cls: "bg-amber-900/60 text-amber-300" },
};

const EVENT_LABEL: Record<string, string> = {
  buy: "buy",
  sell: "sell",
  short_open: "short open",
  short_close: "short close",
  liquidation: "liquidation",
};

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
                <th className="text-left font-medium py-1.5 pr-2">Source</th>
                <th className="text-left font-medium py-1.5 pr-2">Event</th>
                <th className="text-left font-medium py-1.5 pr-2">Who</th>
                <th className="text-right font-medium py-1.5 pr-2">Amount</th>
                <th className="text-right font-medium py-1.5">Price</th>
              </tr>
            </thead>
            <tbody>
              {orders.slice(0, shown).map((p) => {
                const ret = p.priceBefore && p.priceBefore > 0 ? p.price / p.priceBefore - 1 : 0;
                const isYou = you != null && p.userId === you;
                return (
                  <tr key={p.seq} className="border-b border-zinc-800/60 last:border-0">
                    <td className="py-1.5 pr-2 text-zinc-600 tabular-nums">{p.seq}</td>
                    <td className="py-1.5 pr-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${SOURCE_BADGE[p.source].cls}`}>
                        {SOURCE_BADGE[p.source].label}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2 text-zinc-300">{EVENT_LABEL[p.event] ?? p.event}</td>
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
