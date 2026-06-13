// Coverage guard for the launch taxonomy: every person in the roster
// snapshot maps to exactly one of the 14 launch slates. When
// `npm run refresh-roster` pulls a subcategory we haven't mapped,
// this fails and names it — add it to slates.ts.

import { describe, it, expect } from "vitest";
import { SLATE_NAMES, slateFor } from "./slates";
import rosterJson from "@/data/roster.json";

interface RawPerson {
  ticker: string;
  name: string;
  category: string;
}
const people = (rosterJson as { people: RawPerson[] }).people;

describe("launch slates", () => {
  it("has the 14 launch slates", () => {
    expect(SLATE_NAMES).toHaveLength(14);
    expect(new Set(SLATE_NAMES).size).toBe(14);
  });

  it("puts every roster person in exactly one slate", () => {
    const unmapped = people
      .filter((p) => slateFor(p.category, p.ticker) === null)
      .map((p) => `${p.name} (${p.category})`);
    expect(unmapped, `unmapped subcategories — add to slates.ts`).toEqual([]);
  });

  it("leaves no slate empty", () => {
    const counts = new Map<string, number>();
    for (const p of people) {
      const s = slateFor(p.category, p.ticker);
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const empty = SLATE_NAMES.filter((s) => !counts.has(s));
    expect(empty, "slates with no members").toEqual([]);
  });
});
