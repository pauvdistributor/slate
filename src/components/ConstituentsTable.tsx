"use client";

import type { ConstituentSnapshot } from "@/slate/slate-engine";

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
}

export default function ConstituentsTable({
  rows,
  onRemove,
}: {
  rows: ConstituentSnapshot[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-zinc-500 border-b border-zinc-700">
            <th className="text-left font-medium px-3 py-2">Constituent</th>
            <th className="text-right font-medium px-3 py-2">Price</th>
            <th className="text-right font-medium px-3 py-2">Baseline</th>
            <th className="text-right font-medium px-3 py-2">Return</th>
            <th className="text-right font-medium px-3 py-2">Weight</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-zinc-800 last:border-0">
              <td className="px-3 py-2 text-zinc-200 font-medium">{r.name}</td>
              <td className="px-3 py-2 text-right text-zinc-300 tabular-nums">${r.price.toFixed(4)}</td>
              <td className="px-3 py-2 text-right text-zinc-500 tabular-nums">${r.baselinePrice.toFixed(4)}</td>
              <td className={`px-3 py-2 text-right tabular-nums ${r.return >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {pct(r.return)}
              </td>
              <td className="px-3 py-2 text-right text-zinc-300 tabular-nums">{(r.weight * 100).toFixed(1)}%</td>
              <td className="px-3 py-2 text-right">
                <button
                  onClick={() => onRemove(r.id)}
                  className="text-[10px] text-zinc-600 hover:text-red-400 transition-colors"
                  title="Remove from slate"
                >
                  remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
