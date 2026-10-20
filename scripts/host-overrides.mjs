// Hand-confirmed hosts laid over SportsAPI Pro's home/away in team-events.json.
//
// WHY. team-events.json `last` takes `homeAway` from the vendor's homeTeam
// field (normalizeEvent), and nothing downstream second-guesses it: the ESPN
// merge only touches `next`, and only for the leagues ESPN carries (the
// Pacific Nations Cup isn't one of them), and mirrorMissingResults copies the
// side it is given. For a knockout game the vendor's homeTeam is not always
// the host. The 2026 Pacific Nations Cup final (19 Sep 2026, Tokyo) reached
// both teams' records from the vendor itself, Japan "A" and Fiji "H", and sat
// that way from the first fixture listing (15:17 AEST that day) through the
// result. The feed carries no venue for the game, so there is nothing in the
// repo a rule could correct it from; a person has to say who hosted.
//
// HOW. Same key as kickoff-overrides.mjs:
//   key  "<UTC day> <VENDOR HOME>-<VENDOR AWAY>", codes as fixtures.json prints them
//   host the code of the side that actually hosted
//   — or, for a game on neutral ground —
//   neutral true
//   and on either kind, optionally:
//   venue "<ground, city>"   stage "final" (the vendor's league name says
//                             only "Knockout Stage")
// A row is matched in either orientation of the key, so it still applies
// once a writer has corrected the row (the committed file carries the
// corrected side, and the venue and stage have to reach it too) and a vendor
// that corrects itself makes the row a no-op rather than a flip back.
// Applying the table twice changes nothing (both writers run it over the
// committed file on every write). A `host` row moves `homeAway`; scores are
// already from each team's own side. A `neutral` row leaves `homeAway` as the
// vendor has it (the app's H/A badge has no third state) and adds
// `neutral: true`. `venue` and `stage` are copied onto the row; the storyline
// pack (build-storylines.mjs previousMeetings) reads all three, so a final
// on neutral ground is never told as "in Japan" and a rematch on the same
// ground can be told as one. host-overrides.test.mjs checks every row names
// one of its two sides or is marked neutral.
import { keyOf } from "./kickoff-overrides.mjs";

export const HOST_OVERRIDES = {
  // PNC final, Japan 20-15 Fiji at Prince Chichibu Memorial Stadium, Tokyo
  // (World Rugby's match report). SportsAPI Pro event 17085293 lists Fiji as
  // home. Confirmed by Nico, 20 Oct 2026.
  "2026-09-19 FIJ-JPN": { host: "JPN", venue: "Prince Chichibu Memorial Stadium, Tokyo", stage: "final" },
  // PNC final 2025, Fiji 33-27 Japan at America First Field, Salt Lake City,
  // Utah (World Rugby's match report, 21 Sep 2025). The vendor lists Japan as
  // home, and the first published storyline (20 Oct 2026) duly said Fiji won
  // "in Japan". Neither side hosted.
  "2025-09-21 JPN-FIJ": { neutral: true, venue: "America First Field, Salt Lake City", stage: "final" },
};

const flipKey = (key) => key.replace(/^(\S+) ([A-Z]{3})-([A-Z]{3})$/, "$1 $3-$2");

// One team-side row (`last` or `next`) of team `code`. Same object back when
// nothing applies.
export function overrideHost(row, code, table = HOST_OVERRIDES) {
  const key = keyOf.teamNext(code)(row);
  const o = key ? table[key] ?? table[flipKey(key)] : undefined;
  if (!o) return row;
  const extras = {};
  if (o.neutral && row.neutral !== true) extras.neutral = true;
  if (o.venue && row.venue !== o.venue) extras.venue = o.venue;
  if (o.stage && row.stage !== o.stage) extras.stage = o.stage;
  let homeAway = row.homeAway;
  if (!o.neutral) {
    const vendorHome = row.homeAway === "H" ? code : row.opponentCode;
    if (o.host !== vendorHome) homeAway = o.host === code ? "H" : "A";
  }
  if (homeAway === row.homeAway && !Object.keys(extras).length) return row;
  return { ...row, homeAway, ...extras };
}

// Every team's `last` and `next`. Pure; logs each correction it makes.
export function applyHostOverrides(teams, { table = HOST_OVERRIDES, log = console.log } = {}) {
  if (!teams) return teams;
  const out = {};
  for (const [code, t] of Object.entries(teams)) {
    if (!t) { out[code] = t; continue; }
    let changed = false;
    const fix = (rows) =>
      Array.isArray(rows)
        ? rows.map((r) => {
            const o = overrideHost(r, code, table);
            if (o !== r) {
              changed = true;
              const what = [
                o.homeAway !== r.homeAway ? o.homeAway : null,
                o.neutral && !r.neutral ? "neutral" : null,
                o.venue !== r.venue ? "venue" : null,
                o.stage !== r.stage ? o.stage : null,
              ].filter(Boolean).join(", ");
              log(`host override applied: ${code} ${keyOf.teamNext(code)(r)} → ${what}`);
            }
            return o;
          })
        : rows;
    const last = fix(t.last);
    const next = fix(t.next);
    out[code] = changed ? { ...t, last, next } : t;
  }
  return out;
}
