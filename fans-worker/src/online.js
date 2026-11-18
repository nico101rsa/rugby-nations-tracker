// Fans online now: how many phones have had the app open in the last hour,
// and which teams they follow. Nico, 10 Nov 2026: "show users online now";
// 18 Nov: "looks at user having the app open in the last hour".
//
// Like pulse.js this is the rules and the storage with no Cloudflare in it,
// so `node --test` runs the lot against node:sqlite (online.test.mjs).
//
//   checkPing(input)            is this a ping we take? -> { ok, ping } | { ok:false, error }
//   init / notePing / onlineNow the store, over sql(query, ...params) -> rows
//   handle(req, sql, deps)      the two routes, as { status, body }
//
// WHAT A PING IS. { id, team }:
//   id    32 hex characters the app makes up each time it starts and keeps in
//         memory only: it is never written to the phone. It exists so one
//         phone open for an hour counts once, not once per ping. It is not
//         the install number and not a pulse voter number.
//   team  the followed team's code, or null for a phone that follows none.
//
// WHAT IS KEPT. One row per id: the id, the team and when it was last seen.
// A row is deleted an hour after its last ping, so the table only ever holds
// the last hour. No address, country or install number. The privacy policy
// (privacy.html) says exactly this; change the two together.
//
// WHAT THIS DOES NOT DO. It cannot tell a phone from a script, as with the
// pulse. The guards are the per-address rate limit (memory only), the
// one-hour life of a row, and a ceiling on rows so a flood can't fill the
// store. If the number is ever gamed, stop showing it in the app.

import { TRACKED } from "./pulse.js";

const ID_RE = /^[a-f0-9]{32}$/;

// "Online now" is the last hour (Aptabase's live view uses the same).
export const ONLINE_WINDOW_MS = 3_600_000;
// The table can't hold more phones than this. A real match day is a few
// hundred; past the ceiling a new id is refused and known ids still refresh.
export const MAX_ONLINE = 20_000;
// The count is worked out at most this often: every phone pings, and each
// answer would otherwise read the whole table.
export const COUNT_TTL_MS = 20_000;
// A mobile carrier puts many phones behind one address, so this is looser
// than the pulse's twelve votes a minute.
export const PING_RATE = { votes: 60, perMs: 60_000 };

export function checkPing(input) {
  const bad = (error) => ({ ok: false, error });
  if (!input || typeof input !== "object") return bad("not a ping");
  if (!ID_RE.test(String(input.id ?? ""))) return bad("id");
  const team = input.team == null || input.team === "" ? null : String(input.team);
  if (team !== null && !TRACKED.has(team)) return bad("team");
  return { ok: true, ping: { id: input.id, team } };
}

// ---- the store ---------------------------------------------------------------

export function init(sql) {
  sql(`CREATE TABLE IF NOT EXISTS online (
    id TEXT NOT NULL PRIMARY KEY, team TEXT NOT NULL, seen INTEGER NOT NULL
  ) WITHOUT ROWID`);
}

// Rows older than the window are deleted before anything is counted or
// added, so nothing outlives its hour. True when the ping was taken.
export function notePing(sql, { id, team }, now = Date.now()) {
  sql(`DELETE FROM online WHERE seen < ?`, now - ONLINE_WINDOW_MS);
  const known = sql(`SELECT COUNT(*) AS n FROM online WHERE id = ?`, id)[0];
  if (!Number(known?.n)) {
    const rows = sql(`SELECT COUNT(*) AS n FROM online`)[0];
    if (Number(rows?.n) >= MAX_ONLINE) return false;
  }
  sql(
    `INSERT INTO online (id, team, seen) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET team = excluded.team, seen = excluded.seen`,
    id, team ?? "", now,
  );
  return true;
}

// { total, teams: { ENG: 12, … } }. `total` includes phones with no team;
// `teams` lists only teams with someone online, so it sums to total or less.
export function onlineNow(sql, now = Date.now()) {
  const rows = sql(`SELECT team, COUNT(*) AS n FROM online WHERE seen >= ? GROUP BY team`, now - ONLINE_WINDOW_MS);
  let total = 0;
  const teams = {};
  for (const r of rows) {
    const n = Number(r.n);
    total += n;
    if (r.team) teams[r.team] = n;
  }
  return { total, teams };
}

// The count, remembered for COUNT_TTL_MS. Held in the object's memory like
// the rate limiter; a recycled object simply counts again.
export function makeCounter(ttlMs = COUNT_TTL_MS) {
  let at = -Infinity;
  let value = null;
  return (sql, now = Date.now()) => {
    if (!value || now - at >= ttlMs || now < at) {
      value = onlineNow(sql, now);
      at = now;
    }
    return value;
  };
}

// ---- the routes ----------------------------------------------------------------

// POST /online  -> note this phone; answers with the count
// GET  /online  -> the count alone
const MAX_BODY = 200;

export function handle({ method, path, body = "", ip = "", now = Date.now() }, sql, { allow, count }) {
  if (path !== "/online") return { status: 404, body: { error: "not found" } };
  const answer = () => ({ status: 200, body: { asOf: new Date(now).toISOString(), windowMinutes: ONLINE_WINDOW_MS / 60_000, ...count(sql, now) } });
  if (method === "GET") return answer();
  if (method !== "POST") return { status: 405, body: { error: "method" } };

  if (body.length > MAX_BODY) return { status: 413, body: { error: "too large" } };
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: "not json" } };
  }
  const checked = checkPing(input);
  if (!checked.ok) return { status: 400, body: { error: checked.error } };
  if (!allow(ip, now)) return { status: 429, body: { error: "slow down" } };
  if (!notePing(sql, checked.ping, now)) return { status: 503, body: { error: "full" } };
  return answer();
}
