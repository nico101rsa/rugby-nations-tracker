import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { checkVote, init, castVote, tallies, handle, makeLimiter, parseMatch, TRACKED, VOTE_WINDOW_DAYS, SHOWN_DAYS } from "./pulse.js";

// The Durable Object hands the rules sql(query, ...params) -> rows. Here the
// same shape over node's own SQLite, so the real queries run.
function store() {
  const db = new DatabaseSync(":memory:");
  const sql = (q, ...p) => {
    const st = db.prepare(q);
    return /^\s*select/i.test(q) ? st.all(...p) : (st.run(...p), []);
  };
  init(sql);
  return sql;
}

const MATCH = "2026-11-21 ENG-NZL";
const FT = Date.parse("2026-11-21T17:00:00Z");
const voter = (n) => n.toString(16).padStart(32, "0");
const vote = (over = {}) => ({ match: MATCH, team: "ENG", mood: "up", voter: voter(1), ...over });

test("a vote is a game, one of its two sides, a mood and a per-game number", () => {
  assert.deepEqual(checkVote(vote(), FT), { ok: true, vote: vote() });
  assert.equal(checkVote(vote({ team: "NZL", mood: "down" }), FT).ok, true);
});

test("anything else is refused, with which part was wrong", () => {
  const err = (over, now = FT) => checkVote(vote(over), now).error;
  assert.equal(err({ match: "ENG-NZL" }), "match");
  assert.equal(err({ match: "2026-13-45 ENG-NZL" }), "match");
  assert.equal(err({ match: "2026-11-21 ENG-ENG" }), "match");
  assert.equal(err({ team: "FRA" }), "team", "not one of the two sides");
  assert.equal(err({ match: "2026-11-21 ENG-CHI", team: "CHI" }), "team", "a side nobody can follow");
  assert.equal(err({ mood: "furious" }), "mood");
  assert.equal(err({ voter: "nico" }), "voter");
  assert.equal(err({ voter: voter(1).toUpperCase().replace(/0/g, "A") }), "voter");
  assert.equal(checkVote(null, FT).error, "not a vote");
  assert.equal(checkVote("up", FT).error, "not a vote");
});

test("a game takes votes from its kickoff day until the window closes", () => {
  const day = parseMatch(MATCH).dayMs;
  assert.equal(checkVote(vote(), day - 1).error, "too early");
  assert.equal(checkVote(vote(), day).ok, true);
  assert.equal(checkVote(vote(), day + VOTE_WINDOW_DAYS * 86_400_000 - 1).ok, true);
  assert.equal(checkVote(vote(), day + VOTE_WINDOW_DAYS * 86_400_000).error, "closed");
});

test("the twelve are the twelve the app lets you follow", () => {
  assert.equal(TRACKED.size, 12);
  for (const code of ["ENG", "RSA", "NZL", "FIJ", "JPN"]) assert.ok(TRACKED.has(code));
});

test("votes are counted per game, per side, per mood", () => {
  const sql = store();
  castVote(sql, vote({ voter: voter(1), mood: "up" }));
  castVote(sql, vote({ voter: voter(2), mood: "up" }));
  castVote(sql, vote({ voter: voter(3), mood: "down" }));
  castVote(sql, vote({ voter: voter(4), team: "NZL", mood: "flat" }));
  castVote(sql, { match: "2026-11-21 SCO-JPN", team: "SCO", mood: "down", voter: voter(1) });
  assert.deepEqual(tallies(sql, FT), {
    [MATCH]: { ENG: { up: 2, flat: 0, down: 1 }, NZL: { up: 0, flat: 1, down: 0 } },
    "2026-11-21 SCO-JPN": { SCO: { up: 0, flat: 0, down: 1 } },
  });
});

test("voting again changes the answer and never counts twice", () => {
  const sql = store();
  castVote(sql, vote({ mood: "up" }));
  castVote(sql, vote({ mood: "down" }));
  castVote(sql, vote({ mood: "down" }));
  assert.deepEqual(tallies(sql, FT)[MATCH], { ENG: { up: 0, flat: 0, down: 1 } });
  // …and may change the side: a neutral who tapped the wrong team.
  castVote(sql, vote({ team: "NZL", mood: "up" }));
  assert.deepEqual(tallies(sql, FT)[MATCH], { NZL: { up: 1, flat: 0, down: 0 } });
});

