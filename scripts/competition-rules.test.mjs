import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RULES, TOKENS, rulesFor, POOL_NAMES, RWC_R16_SLOTS, RWC_FIXED_THIRDS, RWC_KNOCKOUT,
} from "./competition-rules.mjs";
import { ESPN_CODES } from "./build-competitions.mjs";

const tables = Object.values(RULES).filter((r) => r.table !== false);

test("every tiebreak token of every prefix is in TOKENS", () => {
  for (const r of tables) {
    for (const t of r.tiebreak) assert.ok(TOKENS.includes(t), `${r.id}: unknown token ${t}`);
    for (const t of r.altTiebreak ?? []) assert.ok(TOKENS.includes(t), `${r.id}: unknown alt token ${t}`);
    for (const t of r.thirds ?? []) assert.ok(TOKENS.includes(t), `${r.id}: unknown thirds token ${t}`);
    assert.equal(r.tiebreak[0], "pts", `${r.id}: a chain starts at table points`);
  }
});

test("the unverified tiebreaks stay flagged unverified (nobody silently upgrades them)", () => {
  assert.equal(RULES.rnc.tiebreakVerified, false);
  assert.equal(RULES.trc.tiebreakVerified, false);
  assert.equal(RULES["6n"].tiebreakVerified, true);
  assert.equal(RULES.rwc.tiebreakVerified, "secondary");
});

test("the Nations Championship mirrors computeLog: Pts, W, PD, PF", () => {
  assert.deepEqual([...RULES.rnc.tiebreak], ["pts", "w", "pd", "pf"]);
  assert.deepEqual([...RULES.rnc.altTiebreak], ["pts", "pd", "tf"]);
});

test("TRC's try bonus is a differential, everyone else's is 4 tries", () => {
  assert.equal(RULES.trc.tryBonus.type, "differential");
  assert.equal(RULES.trc.tryBonus.min, 3);
  for (const id of ["6n", "rwc", "rnc"]) assert.deepEqual({ ...RULES[id].tryBonus }, { type: "tries", min: 4 });
  for (const r of tables) {
    assert.deepEqual({ ...r.losingBonus }, { within: 7 });
    assert.deepEqual([r.win, r.draw, r.loss], [4, 2, 0]);
  }
});

test("Grand Slam is 3 for the Six Nations and 0 for every other table", () => {
  assert.equal(RULES["6n"].grandSlam, 3);
  for (const r of tables) if (r.id !== "6n") assert.equal(r.grandSlam, 0, r.id);
});

test("only the World Cup restarts its chain after a split", () => {
  assert.equal(RULES.rwc.restart, true);
  for (const r of tables) if (r.id !== "rwc") assert.equal(r.restart, false, r.id);
  assert.deepEqual([...RULES.rwc.thirds], ["pts", "pd", "td"]);
  assert.equal(RULES.rwc.qualify, 2);
  assert.equal(RULES.rwc.thirdsQualify, 4);
});

test("the Six Nations chain is the official one: Pts, PD, tries, then shared", () => {
  assert.deepEqual([...RULES["6n"].tiebreak], ["pts", "pd", "tf", "shared"]);
  assert.equal(RULES["6n"].source, "https://www.sixnationsrugby.com/rules/");
});

test("RULES is frozen all the way down", () => {
  assert.ok(Object.isFrozen(RULES.rwc.tiebreak));
  assert.throws(() => { RULES["6n"].tiebreak.push("w"); });
});

test("POOL_NAMES: six disjoint pools covering exactly the 24 registry codes", () => {
  const pools = POOL_NAMES["rwc-2027"];
  assert.deepEqual(Object.keys(pools), ["A", "B", "C", "D", "E", "F"]);
  const all = Object.values(pools).flat();
  assert.equal(all.length, 24);
  assert.equal(new Set(all).size, 24, "pools are pairwise disjoint");
  assert.deepEqual([...all].sort(), Object.values(ESPN_CODES).sort());
  for (const teams of Object.values(pools)) assert.equal(teams.length, 4);
});

test("RWC_R16_SLOTS: each pool supplies one winner and one runner-up; thirds fill 2, 4, 5, 6", () => {
  assert.equal(RWC_R16_SLOTS.length, 8);
  assert.deepEqual(RWC_R16_SLOTS.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  const sides = RWC_R16_SLOTS.flatMap((s) => [s.home, s.away]);
  for (const place of [1, 2]) {
    const letters = sides.filter((x) => x.place === place).map((x) => x.pool).sort();
    assert.deepEqual(letters, ["A", "B", "C", "D", "E", "F"], `place ${place}`);
  }
  const thirdsSlots = RWC_R16_SLOTS.filter((s) => s.away.thirds).map((s) => s.n);
  assert.deepEqual(thirdsSlots, [2, 4, 5, 6]);
  assert.deepEqual(Object.keys(RWC_FIXED_THIRDS).sort(), ["A", "B", "C", "D"]);
  assert.deepEqual(Object.values(RWC_FIXED_THIRDS).sort(), [2, 4, 5, 6]);
  for (const [letter, n] of Object.entries(RWC_FIXED_THIRDS)) {
    const slot = RWC_R16_SLOTS.find((s) => s.n === n);
    assert.ok(slot.away.thirds.includes(letter), `${letter}3's fixed slot ${n} lists it`);
    // A third never meets its own pool's winner.
    assert.notEqual(slot.home.pool, letter);
  }
});

test("RWC_KNOCKOUT: QF to final, final at 20:00 Sydney time on Sat 13 Nov 2027", () => {
  assert.deepEqual(RWC_KNOCKOUT.map((s) => `${s.stage}${s.n}`), ["QF1", "QF2", "QF3", "QF4", "SF1", "SF2", "BRONZE1", "FINAL1"]);
  const final = RWC_KNOCKOUT.at(-1);
  assert.equal(final.kickoff, "2027-11-13T09:00:00Z");
  // Every R16 winner feeds exactly one quarter-final.
  const fed = RWC_KNOCKOUT.filter((s) => s.stage === "QF").flatMap((s) => [s.home.winner.n, s.away.winner.n]).sort();
  assert.deepEqual(fed, [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const s of RWC_KNOCKOUT) {
    if (s.kickoff) assert.equal(s.kickoff.slice(0, 10), s.date, `${s.stage}${s.n} kicks off on its UTC day`);
  }
});

test("rulesFor reads the key prefix", () => {
  assert.equal(rulesFor("6n-2027").id, "6n");
  assert.equal(rulesFor("rwc-2027").id, "rwc");
  assert.equal(rulesFor("rnc-2026").id, "rnc");
  assert.equal(rulesFor("pnc-2028").table, false);
  assert.equal(rulesFor("x-1"), null);
  assert.equal(rulesFor("constructor-2027"), null);
  assert.equal(rulesFor(undefined), null);
});
