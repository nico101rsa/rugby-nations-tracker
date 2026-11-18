import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { checkPing, init, notePing, onlineNow, makeCounter, handle, ONLINE_WINDOW_MS, COUNT_TTL_MS, MAX_ONLINE, PING_RATE } from "./online.js";
import { makeLimiter } from "./pulse.js";

function store() {
  const db = new DatabaseSync(":memory:");
  const sql = (q, ...p) => {
    const st = db.prepare(q);
    return /^\s*select/i.test(q) ? st.all(...p) : (st.run(...p), []);
  };
  init(sql);
  return sql;
}

const NOW = Date.parse("2026-11-22T14:30:00Z");
const MIN = 60_000;
const id = (n) => n.toString(16).padStart(32, "0");
// A counter that never remembers, so each test reads the table as it is.
const deps = () => ({ allow: makeLimiter(PING_RATE), count: makeCounter(0) });
const post = (sql, body, over = {}, d = deps()) => handle({ method: "POST", path: "/online", body: JSON.stringify(body), ip: "a", now: NOW, ...over }, sql, d);

test("a ping is a per-run number and a followed team, or no team", () => {
  assert.deepEqual(checkPing({ id: id(1), team: "ENG" }), { ok: true, ping: { id: id(1), team: "ENG" } });
  assert.deepEqual(checkPing({ id: id(1), team: null }).ping, { id: id(1), team: null });
  assert.deepEqual(checkPing({ id: id(1) }).ping, { id: id(1), team: null });
  assert.equal(checkPing({ id: "nico", team: "ENG" }).error, "id");
  assert.equal(checkPing({ id: id(1), team: "CHI" }).error, "team", "a side nobody can follow");
  assert.equal(checkPing(null).error, "not a ping");
});

test("a phone open for the hour counts once, however often it pings", () => {
  const sql = store();
  for (let m = 0; m < 60; m += 10) notePing(sql, { id: id(1), team: "ENG" }, NOW + m * MIN);
  notePing(sql, { id: id(2), team: "ENG" }, NOW);
  notePing(sql, { id: id(3), team: "NZL" }, NOW);
  notePing(sql, { id: id(4), team: null }, NOW);
  assert.deepEqual(onlineNow(sql, NOW + 50 * MIN), { total: 4, teams: { ENG: 2, NZL: 1 } });
});

test("online means the last hour, and a row is deleted once it is older", () => {
  const sql = store();
  notePing(sql, { id: id(1), team: "ENG" }, NOW);
  notePing(sql, { id: id(2), team: "RSA" }, NOW + 30 * MIN);
  assert.equal(onlineNow(sql, NOW + ONLINE_WINDOW_MS).total, 2, "exactly an hour on still counts");
  assert.deepEqual(onlineNow(sql, NOW + ONLINE_WINDOW_MS + 1), { total: 1, teams: { RSA: 1 } });
  // The next ping from anyone clears out what has aged past the hour.
  notePing(sql, { id: id(3), team: null }, NOW + ONLINE_WINDOW_MS + MIN);
  assert.deepEqual(sql(`SELECT id FROM online ORDER BY id`).map((r) => r.id), [id(2), id(3)]);
});

test("a phone that changes its team is counted under the new one", () => {
  const sql = store();
  notePing(sql, { id: id(1), team: "ENG" }, NOW);
  notePing(sql, { id: id(1), team: "FRA" }, NOW + MIN);
  assert.deepEqual(onlineNow(sql, NOW + MIN), { total: 1, teams: { FRA: 1 } });
});

test("nothing but the id, the team and the time is ever stored", () => {
  const sql = store();
  post(sql, { id: id(1), team: "ENG", ip: "1.2.3.4", country: "GB", iid: "abc" }, { ip: "203.0.113.7" });
  const rows = sql(`SELECT * FROM online`);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["id", "seen", "team"]);
  assert.ok(!JSON.stringify(rows).includes("203.0.113.7"));
});

test("POST /online notes the phone and answers with the count; GET only reads", () => {
  const sql = store();
  const res = post(sql, { id: id(1), team: "ENG" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { asOf: "2026-11-22T14:30:00.000Z", windowMinutes: 60, total: 1, teams: { ENG: 1 } });
  const get = handle({ method: "GET", path: "/online", now: NOW }, sql, deps());
  assert.deepEqual(get.body, res.body);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM online`)[0].n, 1, "reading adds nobody");
});

test("bad requests get the right refusal and store nothing", () => {
  const sql = store();
  assert.equal(post(sql, {}, { body: "{not json" }).status, 400);
  assert.equal(post(sql, { id: "x" }).body.error, "id");
  assert.equal(post(sql, {}, { body: "x".repeat(201) }).status, 413);
  assert.equal(post(sql, {}, { method: "DELETE" }).status, 405);
  assert.equal(post(sql, {}, { path: "/phones" }).status, 404);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM online`)[0].n, 0);
});

test("one address is rate-limited, loosely enough for a carrier's shared address", () => {
  const sql = store();
  const d = deps();
  for (let i = 1; i <= PING_RATE.votes; i++) assert.equal(post(sql, { id: id(i) }, {}, d).status, 200);
  assert.equal(post(sql, { id: id(999) }, {}, d).status, 429);
  assert.equal(post(sql, { id: id(999) }, { ip: "b" }, d).status, 200);
  assert.ok(PING_RATE.votes >= 60);
});

test("a flood can't fill the store: past the ceiling a new id is refused, a known one refreshes", () => {
  const sql = store();
  sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_ONLINE})
       INSERT INTO online (id, team, seen) SELECT printf('%032x', i), '', ${NOW} FROM n`);
  assert.equal(notePing(sql, { id: id(MAX_ONLINE + 1), team: null }, NOW), false);
  assert.equal(post(sql, { id: id(MAX_ONLINE + 1) }).status, 503);
  assert.equal(notePing(sql, { id: id(7), team: "ENG" }, NOW), true);
  assert.equal(onlineNow(sql, NOW).total, MAX_ONLINE);
});

test("the count is worked out at most once per interval, however many phones ask", () => {
  const sql = store();
  const count = makeCounter();
  notePing(sql, { id: id(1), team: null }, NOW);
  assert.equal(count(sql, NOW).total, 1);
  notePing(sql, { id: id(2), team: null }, NOW + 1000);
  assert.equal(count(sql, NOW + 1000).total, 1, "still the remembered count");
  assert.equal(count(sql, NOW + COUNT_TTL_MS).total, 2);
});
