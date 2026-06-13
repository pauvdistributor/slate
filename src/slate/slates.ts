// ============================================================
// SLATES — the launch taxonomy
// ------------------------------------------------------------
// Pauv profiles carry a free-form subcategory ("Rapper", "Twitch",
// "Vice President", …). Slates are coarser: sometimes a subcategory
// IS the slate (Basketball), sometimes many subcategories roll up
// into one (Music, Influencers). Every person is in exactly ONE
// slate at launch; slates.test.ts enforces full roster coverage,
// so a refresh-roster pull that introduces a new subcategory fails
// tests until it's mapped here.
// ============================================================

/** The launch slates, in display order. */
export const SLATE_NAMES = [
  "Football (Soccer)",
  "Basketball",
  "Racing",
  "American Football",
  "Tennis",
  "Bodybuilding",
  "Martial Arts",
  "Golf",
  "Business",
  "Politics",
  "Film and TV",
  "Influencers",
  "Music",
  "Comedy",
] as const;

export type SlateName = (typeof SLATE_NAMES)[number];

// Subcategory → slate, keyed lowercase (the roster has case variants
// like "Youtuber"/"YouTuber" and "Singer-songwriter"/"Singer-Songwriter").
const SUBCATEGORY_TO_SLATE: Record<string, SlateName> = {
  // -- sports with their own slate
  soccer: "Football (Soccer)",
  basketball: "Basketball",
  "racing driver": "Racing",
  football: "American Football",
  tennis: "Tennis",
  bodybuilding: "Bodybuilding",
  golf: "Golf",

  // -- combat sports
  "mixed martial arts": "Martial Arts",
  "mixed martial artist": "Martial Arts",
  boxing: "Martial Arts",
  boxer: "Martial Arts",
  kickboxer: "Martial Arts",
  "professional wrestler": "Martial Arts",

  // -- business / founders / investors
  technology: "Business",
  entrepreneur: "Business",
  "venture capitalist": "Business",
  ai: "Business",
  author: "Business",
  philanthropist: "Business",
  goat: "Business", // Aiden C. Davenport (founder)

  // -- holders of / candidates for office
  president: "Politics",
  "vice president": "Politics",
  representative: "Politics",
  "state representative": "Politics",
  mayor: "Politics",
  "first family": "Politics",

  // -- film & television
  actress: "Film and TV",
  film: "Film and TV",
  "film and television": "Film and TV",
  "film producer": "Film and TV",
  filmmaker: "Film and TV",
  director: "Film and TV",
  television: "Film and TV",
  horror: "Film and TV",

  // -- internet / media personalities (incl. commentators and
  //    talkers — only office-holders go to Politics)
  youtuber: "Influencers",
  podcaster: "Influencers",
  podcast: "Influencers",
  gamer: "Influencers",
  gaming: "Influencers",
  twitch: "Influencers",
  "variety streamer": "Influencers",
  "live streamer": "Influencers",
  streamer: "Influencers",
  influencer: "Influencers",
  commentator: "Influencers",
  commentary: "Influencers",
  "political commentator": "Influencers",
  "content creator": "Influencers",
  "internet personality": "Influencers",
  "investigative journalist": "Influencers",
  manosphere: "Influencers",
  "radio host": "Influencers",
  "viral personality": "Influencers",
  // sports without their own slate, where the people are
  // creator-adjacent (Robby Berger, Livvy Dunne)
  sports: "Influencers",
  gymnastics: "Influencers",

  // -- music
  rapper: "Music",
  singer: "Music",
  "singer-songwriter": "Music",
  "record producer": "Music",
  rock: "Music",
  "psychedelic rock": "Music",

  // -- comedy
  comedian: "Comedy",
  "stand-up": "Comedy",
};

// Per-person exceptions where the subcategory's default slate is wrong.
const TICKER_OVERRIDES: Record<string, SlateName> = {
  mrbeast: "Influencers", // subcategory Philanthropist
  "rfk-jr": "Politics", // subcategory Influencer; cabinet member
  ramaswamy: "Politics", // subcategory Entrepreneur; candidate
  "jordan-peterson": "Influencers", // subcategory Author; media figure
};

/**
 * The one slate a person belongs to. Unknown subcategories return null —
 * the caller decides the fallback; slates.test.ts fails on any null so
 * new subcategories get mapped explicitly.
 */
export function slateFor(subcategory: string, ticker?: string): SlateName | null {
  // Object.hasOwn, not a bare lookup: a subcategory/ticker matching an
  // Object.prototype member ("constructor", "toString", …) must miss, not
  // resolve to an inherited function and slip past the coverage test.
  if (ticker && Object.hasOwn(TICKER_OVERRIDES, ticker)) return TICKER_OVERRIDES[ticker];
  const key = subcategory.trim().toLowerCase();
  return Object.hasOwn(SUBCATEGORY_TO_SLATE, key) ? SUBCATEGORY_TO_SLATE[key] : null;
}
