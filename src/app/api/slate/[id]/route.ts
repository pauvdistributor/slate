import { NextResponse } from "next/server";
import { getSim, deleteSim } from "@/server/slate-server-store";
import { summarize, snapshotConstituents, slateValue } from "@/slate/slate-engine";

// GET /api/slate/[id] — full snapshot: summary + constituents + history.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sim = getSim(id);
  if (!sim) return NextResponse.json({ error: "Slate not found" }, { status: 404 });
  return NextResponse.json({
    summary: summarize(sim.slate),
    value: slateValue(sim.slate),
    constituents: snapshotConstituents(sim.slate),
    history: sim.slate.history,
  });
}

// DELETE /api/slate/[id] — remove a slate.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ok = deleteSim(id);
  if (!ok) return NextResponse.json({ error: "Slate not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
