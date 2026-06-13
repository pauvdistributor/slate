"use client";

import { useMemo, useRef, useState } from "react";
import { listCategories, getSlatePrices } from "@/slate/slate-store";

/**
 * Slate lookup, mirroring PersonSearch: type a slate name, pick one.
 * With only ~14 slates, focusing with an empty query lists them all.
 * Slates with no creator-set initial value yet are flagged.
 */
export default function SlateSearch({
  onPick,
  className = "",
  autoFocus = false,
}: {
  onPick: (category: string) => void;
  className?: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const slates = useMemo(() => listCategories(), []);
  // Re-read when the dropdown opens — Set the Slates may have run since.
  const prices = useMemo(() => (open ? getSlatePrices() : {}), [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return slates;
    return slates.filter((s) => s.name.toLowerCase().includes(q));
  }, [query, slates]);

  const pick = (name: string) => {
    setQuery("");
    setOpen(false);
    onPick(name);
  };

  return (
    <div className={`relative ${className}`}>
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
        onKeyDown={(e) => { if (e.key === "Enter" && results.length > 0) pick(results[0].name); }}
        autoFocus={autoFocus}
        placeholder="Search slates…"
        className="w-full rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-200 px-2.5 py-1.5 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
      />
      {open && results.length > 0 && (
        <div
          className="absolute z-20 mt-1 w-full min-w-[220px] rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl overflow-hidden"
          onMouseDown={() => { if (blurTimer.current) clearTimeout(blurTimer.current); }}
        >
          {results.map((s) => (
            <button
              key={s.name}
              onClick={() => pick(s.name)}
              className="w-full flex items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-zinc-800"
            >
              <span className="text-zinc-200 truncate">{s.name}</span>
              <span className="flex items-center gap-2 shrink-0 ml-3">
                {prices[s.name] == null && (
                  <span className="text-[9px] uppercase tracking-wide text-amber-400">no price</span>
                )}
                <span className="text-zinc-500 tabular-nums">{s.count}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {open && query.trim() && results.length === 0 && (
        <div className="absolute z-20 mt-1 w-full min-w-[220px] rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-500">
          No slate matches “{query.trim()}”
        </div>
      )}
    </div>
  );
}
