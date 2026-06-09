import { NextResponse } from "next/server";
import { getSim, putSim } from "@/server/basket-server-store";
import { recordTick, getConstituent } from "@/basket/basket-engine";
import { buy, sell, shortOpen, shortClose, currentPrice } from "@/market/pauv-engine";

// POST /api/basket/[id]/trade
// Body: { constituentId, side: "long"|"short", action: "open"|"close",
//         userId?, amount?, positionId? }
//
// Demonstrates the full flow: mutate ONE constituent's bonding-curve market
// with the pure engine, then record the resulting index value.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sim = getSim(id);
  if (!sim) return NextResponse.json({ error: "Basket not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const { constituentId, side, action, userId = "api-user", amount, positionId } = body;

  const c = getConstituent(sim.basket, constituentId);
  if (!c) return NextResponse.json({ error: "Constituent not found" }, { status: 404 });

  try {
    if (action === "open" && side === "long") {
      c.market = buy(c.market, c.config, userId, Number(amount)).state;
    } else if (action === "open" && side === "short") {
      c.market = shortOpen(c.market, c.config, userId, Number(amount)).state;
    } else if (action === "close" && side === "long") {
      c.market = sell(c.market, c.config, positionId).state;
    } else if (action === "close" && side === "short") {
      c.market = shortClose(c.market, c.config, positionId).state;
    } else {
      return NextResponse.json({ error: "Invalid side/action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 422 },
    );
  }

  const value = recordTick(sim.basket);
  putSim(sim);
  return NextResponse.json({
    ok: true,
    indexValue: value,
    constituent: { id: c.id, name: c.name, price: currentPrice(c.market, c.config) },
  });
}
