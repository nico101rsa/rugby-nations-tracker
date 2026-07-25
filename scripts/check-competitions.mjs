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
// day, and raises a GitHub issue when one is not. It runs after the fixtures
// build, on the daily job.
//
// The checks are deliberately arithmetic or structural — each one either holds
// or it doesn't. None of them asks a model anything.

import { readFile } from "node:fs/promises";
import { classify } from "./build-competitions.mjs";
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
    if (c.fixtureCount !== expect) {
      problems.push({
        kind: "fixture-count-mismatch",
        title: `${c.name} ${c.season}: ${c.fixtureCount} fixtures, expected ${expect}`,
        detail:
          `Classified as **${c.structure}** with ${c.teams.length} teams, which requires ` +
          `**${expect}** matches — the feed carries **${c.fixtureCount}**.\n\n` +
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

async function main() {
  const today = iso(Date.now());
  const [registry, fixtures] = await Promise.all([
    readFile("competitions.json", "utf8").then(JSON.parse).catch(() => null),
    readFile("fixtures.json", "utf8").then(JSON.parse).catch(() => null),
  ]);

  const problems = checkIntegrity(registry, fixtures, today);

  console.log(`current=${registry?.current ?? "none"}`);
  for (const c of registry?.competitions ?? []) {
    const live = c.defaultUntil && c.defaultUntil > today ? "offered" : "expired";
    console.log(
      `  ${c.key.padEnd(9)} ${String(c.structure ?? "-").padEnd(10)} ${String(c.fixtureCount).padStart(3)} fixtures  ${live}`,
    );
  }

  if (!problems.length) {
    console.log("Competition integrity OK — nothing stale, counts match their shapes.");
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
