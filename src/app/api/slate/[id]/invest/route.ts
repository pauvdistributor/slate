import { NextResponse } from "next/server";
import { getSim, putSim } from "@/server/slate-server-store";
import { investInPerson, getConstituent } from "@/slate/slate-engine";

// POST /api/slate/[id]/invest
// Body: { personId, amount, primaryPct?, investorId? }
//
// Single-person investment with the 95/5 split: `primaryPct` of `amount`
// buys the chosen person, the rest is split evenly across all members
// (the person included). Records a slate tick.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sim = getSim(id);
  if (!sim) return NextResponse.json({ error: "Slate not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const { personId, amount, primaryPct = 0.95, investorId } = body;

  if (!getConstituent(sim.slate, personId)) {
    return NextResponse.json({ error: "Person not in slate" }, { status: 404 });
  }
  if (!(Number(amount) > 0)) {
    return NextResponse.json({ error: "amount must be positive" }, { status: 400 });
  }

  try {
    const res = investInPerson(sim.slate, personId, Number(amount), {
      primaryPct: Number(primaryPct),
      investorId,
    });
    putSim(sim);
    return NextResponse.json({
      personId: res.personId,
      amount: res.amount,
      primaryPct: res.primaryPct,
      effectivePrimaryPct: res.effectivePrimaryPct,
      slateBefore: res.slateBefore,
      slateAfter: res.slateAfter,
      allocations: res.allocations,
      cascadeClosures: res.cascadeClosures,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
}
