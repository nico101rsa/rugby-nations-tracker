// The full-time pulse: after a game, a fan taps one of three faces for their
// team, and the app shows how each side's fans took it ("Scotland fans: 84%
// fuming"). This file is the rules and the storage, with no Cloudflare in it,
// so `node --test` runs the lot against node:sqlite (pulse.test.mjs).
//
//   checkVote(input, now)        is this a vote we take? -> { ok, vote } | { ok:false, error }
//   init / castVote / tallies    the store, over sql(query, ...params) -> rows
//   handle(req, sql, limiter)    the two routes, as { status, body }
//
// WHAT A VOTE IS. { match, team, mood, voter }:
//   match  "<UTC day of kickoff> <HOME>-<AWAY>", e.g. "2026-11-21 ENG-NZL" —
//          the same key the kickoff overrides use, because the match is the
//          one thing every feed agrees on;
//   team   whose fan this is: one of the two codes in the key, and one of the
//          twelve nations the app lets you follow;
//   mood   up | flat | down;
//   voter  32 hex characters the phone makes up FOR THAT ONE GAME. It exists
//          so a changed mind replaces the first answer rather than counting
//          twice. It is not the install number, it is different for every
//          game, and nothing else is stored with it: no IP address, no
//          country, no time zone. The privacy policy says exactly this.
//
// WHAT THIS DOES NOT DO. It cannot tell a fan from a script. There is no
// account to check, on purpose. The guards are a window (a game takes votes
// from its kickoff day until four days after), a per-address rate limit held
// in memory only, and the app showing a side's split only once enough people
// have answered. That is the right amount for three faces on a hobby app; if
// it is ever gamed, the answer is to stop showing it, not to add sign-in.

export const TRACKED = new Set(["ARG", "AUS", "ENG", "FIJ", "FRA", "IRE", "ITA", "JPN", "NZL", "RSA", "SCO", "WAL"]);
export const MOODS = ["up", "flat", "down"];

const MATCH_RE = /^(\d{4}-\d{2}-\d{2}) ([A-Z]{3})-([A-Z]{3})$/;
const VOTER_RE = /^[a-f0-9]{32}$/;
const DAY_MS = 86_400_000;

// A game takes votes from the start of its kickoff day (UTC) for this long.
// TEMPORARY (Thu 12 Nov 2026): 9 and 9, so Nico can vote on round 4 (6-8 Nov)
// from a TestFlight build before round 5 is played. The real values are 4 and
// 6; RELEASE below holds them and pulse.test.mjs fails from Sat 14 Nov if
// they haven't been put back.
export const RELEASE = { VOTE_WINDOW_DAYS: 4, SHOWN_DAYS: 6 };
export const VOTE_WINDOW_DAYS = 9;
// What GET returns: games whose kickoff day is within this many days.
export const SHOWN_DAYS = 9;

export function parseMatch(match) {
  const m = MATCH_RE.exec(String(match ?? ""));
  if (!m) return null;
  const dayMs = Date.parse(`${m[1]}T00:00:00Z`);
  if (Number.isNaN(dayMs)) return null;
  return { day: m[1], home: m[2], away: m[3], dayMs };
}

export function checkVote(input, now = Date.now()) {
  const bad = (error) => ({ ok: false, error });
  if (!input || typeof input !== "object") return bad("not a vote");
  const parsed = parseMatch(input.match);
  if (!parsed) return bad("match");
  const { home, away, dayMs } = parsed;
  if (home === away) return bad("match");
  const team = String(input.team ?? "");
  if (team !== home && team !== away) return bad("team");
  if (!TRACKED.has(team)) return bad("team");
  if (!MOODS.includes(input.mood)) return bad("mood");
  if (!VOTER_RE.test(String(input.voter ?? ""))) return bad("voter");
  if (now < dayMs) return bad("too early");
  if (now >= dayMs + VOTE_WINDOW_DAYS * DAY_MS) return bad("closed");
  return { ok: true, vote: { match: input.match, team, mood: input.mood, voter: input.voter } };
}

// ---- the store ---------------------------------------------------------------

export function init(sql) {
  sql(`CREATE TABLE IF NOT EXISTS votes (
    match TEXT NOT NULL, voter TEXT NOT NULL, team TEXT NOT NULL, mood TEXT NOT NULL,
    PRIMARY KEY (match, voter)
  ) WITHOUT ROWID`);
}

// One row per (game, voter): voting again changes the answer, and may change
// the side (a neutral who picked the wrong team).
export function castVote(sql, { match, voter, team, mood }) {
  sql(
    `INSERT INTO votes (match, voter, team, mood) VALUES (?, ?, ?, ?)
     ON CONFLICT (match, voter) DO UPDATE SET team = excluded.team, mood = excluded.mood`,
    match, voter, team, mood,
  );
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// { "<match>": { ENG: { up, flat, down }, NZL: { … } } } for recent games.
// The key starts with the day, so "recent" is a string comparison.
export function tallies(sql, now = Date.now()) {
  const since = isoDay(now - SHOWN_DAYS * DAY_MS);
  const rows = sql(
    `SELECT match, team, mood, COUNT(*) AS n FROM votes WHERE match >= ? GROUP BY match, team, mood`,
    since,
  );
  const out = {};
  for (const r of rows) {
    const teams = (out[r.match] ??= {});
    const t = (teams[r.team] ??= { up: 0, flat: 0, down: 0 });
    t[r.mood] = Number(r.n);
  }
  return out;
}

// ---- rate limit ----------------------------------------------------------------

// Held in the object's memory and nowhere else: an address is never written
// to storage, and the map empties whenever Cloudflare recycles the object.
export const RATE = { votes: 12, perMs: 60_000 };

export function makeLimiter({ votes = RATE.votes, perMs = RATE.perMs } = {}) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    if (!key) return true;
    const recent = (hits.get(key) ?? []).filter((t) => now - t < perMs);
    if (recent.length >= votes) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < perMs)) hits.delete(k);
    return true;
  };
}

// ---- the routes ----------------------------------------------------------------

// GET  /pulse   -> every recent game's counts
// POST /pulse   -> cast or change a vote; answers with the same counts
// GET  /health  -> writes, reads and removes one row, to prove storage works
const MAX_BODY = 400;

export function handle({ method, path, body = "", ip = "", now = Date.now() }, sql, allow) {
  const counts = () => ({ status: 200, body: { asOf: new Date(now).toISOString(), matches: tallies(sql, now) } });

  if (path === "/health" && method === "GET") {
    const probe = { match: "1999-01-01 TST-TST", voter: "0".repeat(32), team: "TST", mood: "up" };
    castVote(sql, probe);
    const seen = sql(`SELECT COUNT(*) AS n FROM votes WHERE match = ?`, probe.match)[0];
    sql(`DELETE FROM votes WHERE match = ?`, probe.match);
    return { status: Number(seen?.n) === 1 ? 200 : 500, body: { ok: Number(seen?.n) === 1, storage: "sqlite" } };
  }
  if (path !== "/pulse") return { status: 404, body: { error: "not found" } };
  if (method === "GET") return counts();
  if (method !== "POST") return { status: 405, body: { error: "method" } };

  if (body.length > MAX_BODY) return { status: 413, body: { error: "too large" } };
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: "not json" } };
  }
  const checked = checkVote(input, now);
  if (!checked.ok) return { status: 400, body: { error: checked.error } };
  if (!allow(ip, now)) return { status: 429, body: { error: "slow down" } };
  castVote(sql, checked.vote);
  return counts();
}
