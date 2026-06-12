import { NextResponse } from "next/server";
import { getSim, putSim } from "@/server/slate-server-store";
import { rebalance, summarize } from "@/slate/slate-engine";

// POST /api/slate/[id]/rebalance — re-equalize weights (PDF Part 6).
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sim = getSim(id);
  if (!sim) return NextResponse.json({ error: "Slate not found" }, { status: 404 });

  rebalance(sim.slate, "api rebalance");
  putSim(sim);
  return NextResponse.json(summarize(sim.slate));
}
