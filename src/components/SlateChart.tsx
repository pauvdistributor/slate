"use client";

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
import type { SlatePoint } from "@/slate/slate-engine";

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { payload: SlatePoint }[] }) {
  if (!active || !payload || !payload.length) return null;
  const pt = payload[0].payload;
  return (
    <div style={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
      <p style={{ color: "#a1a1aa", marginBottom: 2 }}>
        #{pt.seq} · {pt.event}{pt.note ? ` — ${pt.note}` : ""}
      </p>
      <p style={{ color: "#e4e4e7", fontWeight: 600 }}>
        {pt.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </p>
    </div>
  );
}

export default function SlateChart({
  history,
  baseValue,
  title = "Slate Value",
}: {
  history: SlatePoint[];
  baseValue: number;
  title?: string;
}) {
  if (history.length <= 1) {
    return (
      <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 flex items-center justify-center h-64">
        <p className="text-zinc-500 text-sm">Run the simulation to see the slate move</p>
      </div>
    );
  }

  const values = history.map((d) => d.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const pad = (maxV - minV) * 0.15 || 1;
  const yMin = Math.floor(minV - pad);
  const yMax = Math.ceil(maxV + pad);

  // Mark non-market events (rebalance / add / remove) on the axis.
  const events = history.filter((d) => d.event === "rebalance" || d.event === "add" || d.event === "remove");

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-4">
      <h3 className="text-sm font-semibold text-zinc-200 mb-3">{title}</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={history} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis
            dataKey="seq"
            tick={{ fill: "#888", fontSize: 10 }}
            stroke="#555"
          />
          <YAxis
            domain={[yMin, yMax]}
            tick={{ fill: "#888", fontSize: 10 }}
            stroke="#555"
            tickFormatter={(v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine
            y={baseValue}
            stroke="#555"
            strokeDasharray="6 4"
            label={{ value: `base ${baseValue}`, fill: "#666", fontSize: 10, position: "right" }}
          />
          {events.map((e) => (
            <ReferenceLine
              key={e.seq}
              x={e.seq}
              stroke={e.event === "rebalance" ? "#f59e0b" : "#38bdf8"}
              strokeDasharray="2 3"
              strokeOpacity={0.6}
            />
          ))}
          <Line
            type="monotone"
            dataKey="value"
            stroke="#a78bfa"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, fill: "#c4b5fd" }}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="flex gap-4 mt-2 text-[10px] text-zinc-500">
        <span><span className="inline-block w-3 border-t border-amber-500 align-middle mr-1" /> rebalance</span>
        <span><span className="inline-block w-3 border-t border-sky-400 align-middle mr-1" /> add / remove</span>
      </div>
    </div>
  );
}
