import { NextResponse } from "next/server";
import { getSim, deleteSim } from "@/server/basket-server-store";
import { summarize, snapshotConstituents, indexValue } from "@/basket/basket-engine";

// GET /api/basket/[id] — full snapshot: summary + constituents + history.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sim = getSim(id);
  if (!sim) return NextResponse.json({ error: "Basket not found" }, { status: 404 });
  return NextResponse.json({
    summary: summarize(sim.basket),
    value: indexValue(sim.basket),
    constituents: snapshotConstituents(sim.basket),
    history: sim.basket.history,
  });
}

// DELETE /api/basket/[id] — remove a basket.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ok = deleteSim(id);
  if (!ok) return NextResponse.json({ error: "Basket not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
