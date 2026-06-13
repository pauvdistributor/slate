import { NextResponse } from "next/server";
import { findSimByConstituent, putSim } from "@/server/slate-server-store";
import { closePersonPosition, DIRECT_FEE_RATE } from "@/slate/slate-engine";

// DTM4.1 path: POST /api/market/close — close a position (sell a long /
// buy back a short) and unwind the slate leg auto-opened with it.
//
// Body: { marketId, positionId, feeRate? }
// `proceeds` = directProceeds + slateProceeds; legs that cannot close right
// now (e.g. an underwater member short) stay open and remain linked.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const { marketId, positionId, feeRate } = body;
  if (!marketId || !positionId) {
    return NextResponse.json(
      { error: "marketId and positionId are required" },
      { status: 400 },
    );
  }

  const sim = findSimByConstituent(marketId);
  if (!sim) return NextResponse.json({ error: "Market not found" }, { status: 404 });

  try {
    const res = closePersonPosition(sim.slate, marketId, positionId, {
      feeRate: feeRate != null ? Number(feeRate) : DIRECT_FEE_RATE,
    });
    putSim(sim);
    return NextResponse.json({
      ok: true,
      proceeds: res.proceeds,
      directProceeds: res.directProceeds,
      slateProceeds: res.slateProceeds,
      closedSlateLegs: res.closedSlateLegs,
      failedSlateLegs: res.failedSlateLegs,
      cascadeClosures: res.cascadeClosures,
      priceBefore: res.priceBefore,
      priceAfter: res.priceAfter,
      slateValue: res.slateAfter,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 422 },
    );
  }
}
