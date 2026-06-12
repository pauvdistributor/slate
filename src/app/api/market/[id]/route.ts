import { NextResponse } from "next/server";
import { findSimByConstituent } from "@/server/slate-server-store";
import { getConstituent, personPriceHistory } from "@/slate/slate-engine";
import { getMarket, getPositions, getClosedPositions } from "@/market/pauv-engine";

// DTM4.1 path: GET /api/market/[id] — one person market in full: the
// MarketSnapshot, open positions with live value/P&L, closed positions
// (DTM4.1's ClosedPositionRecord shape), and the price series.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sim = findSimByConstituent(id);
  const c = sim ? getConstituent(sim.slate, id) : undefined;
  if (!sim || !c) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: c.id,
    name: c.name,
    createdAt: c.addedAt,
    slateId: sim.slate.id,
    slateName: sim.slate.name,
    ...getMarket(c.market, c.config), // Q, currentPrice, sentimentScore
    positions: getPositions(c.market, c.config),
    closedPositions: getClosedPositions(c.market),
    priceHistory: personPriceHistory(c),
  });
}
