"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SlateChart from "@/components/SlateChart";
import Nav from "@/components/Nav";
import FlowBreakdown, { type FlowLeg } from "@/components/FlowBreakdown";
import SimControls from "@/components/SimControls";
import SlateSimSidebar from "@/components/SlateSimSidebar";
import PersonSearch from "@/components/PersonSearch";
import PersonPricePanel from "@/components/PersonPricePanel";
import {
  slateValue,
  summarize,
  snapshotConstituents,
  investInPerson,
  previewInvestment,
  holderValue,
  advanceTime,
  setSchedule,
  nextRebalanceMs,
  simDateLabel,
  getConstituent,
  personPriceHistory,
  personOrders,
  shortPerson,
  closePersonPosition,
  totalFeesPaid,
  DAY_MS,
  DIRECT_FEE_RATE,
  type Slate,
  type SlateSummary,
  type ConstituentSnapshot,
  type SlatePoint,
  type InvestResult,
  type InvestAllocation,
  type RebalanceSchedule,
  type PersonPricePoint,
  type PersonOrder,
  type CascadeClosure,
} from "@/slate/slate-engine";
import { shortViabilityCheck } from "@/market/pauv-engine";
import PersonOrderLog from "@/components/PersonOrderLog";
import {
  botTick,
  botPortfolios,
  closeAllPositions,
  closeAccountPositions,
  creditBotCascades,
  type SimState,
  type BotPortfolio,
} from "@/slate/simulation";
import {
  loadOrSeed,
  saveSim,
  resetSim,
  seedSim,
  getSlatePrice,
  getFeesEnabled,
  allPeople,
  findPerson,
  getLastViewedPerson,
  setLastViewedPerson,
  getWallet,
  adjustWallet,
  USER_ID,
  type RosterPerson,
} from "@/slate/slate-store";
import Link from "next/link";

const YOU = USER_ID;

interface View {
  /** The live slate behind this view (refreshed snapshots key off view identity). */
  slate: Slate;
  summary: SlateSummary;
  value: number;
  rows: ConstituentSnapshot[];
  history: SlatePoint[];
  portfolios: BotPortfolio[];
  schedule: RebalanceSchedule;
  dateLabel: string;
  startDateValue: string;
  nextRebalanceLabel: string;
  baseValue: number;
  yourUnitsValue: number;
  feesPaid: number;
}

function deriveView(sim: SimState): View {
  const b = sim.slate;
  return {
    slate: b,
    summary: summarize(b),
    value: slateValue(b),
    rows: snapshotConstituents(b),
    history: b.history.slice(),
    portfolios: botPortfolios(sim),
    schedule: b.schedule,
    dateLabel: simDateLabel(b.clockMs),
    startDateValue: new Date(b.startMs).toISOString().slice(0, 10),
    nextRebalanceLabel: simDateLabel(nextRebalanceMs(b)),
    baseValue: b.baseValue,
    yourUnitsValue: holderValue(b, YOU),
    feesPaid: totalFeesPaid(b),
  };
}

/** The live direct-leg fee rate, honoring the Nav toggle. */
function activeFeeRate(): number {
  return getFeesEnabled() ? DIRECT_FEE_RATE : 0;
}

function fmtUSD(n: number, d = 2): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

type TradeMsg = { kind: "ok" | "err"; text: string };

/**
 * Credit YOUR share of a trade's liquidation cascades back to the wallet
 * (bot owners are credited via creditBotCascades / inside botTick). Returns
 * a banner fragment, "" when none of your positions were hit.
 */
function settleYourCascades(cascades: CascadeClosure[] | undefined): string {
  const yours = (cascades ?? []).filter((c) => c.userId === YOU);
  if (yours.length === 0) return "";
  const proceeds = yours.reduce((s, c) => s + c.proceeds, 0);
  if (proceeds > 0) adjustWallet(proceeds);
  const legs = yours.reduce((s, c) => s + c.closedSlateLegs, 0);
  const what = yours.length === 1 ? "a short of yours" : `${yours.length} shorts of yours`;
  return ` — ${what} got liquidated; ${legs} linked slate leg${legs === 1 ? "" : "s"} auto-closed, returning ${fmtUSD(proceeds)} to your wallet`;
}

