// Daily integrity check on what the app is being shown (Nico's ask, 2026-07-25).
//
// The prompt for this was a real defect he caught by opening TestFlight: the
// Six Nations 2026 finished on 14 March and was STILL being offered in the
// competition dropdown in late July — four months stale, opening to a line-up
// with no table behind it. Nothing anywhere would ever have noticed. He asked
// for the class to be caught, not just the instance:
//
//   "think how this error pattern will be caught in the future if i leave the
//    app on autopilot ... checking if all announced fixtures standings are
//    correct and that there is no competition older than a month"
//
// So this asserts the things that must be true of the published data every
// day, and raises a GitHub issue when one is not — silent (no @mention, no
// assignee; notify.mjs), for the Claude weekly review to triage. It runs after
// the fixtures build, on the daily job.
//
// The checks are deliberately arithmetic or structural — each one either holds
// or it doesn't. None of them asks a model anything.

import { readFile } from "node:fs/promises";
import { classify } from "./build-competitions.mjs";
import { gamesFor, lineUp, TABLE_STRUCTURES } from "./build-standings.mjs";
import { postIssue } from "./notify.mjs";

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// How many matches a competition of this shape MUST have, given its teams.
// A single round robin among n teams is n(n-1)/2; a conference split is the
// product of the two sides; pools is the sum over each pool.
export function expectedFixtures(comp) {
  const n = comp.teams?.length ?? 0;
  if (comp.structure === "table") return (n * (n - 1)) / 2;
  if (comp.structure === "conference" && comp.groups?.length === 2) {
    return comp.groups[0].teams.length * comp.groups[1].teams.length;
  }
  if (comp.structure === "pools" && comp.groups?.length) {
    return comp.groups.reduce((sum, g) => sum + (g.teams.length * (g.teams.length - 1)) / 2, 0);
  }
  return null; // UNKNOWN or unclassified — nothing to assert
}

// The games a format plays AFTER its table: a two-conference competition
// pairs equal ranks on a finals weekend, one game per rank (the Nations
// Championship's six, 27–29 Nov 2026). ESPN files them under the same league
// once drawn, so a complete season counts the table plus these (#165).
export function finalsFor(comp) {
  if (comp?.structure === "conference" && comp.groups?.length === 2) {
    return Math.min(comp.groups[0].teams.length, comp.groups[1].teams.length);
  }
  return 0;
}

