<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project map

- `src/market/pauv-engine.ts` — per-constituent softplus bonding-curve engine. **Pure** functions over an explicit `(state, cfg)` pair (DTM4.1's localStorage singleton was removed so N markets can run at once). Math is unchanged from DTM4.1; only storage/operation signatures differ.
- `src/basket/basket-engine.ts` — the index/basket layer. Equal-weight (Pauv) and market-cap weighting, rebaseline / rebalance / add / remove, history. This is the new code; it implements `doc/index-implementation.md` (the PDF).
- `src/basket/simulation.ts` — framework-agnostic bot logic.
- `src/basket/basket-store.ts` — browser localStorage persistence + demo seed.
- `src/server/basket-server-store.ts` — server-side in-memory store example.
- `src/app/basket/page.tsx` — the UI.
- `src/app/api/basket/**` — REST surface backed by the pure engine.
- `scripts/run-sim.ts` — headless CLI runner (`npm run sim`).

# Invariants worth preserving

- Engine operations are pure: they `structuredClone` the input state, mutate the clone, and return `{ state, ... }`. A thrown rejection leaves the caller's state untouched (DTM4.1's "don't save" rollback).
- Composition changes (add/remove) and rebalances must be **value-continuous** — snapshot the index value first, then re-anchor. See `reanchorTo` and the PDF Part 7 tests.
- `npm test` covers the PDF's worked examples; keep them green.