export default function SinglePage() {
  const simRef = useRef<SimState | null>(null);
  const [selected, setSelected] = useState<RosterPerson | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [amount, setAmount] = useState("1000");
  const [primary, setPrimary] = useState("95");
  // Auto-spread on/off: off trades 100% direct (no slate leg).
  const [spreadOn, setSpreadOn] = useState(true);
  const [lastResult, setLastResult] = useState<InvestResult | null>(null);
  const [tradeMsg, setTradeMsg] = useState<TradeMsg | null>(null);
  // Person whose slate has no initial value yet — trading on them is blocked.
  const [blocked, setBlocked] = useState<RosterPerson | null>(null);

  const refresh = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    saveSim(sim);
    setView(deriveView(sim));
  }, []);

  // Look up a person: load (or seed) their category's sim and focus them.
  // Blocked until their slate's initial value is set (Set the Slates page).
  const onPick = useCallback((p: RosterPerson) => {
    // Remembered even when blocked, so tab jumps restore this view.
    setLastViewedPerson(p.ticker);
    if (getSlatePrice(p.category) == null) {
      simRef.current = null;
      setSelected(null);
      setView(null);
      setBlocked(p);
      return;
    }
    setBlocked(null);
    // The person's slate sim is SHARED with the Slate tab — trades here move
    // the same world its chart shows.
    let sim = loadOrSeed(p.category);
    if (!getConstituent(sim.slate, p.ticker)) {
      // Stale sim from an older roster (the person was added after it was
      // seeded). Cash YOUR positions out first so the reseed doesn't strand
      // wallet money, then reseed so the person exists.
      const { proceeds, cascades } = closeAccountPositions(sim.slate, YOU, activeFeeRate());
      if (proceeds) adjustWallet(proceeds);
      settleYourCascades(cascades);
      resetSim(p.category);
      sim = loadOrSeed(p.category);
    }
    simRef.current = sim;
    setSelected(p);
    setLastResult(null);
    setTradeMsg(null);
    setView(deriveView(sim));
  }, []);

  // Restore the last person you were looking at when returning to this tab.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    const ticker = getLastViewedPerson();
    const p = ticker ? findPerson(ticker) : undefined;
    if (p) onPick(p);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  // Reseed the current category, preserving settings not overridden.
  const reseed = useCallback((o: {
    startMs?: number;
  } = {}) => {
    const cat = selected?.category;
    if (!cat) return;
    const b = simRef.current?.slate;
    if (simRef.current) {
      // Cash YOUR positions out first so the wipe doesn't strand wallet money.
      const { proceeds, cascades } = closeAccountPositions(simRef.current.slate, YOU, activeFeeRate());
      if (proceeds) adjustWallet(proceeds);
      settleYourCascades(cascades);
    }
    resetSim(cat);
    const sim = seedSim({
      category: cat,
      startMs: o.startMs ?? b?.startMs,
    });
    simRef.current = sim;
    saveSim(sim);
    setLastResult(null);
    setTradeMsg(null);
    setView(deriveView(sim));
  }, [selected]);

  const onSetStartDate = useCallback((ms: number) => reseed({ startMs: ms }), [reseed]);

  const onTick = useCallback(() => {
    if (!simRef.current || !selected) return;
    simRef.current.config.feeRate = activeFeeRate();
    // Bots trade only the profile currently being viewed.
    const ev = botTick(simRef.current, undefined, selected.ticker);
    // A bot trade can liquidate YOUR parent short; its slate leg auto-closes
    // and the proceeds belong in your wallet (bots are credited in botTick).
    const cascadeNote = settleYourCascades(ev.cascades);
    if (cascadeNote) setTradeMsg({ kind: "ok", text: `Bot trading${cascadeNote}` });
    refresh();
  }, [refresh, selected]);

  const onConfig = useCallback((c: { bias?: number; minTrade?: number; maxTrade?: number }) => {
    if (!simRef.current) return;
    Object.assign(simRef.current.config, c);
  }, []);

  const onCloseAll = useCallback(() => {
    if (!simRef.current) return;
    simRef.current.config.feeRate = activeFeeRate();
    // Bots only — YOUR positions stay open until you close them yourself,
    // though a buyback can liquidate one; that cascade is yours to pocket.
    const { cascades } = closeAllPositions(simRef.current);
    const cascadeNote = settleYourCascades(cascades);
    if (cascadeNote) setTradeMsg({ kind: "ok", text: `Closed all bot positions${cascadeNote}` });
    refresh();
  }, [refresh]);

  const onAdvanceDays = useCallback((n: number) => {
    if (!simRef.current) return;
    advanceTime(simRef.current.slate, n * DAY_MS);
    refresh();
  }, [refresh]);

  const onSetSchedule = useCallback((p: Partial<RebalanceSchedule>) => {
    if (!simRef.current) return;
    setSchedule(simRef.current.slate, p);
    refresh();
  }, [refresh]);

  const amt = parseFloat(amount) || 0;
  // Direct share floors at 70% (the 70/30 product rule); toggling auto-spread
  // off trades 100% direct.
  const primaryPct = spreadOn
    ? Math.min(100, Math.max(70, parseFloat(primary) || 95)) / 100
    : 1;
  const selectedId = selected?.ticker ?? "";

  // ---- trading ----

  const doLong = useCallback(() => {
    const sim = simRef.current;
    if (!sim || !selectedId || amt <= 0) return;
    if (amt > getWallet()) {
      setTradeMsg({ kind: "err", text: `Insufficient funds: ${fmtUSD(amt)} exceeds your wallet (${fmtUSD(getWallet())}).` });
      return;
    }
    try {
      const res = investInPerson(sim.slate, selectedId, amt, { primaryPct, investorId: YOU, feeRate: activeFeeRate() });
      adjustWallet(-amt);
      creditBotCascades(sim, res.cascadeClosures);
      const cascadeNote = settleYourCascades(res.cascadeClosures);
      const a = res.allocations.find((x) => x.isPrimary);
      setLastResult(res);
      setTradeMsg({
        kind: "ok",
        text: `Long ${fmtUSD(amt)} — price ${fmtUSD(a?.priceBefore ?? 0)} → ${fmtUSD(a?.priceAfter ?? 0)}${cascadeNote}`,
      });
      refresh();
    } catch (e) {
      setTradeMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    }
  }, [selectedId, amt, primaryPct, refresh]);

  const doShort = useCallback(() => {
    const sim = simRef.current;
    if (!sim || !selectedId || amt <= 0) return;
    if (amt > getWallet()) {
      setTradeMsg({ kind: "err", text: `Insufficient funds: ${fmtUSD(amt)} exceeds your wallet (${fmtUSD(getWallet())}).` });
      return;
    }
    const directStake = amt * primaryPct;
    // Same viability gate DTM4.1 runs before opening a short, applied to the
    // direct leg: blocked → refuse, limited → warn and confirm.
    const person = getConstituent(sim.slate, selectedId);
    if (person && directStake > 0) {
      const viability = shortViabilityCheck(directStake, person.market.Q, person.config);
      if (viability.zone === "blocked") {
        setTradeMsg({
          kind: "err",
          text:
            `Cannot open this short. At the current price of ${fmtUSD(viability.currentPrice)}, ` +
            `the maximum winnings possible (even pushing price to floor) is ` +
            `~${fmtUSD(viability.maxWinningsFloor)}. Your direct stake of ${fmtUSD(directStake)} exceeds this. ` +
            `Reduce stake to under ${fmtUSD(viability.maxWinningsFloor)} or wait for the price to rise.`,
        });
        return;
      }
      if (viability.zone === "limited") {
        const ok = window.confirm(
          `Limited-upside short: realistic winnings (price −50%) are ~${fmtUSD(viability.maxWinnings50pct)} ` +
          `against ~${fmtUSD(viability.lossAtLiquidation)} lost if liquidated ` +
          `(ratio ${viability.trueRatio.toFixed(1)}×). Open anyway?`,
        );
        if (!ok) return;
      }
    }
    try {
      const res = shortPerson(sim.slate, selectedId, amt, { investorId: YOU, primaryPct, feeRate: activeFeeRate() });
      adjustWallet(-amt);
      creditBotCascades(sim, res.cascadeClosures);
      const cascadeNote = settleYourCascades(res.cascadeClosures);
      setLastResult(null);
      setTradeMsg({
        kind: "ok",
        text:
          `Short ${fmtUSD(amt)} — ${fmtUSD(directStake)} direct on ${selected?.name ?? "person"}` +
          (res.slateShortCount > 0
            ? `, ${fmtUSD(res.slateAmount)} spread as shorts across ${res.slateShortCount} slate members`
            : "") +
          ` — price ${fmtUSD(res.priceBefore)} → ${fmtUSD(res.priceAfter)}${cascadeNote}`,
      });
      refresh();
    } catch (e) {
      setTradeMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    }
  }, [selectedId, selected, amt, primaryPct, refresh]);

  const doClosePosition = useCallback((positionId: string) => {
    const sim = simRef.current;
    if (!sim || !selectedId) return;
    try {
      const res = closePersonPosition(sim.slate, selectedId, positionId, { feeRate: activeFeeRate() });
      adjustWallet(res.proceeds);
      creditBotCascades(sim, res.cascadeClosures);
      const cascadeNote = settleYourCascades(res.cascadeClosures);
      const slateNote = res.closedSlateLegs > 0
        ? ` (${fmtUSD(res.directProceeds)} direct + ${fmtUSD(res.slateProceeds)} from ${res.closedSlateLegs} slate leg${res.closedSlateLegs === 1 ? "" : "s"})`
        : "";
      const failNote = res.failedSlateLegs > 0
        ? ` — ${res.failedSlateLegs} slate leg(s) could not close yet and stay open`
        : "";
      setTradeMsg({ kind: "ok", text: `Position closed — ${fmtUSD(res.proceeds)} returned${slateNote}${failNote}${cascadeNote}` });
      refresh();
    } catch (e) {
      setTradeMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    }
  }, [selectedId, refresh]);

  // ---- derived ----

  const row = view?.rows.find((r) => r.id === selectedId);

  // These key off `view` identity: every mutation goes through refresh(),
  // which derives a fresh view, so the snapshots below recompute then.
  const points = useMemo<PersonPricePoint[]>(() => {
    const b = view?.slate;
    if (!b || !selectedId) return [];
    const c = getConstituent(b, selectedId);
    return c ? personPriceHistory(c, b) : [];
  }, [view, selectedId]);

  // One entry per trade: the direct position combined with its slate leg.
  const orders = useMemo<PersonOrder[]>(() => {
    const b = view?.slate;
    if (!b || !selectedId) return [];
    return personOrders(b, selectedId, YOU);
  }, [view, selectedId]);

  const previewAllocs = useMemo<InvestAllocation[]>(() => {
    const b = view?.slate;
    if (!b || !selectedId || amt <= 0) return [];
    return previewInvestment(b, selectedId, amt, primaryPct);
  }, [view, selectedId, amt, primaryPct]);

  // ---- blank lookup screen ----

  if (!selected || !view) {
    const top20 = allPeople().slice().sort((a, b) => b.priceUsd - a.priceUsd).slice(0, 20);
    return (
      <div className="flex flex-col h-screen">
        <Nav />
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-xl mx-auto px-6 pt-28 pb-12">
            <PersonSearch onPick={onPick} autoFocus />
            {blocked ? (
              <div className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-4 mt-4 text-center">
                <div className="text-amber-300 text-sm font-semibold mb-1">Please set the initial slate price</div>
                <p className="text-xs text-zinc-400 mb-3">
                  <span className="text-zinc-200 font-medium">{blocked.name}</span> is on the{" "}
                  <span className="text-zinc-200 font-medium">{blocked.category}</span> slate, which has no
                  initial value yet. Trading is blocked until you set one.
                </p>
                <Link
                  href="/set-slates"
                  className="inline-block rounded-md bg-emerald-600 hover:bg-emerald-500 px-4 py-1.5 text-xs font-medium text-white"
                >
                  Set the Slates →
                </Link>
              </div>
            ) : (
              <p className="text-center text-xs text-zinc-600 mt-3">
                Look someone up to see their price chart and trade long or short.
              </p>
            )}

            {/* Top 20 by price */}
            <div className="mt-8">
              <h2 className="text-[10px] uppercase tracking-wide text-zinc-500 mb-2">Top 20 by price</h2>
              <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 overflow-hidden">
                {top20.map((p, i) => (
                  <button
                    key={p.id}
                    onClick={() => onPick(p)}
                    className="w-full flex items-center justify-between px-4 py-2 text-left text-sm hover:bg-zinc-800 border-b border-zinc-800/60 last:border-0"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="text-zinc-600 tabular-nums text-xs w-5 shrink-0">{i + 1}</span>
                      <span className="text-zinc-200 truncate">{p.name}</span>
                      <span className="text-[10px] uppercase tracking-wide text-zinc-500 shrink-0">{p.category}</span>
                    </span>
                    <span className="text-zinc-300 tabular-nums shrink-0 ml-3">{fmtUSD(p.priceUsd)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { summary, value, history, schedule, dateLabel, startDateValue, nextRebalanceLabel, baseValue, portfolios, yourUnitsValue, feesPaid } = view;
  const n = summary.n;
  const effectivePrimary = n > 0 ? primaryPct + (1 - primaryPct) / n : primaryPct;

  const previewLegs: FlowLeg[] = [
    { label: `Direct → ${selected.name}`, amount: amt * primaryPct, tone: "primary" },
    { label: `Slate → all ${n} members`, amount: amt * (1 - primaryPct), tone: "slate" },
  ];

  const resultLegs: FlowLeg[] = lastResult
    ? [
        { label: `Direct → ${lastResult.allocations.find((a) => a.isPrimary)?.name ?? "person"}`, amount: lastResult.amount * lastResult.primaryPct, tone: "primary" },
        { label: `Slate → all members`, amount: lastResult.slateAmount, tone: "slate" },
      ]
    : [];

  return (
    <div className="flex flex-col h-screen">
      <Nav onToggleBots={() => setSidebarOpen((v) => !v)} feesPaid={feesPaid} />
      <div className="flex flex-1 overflow-hidden">
        <SlateSimSidebar
          open={sidebarOpen}
          onToggle={() => setSidebarOpen((v) => !v)}
          portfolios={portfolios}
          onTick={onTick}
          onConfig={onConfig}
          onCloseAll={onCloseAll}
        />

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-6 py-6">
            {/* Lookup stays on top so you can jump to someone else */}
            <div className="mb-4">
              <PersonSearch onPick={onPick} />
            </div>

            {/* Price chart + long/short trading */}
            <PersonPricePanel
              name={selected.name}
              category={selected.category}
              price={row?.price ?? selected.priceUsd}
              baselinePrice={row?.baselinePrice ?? selected.priceUsd}
              points={points}
              amount={amount}
              onAmount={setAmount}
              primary={primary}
              onPrimary={setPrimary}
              spreadOn={spreadOn}
              onSpreadToggle={setSpreadOn}
              onLong={doLong}
              onShort={doShort}
              orders={orders}
              onClosePosition={doClosePosition}
              message={tradeMsg}
            />

            {/* Order log — every price-moving event, right under the chart */}
            <div className="mt-4">
              <PersonOrderLog points={points} you={YOU} />
            </div>

            {/* Money flow — everything below the chart */}
            <div className="mt-4 grid md:grid-cols-2 gap-4">
              <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-4">
                <h2 className="text-sm font-semibold text-zinc-200 mb-3">Where a Buy Long goes</h2>
                <div className="text-[11px] text-zinc-400 space-y-1">
                  <div>Direct to {selected.name}: <span className="text-emerald-300">{fmtUSD(amt * primaryPct)}</span></div>
                  <div>Into slate units: <span className="text-sky-300">{fmtUSD(amt * (1 - primaryPct))}</span></div>
                  <div>Effective share to {selected.name}: <span className="text-zinc-200 font-medium">{(effectivePrimary * 100).toFixed(2)}%</span></div>
                  <div>Your slate units value: <span className="text-zinc-200">{fmtUSD(yourUnitsValue)}</span></div>
                  <div className="text-zinc-500 pt-1">
                    Shorts split the same way: {Math.round(primaryPct * 100)}% opens an escrow-backed short on{" "}
                    {selected.name}&apos;s curve, the rest spreads as small shorts across the slate. Closing a
                    position also unwinds the slate leg it opened.
                  </div>
                </div>
              </div>
              <FlowBreakdown
                total={amt}
                legs={previewLegs}
                allocations={previewAllocs}
                title="Money flow (preview)"
              />
            </div>

            {lastResult && (
              <div className="mt-4 space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs rounded-lg border border-emerald-700/50 bg-emerald-950/20 p-3">
                  <Stat label="Slate before" value={lastResult.slateBefore.toFixed(2)} />
                  <Stat label="Slate after" value={lastResult.slateAfter.toFixed(2)} accent />
                  <Stat
                    label={`${lastResult.allocations.find((a) => a.isPrimary)?.name} price`}
                    value={`${fmtUSD(lastResult.allocations.find((a) => a.isPrimary)!.priceBefore)} → ${fmtUSD(lastResult.allocations.find((a) => a.isPrimary)!.priceAfter)}`}
                  />
                  <Stat label="Slate units bought" value={lastResult.units.toFixed(4)} />
                </div>
                <FlowBreakdown
                  total={lastResult.amount}
                  legs={resultLegs}
                  allocations={lastResult.allocations}
                  title="Money flow (executed)"
                />
              </div>
            )}

            {/* Simulation plumbing */}
            <h2 className="mt-6 mb-2 text-sm font-semibold text-zinc-200">Simulation — {summary.name} slate</h2>
            <SimControls
              dateLabel={dateLabel}
              startDateValue={startDateValue}
              nextRebalanceLabel={nextRebalanceLabel}
              schedule={schedule}
              baseValue={baseValue}
              onAdvanceDays={onAdvanceDays}
              onSetSchedule={onSetSchedule}
              onSetStartDate={onSetStartDate}
            />

            <div className="mt-2 mb-2">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">{summary.name} Slate</div>
              <div className="text-2xl font-bold text-zinc-100 tabular-nums">
                {value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <SlateChart history={history} baseValue={summary.baseValue} title={`${summary.name} — Slate Value`} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`font-semibold tabular-nums ${accent ? "text-emerald-300" : "text-zinc-200"}`}>{value}</div>
    </div>
  );
}
