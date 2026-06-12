<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project map

- `src/market/pauv-engine.ts` — per-constituent softplus bonding-curve engine. **Pure** functions over an explicit `(state, cfg)` pair (DTM4.1's localStorage singleton was removed so N markets can run at once). Math is unchanged from DTM4.1; only storage/operation signatures differ.
- `src/slate/slate-engine.ts` — the index/slate layer. Equal-weight (Pauv) slates, rebaseline / rebalance / add / remove, history. This is the new code; it implements `doc/index-implementation.md` (the PDF).
- `src/slate/simulation.ts` — framework-agnostic bot logic.
- `src/slate/slate-store.ts` — browser localStorage persistence + demo seed.
- `src/server/slate-server-store.ts` — server-side in-memory store example.
- `src/app/slate/page.tsx` — the UI.
- `src/app/api/slate/**` — index-only REST surface backed by the pure engine.
- `src/app/api/market/**`, `src/app/api/portfolio/[userId]`, `src/app/api/treasury` — DTM4.1's prod route paths implemented against slate world (each constituent = one DTM4.1 market). Shapes documented in `doc/dtm41-migration.md`.
- `doc/dtm41-migration.md` — the prod migration blueprint: what's verbatim DTM4.1 vs what the index feature adds (tables, routes, conventions). Keep it in sync when shapes change.
- `scripts/run-sim.ts` — headless CLI runner (`npm run sim`).
- `scripts/diff-engines.mjs` — engine-parity checker against the sibling `Desktop/dtm4.1` repo; run after pulling DTM4.1 updates.

# Invariants worth preserving

- Engine operations are pure: they `structuredClone` the input state, mutate the clone, and return `{ state, ... }`. A thrown rejection leaves the caller's state untouched (DTM4.1's "don't save" rollback).
- Composition changes (add/remove) and rebalances must be **value-continuous** — snapshot the index value first, then re-anchor. See `reanchorTo` and the PDF Part 7 tests.
- P&L is **fee-excluded** (DTM4.1 convention): cost basis is `amountIn − fee`, closed records report `paid`/`fees`/`amountOut` separately, and a no-move round trip realizes $0.
- The slate is **never directly tradeable**: units are minted only by the auto-spread leg of a person order (`investInPerson`) and burned only by its close-unwind (`closePersonPosition`). `buySlateUnits`/`sellSlateUnits` are private; do not add an endpoint, UI, or export that trades the slate directly.
- `npm test` covers the PDF's worked examples; keep them green.
