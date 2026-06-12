import { NextResponse } from "next/server";
import { getDefaultSim, listSims } from "@/server/slate-server-store";
import { totalFeesPaid } from "@/slate/slate-engine";

// DTM4.1 path: GET /api/treasury — { balance } is DTM4.1's contract: the
// fees collected by the house. Direct legs pay fees into their market's
// treasury, so the total is the sum over every constituent market;
// `bySlate` is the index-feature breakdown.
export async function GET() {
  getDefaultSim();
  const bySlate = listSims().map((s) => ({
    slateId: s.slate.id,
    slateName: s.slate.name,
    balance: totalFeesPaid(s.slate),
  }));
  const balance = bySlate.reduce((sum, s) => sum + s.balance, 0);
  return NextResponse.json({ balance, bySlate });
}

// DTM4.1 path: PUT /api/treasury — same { balance } shape. In the sim,
// treasuries accrue inside each market's state and are not directly
// settable; prod's PUT (withdraw/adjust) belongs to its accounts system.
export async function PUT() {
  getDefaultSim();
  const balance = listSims().reduce((sum, s) => sum + totalFeesPaid(s.slate), 0);
  return NextResponse.json({ balance });
}
