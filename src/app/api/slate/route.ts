import { NextResponse } from "next/server";
import { listSlates, createSeeded, getDefaultSim } from "@/server/slate-server-store";
import { summarize } from "@/slate/slate-engine";

// GET /api/slate — list slate summaries (seeds a default one if empty).
export async function GET() {
  getDefaultSim();
  return NextResponse.json(listSlates().map(summarize));
}

// POST /api/slate — create a new seeded slate for a category.
// Body: { category?, baseValue? }
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const sim = createSeeded({
    category: body.category,
    baseValue: body.baseValue,
  });
  return NextResponse.json(summarize(sim.slate), { status: 201 });
}
