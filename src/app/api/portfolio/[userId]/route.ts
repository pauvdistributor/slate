import { NextResponse } from "next/server";
import { getDefaultSim, listSims } from "@/server/slate-server-store";
import { getPortfolio } from "@/slate/slate-engine";

// DTM4.1 path: GET /api/portfolio/[userId] — DTM4.1's contract
// { userId, balance, positions, closedPositions } plus the index-feature
// additions (slateHoldings, value/P&L rollups). Positions and closed
// positions span every person market; each row carries marketId/marketName.
//
// `balance` is a store concern: the sim tracks bot cash, anything else
// defaults to 0 (prod reads its accounts table here).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  getDefaultSim();
  const sims = listSims();
  const withCash = sims.find((s) => s.botCash[userId] != null);
  const balance = withCash?.botCash[userId] ?? 0;
  return NextResponse.json(
    getPortfolio(sims.map((s) => s.slate), userId, balance),
  );
}
