// ============================================================
// REFRESH ROSTER
// ------------------------------------------------------------
// Snapshots the real Pauv roster (people + categories + current
// prices) from the MAIN read-only Supabase project into
// src/data/roster.json. The simulation seeds its constituents
// from that file, so it runs offline and deterministically.
//
//   # one-off, passing creds inline:
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run refresh-roster
//
//   # or put them in this repo's .env (gitignored):
//   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=...
//
// Categories come from profiles.info_subcategory (e.g. "Basketball").
// Only the read-only anon key is needed; nothing here writes to Pauv.
// ============================================================

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const OUT = join(REPO, "src", "data", "roster.json");

// Load creds from process.env, falling back to a .env file in the repo root.
function loadEnv(key: string, ...alts: string[]): string {
  for (const k of [key, ...alts]) {
    if (process.env[k]) return process.env[k]!;
  }
  const envPath = join(REPO, ".env");
  if (existsSync(envPath)) {
    const txt = readFileSync(envPath, "utf8");
    for (const k of [key, ...alts]) {
      const m = txt.match(new RegExp(`^${k}=(.*)$`, "m"));
      if (m) return m[1].trim();
    }
  }
  return "";
}

const SUPABASE_URL = loadEnv("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_KEY = loadEnv("SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SECRET_KEY");

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "Missing Supabase creds. Set SUPABASE_URL and SUPABASE_ANON_KEY (or the\n" +
    "NEXT_PUBLIC_* equivalents) in the environment or this repo's .env file.",
  );
  process.exit(1);
}

function sb(path: string): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
}

interface ProfileRow {
  id: string;
  ticker: string;
  name: string;
  photo_url: string | null;
  industry: string | null;
  info_subcategory: string | null;
}
interface MarketRow {
  profile_id: string;
  latest_price_cents: number | null;
  p0: number | null;
  holders_count: number | null;
  total_volume_lifetime_cents: number | null;
  frozen: boolean | null;
}

export interface RosterPerson {
  id: string;
  ticker: string;
  name: string;
  category: string;
  priceUsd: number;
  p0Usd: number | null;
  holders: number;
  volumeUsd: number;
  frozen: boolean;
  photoUrl: string | null;
  industry: string | null;
}
export interface Roster {
  fetchedAt: string;
  source: string;
  categories: Array<{ name: string; count: number }>;
  people: RosterPerson[];
}

async function main() {
  console.log(`Fetching roster from ${new URL(SUPABASE_URL).host} …`);

  const pRes = await sb(
    "profiles?select=id,ticker,name,photo_url,industry,info_subcategory" +
    "&delisted_at=is.null&info_subcategory=not.is.null&order=name",
  );
  if (!pRes.ok) throw new Error(`profiles fetch failed: ${pRes.status} ${await pRes.text()}`);
  const profiles: ProfileRow[] = await pRes.json();

  const mRes = await sb(
    "markets?select=profile_id,latest_price_cents,p0,holders_count,total_volume_lifetime_cents,frozen",
  );
  if (!mRes.ok) throw new Error(`markets fetch failed: ${mRes.status} ${await mRes.text()}`);
  const markets: MarketRow[] = await mRes.json();
  const byProfile = new Map(markets.map((m) => [m.profile_id, m]));

  const DEFAULT_PRICE = 0.1; // floor for people with no traded price yet
  const people: RosterPerson[] = profiles
    .filter((p) => p.ticker && p.info_subcategory)
    .map((p) => {
      const m = byProfile.get(p.id);
      const cents = m?.latest_price_cents ?? null;
      const priceUsd = cents != null && cents > 0 ? cents / 100 : DEFAULT_PRICE;
      return {
        id: p.id,
        ticker: p.ticker,
        name: p.name,
        category: p.info_subcategory!,
        priceUsd,
        p0Usd: m?.p0 != null ? m.p0 / 100 : null,
        holders: m?.holders_count ?? 0,
        volumeUsd: m?.total_volume_lifetime_cents != null ? m.total_volume_lifetime_cents / 100 : 0,
        frozen: m?.frozen ?? false,
        photoUrl: p.photo_url,
        industry: p.industry,
      };
    });

  const counts = new Map<string, number>();
  for (const p of people) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const categories = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const roster: Roster = {
    fetchedAt: new Date().toISOString(),
    source: "Pauv MAIN Supabase (profiles + markets)",
    categories,
    people,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(roster, null, 2) + "\n");

  console.log(`Wrote ${people.length} people across ${categories.length} categories → ${OUT}`);
  console.log("Top categories:", categories.slice(0, 6).map((c) => `${c.name}(${c.count})`).join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
