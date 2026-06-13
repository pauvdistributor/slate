import { NextResponse } from "next/server";
import { findSimByConstituent, putSim } from "@/server/slate-server-store";
import {
  investInPerson,
  shortPerson,
  DIRECT_FEE_RATE,
} from "@/slate/slate-engine";

// DTM4.1 path: POST /api/market/[id]/trade — open a position on a person
// market, with the index feature's auto-spread attached: `primaryPct` (95%)
// trades the person directly, the rest flows through the slate (units for
// longs, member shorts for shorts). Closing goes through /api/market/close.
//
// Body: { userId?, side: "long"|"short", amount, primaryPct?, feeRate? }
// The direct leg pays `feeRate` (default DIRECT_FEE_RATE); slate legs are
// fee-free, same convention as the slate engine throughout.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sim = findSimByConstituent(id);
  if (!sim) return NextResponse.json({ error: "Market not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const { side, userId = "api-user", amount, primaryPct, feeRate } = body;
  if (!(Number(amount) > 0)) {
    return NextResponse.json({ error: "amount must be positive" }, { status: 400 });
  }

  const opts = {
    investorId: userId,
    primaryPct: primaryPct != null ? Number(primaryPct) : undefined,
    feeRate: feeRate != null ? Number(feeRate) : DIRECT_FEE_RATE,
  };

  try {
    if (side === "long") {
      const res = investInPerson(sim.slate, id, Number(amount), opts);
      putSim(sim);
      return NextResponse.json({
        ok: true,
        positionId: res.positionId,
        amount: res.amount,
        primaryPct: res.primaryPct,
        effectivePrimaryPct: res.effectivePrimaryPct,
        slateAmount: res.slateAmount,
        units: res.units,
        allocations: res.allocations,
        cascadeClosures: res.cascadeClosures,
        slateValue: res.slateAfter,
      });
    }
    if (side === "short") {
      const res = shortPerson(sim.slate, id, Number(amount), opts);
      putSim(sim);
      return NextResponse.json({
        ok: true,
        positionId: res.positionId,
        tokens: res.tokens,
        priceBefore: res.priceBefore,
        priceAfter: res.priceAfter,
        primaryPct: res.primaryPct,
        slateAmount: res.slateAmount,
        slateShortCount: res.slateShortCount,
        cascadeClosures: res.cascadeClosures,
        slateValue: res.slateAfter,
      });
    }
    return NextResponse.json({ error: 'side must be "long" or "short"' }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 422 },
    );
  }
}
