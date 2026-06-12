# Index Implementation (source brief)

> Transcription of the original `index implementation.pdf` that this simulation
> implements. The slate engine (`src/slate/slate-engine.ts`) and its tests
> map directly to the parts below.

## Part One
An index is a single numerical value that summarizes how a group of things is
doing (it compresses a collection of prices into one signal). The index value
itself is meaningless — "the S&P is at 5,800" is useless on its own. What
matters is how it changes over time. **Indices measure change, not absolute
value.**

## Part Two
In traditional markets price comes from bid-ask matching. On a bonding curve,
price comes from a formula taking supply as input. For a (simplified) linear
curve: `price = m × supply + b`. Supply is always knowable, price is always
knowable, liquidity is automatic. Market cap = `price × supply`; because price
itself grows with supply, market cap is ~`½ × m × supply²` — quadratic. Early
holders grow faster than late holders.

> Pauv's real curve (and this sim) uses a **softplus** bonding curve, not a pure
> line — see `src/market/pauv-engine.ts`.

## Part Three
Prices are arbitrary; returns are universal. The only fair way to compare two
constituents is by return: `return = (new_price / old_price) − 1`. Returns are
unitless and strip out the arbitrary starting price. Every serious index uses
returns under the hood. A portfolio's return is the (weighted) average of its
constituents' returns.

## Part Four — weighting
**Market-cap weighting:** bigger caps matter more.
`Index Value = Σ(price × supply) / Divisor`. Reflects real economic weight (S&P
500). Downside: a few names dominate.

**Equal weighting:** every constituent is `1/N`.
`Index Value(t) = Index Value(t−1) × [1 + (1/N) × Σ returns]`. Size is ignored.
If half go +10% and half −10%, the index doesn't budge. Harder to manipulate;
small names get real representation.

**Pauv uses equal weighting** — the mission highlights human potential, so every
person in the index is treated as equally valuable. It also keeps the math
simple given low early volume.

## Part Five — the divisor / rebaseline
A divisor keeps the index continuous across **non-market** events (people
joining/leaving, methodology changes). Pick a base value (e.g. 1000) at launch;
`Divisor = total_market_cap / 1000`. Normal trading moves market cap and thus
the index. A composition change would jump the index, so adjust:
`new_divisor = old_divisor × (new_total_mcap / old_total_mcap)` — making the
value identical the instant before and after.

On a bonding curve, supply changes from trading **are** market activity and
should move the index (do **not** adjust the divisor for them). Only adjust for:
(1) adding/removing a constituent, (2) changing weighting, (3) manual changes.

For **equal-weight** indices we don't need an explicit divisor (returns are
already normalized). Instead we **rebaseline**: snapshot the current index value
and restart returns from the constituents' current prices. Same effect.

## Part Six — rebalancing
Equal weights **drift**: if A is +50% and B is −50%, A is now twice B's size.
The fix is periodic rebalancing — reset everyone to target weights. At rebalance
take a price snapshot; each current price becomes the new baseline; next
period's returns are measured from there.

```
At rebalance:        baseline_price_i = current_price_i
Until next rebalance: return_i = (current_price_i / baseline_price_i) − 1
                     index_value = previous_index × (1 + average_return)
```

Everyone's "return clock" resets to zero simultaneously, re-equalizing weights.
Rebalancing creates predictable volume events, narrative, prevents winner
concentration, and distributes volume. **Weekly** is the sweet spot.

## Part Seven — lifecycle

**Launch (T = 0):** pick N people; pick a base value (1000); record each current
price as `baseline_price`; weight = `1/N`; index value = 1000.

**Normal trading (between rebalances):** for each person
`return = current/baseline − 1`; average across N;
`index = last_known_index × (1 + average_return)`. No divisor needed.

**Rebalance event:** snapshot the current index value (it doesn't change); set
each `baseline_price` to the current price; measure next period from the fresh
baselines.

**Composition change (add/remove):** [1] snapshot current index value;
[2] update the constituent list; [3] recompute N; [4] set the newcomer's
`baseline_price` to its current price; [5] continue from the snapshot — the
change is invisible to the index value (no jump).

## Part Eight — story
Market-cap weight: "the biggest names dominate." Equal weight: "everyone matters
equally." Frequent rebalancing: "we keep things fair and fresh." Themed indices:
"a coherent category worth tracking." For Pauv at launch: **equal weight +
weekly rebalance + small themed groups.**
