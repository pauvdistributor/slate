"use client";

import { useState, useRef, useEffect, useCallback } from "react";

export default function InfoTooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const popupRef = useRef<HTMLSpanElement>(null);

  const reposition = useCallback(() => {
    const popup = popupRef.current;
    if (!popup) return;
    popup.style.left = "auto";
    popup.style.right = "0";
    const rect = popup.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      popup.style.left = "auto";
      popup.style.right = "0";
    }
    if (rect.left < 8) {
      popup.style.right = "auto";
      popup.style.left = "0";
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(reposition);
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, reposition]);

  return (
    <span ref={ref} className="relative inline-flex items-center ml-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-zinc-600 text-zinc-500 hover:text-zinc-300 hover:border-zinc-400 transition-colors text-[10px] leading-none cursor-pointer"
        aria-label="More info"
      >
        i
      </button>
      {open && (
        <span
          ref={popupRef}
          className="absolute top-6 right-0 z-50 w-64 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl p-3 text-xs text-zinc-300 leading-relaxed block"
        >
          {text}
        </span>
      )}
    </span>
  );
}
