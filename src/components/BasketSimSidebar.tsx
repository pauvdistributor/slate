"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { BOT_IDS, BOT_STARTING_CASH, type BotPortfolio } from "@/basket/simulation";

const BOT_COLORS: Record<string, string> = {
  "bot-1": "text-rose-400",
  "bot-2": "text-cyan-400",
  "bot-3": "text-amber-400",
  "bot-4": "text-lime-400",
  "bot-5": "text-fuchsia-400",
};

function fmtUSD(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export interface BasketSimSidebarProps {
  open: boolean;
  onToggle: () => void;
  portfolios: BotPortfolio[];
  /** Run a single bot tick (page mutates sim + persists + re-renders). */
  onTick: () => void;
  /** Push bias / trade-range changes into the sim config. */
  onConfig: (c: { bias?: number; minTrade?: number; maxTrade?: number }) => void;
  onCloseAll: () => void;
}

export default function BasketSimSidebar({
  open,
  onToggle,
  portfolios,
  onTick,
  onConfig,
  onCloseAll,
}: BasketSimSidebarProps) {
  const [running, setRunning] = useState(false);
  const [bias, setBias] = useState(0);
  const [minTrade, setMinTrade] = useState("200");
  const [maxTrade, setMaxTrade] = useState("1000");
  const [intervalMs, setIntervalMs] = useState("400");

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onTickRef = useRef(onTick);
  useEffect(() => { onTickRef.current = onTick; }, [onTick]);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setRunning(false);
  }, []);

  const start = useCallback(() => {
    if (timerRef.current) return;
    const ms = Math.max(50, parseInt(intervalMs) || 400);
    timerRef.current = setInterval(() => onTickRef.current(), ms);
    setRunning(true);
  }, [intervalMs]);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // Push config whenever inputs change.
  useEffect(() => {
    onConfig({
      bias: bias / 100,
      minTrade: parseInt(minTrade) || 200,
      maxTrade: parseInt(maxTrade) || 1000,
    });
  }, [bias, minTrade, maxTrade, onConfig]);

  const totalPortfolio = portfolios.reduce((s, p) => s + p.portfolio, 0);
  const totalStart = portfolios.length * BOT_STARTING_CASH;

  return (
    <div
      className="h-full bg-zinc-900 border-r border-zinc-700 overflow-y-auto shrink-0 transition-all duration-300"
      style={{ width: open ? 340 : 0, minWidth: open ? 340 : 0 }}
    >
      {open && (
        <div className="px-4 py-4" style={{ width: 340 }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-zinc-200">Simulation Bots</h2>
            <button onClick={onToggle} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">×</button>
          </div>

          {/* Total */}
          <div className="rounded-lg border border-zinc-600 bg-zinc-800/80 p-3 mb-4">
            <p className="text-[10px] text-zinc-400 uppercase tracking-wide mb-1">Total Bot Portfolio</p>
            <p className={`text-xl font-bold ${totalPortfolio >= totalStart ? "text-emerald-400" : "text-red-400"}`}>
              {fmtUSD(totalPortfolio)}
            </p>
            <div className="flex items-center justify-between mt-1">
              <span className="text-[10px] text-zinc-500">Started: {fmtUSD(totalStart)}</span>
              <span className={`text-[10px] font-medium ${totalPortfolio - totalStart >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {totalPortfolio - totalStart >= 0 ? "+" : ""}{fmtUSD(totalPortfolio - totalStart)}
              </span>
            </div>
          </div>

          {/* Bias */}
          <div className="rounded-lg border border-zinc-600 bg-zinc-800/80 p-3 mb-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-zinc-400 uppercase tracking-wide">Sentiment Bias</span>
              <span className={`text-xs font-medium ${bias > 0 ? "text-emerald-400" : bias < 0 ? "text-orange-400" : "text-zinc-400"}`}>
                {bias > 0 ? `+${bias}% Bull` : bias < 0 ? `${bias}% Bear` : "Neutral"}
              </span>
            </div>
            <input
              type="range" min={-100} max={100} step={5} value={bias}
              onChange={(e) => setBias(parseInt(e.target.value))}
              className="w-full h-1.5 rounded-lg appearance-none cursor-pointer bg-zinc-700 accent-zinc-400"
            />
          </div>

          {/* Range + interval */}
          <div className="rounded-lg border border-zinc-600 bg-zinc-800/80 p-3 mb-4">
            <span className="text-[10px] text-zinc-400 uppercase tracking-wide">Position Amount ($)</span>
            <div className="flex items-center gap-2 my-2">
              <label className="text-[10px] text-zinc-400 w-6">Min</label>
              <input value={minTrade} onChange={(e) => setMinTrade(e.target.value)} inputMode="numeric"
                className="flex-1 rounded border border-zinc-600 bg-zinc-900 px-2 py-1 text-xs text-zinc-200" />
              <label className="text-[10px] text-zinc-400 w-7">Max</label>
              <input value={maxTrade} onChange={(e) => setMaxTrade(e.target.value)} inputMode="numeric"
                className="flex-1 rounded border border-zinc-600 bg-zinc-900 px-2 py-1 text-xs text-zinc-200" />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-zinc-400 whitespace-nowrap">Tick (ms)</label>
              <input value={intervalMs} onChange={(e) => setIntervalMs(e.target.value)} inputMode="numeric"
                className="w-16 rounded border border-zinc-600 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-200" />
              <span className="text-[10px] text-zinc-400">between trades</span>
            </div>
          </div>

          {/* Controls */}
          <div className="flex gap-2 mb-2">
            <button
              onClick={running ? stop : start}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors ${running ? "bg-red-600 hover:bg-red-500" : "bg-emerald-600 hover:bg-emerald-500"}`}
            >
              {running ? "Stop" : "Start"}
            </button>
            <button onClick={() => onTickRef.current()} className="rounded-md bg-zinc-700 hover:bg-zinc-600 px-3 py-1.5 text-xs font-medium text-zinc-100">
              Step
            </button>
          </div>
          <button onClick={onCloseAll} className="w-full rounded-md bg-amber-700/70 hover:bg-amber-600 px-3 py-1.5 text-xs font-medium text-white mb-4">
            Close All Positions
          </button>

          {/* Per-bot */}
          <div className="space-y-2">
            {portfolios.map((p) => (
              <div key={p.botId} className="rounded-lg border border-zinc-700 bg-zinc-800/60 p-2.5 flex items-center justify-between">
                <span className={`text-sm font-bold ${BOT_COLORS[p.botId] ?? "text-zinc-300"}`}>{p.botId}</span>
                <div className="text-right">
                  <div className="text-xs text-zinc-200">{fmtUSD(p.portfolio)}</div>
                  <div className={`text-[10px] ${p.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {p.pnl >= 0 ? "+" : ""}{fmtUSD(p.pnl)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export { BOT_IDS };
