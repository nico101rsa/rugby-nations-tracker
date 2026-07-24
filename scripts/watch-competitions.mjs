// The weekly competitions watcher (map #206).
//
// Rebuilds competitions.json and raises a GitHub issue when something happens
// that a human needs to see:
//
//   - a registered competition PUBLISHES FIXTURES for the first time
//     (Six Nations 2027 is sitting in exactly this state right now: a season
//     record for 31 Jan–17 Mar 2027 with zero events);
//   - a competition classifies as UNKNOWN — never guess a layout;
//   - a competition that HAD fixtures loses them, or its window moves, which
//     means either a reschedule or the vendor breaking underneath us.
//
// Why an issue and not an email: Gmail SMTP is rejected from Actions runners
// (535, datacenter IPs), so email cannot be relied on to reach anyone. An
// assigned + @mentioned issue notifies under GitHub's default "Participating
// and @mentions" whatever the repo watch setting is. Same channel the
// watchdog uses.

import { readFile, writeFile } from "node:fs/promises";
import { buildRegistry, defaultCompetition } from "./build-competitions.mjs";
import { postIssue } from "./notify.mjs";

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const byKey = (reg) => new Map((reg?.competitions ?? []).map((c) => [c.key, c]));

// Previous registry + freshly built one -> the things worth telling Nico.
// Pure, so the interesting cases are testable without the network.
export function diffRegistry(before, after) {
  const prev = byKey(before);
  const events = [];

  for (const c of after?.competitions ?? []) {
    const was = prev.get(c.key);

    if (c.structure === "UNKNOWN") {
      events.push({
        kind: "unknown-structure",
        key: c.key,
        title: `Competition ${c.key} classifies as UNKNOWN — layout not derivable`,
        detail:
          `${c.name} ${c.season} has ${c.fixtureCount} fixtures across ${c.teams.length} teams, ` +
          `and the fixture graph matches none of table / conference / pools.\n\n` +
          `Nothing is guessed: the Standings tab renders nothing for an UNKNOWN structure. ` +
          `Either the competition uses a shape the classifier doesn't model (a knockout ` +
          `bracket will always land here — that is expected once the RWC draw is made), or ` +
          `the fixture list is incomplete at the moment it was read.`,
      });
      continue;
    }

    // First fixtures. `was` being absent counts only when the competition
    // arrives already populated — a brand new season record with no fixtures
    // is not news, it is the normal announced state.
    const hadNone = !was || was.fixtureCount === 0;
    if (hadNone && c.fixtureCount > 0) {
      events.push({
        kind: "fixtures-published",
        key: c.key,
        title: `${c.name} ${c.season} has published fixtures`,
        detail:
          `${c.fixtureCount} fixtures, ${c.teams.length} teams, ${c.startDate} → ${c.endDate}.\n` +
          `Classified as **${c.structure}**` +
          (c.groups ? ` with ${c.groups.length} groups.` : ".") +
          `\n\nIt becomes the app's default selection from ${c.defaultFrom} until ${c.defaultUntil}.` +
          `\n\nNothing needs doing for the app to pick this up — the dropdown and the Standings ` +
          `tab both read competitions.json. This is a heads-up that the handover date moved.`,
      });
      continue;
    }

    // Regressions: a competition that had fixtures and now doesn't, or whose
    // window shifted. Both mean something changed upstream.
    if (was && was.fixtureCount > 0 && c.fixtureCount === 0) {
      events.push({
        kind: "fixtures-vanished",
        key: c.key,
        title: `${c.name} ${c.season} lost its fixtures`,
        detail:
          `It had ${was.fixtureCount} fixtures (${was.startDate} → ${was.endDate}) and now has none.\n\n` +
          `This is not a normal transition. Either ESPN's league feed changed shape, or the ` +
          `season rolled over and league ${c.espnLeagueId} now answers for a different year.`,
      });
      continue;
    }

    if (was && was.fixtureCount > 0 && (was.startDate !== c.startDate || was.endDate !== c.endDate)) {
      events.push({
        kind: "window-moved",
        key: c.key,
        title: `${c.name} ${c.season} window moved`,
        detail:
          `Was ${was.startDate} → ${was.endDate} (${was.fixtureCount} fixtures), ` +
          `now ${c.startDate} → ${c.endDate} (${c.fixtureCount} fixtures).\n\n` +
          `The +2-week handover moves with it: the app now defaults to this competition ` +
          `until ${c.defaultUntil}.`,
      });
    }
  }

  return events;
}

// One issue per distinct title, skipped if an open one already says the same
// thing — the watcher runs weekly and would otherwise reopen the same news
// every Monday for as long as the condition holds.
async function openIssues() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync("gh", [
      "issue", "list", "--state", "open", "--limit", "100", "--json", "title",
    ]);
    return new Set(JSON.parse(stdout).map((i) => i.title));
  } catch {
    return new Set(); // no gh / no auth: better to risk a duplicate than to go silent
  }
}

async function main() {
  const today = iso(Date.now());
  const year = new Date(today).getUTCFullYear();

  const before = await readFile("competitions.json", "utf8")
    .then(JSON.parse)
    .catch(() => null);

  const competitions = await buildRegistry([year, year + 1, year + 2], today);
  const current = defaultCompetition(competitions, today);
  const after = {
    updatedAt: new Date().toISOString(),
    source: "espn",
    current: current?.key ?? null,
    competitions,
  };
  await writeFile("competitions.json", JSON.stringify(after, null, 1) + "\n");

  for (const c of competitions) {
    console.log(
      `  ${c.key.padEnd(9)} ${String(c.structure ?? "-").padEnd(10)} ` +
        `${String(c.fixtureCount).padStart(3)} games  ${c.status}`,
    );
  }
  console.log(`current=${after.current}`);

  const events = diffRegistry(before, after);
  if (!events.length) {
    console.log("No competition changes worth raising.");
    return;
  }

  const existing = await openIssues();
  for (const e of events) {
    console.log(`::notice::${e.kind} — ${e.title}`);
    if (existing.has(e.title)) {
      console.log(`  (an open issue already says this — not filing a duplicate)`);
      continue;
    }
    await postIssue({
      title: e.title,
      body:
        `${e.detail}\n\n---\nRaised automatically by the weekly competitions watcher ` +
        `(\`scripts/watch-competitions.mjs\`) on ${today}.`,
    });
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
