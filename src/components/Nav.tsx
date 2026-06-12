"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { resetAllSims, getFeesEnabled, setFeesEnabled } from "@/slate/slate-store";
import { DIRECT_FEE_RATE } from "@/slate/slate-engine";

const TABS = [
  { href: "/set-slates", label: "Set the Slates", hint: "Set each slate's initial value (required before trading)" },
  { href: "/slate", label: "Slate", hint: "Invest in / track a whole category" },
  { href: "/single", label: "Single", hint: "Invest in one person (95/5 split)" },
];

const FEE_PCT = `${(DIRECT_FEE_RATE * 100).toFixed(1)}%`;

export default function Nav({
  onToggleBots,
  feesPaid,
}: {
  onToggleBots?: () => void;
  /** Total fees collected across all accounts on the active sim. */
  feesPaid?: number;
}) {
  const pathname = usePathname();

  // Hydration-safe read of the persisted toggle.
  const [feesOn, setFeesOn] = useState(true);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { setFeesOn(getFeesEnabled()); }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const toggleFees = () => {
    const next = !feesOn;
    setFeesOn(next);
    setFeesEnabled(next);
  };

  const doRestart = () => {
    if (!window.confirm("Restart the simulation? This clears ALL trades, positions, and history on every slate, and resets each slate to its initial value.")) return;
    resetAllSims();
    window.location.reload();
  };

  return (
    <div className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-950/60 px-4 py-2">
      <span className="text-xs font-bold text-zinc-300 mr-3">Pauv Slates</span>
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            title={t.hint}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              active
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
      <div className="ml-auto flex items-center gap-2">
        {feesPaid != null && (
          <span
            className="text-xs text-zinc-400 tabular-nums"
            title={`Total ${FEE_PCT} direct-leg fees collected across all accounts on this slate`}
          >
            Fees paid: <span className="text-amber-300">${feesPaid.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </span>
        )}
        <button
          onClick={toggleFees}
          className={`rounded-md border px-3 py-1 text-xs font-medium ${
            feesOn
              ? "bg-amber-900/40 border-amber-700 text-amber-300 hover:bg-amber-900/60"
              : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:bg-zinc-700"
          }`}
          title={`The ${FEE_PCT} fee on the direct leg of every order, charged on open AND close. Slate buys and slate legs are always fee-free.`}
        >
          Fees {FEE_PCT}: {feesOn ? "on" : "off"}
        </button>
        {onToggleBots && (
          <button
            onClick={onToggleBots}
            className="rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-200"
            title="Open the bot trading panel"
          >
            Bots
          </button>
        )}
        <button
          onClick={doRestart}
          className="rounded-md bg-red-700 hover:bg-red-600 px-3 py-1 text-xs font-medium text-white"
          title="Wipe ALL trades, positions, and history on every slate; each slate reseeds at its initial value"
        >
          Restart Sim
        </button>
      </div>
    </div>
  );
}
