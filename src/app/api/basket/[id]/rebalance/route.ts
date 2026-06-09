import { NextResponse } from "next/server";
import { getSim, putSim } from "@/server/basket-server-store";
import { rebalance, summarize } from "@/basket/basket-engine";

// POST /api/basket/[id]/rebalance — re-equalize weights (PDF Part 6).
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sim = getSim(id);
  if (!sim) return NextResponse.json({ error: "Basket not found" }, { status: 404 });

  rebalance(sim.basket, "api rebalance");
  putSim(sim);
  return NextResponse.json(summarize(sim.basket));
}
