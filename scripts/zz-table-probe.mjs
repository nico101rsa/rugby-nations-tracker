// One-off: the real comparison, live, printing what it would raise. Files nothing.
import { readFile } from "node:fs/promises";
import { fetchComparisons, checkPublishedTables, compareTable } from "./published-tables.mjs";
import { gamesFor } from "./build-standings.mjs";
const read = (p) => readFile(p, "utf8").then(JSON.parse);
const [registry, standings, nations, fixtures, rncTries] = await Promise.all(["competitions.json", "standings.json", "nations.json", "fixtures.json", "scripts/match-tries.json"].map(read));
const today = new Date().toISOString().slice(0, 10);
const cmp = await fetchComparisons(registry, standings, today, { gamesOf: (c) => gamesFor(c, { nations, fixtures, rncTries, espnTries: {} }).games });
for (const c of cmp) console.log(c.comp.key, JSON.stringify(c.espn ? compareTable(c.entry, c.espn) : "no answer"));
console.log("PROBLEMS:", JSON.stringify(checkPublishedTables(cmp), null, 1));
// And the table as it stood this morning: Scotland back on 10.
const before = structuredClone(standings);
for (const e of before.competitions) for (const g of e.groups ?? []) for (const r of g.rows ?? []) if (e.key === "rnc-2026" && r.code === "SCO") Object.assign(r, { Pts: 10, BPtry: 2, BP: 2, TF: 17 });
const old = await fetchComparisons(registry, before, today, { gamesOf: (c) => gamesFor(c, { nations, fixtures, rncTries: { ...rncTries, 53228: { home: 3, away: 3 } }, espnTries: {} }).games, log: {} });
console.log("WITH THIS MORNING'S TABLE:", checkPublishedTables(old).map((p) => `${p.title}\n${p.detail}`).join("\n"));
