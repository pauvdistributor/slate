"use client";

import type { RebalanceSchedule, RebalanceFrequency, BaseValueMode } from "@/basket/basket-engine";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Simulated-calendar controls: shows the current sim date, lets you advance
 * time manually, and configure the auto-rebalance schedule (e.g. every Friday).
 */
export default function SimControls({
  dateLabel,
  startDateValue,
  nextRebalanceLabel,
  schedule,
  baseMode,
  baseValue,
  onAdvanceDays,
  onSetSchedule,
  onSetStartDate,
  onSetBaseMode,
}: {
  dateLabel: string;
  /** Start date as YYYY-MM-DD for the date input. */
  startDateValue: string;
  nextRebalanceLabel: string;
  schedule: RebalanceSchedule;
  baseMode: BaseValueMode;
  baseValue: number;
  onAdvanceDays: (n: number) => void;
  onSetSchedule: (p: Partial<RebalanceSchedule>) => void;
  /** Pick a new start date (ms, UTC midnight). Reseeds the sim from that date. */
  onSetStartDate: (ms: number) => void;
  /** Pick how the launch index value is set. Reseeds the sim. */
  onSetBaseMode: (m: BaseValueMode) => void;
}) {
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-3 mb-4 flex items-center gap-x-5 gap-y-2 flex-wrap text-xs">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">Start</span>
        <input
          type="date"
          value={startDateValue}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            const ms = new Date(`${v}T00:00:00Z`).getTime();
            if (Number.isFinite(ms)) onSetStartDate(ms);
          }}
          title="Set the simulation's start date (reseeds this tab from that date)"
          className="rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-200 px-1.5 py-1 [color-scheme:dark]"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">Now</span>
        <span className="font-semibold text-zinc-100 tabular-nums">{dateLabel}</span>
      </div>

      <div className="flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500 mr-1">Advance</span>
        <button onClick={() => onAdvanceDays(1)} className="rounded bg-zinc-700 hover:bg-zinc-600 px-2 py-1 text-zinc-100">+1d</button>
        <button onClick={() => onAdvanceDays(7)} className="rounded bg-zinc-700 hover:bg-zinc-600 px-2 py-1 text-zinc-100">+1w</button>
        <button onClick={() => onAdvanceDays(30)} className="rounded bg-zinc-700 hover:bg-zinc-600 px-2 py-1 text-zinc-100">+1mo</button>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">Rebalance</span>
        <select
          value={schedule.frequency}
          onChange={(e) => onSetSchedule({ frequency: e.target.value as RebalanceFrequency })}
          className="rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-200 px-1.5 py-1"
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
        {schedule.frequency === "weekly" && (
          <select
            value={schedule.weekday}
            onChange={(e) => onSetSchedule({ weekday: parseInt(e.target.value) })}
            className="rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-200 px-1.5 py-1"
          >
            {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        )}
        {schedule.frequency === "monthly" && (
          <select
            value={schedule.dayOfMonth}
            onChange={(e) => onSetSchedule({ dayOfMonth: parseInt(e.target.value) })}
            className="rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-200 px-1.5 py-1"
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>day {d}</option>)}
          </select>
        )}
      </div>

      <div className="flex items-center gap-2 text-zinc-500">
        <span className="text-[10px] uppercase tracking-wide">Next</span>
        <span className="text-amber-300 tabular-nums">{nextRebalanceLabel}</span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">Base value</span>
        <select
          value={baseMode}
          onChange={(e) => onSetBaseMode(e.target.value as BaseValueMode)}
          title="How the launch index value is set (supply-free for equal weight)"
          className="rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-200 px-1.5 py-1"
        >
          <option value="avgPrice">Avg price (ΣP/N)</option>
          <option value="sumPrice">Total price (ΣP)</option>
          <option value="fixed">Fixed 1000</option>
        </select>
        <span className="text-zinc-400 tabular-nums">= {baseValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
      </div>
    </div>
  );
}
