"use client";

import { useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import type { PersonPricePoint, PriceMoveSource, PersonOrder } from "@/slate/slate-engine";
import InfoTooltip from "./InfoTooltip";

function fmtUSD(n: number, d?: number): string {
  const digits = d ?? (Math.abs(n) < 10 ? 4 : 2);
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const SOURCE_COLOR: Record<PriceMoveSource, string> = {
  launch: "#71717a",
  order: "#34d399",
  slate: "#38bdf8",
  liquidation: "#f59e0b",
};
const SOURCE_LABEL: Record<PriceMoveSource, string> = {
  launch: "launch",
  order: "direct order",
  slate: "slate flow",
  liquidation: "liquidation",
};

/** Keep the chart responsive on long-running sims. */
const MAX_CHART_POINTS = 600;
/** Per-point dots get noisy/slow beyond this. */
const MAX_DOT_POINTS = 250;

function PriceTooltip({ active, payload }: { active?: boolean; payload?: { payload: PersonPricePoint }[] }) {
  if (!active || !payload || !payload.length) return null;
  const pt = payload[0].payload;
  return (
    <div style={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
      <p style={{ color: SOURCE_COLOR[pt.source], marginBottom: 2 }}>
        #{pt.seq} · {SOURCE_LABEL[pt.source]}
        {pt.event !== "launch" && pt.source !== "slate" ? ` — ${pt.event.replace("_", " ")}` : ""}
        {pt.userId && pt.source === "order" ? ` (${pt.userId})` : ""}
      </p>
      {pt.amount != null && pt.amount > 0 && (
        <p style={{ color: "#a1a1aa", marginBottom: 2 }}>{fmtUSD(pt.amount, 2)}</p>
      )}
      <p style={{ color: "#e4e4e7", fontWeight: 600 }}>{fmtUSD(pt.price)}</p>
    </div>
  );
}

export interface PersonPanelProps {
  name: string;
  category: string;
  price: number;
  baselinePrice: number;
  points: PersonPricePoint[];
  amount: string;
  onAmount: (v: string) => void;
  primary: string;
  onPrimary: (v: string) => void;
  /** Auto-spread on/off — off trades 100% direct (no slate leg). */
  spreadOn: boolean;
  onSpreadToggle: (on: boolean) => void;
  onLong: () => void;
  onShort: () => void;
  /** One entry per trade: the direct position combined with its slate leg. */
  orders: PersonOrder[];
  onClosePosition: (positionId: string) => void;
  message?: { kind: "ok" | "err", text: string } | null;
}

/**
 * The trading view for one person: current price + price-history chart on
 * top (every move tagged direct order vs slate flow), long/short controls
 * right under it, and your open orders on this person. Each order is one
 * row combining both legs; expanding it reveals the direct and slate legs.
 */
export default function PersonPricePanel({
  name,
  category,
  price,
  baselinePrice,
  points,
  amount,
  onAmount,
  primary,
  onPrimary,
  spreadOn,
  onSpreadToggle,
  onLong,
  onShort,
  orders,
  onClosePosition,
  message,
}: PersonPanelProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const launchPrice = points[0]?.price ?? price;
  const sinceLaunch = launchPrice > 0 ? price / launchPrice - 1 : 0;
  const amt = parseFloat(amount) || 0;

  const truncated = points.length > MAX_CHART_POINTS;
  const data = truncated ? points.slice(-MAX_CHART_POINTS) : points;
  const values = data.map((p) => p.price);
  const minV = Math.min(...values, baselinePrice);
  const maxV = Math.max(...values, baselinePrice);
  const pad = (maxV - minV) * 0.15 || Math.max(price * 0.05, 0.01);

  const showDots = data.length <= MAX_DOT_POINTS;
  const renderDot = (props: unknown) => {
    const { key, cx, cy, payload } = props as { key?: string; cx?: number; cy?: number; payload?: PersonPricePoint };
    if (cx == null || cy == null || !payload) return <g key={key} />;
    return <circle key={key} cx={cx} cy={cy} r={2.5} fill={SOURCE_COLOR[payload.source]} stroke="none" />;
  };

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-4">
      {/* Name · category · current price */}
      <div className="flex items-end justify-between gap-4 flex-wrap mb-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-zinc-100">{name}</h2>
            <span className="rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
              {category}
            </span>
          </div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500 mt-1">Current price</div>
          <div className="text-3xl font-bold text-zinc-100 tabular-nums">{fmtUSD(price)}</div>
          <div className={`text-xs mt-0.5 ${sinceLaunch >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {sinceLaunch >= 0 ? "+" : ""}{(sinceLaunch * 100).toFixed(2)}% since launch
          </div>
        </div>

        {/* Trade controls */}
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-end gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Amount (USD)</label>
              <input
                value={amount}
                onChange={(e) => onAmount(e.target.value)}
                inputMode="decimal"
                className="w-28 rounded border border-zinc-700 bg-zinc-900 text-sm text-zinc-200 px-2 py-1.5"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Auto-spread</label>
              <button
                onClick={() => onSpreadToggle(!spreadOn)}
                className={`rounded border px-2 py-1.5 text-sm font-medium ${
                  spreadOn
                    ? "bg-sky-900/40 border-sky-700 text-sky-300 hover:bg-sky-900/60"
                    : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:bg-zinc-700"
                }`}
                title="On: part of every order spreads across the slate. Off: the whole order trades the person directly (100/0)."
              >
                {spreadOn ? "On" : "Off"}
              </button>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1 flex items-center">
                Direct %
                <InfoTooltip text="This share trades the person directly; the remainder spreads across the slate — a long buys slate units, a short opens small shorts on every member. Closing the direct position unwinds its slate leg too. 70 minimum (the 70/30 floor); toggle auto-spread off for 100% direct." />
              </label>
              <input
                value={spreadOn ? primary : "100"}
                onChange={(e) => onPrimary(e.target.value)}
                onBlur={() => onPrimary(String(Math.min(100, Math.max(70, parseFloat(primary) || 95))))}
                disabled={!spreadOn}
                inputMode="decimal"
                title={spreadOn ? "70–100" : "Auto-spread is off — the whole order is direct"}
                className="w-16 rounded border border-zinc-700 bg-zinc-900 text-sm text-zinc-200 px-2 py-1.5 disabled:opacity-50"
              />
            </div>
            <button
              onClick={onLong}
              disabled={amt <= 0}
              className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-1.5 text-sm font-medium text-white"
            >
              Buy Long
            </button>
            <button
              onClick={onShort}
              disabled={amt <= 0}
              className="rounded-md bg-red-700 hover:bg-red-600 disabled:opacity-40 px-4 py-1.5 text-sm font-medium text-white"
            >
              Short
            </button>
          </div>
          {message && (
            <div className={`text-[11px] max-w-md text-right ${message.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>
              {message.text}
            </div>
          )}
        </div>
      </div>

      {/* Price history */}
      {data.length <= 1 ? (
        <div className="flex items-center justify-center h-64 rounded-md border border-zinc-800">
          <p className="text-zinc-500 text-sm">No trades yet — buy, short, or run the bots to see the price move</p>
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="seq" tick={{ fill: "#888", fontSize: 10 }} stroke="#555" />
              <YAxis
                domain={[minV - pad, maxV + pad]}
                tick={{ fill: "#888", fontSize: 10 }}
                stroke="#555"
                tickFormatter={(v: number) => fmtUSD(v).replace("$", "")}
              />
              <Tooltip content={<PriceTooltip />} />
              <ReferenceLine
                y={baselinePrice}
                stroke="#555"
                strokeDasharray="6 4"
                label={{ value: `baseline ${fmtUSD(baselinePrice)}`, fill: "#666", fontSize: 10, position: "right" }}
              />
              <Line
                type="monotone"
                dataKey="price"
                stroke="#34d399"
                strokeWidth={2}
                dot={showDots ? renderDot : false}
                activeDot={{ r: 5, fill: "#6ee7b7" }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
          <div className="flex gap-4 mt-2 text-[10px] text-zinc-500">
            <span><span className="inline-block w-2 h-2 rounded-full align-middle mr-1" style={{ backgroundColor: SOURCE_COLOR.order }} /> direct order</span>
            <span><span className="inline-block w-2 h-2 rounded-full align-middle mr-1" style={{ backgroundColor: SOURCE_COLOR.slate }} /> slate flow</span>
            <span><span className="inline-block w-2 h-2 rounded-full align-middle mr-1" style={{ backgroundColor: SOURCE_COLOR.liquidation }} /> liquidation</span>
            {truncated && <span className="ml-auto">showing last {MAX_CHART_POINTS} of {points.length} moves</span>}
          </div>
        </>
      )}

      {/* Your open orders on this person (direct + slate leg combined) */}
      {orders.length > 0 && (
        <div className="mt-4 border-t border-zinc-800 pt-3">
          <h3 className="text-xs font-semibold text-zinc-300 mb-2 flex items-center">
            Your positions on {name}
            <InfoTooltip text="One row per trade, with the direct and slate legs combined. Click a row to see the legs. Closing the trade closes both legs — legs can't be closed on their own." />
          </h3>
          <div className="space-y-1.5">
            {orders.map((o) => {
              const p = o.position;
              const open = expanded.has(p.id);
              return (
                <div key={p.id} className="rounded-md border border-zinc-800 bg-zinc-900 text-xs">
                  {/* Parent row — the whole trade */}
                  <div
                    onClick={() => toggleExpanded(p.id)}
                    className="flex items-center justify-between px-3 py-2 gap-3 flex-wrap cursor-pointer hover:bg-zinc-800/50 rounded-md"
                    title={open ? "Hide legs" : "Show the direct and slate legs"}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-zinc-500 w-3 text-center">{open ? "▾" : "▸"}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${p.type === "long" ? "bg-emerald-900/60 text-emerald-300" : "bg-red-900/60 text-red-300"}`}>
                        {p.type}
                      </span>
                      <span className="text-zinc-400">{fmtUSD(o.totalCost, 2)} in{o.slateLeg ? " · 2 legs" : ""}</span>
                      {p.type === "short" && p.escrowUtilization != null && (
                        <span className={`${p.escrowUtilization > 0.8 ? "text-amber-400" : "text-zinc-500"}`}>
                          escrow {(p.escrowUtilization * 100).toFixed(0)}% used
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-zinc-300 tabular-nums">{fmtUSD(o.totalValue, 2)}</span>
                      <span className={`tabular-nums ${o.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {o.totalPnl >= 0 ? "+" : ""}{fmtUSD(o.totalPnl, 2)}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); onClosePosition(p.id); }}
                        className="rounded bg-zinc-700 hover:bg-zinc-600 px-2 py-1 text-[11px] font-medium text-white"
                        title="Close the whole trade — unwinds the direct position and its slate leg"
                      >
                        Close
                      </button>
                    </div>
                  </div>

                  {/* Legs */}
                  {open && (
                    <div className="border-t border-zinc-800 px-3 py-2 space-y-1.5">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <span className="text-zinc-400">
                          <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-emerald-900/40 text-emerald-300 mr-2">direct</span>
                          {p.tokens.toFixed(4)} tokens @ {fmtUSD(p.openPrice)}
                        </span>
                        <span className="flex items-center gap-3">
                          <span className="text-zinc-300 tabular-nums">{fmtUSD(p.currentValue, 2)}</span>
                          <span className={`tabular-nums ${p.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {p.pnl >= 0 ? "+" : ""}{fmtUSD(p.pnl, 2)}
                          </span>
                        </span>
                      </div>
                      {o.slateLeg ? (
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <span className="text-zinc-400">
                            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-sky-900/40 text-sky-300 mr-2">slate</span>
                            {o.slateLeg.kind === "units"
                              ? `${(o.slateLeg.units ?? 0).toFixed(4)} slate units`
                              : `shorts across ${o.slateLeg.memberLegs?.length ?? 0} members`}
                            <span className="text-zinc-600"> · closes with the trade</span>
                          </span>
                          <span className="flex items-center gap-3">
                            <span className="text-zinc-300 tabular-nums">{fmtUSD(o.slateLeg.currentValue, 2)}</span>
                            <span className={`tabular-nums ${o.slateLeg.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                              {o.slateLeg.pnl >= 0 ? "+" : ""}{fmtUSD(o.slateLeg.pnl, 2)}
                            </span>
                          </span>
                        </div>
                      ) : (
                        <div className="text-zinc-600">No slate leg — this trade was 100% direct.</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
