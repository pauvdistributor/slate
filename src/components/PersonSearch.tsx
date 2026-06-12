"use client";

import { useMemo, useRef, useState } from "react";
import { allPeople, type RosterPerson } from "@/slate/slate-store";

function fmtUSD(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MAX_RESULTS = 12;

/**
 * Roster lookup: type a name or ticker, pick a person. Results show only
 * name, price, and category.
 */
export default function PersonSearch({
  onPick,
  autoFocus = false,
}: {
  onPick: (p: RosterPerson) => void;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allPeople()
      .filter((p) => p.name.toLowerCase().includes(q) || p.ticker.toLowerCase().includes(q))
      .slice(0, MAX_RESULTS);
  }, [query]);

  const pick = (p: RosterPerson) => {
    setQuery("");
    setOpen(false);
    onPick(p);
  };

  return (
    <div className="relative">
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
        onKeyDown={(e) => { if (e.key === "Enter" && results.length > 0) pick(results[0]); }}
        autoFocus={autoFocus}
        placeholder="Search a person by name or ticker…"
        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 text-sm text-zinc-200 px-4 py-2.5 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
      />
      {open && results.length > 0 && (
        <div
          className="absolute z-20 mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl overflow-hidden"
          onMouseDown={() => { if (blurTimer.current) clearTimeout(blurTimer.current); }}
        >
          {results.map((p) => (
            <button
              key={p.id}
              onClick={() => pick(p)}
              className="w-full flex items-center justify-between px-4 py-2 text-left text-sm hover:bg-zinc-800"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-zinc-200 truncate">{p.name}</span>
                <span className="text-[10px] uppercase tracking-wide text-zinc-500 shrink-0">{p.category}</span>
              </span>
              <span className="text-zinc-300 tabular-nums shrink-0 ml-3">{fmtUSD(p.priceUsd)}</span>
            </button>
          ))}
        </div>
      )}
      {open && query.trim() && results.length === 0 && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-500">
          No one matches “{query.trim()}”
        </div>
      )}
    </div>
  );
}
