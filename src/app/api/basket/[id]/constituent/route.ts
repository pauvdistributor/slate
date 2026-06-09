import { NextResponse } from "next/server";
import { getSim, putSim } from "@/server/basket-server-store";
import {
  addConstituent,
  removeConstituent,
  summarize,
  snapshotConstituents,
} from "@/basket/basket-engine";
import { buy, defaultState, defaultConfig } from "@/market/pauv-engine";

// POST /api/basket/[id]/constituent — add a constituent (PDF Part 7).
// Body: { id, name, seedUsd? }  — value is continuous across the add.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sim = getSim(id);
  if (!sim) return NextResponse.json({ error: "Basket not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  if (!body.id || !body.name) {
    return NextResponse.json({ error: "id and name are required" }, { status: 400 });
  }

  const cfg = defaultConfig({ P0: 1, b: 0.001, alpha: 100, feeRate: 0 });
  const seedUsd = Number(body.seedUsd ?? 2_000);
  const market = seedUsd > 0 ? buy(defaultState(), cfg, "seed", seedUsd).state : defaultState();

  try {
    addConstituent(sim.basket, { id: body.id, name: body.name, market, config: cfg });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
  putSim(sim);
  return NextResponse.json({ summary: summarize(sim.basket), constituents: snapshotConstituents(sim.basket) }, { status: 201 });
}

// DELETE /api/basket/[id]/constituent?cid=... — remove a constituent.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sim = getSim(id);
  if (!sim) return NextResponse.json({ error: "Basket not found" }, { status: 404 });

  const cid = new URL(request.url).searchParams.get("cid");
  if (!cid) return NextResponse.json({ error: "cid query param required" }, { status: 400 });

  try {
    removeConstituent(sim.basket, cid);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
  putSim(sim);
  return NextResponse.json({ summary: summarize(sim.basket), constituents: snapshotConstituents(sim.basket) });
}
