import { NextResponse } from "next/server";
import { listBaskets, createSeeded, getDefaultSim } from "@/server/basket-server-store";
import { summarize, type WeightingMode } from "@/basket/basket-engine";

// GET /api/basket — list basket summaries (seeds a default one if empty).
export async function GET() {
  getDefaultSim();
  return NextResponse.json(listBaskets().map(summarize));
}

// POST /api/basket — create a new seeded basket.
// Body: { name?, weighting?, baseValue?, rebalanceIntervalMs? }
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const sim = createSeeded({
    name: body.name,
    weighting: body.weighting as WeightingMode | undefined,
    baseValue: body.baseValue,
    rebalanceIntervalMs: body.rebalanceIntervalMs,
  });
  return NextResponse.json(summarize(sim.basket), { status: 201 });
}
