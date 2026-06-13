# Migrating the index (slate) feature onto DTM4.1 / prod

This repo is the blueprint for adding the index feature to pauv.com, whose
database and engine are modeled on the DTM4.1 repo. Everything below is
organized as **"unchanged from DTM4.1"** vs **"what the index feature adds"**,
so prod migrates by extension, never by rewrite.

Reference: the DTM4.1 repo at commit `89fc944` ("Fee-excluded Paid + Fees
column on position tables"). Two DTM4.1 commits are prerequisites — prod must
already include them before layering the index on top:

- `d8845c0` — walked liquidation + cascade-aware analysis (the `walk`-based
  buy/shortClose and `computeAllLiveTripQs`).
- `89fc944` — fee-excluded P&L: a long's cost basis is `amountIn − fee`, and
  the closed-position record gained `paid`/`fees` (replacing `amountIn`).

## 1. Engine layer — identical math, explicit state

`src/market/pauv-engine.ts` here is the same engine as DTM4.1's, verified
function-by-function (`node scripts/diff-engines.mjs` re-checks parity any
time DTM4.1 updates). All math — `price`, `costIntegral`, `solveQ2ForCost`,
`solveTripPoint`, `effectiveThreshold`, `computeAllLiveTripQs`, `liveTripQ`,
`executeLiquidation`, `walk`, `shortViabilityCheck` — is verbatim.

The one structural change: DTM4.1 stores ONE market in localStorage and its
ops read it implicitly; here every op is a pure function over an explicit
`(state, cfg)` pair so N person-markets can run at once. For prod that means:
**state is the market's DB rows, and each op is one transaction** — load
state, run the pure op, persist the returned state; a thrown rejection
persists nothing (DTM4.1's "don't save" rollback).

| DTM4.1 (singleton)            | This repo (pure)                                  |
| ----------------------------- | ------------------------------------------------- |
| `initEngine(cfg?)`            | `defaultConfig(overrides?)` + `defaultState()`    |
| `getConfig()` / `setConfig()` | config travels with the constituent               |
| `getMarket()`                 | `getMarket(state, cfg)`                           |
| `getPositions(userId?)`       | `getPositions(state, cfg, userId?)`               |
| `getTransactionLog(...)`      | `getTransactionLog(state, userId?, limit?)`       |
| `buy(userId, usd)`            | `buy(state, cfg, userId, usd) → { state, ... }`   |
| `sell(posId, tokens?)`        | `sell(state, cfg, posId, tokens?)`                |
| `shortOpen(userId, usd)`      | `shortOpen(state, cfg, userId, usd)`              |
| `shortClose(posId, tokens?)`  | `shortClose(state, cfg, posId, tokens?)`          |
| `resetEngine()`               | build a fresh `defaultState()`                    |

New engine primitives the index feature needs (no DTM4.1 counterpart):

- `buyValue(state, cfg, usd, actor)` — fee-free, **positionless** buy: pushes
  cash into the curve and returns tokens without creating a `PauvPosition`.
  Used by the slate pool; logs a normal `buy` tx row under userId
  `"slate-pool"`.
- `sellTokens(state, cfg, tokens, actor)` — the positionless inverse.
- `getClosedPositions(state, userId?)` — DTM4.1's closed-positions table as
  an engine view (see §2).

## 2. Data shapes (the DB tables)

### Unchanged from DTM4.1 — these rows migrate as-is

- `PauvConfig` — P0, b, alpha, feeRate, liquidationThreshold.
- `PauvPosition` — id, userId, type, tokens, escrow?, openCost?, openQ,
  openPrice, openedAt.
- `PauvTxLog` — id, type, positionId, userId, amountIn, amountOut, tokens,
  fee, qBefore, qAfter, priceBefore, priceAfter, timestamp.
- `PauvState` — Q, positions, treasury.balance, txLog. One per market.
- `PositionWithMetrics` — + currentValue, pnl, escrowUtilization?.
- `MarketSnapshot` — Q, currentPrice, sentimentScore.
- `ClosedPositionRecord` — id, type, userId, tokens, **paid**, **fees**,
  amountOut, realizedPnL, openPrice, closePrice, closedAt, wasLiquidated.
  DTM4.1 derives this in the page; here it is `getClosedPositions(state)`
  with the **identical** derivation (pair open/close tx rows per positionId,
  keep pairs whose position is gone, newest first) and the same fee-excluded
  convention: `paid = open.amountIn − open.fee` (net into the curve),
  `amountOut = close.amountOut + close.fee` (gross out of the curve),
  `realizedPnL = amountOut − paid`. Fees never contaminate P&L; they are
  their own column. If prod stores closed positions as a table instead of
  deriving them, the column set is exactly this interface.

The only multiplicity change: prod's market tables gain one market **per
slate constituent** (each person IS a DTM4.1 market — own config, own Q, own
positions, own txLog, own treasury).

### New — the index feature's tables (all in `src/slate/slate-engine.ts`)

- `Slate` — id, name, baseValue, anchorValue, schedule, clockMs, startMs,
  ledger, linkedLegs, history, seq, createdAt.
- `Constituent` — the slate↔market join: constituent id (= market id), name,
  `baselinePrice` (price at last rebaseline), addedAt. In SQL terms:
  `slate_constituents(slate_id, market_id, baseline_price, added_at)`.
- `SlateLedger` — the vehicle (ETF): `unitsOutstanding`, `holders`
  (`slate_holdings(slate_id, user_id, units)`), `poolTokens`
  (`slate_pool_tokens(slate_id, market_id, tokens)`). The slate is **not
  directly tradeable**: units are minted only by the auto-spread leg of a
  person order and burned only by that order's close-unwind.
- `LinkedSlateLeg` — `linkedLegs[directPositionId] = { units?, cost? } |
  { shorts: [{constituentId, positionId}] }`: which slate leg a direct order
  auto-opened, so closing the parent unwinds it. In SQL terms a
  `parent_position_id` on the leg rows (longs' unit legs:
  `slate_linked_units(position_id, units, cost)`).
- `SlatePoint` — the slate value series: seq, t, value, event
  (launch/trade/rebalance/add/remove), note, n.
- `RebalanceSchedule` — frequency (daily/weekly/monthly), weekday,
  dayOfMonth, lastRebalanceMs.

### Derived views (no storage; compute from the rows above)

- `PersonPricePoint` / `personPriceHistory(c)` — per-person price series
  straight off the txLog; pool legs tagged `source: "slate"`.
- `PersonOrder` / `personOrders(...)` — a direct position + its slate leg,
  combined cost/value/P&L (the "your positions" UI).
- `Portfolio` / `getPortfolio(slates, userId, balance)` — DTM4.1's portfolio
  contract `{ userId, balance, positions, closedPositions }` first, then the
  additions: `slateHoldings`, `positionValue`, `unrealizedPnL`,
  `realizedPnL`, `openPositions`. Every position/closed row carries additive
  `marketId`, `marketName`, `slateId`, and (slate legs only) `slateLegOf` →
  the parent direct-position id.

## 3. API surface

DTM4.1's routes are stubs — the **paths and response skeletons** are the prod
contract. This repo implements every one of them against slate world, keeping
DTM4.1's fields first and adding index fields after:

| DTM4.1 path (stub)          | Implemented here as                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /api/market`           | every person market: `{ id, name, createdAt, Q, currentPrice, sentimentScore }` + `slateId`, `slateName`        |
| `POST /api/market`          | add a person market to a slate (value-continuous, PDF Part 7): body `{ id, name, slateId?, seedUsd?, config? }` |
| `GET /api/market/[id]`      | snapshot + `positions` + `closedPositions` + `priceHistory`                                                     |
| `POST /api/market/[id]/trade` | open with auto-spread: body `{ userId?, side, amount, primaryPct?, feeRate? }`; long → `investInPerson`, short → `shortPerson`; response carries `cascadeClosures` (§4.5) |
| `POST /api/market/close`    | body `{ marketId, positionId, feeRate? }` → `closePersonPosition` (unwinds the linked slate leg too); response carries `cascadeClosures` (§4.5) |
| `GET /api/portfolio/[userId]` | `{ userId, balance, positions, closedPositions }` + the §2 additions                                          |
| `GET/PUT /api/treasury`     | `{ balance }` = Σ market treasuries (fees only land there) + additive `bySlate`                                 |

Index-only surface (all new in prod):

- `GET/POST /api/slate` — list / create slates.
- `GET/DELETE /api/slate/[id]` — summary + constituents + history / remove.
- `POST /api/slate/[id]/invest` — the 95/5 person invest (response carries
  `cascadeClosures`, §4.5).
- `POST /api/slate/[id]/rebalance` — re-equalize (PDF Part 6).
- `POST/DELETE /api/slate/[id]/constituent` — composition changes (Part 7).

There is deliberately **no slate trade endpoint**. Every order goes through
the auto-spread person routes (`/api/market/[id]/trade`, `/api/market/close`,
`/api/slate/[id]/invest`); nothing can buy or sell slate units directly.

Error convention everywhere: `{ error }` with 400 (bad input), 404 (unknown
slate/market/person), 422 (engine rejection, e.g. `UnderwaterRejection`).

## 4. Conventions that must survive the migration

1. **Fee-excluded P&L** (DTM4.1 `89fc944`): cost basis is net-of-fee, fees
   are reported separately, a no-move round trip realizes $0.
2. **Fees on direct legs only**: `DIRECT_FEE_RATE` (0.018) on a person
   order's direct leg, open and close; slate-pool flows and auto-spread legs
   are always fee-free. Fees are the only thing that lands in a treasury, so
   house revenue = Σ treasuries (`totalFeesPaid`).
3. **Value continuity**: rebalance / add / remove snapshot the slate value
   first, then re-anchor (`reanchorTo`) — composition events never move the
   displayed number.
4. **Rollback by not persisting**: engine ops clone, mutate, return; a throw
   leaves the caller's state untouched. Multi-leg ops (`shortPerson`)
   compute every leg against pending states and commit only if all succeed —
   in prod, one DB transaction.
5. **Linked legs**: closing a direct position must unwind its slate leg
   (units sold back / member shorts bought back); legs that cannot close stay
   linked for a later retry (`failedSlateLegs`). **Liquidation cascades the
   same way**: a liquidation deletes the parent inside the market walk, so
   every engine trade op sweeps `linkedLegs` for parents that died by
   liquidation and auto-unwinds their slate legs (`sweepLiquidatedParents`).
   The proceeds are reported as `cascadeClosures:
   [{ parentPositionId, personId, userId, proceeds, closedSlateLegs,
   failedSlateLegs }]` on every trade/close result and route response — the
   caller must credit each `userId`'s balance, since the liquidated owner is
   usually not the account that placed the triggering trade.
6. **`"slate-pool"` sentinel**: pool flows log under this userId, which is
   how per-person history distinguishes `order` from `slate` flow — never
   assign it to a real account.
7. **The slate itself is never directly tradeable.** Units exist only as the
   auto-spread side of person orders: minted by `investInPerson`'s slate leg,
   burned by `closePersonPosition`'s unwind. The pool ops
   (`buySlateUnits`/`sellSlateUnits`) are private engine internals — expose
   no endpoint, UI, or export that mints or burns units any other way.

## 5. Suggested migration order

1. Land the two DTM4.1 engine commits in prod if not already there
   (`d8845c0`, `89fc944`); re-run `scripts/diff-engines.mjs` against prod's
   engine copy.
2. Add the §2 index tables (slates, constituents, holdings, pool tokens,
   linked legs, history, schedule).
3. Wrap prod's engine ops in the explicit-state form (transaction per op).
4. Port `slate-engine.ts` verbatim — it only talks to the pure engine.
5. Implement the §3 routes; the DTM4.1 paths replace their stubs.
6. Port the test suites (`slate-engine.test.ts`, `linked-legs.test.ts`,
   `closed-positions.test.ts`, `portfolio.test.ts`) — they encode the PDF's
   worked examples and the DTM4.1 record-shape guarantees.
