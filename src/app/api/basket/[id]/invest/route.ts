import { NextResponse } from "next/server";
import { getSim, putSim } from "@/server/basket-server-store";
import { investInPerson, getConstituent } from "@/basket/basket-engine";

// POST /api/basket/[id]/invest
// Body: { personId, amount, primaryPct?, investorId? }
//
// Single-person investment with the 95/5 split: `primaryPct` of `amount`
// buys the chosen person, the rest is split evenly across all members
// (the person included). Records an index tick.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sim = getSim(id);
  if (!sim) return NextResponse.json({ error: "Basket not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const { personId, amount, primaryPct = 0.95, investorId } = body;

  if (!getConstituent(sim.basket, personId)) {
    return NextResponse.json({ error: "Person not in basket" }, { status: 404 });
  }
  if (!(Number(amount) > 0)) {
    return NextResponse.json({ error: "amount must be positive" }, { status: 400 });
  }

  try {
    const res = investInPerson(sim.basket, personId, Number(amount), {
      primaryPct: Number(primaryPct),
      investorId,
    });
    putSim(sim);
    return NextResponse.json({
      personId: res.personId,
      amount: res.amount,
      primaryPct: res.primaryPct,
      effectivePrimaryPct: res.effectivePrimaryPct,
      indexBefore: res.indexBefore,
      indexAfter: res.indexAfter,
      allocations: res.allocations,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
}
