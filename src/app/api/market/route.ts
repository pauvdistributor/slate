import { NextResponse } from "next/server";
import {
  getDefaultSim,
  getSim,
  listSims,
  putSim,
} from "@/server/slate-server-store";
import { addConstituent, constituentPrice } from "@/slate/slate-engine";
import { buy, defaultConfig, defaultState, getMarket } from "@/market/pauv-engine";

// DTM4.1 path: GET /api/market — list every person market.
// Each slate constituent IS one DTM4.1 market; `slateId`/`slateName` are the
// index-feature additions telling you which slate the market belongs to.
export async function GET() {
  getDefaultSim();
  const out = [];
  for (const sim of listSims()) {
    for (const c of sim.slate.constituents) {
      const snap = getMarket(c.market, c.config);
      out.push({
        id: c.id,
        name: c.name,
        createdAt: c.addedAt,
        slateId: sim.slate.id,
        slateName: sim.slate.name,
        ...snap, // Q, currentPrice, sentimentScore (DTM4.1 MarketSnapshot)
      });
    }
  }
  return NextResponse.json(out);
}

// DTM4.1 path: POST /api/market — create a person market.
// Body: { id, name, slateId?, seedUsd?, config? } — the market is added to
// `slateId` (default: the default slate), value-continuous (PDF Part 7).
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!body.id || !body.name) {
    return NextResponse.json({ error: "id and name are required" }, { status: 400 });
  }

  const sim = body.slateId ? getSim(body.slateId) : getDefaultSim();
  if (!sim) return NextResponse.json({ error: "Slate not found" }, { status: 404 });

  const cfg = defaultConfig({ P0: 1, b: 0.001, alpha: 100, feeRate: 0, ...body.config });
  const seedUsd = Number(body.seedUsd ?? 2_000);
  const market = seedUsd > 0 ? buy(defaultState(), cfg, "seed", seedUsd).state : defaultState();

  try {
    addConstituent(sim.slate, { id: body.id, name: body.name, market, config: cfg });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
  putSim(sim);

  const c = sim.slate.constituents[sim.slate.constituents.length - 1];
  return NextResponse.json(
    {
      ok: true,
      market: {
        id: c.id,
        name: c.name,
        createdAt: c.addedAt,
        slateId: sim.slate.id,
        slateName: sim.slate.name,
        currentPrice: constituentPrice(c),
      },
    },
    { status: 201 },
  );
}