// registry + fixtures.json -> the problems worth raising. Pure.
export function checkIntegrity(registry, fixturesFile, today = iso(Date.now())) {
  const problems = [];
  const comps = registry?.competitions ?? [];
  const fixtures = fixturesFile?.fixtures ?? [];

  if (!comps.length) {
    return [{
      kind: "empty-registry",
      title: "Competitions registry is empty",
      detail: "`competitions.json` carries no competitions at all. Every competition surface in the app reads this file, so the dropdown and the Standings tab have nothing to show.",
    }];
  }

  // 1. STALENESS — the defect that prompted this check.
  // A competition past its two-week tail must not still be offered. The app
  // filters client-side, but if it is still the registry's `current` then the
  // app's default selection is a finished competition.
  const expired = comps.filter((c) => c.defaultUntil && c.defaultUntil <= today && c.fixtureCount > 0);
  if (registry.current && expired.some((c) => c.key === registry.current)) {
    problems.push({
      kind: "stale-current",
      title: `The app's default competition (${registry.current}) has expired`,
      detail:
        `\`current\` points at **${registry.current}**, whose window closed on ` +
        `${comps.find((c) => c.key === registry.current)?.defaultUntil}. The app opens on a finished ` +
        `competition.\n\nThis usually means the NEXT competition has no published fixtures, so the ` +
        `handover chain had nothing to hand over to. Check whether a seed is needed ` +
        `(\`scripts/seed-competitions.mjs\`).`,
    });
  }

  // 2. NOTHING CURRENT AT ALL — a live tracker with no live competition.
  if (!registry.current) {
    problems.push({
      kind: "no-current",
      title: "No competition is current",
      detail:
        "`current` is null, so today falls outside every competition's window. The app has no default " +
        "selection and the masthead falls back to its shipped values.\n\nEither the calendar has a real " +
        "gap, or the upcoming competition's fixtures are unpublished and it was skipped — the same " +
        "cause as a stale `current`.",
    });
  }

  // 3. FIXTURE COUNT vs SHAPE — arithmetic, so it cannot be fudged.
  // A "table" of 6 teams is 15 matches. If a seed or a vendor feed is missing
  // one, the structure still classifies but the competition is incomplete.
  for (const c of comps) {
    const expect = expectedFixtures(c);
    if (expect == null || c.fixtureCount === 0) continue;
    const finals = finalsFor(c);
    if (c.fixtureCount !== expect && !(finals && c.fixtureCount === expect + finals)) {
      problems.push({
        kind: "fixture-count-mismatch",
        title: `${c.name} ${c.season}: ${c.fixtureCount} fixtures, expected ${expect}`,
        detail:
          `Classified as **${c.structure}** with ${c.teams.length} teams, which requires ` +
          `**${expect}** matches${finals ? ` (${expect + finals} with its finals weekend)` : ""} — the feed carries **${c.fixtureCount}**.\n\n` +
          `The list is incomplete or carries a duplicate. A partial fixture list still classifies ` +
          `correctly, so nothing else catches this.`,
      });
    }
  }

  // 4. THE REGISTRY AND THE FIXTURES MUST AGREE.
  // A comp key in fixtures.json that the registry doesn't know is a fixture the
  // app can never filter to; the reverse is a competition offering an empty list.
  const registryKeys = new Set(comps.map((c) => c.key));
  const fixtureKeys = new Set(
    fixtures.filter((f) => f.comp?.kind === "competition").map((f) => f.comp.key),
  );
  const orphaned = [...fixtureKeys].filter((k) => !registryKeys.has(k));
  if (orphaned.length) {
    problems.push({
      kind: "orphaned-fixtures",
      title: `fixtures.json carries competitions the registry doesn't know: ${orphaned.join(", ")}`,
      detail:
        `These fixtures can never be filtered to, because the dropdown is built from the registry.\n\n` +
        `Usually a comp key derived from a fixture's calendar year drifting from the registry's key.`,
    });
  }

  for (const c of comps) {
    if (c.fixtureCount === 0 || !c.defaultUntil || c.defaultUntil <= today) continue;
    if (!fixtureKeys.has(c.key) && c.endDate >= today) {
      problems.push({
        kind: "empty-competition",
        title: `${c.name} ${c.season} is selectable but has no fixtures in fixtures.json`,
        detail:
          `The registry says ${c.fixtureCount} fixtures, and fixtures.json carries none under ` +
          `\`${c.key}\`. Selecting it in the app shows an empty list.`,
      });
    }
  }

  // 5. THE STRUCTURE MUST STILL HOLD against the published fixtures — the
  // registry's structure is a snapshot; recompute it from what actually
  // shipped. This is what catches a seed whose fixtures were mistyped.
  for (const c of comps) {
    if (!c.structure || c.structure === "UNKNOWN") continue;
    // A declared format the classifier cannot produce (a knockout bracket is
    // none of its three shapes) has nothing to recompute against.
    if (c.structure === "knockout") continue;
    const own = fixtures.filter((f) => f.comp?.key === c.key);
    if (own.length !== c.fixtureCount) continue; // count mismatch already reported
    const recomputed = classify(own.map((f) => ({ teams: [f.home.code, f.away.code], date: f.date })));
    if (recomputed.structure !== c.structure) {
      problems.push({
        kind: "structure-drift",
        title: `${c.name} ${c.season}: registry says ${c.structure}, its fixtures say ${recomputed.structure}`,
        detail:
          `The Standings tab renders the registry's structure, so it would draw a **${c.structure}** ` +
          `over fixtures that are actually **${recomputed.structure}**.\n\n` +
          `Recomputed from the ${own.length} published fixtures.`,
      });
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// standings.json — the points tables (build-standings.mjs)
// ---------------------------------------------------------------------------
// The invariants the app relies on when it prints a table without re-sorting
// or re-adding it. Each is arithmetic or a comparison with the feeds the
// table is built from; titles are fixed per kind + key so the open-title
// dedupe holds while a problem persists. Pure.
const DAY_MS = 86400000;
const PARITY_FIELDS = ["P", "W", "D", "L", "PF", "PA", "PD", "BP", "Pts"];

export function checkStandings(registry, standings, fixturesFile, nations, today = iso(Date.now()), { now = Date.now() } = {}) {
  const problems = [];
  const comps = (registry?.competitions ?? []).filter((c) => c.fixtureCount > 0);
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const counted = (c) => gamesFor(c, { nations, fixtures: fixturesFile }).games;

  // standings-missing — the file is gone while there are results to table.
  if (!standings || !Array.isArray(standings.competitions)) {
    const withResults = comps.filter((c) => counted(c).length > 0).map((c) => c.key);
    if (withResults.length) {
      problems.push({
        kind: "standings-missing",
        title: "standings.json is missing while competitions have results",
        detail:
          `Results exist for **${withResults.join(", ")}**, but \`standings.json\` is absent or unreadable, so no ` +
          `points table reaches the app for them.\n\nIt is written by \`scripts/build-standings.mjs\`; check that ` +
          `step's log in the workflow that runs it.`,
      });
    }
    return problems;
  }

  const byKey = new Map(standings.competitions.map((e) => [e.key, e]));
  const updatedMs = Date.parse(standings.updatedAt ?? "") || 0;
  for (const c of comps) {
    const e = byKey.get(c.key);
    const games = counted(c);
    const label = `${c.name ?? c.key} ${c.season ?? ""}`.trim();
    if (!e) {
      if (games.length) {
        problems.push({
          kind: "standings-missing",
          title: `standings.json has no table for ${c.key}`,
          detail: `${label} has ${games.length} result(s) in the feeds and no entry in \`standings.json\`.`,
        });
      }
      continue;
    }
    const offered = !(c.defaultUntil && c.defaultUntil <= today);
    const rules = e.rules;
    const rows = (e.groups ?? []).flatMap((g) => g.rows ?? []);

    // standings-arithmetic — every row adds up, and the rows hold every game twice.
    if (e.groups && rules) {
      const bad = [];
      for (const r of rows) {
        const pts = rules.win * r.W + rules.draw * r.D + (rules.loss ?? 0) * r.L + r.BP + r.GS;
        if (r.Pts !== pts) bad.push(`${r.code}: Pts ${r.Pts}, but ${rules.win}·W + ${rules.draw}·D + BP + GS = ${pts}`);
        if (r.BP !== r.BPtry + r.BPlose) bad.push(`${r.code}: BP ${r.BP} ≠ BPtry ${r.BPtry} + BPlose ${r.BPlose}`);
      }
      const sumP = rows.reduce((s, r) => s + r.P, 0);
      if (sumP !== 2 * e.played) bad.push(`the rows hold ${sumP} appearances for ${e.played} games (should be ${2 * e.played})`);
      if (bad.length) {
        problems.push({
          kind: "standings-arithmetic",
          title: `standings.json ${c.key}: the table's points don't add up`,
          detail: `${label}:\n\n${bad.slice(0, 10).map((b) => `- ${b}`).join("\n")}\n\nThe app prints these numbers as they are.`,
        });
      }
    }

    // standings-teams — every registry team exactly once.
    if (e.groups && TABLE_STRUCTURES.has(c.structure)) {
      const seen = new Map();
      for (const r of rows) seen.set(r.code, (seen.get(r.code) ?? 0) + 1);
      const expected = lineUp(c);
      const missing = expected.filter((code) => !seen.has(code));
      const doubled = [...seen].filter(([, n]) => n > 1).map(([code]) => code);
      const extra = [...seen.keys()].filter((code) => !expected.includes(code));
      if (missing.length || doubled.length || extra.length) {
        problems.push({
          kind: "standings-teams",
          title: `standings.json ${c.key}: teams missing or duplicated`,
          detail:
            `${label}: ` +
            [missing.length && `missing ${missing.join(", ")}`, doubled.length && `listed twice ${doubled.join(", ")}`, extra.length && `not in the registry ${extra.join(", ")}`]
              .filter(Boolean).join("; ") + ".",
        });
      }
    }

    // standings-parity — the Nations Championship table is nations.json's
    // `log` (computeLog), number for number, per api-sports team id.
    const fromNations = c.key.startsWith("rnc-") && nations?.competition?.name === c.name &&
      Number(nations?.competition?.season) === Number(c.season);
    if (fromNations && Array.isArray(nations.log) && e.groups) {
      const log = new Map(nations.log.map((r) => [r.id, r]));
      const diffs = [];
      for (const r of rows) {
        const l = log.get(r.id);
        if (!l) {
          if (r.P > 0) diffs.push(`${r.code}: in standings.json, not in the log`);
          continue;
        }
        const fields = r.pending === 0 ? [...PARITY_FIELDS, "TF", "TA"] : PARITY_FIELDS;
        for (const f of fields) if (r[f] !== l[f]) diffs.push(`${r.code} ${f}: standings ${r[f]}, log ${l[f]}`);
      }
      const ids = new Set(rows.map((r) => r.id));
      for (const l of nations.log) if (!ids.has(l.id)) diffs.push(`${l.team ?? l.id}: in the log, not in standings.json`);
      if (diffs.length) {
        problems.push({
          kind: "standings-parity",
          title: `standings.json ${c.key}: table disagrees with nations.json log`,
          detail:
            `The two Nations Championship tables must agree; they count the same pool-stage games with the same rules.\n\n` +
            `${diffs.slice(0, 12).map((d) => `- ${d}`).join("\n")}\n\nUsually one of the two files was rebuilt and the other not yet.`,
        });
      }
    }

    // standings-results-missing — a still-offered table is holding games the
    // feeds no longer carry (frozen, or the never-backwards guard kept it).
    if (offered && (e.frozen || e.played > games.length)) {
      problems.push({
        kind: "standings-results-missing",
        title: `standings.json ${c.key}: results missing from the feeds`,
        detail:
          `${label} is still offered (until ${c.defaultUntil ?? "—"}), and its table ` +
          (e.frozen ? "is frozen — carried forward because its results left the feeds." : `counts ${e.played} game(s) while the feeds carry ${games.length}.`) +
          `\n\nThe build keeps the last good table rather than publish fewer games; find which feed lost results.`,
      });
    }

    // standings-stale — a result has been in the feeds for two days and the
    // table has not moved since before it kicked off. (`updatedAt` is the
    // last change, so a game counted in the table kicked off before it.)
    if (offered) {
      const late = games.filter((g) => {
        const t = Date.parse(g.date);
        return t > updatedMs && nowMs - t > 2 * DAY_MS;
      });
      if (late.length) {
        problems.push({
          kind: "standings-stale",
          title: `standings.json ${c.key}: results are in but the table has not moved`,
          detail:
            `${late.length} ${label} result(s) kicked off after the tables last changed (${standings.updatedAt}) and more than ` +
            `48 hours ago: ${late.slice(0, 6).map((g) => `${g.home.code} ${g.homeScore}-${g.awayScore} ${g.away.code}`).join(", ")}.` +
            `\n\nIs \`scripts/build-standings.mjs\` running after the feeds are rebuilt?`,
        });
      }
    }

    // standings-tries-pending — the season is over and a week later some try
    // counts (so some bonus points) are still missing.
    if (e.complete && e.triesPending > 0 && e.completedAt && nowMs - Date.parse(e.completedAt) > 7 * DAY_MS) {
      problems.push({
        kind: "standings-tries-pending",
        title: `standings.json ${c.key}: try counts still missing a week after the last game`,
        detail:
          `${label} finished (${e.completedAt}) with ${e.triesPending} game(s) still without try counts, so the final table ` +
          `may be missing try bonus points. ESPN never supplied them; a person can confirm them and add the counts to ` +
          `\`scripts/match-tries-espn.json\` (or \`scripts/match-tries.json\` for the Nations Championship).`,
      });
    }

    // standings-tiebreak — every split names a criterion of this
    // competition's chain, and every shared rank is explained.
    if (e.groups && rules) {
      const allowed = new Set(["pts", ...(rules.tiebreak ?? [])]);
      const bad = [];
      for (const r of rows) {
        if (r.decidedBy != null && !allowed.has(r.decidedBy)) bad.push(`${r.code} placed by "${r.decidedBy}", not in ${[...allowed].join(" > ")}`);
        // A team that hasn't played shares its rank without an unresolved set
        // (build-standings rankRows): nothing is unsettled yet.
        if (r.tied && r.P > 0 && !(e.unresolved ?? []).some((u) => u.codes?.includes(r.code))) bad.push(`${r.code} is tied but in no unresolved set`);
      }
      for (const u of e.unresolved ?? []) if (!u.needs) bad.push(`${(u.codes ?? []).join("/")} tied without saying what it needs`);
      if (bad.length) {
        problems.push({
          kind: "standings-tiebreak",
          title: `standings.json ${c.key}: a tiebreak outside the competition's rules`,
          detail: `${label}:\n\n${bad.slice(0, 10).map((b) => `- ${b}`).join("\n")}`,
        });
      }
    }

    // standings-stage-past-end — the World Cup bracket outlives the registry
    // window (ESPN has not published the knockouts, so endDate is still the
    // pool stage's and the competition would expire mid-tournament).
    const bracket = e.qualification?.bracket;
    if (Array.isArray(bracket) && c.endDate) {
      const past = bracket.filter((s) => s?.date && String(s.date).slice(0, 10) > c.endDate);
      if (past.length) {
        problems.push({
          kind: "standings-stage-past-end",
          title: `standings.json ${c.key}: knockout slots dated after the registry's end date`,
          detail:
            `${past.length} bracket slot(s) of ${label} fall after the registry's endDate ${c.endDate} ` +
            `(latest ${past.map((s) => String(s.date).slice(0, 10)).sort().at(-1)}); its defaultUntil follows endDate, ` +
            `so the competition would leave the app before its final.`,
        });
      }
    }
  }
  return problems;
}

async function main() {
  const today = iso(Date.now());
  const [registry, fixtures, standings, nations] = await Promise.all([
    readFile("competitions.json", "utf8").then(JSON.parse).catch(() => null),
    readFile("fixtures.json", "utf8").then(JSON.parse).catch(() => null),
    readFile("standings.json", "utf8").then(JSON.parse).catch(() => null),
    readFile("nations.json", "utf8").then(JSON.parse).catch(() => null),
  ]);

  const problems = [
    ...checkIntegrity(registry, fixtures, today),
    ...checkStandings(registry, standings, fixtures, nations, today),
  ];

  console.log(`current=${registry?.current ?? "none"}`);
  for (const c of registry?.competitions ?? []) {
    const live = c.defaultUntil && c.defaultUntil > today ? "offered" : "expired";
    console.log(
      `  ${c.key.padEnd(9)} ${String(c.structure ?? "-").padEnd(10)} ${String(c.fixtureCount).padStart(3)} fixtures  ${live}`,
    );
  }

  if (!problems.length) {
    console.log("Competition integrity OK — nothing stale, counts match their shapes, tables add up.");
    return;
  }

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  let open = new Set();
  try {
    const { stdout } = await execFileAsync("gh", ["issue", "list", "--state", "open", "--limit", "100", "--json", "title"]);
    open = new Set(JSON.parse(stdout).map((i) => i.title));
  } catch { /* risk a duplicate rather than go silent */ }

  for (const p of problems) {
    console.log(`::warning::${p.kind} — ${p.title}`);
    if (open.has(p.title)) {
      console.log("  (an open issue already says this — not filing a duplicate)");
      continue;
    }
    await postIssue({
      title: p.title,
      body: `${p.detail}\n\n---\nRaised automatically by the daily competition integrity check (\`scripts/check-competitions.mjs\`) on ${today}.`,
    });
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