test("only recent games come back", () => {
  const sql = store();
  castVote(sql, vote());
  castVote(sql, { match: "2026-10-10 NZL-AUS", team: "NZL", mood: "up", voter: voter(9) });
  assert.deepEqual(Object.keys(tallies(sql, FT)), [MATCH]);
  const day = parseMatch(MATCH).dayMs;
  assert.deepEqual(Object.keys(tallies(sql, day + SHOWN_DAYS * 86_400_000)), [MATCH]);
  assert.deepEqual(Object.keys(tallies(sql, day + (SHOWN_DAYS + 1) * 86_400_000)), []);
});

test("nothing but the four fields is ever stored", () => {
  const sql = store();
  handle({ method: "POST", path: "/pulse", body: JSON.stringify({ ...vote(), ip: "1.2.3.4", country: "GB", iid: "abc" }), ip: "203.0.113.7", now: FT }, sql, makeLimiter());
  const rows = sql(`SELECT * FROM votes`);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["match", "mood", "team", "voter"]);
  assert.ok(!JSON.stringify(rows).includes("203.0.113.7"));
});

test("POST /pulse casts the vote and answers with the counts; GET reads them", () => {
  const sql = store();
  const allow = makeLimiter();
  const post = handle({ method: "POST", path: "/pulse", body: JSON.stringify(vote()), ip: "a", now: FT }, sql, allow);
  assert.equal(post.status, 200);
  assert.deepEqual(post.body.matches[MATCH].ENG, { up: 1, flat: 0, down: 0 });
  const get = handle({ method: "GET", path: "/pulse", now: FT }, sql, allow);
  assert.deepEqual(get.body.matches, post.body.matches);
  assert.equal(get.body.asOf, "2026-11-21T17:00:00.000Z");
});

test("bad requests get the right refusal and store nothing", () => {
  const sql = store();
  const allow = makeLimiter();
  const req = (over) => handle({ method: "POST", path: "/pulse", body: JSON.stringify(vote()), ip: "a", now: FT, ...over }, sql, allow);
  assert.equal(req({ body: "{not json" }).status, 400);
  assert.equal(req({ body: JSON.stringify(vote({ mood: "x" })) }).body.error, "mood");
  assert.equal(req({ body: "x".repeat(401) }).status, 413);
  assert.equal(req({ method: "DELETE" }).status, 405);
  assert.equal(req({ path: "/votes" }).status, 404);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM votes`)[0].n, 0);
});

test("one address can't stuff the box: twelve votes a minute, then 429", () => {
  const sql = store();
  const allow = makeLimiter();
  const cast = (n, ip, now = FT) => handle({ method: "POST", path: "/pulse", body: JSON.stringify(vote({ voter: voter(n) })), ip, now }, sql, allow).status;
  for (let i = 1; i <= 12; i++) assert.equal(cast(i, "a"), 200);
  assert.equal(cast(13, "a"), 429);
  assert.equal(cast(14, "b"), 200, "another address is unaffected");
  assert.equal(cast(15, "a", FT + 61_000), 200, "and the limit lifts after a minute");
  assert.equal(tallies(sql, FT)[MATCH].ENG.up, 14);
});

test("/health proves storage works and leaves nothing behind", () => {
  const sql = store();
  const res = handle({ method: "GET", path: "/health", now: FT }, sql, makeLimiter());
  assert.deepEqual([res.status, res.body.ok], [200, true]);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM votes`)[0].n, 0);
});

test("the windows are the released ones", () => {
  // Opened to nine days for one TestFlight test on Thu 12 Nov 2026, then put
  // back. The app stops asking after three days and shows for six.
  assert.deepEqual({ VOTE_WINDOW_DAYS, SHOWN_DAYS }, { VOTE_WINDOW_DAYS: 4, SHOWN_DAYS: 6 });
});
