# Slate (Index) — the DTM4.1 addition

This repo is the **blueprint for adding the index ("slate") feature to a
DTM4.1-shaped system**. Open it next to
[`Pauv-Inc/DTM4.1`](https://github.com/Pauv-Inc/DTM4.1): everything DTM4.1
already has is reused **verbatim**, and everything the slate feature needs is
layered on top as an **addition — never a rewrite**. A developer who knows
DTM4.1 should be able to graft the feature onto it from this repo alone.

**Start with [`doc/dtm41-migration.md`](doc/dtm41-migration.md).** It maps,
table by table and route by route, what is unchanged DTM4.1 vs. what the slate
feature adds, lists the conventions that must survive, and ends with the
suggested migration order. This README is the overview; the migration doc is
the contract.

## The mental model

- **Each slate constituent IS one DTM4.1 market.** A slate of 25 people is 25
  independent DTM4.1 bonding-curve markets (each with its own config, `Q`,
  positions, txLog, and treasury) plus one thin index layer that reads their
  prices. Nothing about an individual market changes.
- **The slate is never directly tradeable.** There is no "buy the index"
  button, endpoint, or export. Money reaches the slate pool exactly one way —
  the **auto-spread** of a person order: `primaryPct` (default 95%) trades the
  person directly (a normal DTM4.1 position), and the remainder (5%) spreads
  across all members, minting **slate units** to the investor. Closing the
  direct position unwinds its slate leg with it (linked legs). Shorts mirror
  the same split with small member shorts instead of units.
- **The slate value is pure read-math** over member prices (equal weight, no
  divisor needed):

  ```
  launch:     baseline_i = current_price_i ;  slate = baseValue (creator-set)
  trading:    return_i   = current_price_i / baseline_i − 1
              slate      = anchorValue × (1 + average(return_i))
  rebalance:  re-anchor to current value, reset baselines → weights re-equalize
  add/remove: snapshot value first, change roster, re-anchor → value never jumps
  ```

  The methodology source is [`doc/index-implementation.md`](doc/index-implementation.md)
  (the PDF, Parts 1–8); `npm test` runs its worked examples.

## What is verbatim DTM4.1

- **The engine** — [`src/market/pauv-engine.ts`](src/market/pauv-engine.ts):
  softplus price/cost integral, escrow shorting, walked liquidation cascades,
  fee-excluded P&L. The math is identical function-by-function; the only
  change is that operations are **pure** — `buy(state, cfg, …) → { state, … }`
  instead of DTM4.1's localStorage singleton — so N markets can coexist. In
  prod that means: state is the market's DB rows, one transaction per op, and
  a thrown rejection persists nothing (DTM4.1's "don't save" rollback).
  `node scripts/diff-engines.mjs` re-verifies parity against a sibling
  `Desktop/dtm4.1` checkout — run it after pulling DTM4.1 updates.
- **The data shapes** — `PauvConfig`, `PauvPosition`, `PauvTxLog`,
  `PauvState`, `PositionWithMetrics`, `MarketSnapshot`,
  `ClosedPositionRecord` (`paid`/`fees`/`amountOut`, fee-excluded
  `realizedPnL`). These are the rows prod already has.
- **The route paths** — `/api/market`, `/api/market/[id]`,
  `/api/market/[id]/trade`, `/api/market/close`, `/api/portfolio/[userId]`,
  `/api/treasury` are DTM4.1's prod paths, implemented here for real against
  slate world.
- **The conventions** — P&L is fee-excluded (a no-move round trip realizes
  $0); fees are charged only on the **direct** leg of a person order
  (`DIRECT_FEE_RATE`, 1.8%, open and close) and land in that market's
  treasury, so house revenue = Σ treasuries; slate legs are always fee-free.

## What the slate feature adds

- [`src/slate/slate-engine.ts`](src/slate/slate-engine.ts) — the entire index
  layer, framework-free. This is the module you port:
  - launch / rebalance / add / remove — all **value-continuous** (the
    displayed number never jumps on a non-market event);
  - `investInPerson` / `shortPerson` / `closePersonPosition` — the 95/5
    auto-spread and its linked-leg unwind (the **only** trading entry points);
  - the ledger (units outstanding, holders, pool tokens) and linked legs;
  - read views: portfolio (DTM4.1's `{ userId, balance, positions,
    closedPositions }` contract + slate holdings), per-person closed
    positions, per-person price history, combined orders.
- **New tables** (SQL sketch in the migration doc §2): slates, constituents
  (slate↔market join + baseline price), holdings, pool tokens, linked legs,
  history, rebalance schedule.
- **New routes**: the `/api/slate/**` surface below. There is deliberately
  **no slate trade endpoint**.

## API surface

DTM4.1 paths, implemented (DTM4.1 fields first, slate additions after):

| Method & path | Purpose |
|---|---|
| `GET /api/market` | every person market: snapshot + `slateId`/`slateName` |
| `POST /api/market` | add a person market to a slate (value-continuous) |
| `GET /api/market/[id]` | snapshot + positions + closed positions + price history |
| `POST /api/market/[id]/trade` | **open with auto-spread**: `{ userId?, side: "long"\|"short", amount, primaryPct?, feeRate? }` |
| `POST /api/market/close` | close + unwind the linked slate leg: `{ marketId, positionId, feeRate? }` |
| `GET /api/portfolio/[userId]` | `{ userId, balance, positions, closedPositions }` + slate holdings & rollups |
| `GET /api/treasury` | `{ balance }` = Σ market treasuries (+ per-slate breakdown) |

Slate-only surface (all new in prod):

| Method & path | Purpose |
|---|---|
| `GET /api/slate` · `POST /api/slate` | list / create slates |
| `GET /api/slate/[id]` · `DELETE` | full snapshot / remove |
| `POST /api/slate/[id]/invest` | the 95/5 person invest `{ personId, amount, primaryPct?, investorId? }` |
| `POST /api/slate/[id]/rebalance` | re-equalize weights (PDF Part 6) |
| `POST /api/slate/[id]/constituent` · `DELETE ?cid=` | add / remove a member (PDF Part 7) |

Errors everywhere: `{ error }` with `400` (bad input), `404` (unknown
slate/market), `422` (engine rejection, e.g. underwater-liquidation guard).

```bash
ID=$(curl -s localhost:3000/api/market | python -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
curl -s -X POST localhost:3000/api/market/$ID/trade \
  -H 'content-type: application/json' \
  -d '{"userId":"alice","side":"long","amount":1000}'
curl -s localhost:3000/api/portfolio/alice
```

The routes run on an in-memory store
([`src/server/slate-server-store.ts`](src/server/slate-server-store.ts));
swap its get/put for DB calls and the engine usage is unchanged.

## Quick start

```bash
npm install
npm test       # 57 tests: engine math, PDF worked examples, linked legs, portfolio
npm run sim    # headless bot simulation, prints the slate trajectory
npm run dev    # web UI at http://localhost:3000 → redirects to /slate
```

### Headless runner

```bash
npm run sim -- --ticks 500 --bias 0.3 --days-per-tick 1 --base 1000
```

Flags: `--ticks`, `--bias -1..1`, `--mode slate|single`, `--days-per-tick`,
`--base` (the creator-set initial slate value).

## The demo app

- **`/set-slates`** — the creator sets each category slate's **initial
  value**. Trading pages stay blocked until a slate has one.
- **`/slate`** — the index tab: slate value + return since launch, the
  simulated calendar (each tick advances sim time; scheduled rebalances fire
  at their true dates — weekly on Fridays by default), value chart with
  rebalance/add/remove markers, constituents table with inline add/remove,
  and the bots sidebar.
- **`/single`** — one person: search, price panel and order log (direct
  orders vs. slate flows tagged separately), the 95/5 invest with a direct-%
  input, and your combined orders (direct leg + slate leg per position).
- **Bots** trade person orders only — never the slate — over the simulated
  calendar. The Nav fees toggle applies `DIRECT_FEE_RATE` to direct legs.
- **Roster**: constituents seed from a committed snapshot of the real Pauv
  roster ([`src/data/roster.json`](src/data/roster.json)), grouped by
  category. Re-pull with `SUPABASE_URL=… SUPABASE_ANON_KEY=… npm run
  refresh-roster` (read-only anon key; also reads `.env`).
- Each tab is its own simulation (separate localStorage state), mirroring
  DTM4.1's storage style.

## Layout

```
src/
  market/pauv-engine.ts          # DTM4.1 engine, pure port (verbatim math)
  market/pauv-engine.test.ts
  market/closed-positions.test.ts# DTM4.1 ClosedPositionRecord guarantees
  slate/slate-engine.ts          # the index layer — START HERE
  slate/slate-engine.test.ts     # PDF worked examples
  slate/linked-legs.test.ts      # auto-spread + unwind + fee conventions
  slate/portfolio.test.ts        # portfolio contract
  slate/simulation.ts            # bot logic (UI + CLI)
  slate/slate-store.ts           # localStorage + roster seeding
  server/slate-server-store.ts   # in-memory store behind the API (→ DB)
  data/roster.json               # real Pauv roster snapshot
  components/                    # Nav, SlateChart, ConstituentsTable, SimControls,
                                 # SlateSimSidebar, Person{Search,PricePanel,OrderLog},
                                 # FlowBreakdown, InfoTooltip
  app/slate/page.tsx             # Index tab
  app/single/page.tsx            # Single-person (95/5) tab
  app/set-slates/page.tsx        # creator sets initial slate values
  app/api/market/**              # DTM4.1 prod paths, implemented
  app/api/portfolio/[userId]/    #   "
  app/api/treasury/              #   "
  app/api/slate/**               # slate-only surface
scripts/run-sim.ts               # headless runner (npm run sim)
scripts/diff-engines.mjs         # engine-parity check vs ../dtm4.1
scripts/refresh-roster.ts        # re-pull roster snapshot (Supabase, read-only)
doc/index-implementation.md      # the methodology source (the PDF)
doc/dtm41-migration.md           # ← the migration contract
AGENTS.md                        # invariants for AI/code agents
```

## Notes & assumptions

- **Equal weight only**, per the brief (PDF Part 4). Weight drift between
  rebalances is shown in the constituents table; `marketCap`
  (price × max(Q, 0)) is informational.
- This is a **simulation**, not production: no auth, no real funds,
  in-memory / localStorage state. The engine and slate layer are written to
  lift straight into a real backend behind a database — that path is
  [`doc/dtm41-migration.md`](doc/dtm41-migration.md).
