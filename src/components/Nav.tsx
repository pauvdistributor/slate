"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/basket", label: "Index", hint: "Invest in / track a whole category" },
  { href: "/single", label: "Single", hint: "Invest in one person (95/5 split)" },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-950/60 px-4 py-2">
      <span className="text-xs font-bold text-zinc-300 mr-3">Pauv Baskets</span>
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
    </div>
  );
}
