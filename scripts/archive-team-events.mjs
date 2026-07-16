// Accumulates every game that passes through team-events.json into an
// append-only archive (team-events-archive.json) so per-game history —
// scores, tries, cards, venue, competition — survives beyond the rolling
// last-10 window (Nico's ask, 2026-07-16: "a weekly database of the stats
// so we can use it in the future"). Runs inside the existing daily
// team-events job — no new schedule, no extra API calls; the file simply
// grows as games are played.
//
// Shape: { updatedAt, games: { RSA: { "<gameId>": entry, ... }, ... } }
// — each entry is the team-side view already published in `last`.

// Pure merge: current teams map -> archive. Existing entries are updated
// field-by-field (late tries/cards enrichment lands), but a non-null
// archived value is never clobbered by a null re-fetch.
export function mergeArchive(archive, teams, now = new Date().toISOString()) {
  const merged = { updatedAt: now, games: { ...(archive?.games ?? {}) } };
  let added = 0;
  for (const [code, t] of Object.entries(teams ?? {})) {
    const byId = { ...(merged.games[code] ?? {}) };
    for (const g of t.last ?? []) {
      if (g.id == null) continue;
      const key = String(g.id);
      const prev = byId[key];
      if (!prev) added += 1;
      const next = { ...(prev ?? {}), ...g };
      // never lose enrichment to a null re-fetch
      for (const k of ["tries", "cards", "venue"]) {
        if (g[k] == null && prev?.[k] != null) next[k] = prev[k];
      }
      byId[key] = next;
    }
    merged.games[code] = byId;
  }
  return { merged, added };
}

async function main() {
  const { readFile, writeFile } = await import("node:fs/promises");
  const te = JSON.parse(await readFile("team-events.json", "utf8"));
  const archive = await readFile("team-events-archive.json", "utf8").then(JSON.parse).catch(() => null);
  const { merged, added } = mergeArchive(archive, te.teams);
  await writeFile("team-events-archive.json", JSON.stringify(merged, null, 1) + "\n");
  const total = Object.values(merged.games).reduce((t, g) => t + Object.keys(g).length, 0);
  console.log(`team-events-archive.json written — +${added} new games, ${total} total`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
