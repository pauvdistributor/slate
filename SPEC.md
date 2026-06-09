# Basket / Index Engine — Spec

This is the implementation contract for `src/basket/basket-engine.ts`. It
translates `doc/index-implementation.md` (the PDF) into precise rules. Every
rule below has a test in `src/basket/basket-engine.test.ts`.

## Data model

A **constituent** is one person/asset. It owns its own bonding-curve market
(`PauvState` + `PauvConfig`) and a `baselinePrice` captured at the last
rebaseline.

A **basket** is `{ weighting, baseValue, anchorValue, divisor, constituents[],
rebalanceIntervalMs, lastRebalanceAt, history[] }`.

## Price & return

- `constituentPrice(c)` = the spot price of the constituent's curve at its
  current `Q` (softplus). PDF Part 2.
- `constituentReturn(c)` = `price / baselinePrice − 1`. PDF Part 3.
- `constituentSupply(c)` = `max(0, Q)`; `marketCap = price × supply`. PDF Part 2.

## Index value

```
equal:  indexValue = anchorValue × (1 + (1/N) Σ return_i)      // PDF Parts 4,7
mcap:   indexValue = Σ(price_i × supply_i) / divisor           // PDF Parts 4,5
```

`anchorValue` is the index value at the last rebaseline; `divisor` is set so the
mcap formula yields the anchored value.

## Lifecycle operations

| Operation | Rule | PDF |
|---|---|---|
| `createBasket` | record each launch price as baseline; equal: `anchorValue = baseValue`; mcap: `divisor = ΣmarketCap / baseValue`; value == `baseValue`. | Part 7 launch |
| `recordTick` | append the current index value to `history`. Pure trades move the value; no re-anchoring. | Part 7 normal trading |
| `rebalance` | re-anchor to the **current** value; reset every baseline to current price. Value is unchanged at the instant of rebalance; return clocks reset to 0 → weights re-equalize. | Part 6 |
| `addConstituent` | **snapshot value first**, append the newcomer (baseline = its current price), then re-anchor to the snapshot. Value continuous (no jump). | Part 7 composition change |
| `removeConstituent` | **snapshot value first**, drop the member, then re-anchor to the snapshot. Value continuous. | Part 7 composition change |

The shared mechanism is `reanchorTo(basket, v)`: set `anchorValue = v` (equal) or
`divisor = ΣmarketCap / v` (mcap), and reset all baselines to current prices.
**For composition changes `v` must be captured before the set is mutated.**

## Invariants (tested)

1. Equal-weight launch with all-equal inputs == `baseValue`.
2. Half +x% / half −x% leaves an equal-weight index unchanged.
3. Equal-weight index == `baseValue × (1 + average return)`.
4. Rebalance is value-continuous and resets returns to 0; post-rebalance
   realized weights are all `1/N`.
5. Add/remove are value-continuous (no jump); only later trades move the value.
6. mcap divisor: launch == `baseValue`; composition change scales the divisor by
   `newTotal / oldTotal`; larger names move the index more.

## Out of scope (left for the backend dev)

- Persistence beyond localStorage / in-memory (swap in a DB behind the same pure
  engine calls — see `src/server/basket-server-store.ts`).
- Authentication, real users/wallets, fees routing.
- Scheduling real wall-clock weekly rebalances (the sim uses
  `rebalanceIntervalMs` + `isRebalanceDue`; wire to a cron/queue in prod).
- Corporate-action analogues beyond add/remove.
