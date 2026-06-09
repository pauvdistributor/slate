# Basket Index Simulation

A simulation for building **indices ("baskets")** on top of Pauv's bonding-curve
markets. It is a sibling to [`Pauv-Inc/DTM4.1`](https://github.com/Pauv-Inc/DTM4.1):
it reuses DTM4.1's softplus bonding-curve engine for each individual person, and
adds an **equal-weight index layer** on top — exactly the methodology described
in `doc/index-implementation.md`.

> **For the backend developer:** the index math lives in one pure, fully tested
> module — [`src/basket/basket-engine.ts`](src/basket/basket-engine.ts). Read
> [SPEC.md](SPEC.md) for the contract, run `npm test` to see the PDF's worked
> examples pass, and run `npm run sim` to watch an index move. The web UI and the
> REST API are two thin layers over the same engine, showing both a client-side
> (localStorage) and a server-side (in-memory → swap for a DB) integration.

## Two modes (tabs)

1. **Index** (`/basket`) — invest in / track a whole **category** (e.g.
   "Basketball" = the NBA-All-Stars analog). Equal-weight index over every member,
   with rebalancing and add/remove.
2. **Single** (`/single`) — invest in **one person** (e.g. LeBron) with a **95/5
   split**: 95% buys that person's curve, the remaining 5% is split evenly across
   *all* category members (the person included), so the person's effective share
   is a little over 95% (`95% + 5%/N`) and the whole index lifts with them.

Each tab is its **own independent simulation** (separate localStorage state), so
you can run an index experiment and a single-person experiment side by side
without one disturbing the other.

## Real Pauv roster

Constituents are seeded from a snapshot of the **real Pauv roster** in
[`src/data/roster.json`](src/data/roster.json) — people grouped by category
(`profiles.info_subcategory`) with their current prices (from `markets`). The
snapshot is committed so the sim runs offline. Re-pull fresh data with:

```bash
# creds: the MAIN read-only Supabase anon key (see .env.example)
npm run refresh-roster
```

## How it relates to DTM4.1

| | DTM4.1 | This repo |
|---|---|---|
| Unit of trading | **one** market (one person) | **N** markets, one per constituent |
| Engine storage | localStorage singleton | pure `(state, cfg)` functions — N states |
| Headline number | a single market price | an **index value** over all constituents |
| New concept | — | equal-weight returns, rebaseline, **rebalancing**, add/remove |

The bonding-curve math in [`src/market/pauv-engine.ts`](src/market/pauv-engine.ts)
is ported **verbatim** from DTM4.1 (price/cost integral, escrow shorting,
interleaved liquidation cascades). The only change is that operations are pure
and take an explicit state, so many markets can coexist.

## The index methodology (equal weight — Pauv's choice)

```
launch:     baseline_i = current_price_i ;  index = baseValue (e.g. 1000)
trading:    return_i   = current_price_i / baseline_i − 1
            index      = anchorValue × (1 + average(return_i))
rebalance:  re-anchor to the current value, reset every baseline → weights re-equalize
add/remove: snapshot value first, change the roster, re-anchor → value never jumps
```

No divisor is needed for equal weight (returns are already normalized). A
market-cap mode (with the classic `Σ(price×supply)/divisor` divisor) is included
for contrast and is selectable in the UI and CLI. See [SPEC.md](SPEC.md) and
[doc/index-implementation.md](doc/index-implementation.md).

## Quick start

```bash
npm install

npm test            # 21 tests: engine + PDF worked examples
npm run sim         # headless simulation, prints the index trajectory
npm run dev         # web UI at http://localhost:3000  → redirects to /basket
```

### Headless runner

```bash
npm run sim                                       # 200 ticks, equal weight
npm run sim -- --ticks 500 --weighting mcap --bias 0.3 --rebalance-every 50
```

Flags: `--ticks`, `--weighting equal|mcap`, `--bias -1..1`, `--rebalance-every N`.

## The web UI (`/basket`)

- Big **index value** + total return since launch.
- **Index chart** with rebalance (amber) and add/remove (blue) markers.
- **Constituents table**: price, baseline, return, weight (and market cap in
  mcap mode); remove a constituent inline; add one by name.
- **Rebalance** button (highlights when a rebalance interval is due).
- **Weighting** dropdown (reseeds the sim).
- **Bots sidebar**: Start/Stop/Step, sentiment bias, position-size range, tick
  interval, per-bot P&L. Bots trade the constituents' individual curves; each
  trade records a new index point.

State persists in `localStorage` (like DTM4.1). Reset by switching weighting or
clearing storage.

## REST API (server-side engine example)

The same pure engine, wired into Next.js route handlers with an in-memory store
([`src/server/basket-server-store.ts`](src/server/basket-server-store.ts)).
Replace the store's get/put with DB calls and the engine usage is unchanged.

| Method & path | Purpose |
|---|---|
| `GET /api/basket` | list basket summaries (seeds a demo basket if empty) |
| `POST /api/basket` | create a seeded basket `{ name?, weighting?, baseValue? }` |
| `GET /api/basket/:id` | full snapshot: summary + constituents + history |
| `DELETE /api/basket/:id` | delete a basket |
| `POST /api/basket/:id/trade` | trade one constituent `{ constituentId, side, action, amount?, positionId? }` → records an index tick |
| `POST /api/basket/:id/invest` | single-person 95/5 invest `{ personId, amount, primaryPct? }` → records a tick |
| `POST /api/basket/:id/rebalance` | re-equalize weights |
| `POST /api/basket/:id/constituent` | add `{ id, name, seedUsd? }` (value-continuous) |
| `DELETE /api/basket/:id/constituent?cid=` | remove a constituent |

Example:

```bash
BID=$(curl -s localhost:3000/api/basket | python -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
curl -s -X POST localhost:3000/api/basket/$BID/trade \
  -H 'content-type: application/json' \
  -d '{"constituentId":"ada","side":"long","action":"open","amount":5000}'
curl -s -X POST localhost:3000/api/basket/$BID/rebalance
```

## Layout

```
src/
  market/pauv-engine.ts        # per-constituent softplus curve (pure port of DTM4.1)
  market/pauv-engine.test.ts
  basket/basket-engine.ts      # the index layer + 95/5 invest  ← start here
  basket/basket-engine.test.ts # PDF worked examples + invest tests
  basket/simulation.ts         # bot logic (UI + CLI)
  basket/basket-store.ts       # localStorage + roster-based seeding
  data/roster.json             # real Pauv roster snapshot (people/categories/prices)
  server/basket-server-store.ts# server in-memory store
  components/                  # Nav, IndexChart, ConstituentsTable, BasketSimSidebar, InfoTooltip
  app/basket/page.tsx          # Index tab
  app/single/page.tsx          # Single-person (95/5) tab
  app/api/basket/**            # REST surface
scripts/run-sim.ts             # headless runner
scripts/refresh-roster.ts      # re-pull the roster snapshot from Supabase
doc/index-implementation.md    # the source brief (the PDF)
SPEC.md                        # engine contract + invariants
```

## Notes & assumptions

- **Equal weight is the default**, per Pauv's brief (Part 4). Market-cap mode is
  provided for comparison.
- Constituent "supply" for market cap is the net curve quantity `Q`, floored at
  0 (shorts can push `Q` slightly negative).
- Bots track their own cash; short escrow is funded by the curve, so a bot's cash
  only debits the stake on a short open.
- This is a **simulation**, not production: no auth, no real funds, in-memory /
  localStorage state. The engine is written to be lifted straight into a real
  backend behind a database.
