// Hourly news harvest: pull the publisher spine into a rolling pool so the daily
// briefing writes from a full day of coverage rather than a single instant.
//
// Why hourly. Planet Rugby's feed holds ~12 items and they publish at roughly
// that rate, so the window turns over inside a day. On 2026-07-20 the Erasmus
// story on Feinberg-Mngomezulu's fitness and Pollard's hamstring was in the feed
// at 08:00 AEST and gone by 19:30 — a once-daily pull would have missed the
// day's biggest Springbok story entirely, which is the exact failure the
// retrieval redesign exists to fix.
//
// Corroboration also accumulates. Outlets pick a story up over hours; sampling
// once catches it at one outlet, sampling hourly catches it at three — and
// cross-outlet corroboration is the strongest salience signal we have.
//
// The pool is raw items only. Typed Storylines (the backlog drawn on when a team
// is Quiet) are extracted from it by the daily run — see docs/adr/0002 in the
// app repo.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { parseRss } from "./generate-digests.mjs";
import { FEEDS } from "./news-sources.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOL = join(ROOT, "editorial", "news-pool.json");

// Long enough that a Friday story is still available to Sunday's edition, short
// enough that the pool stays a few hundred items and the file stays reviewable.
export const RETENTION_HOURS = 72;
const FETCH_TIMEOUT_MS = 20000;
// Feeds are the agenda-setter; a single outlet being down must not empty the
// pool, so failures are logged and skipped rather than thrown.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

// ---- pure helpers -----------------------------------------------------------

// Identity for dedupe. Link is the strong key, but outlets re-publish the same
// story under tracking-parameter variants, so the query string is stripped. A
// missing link falls back to the title.
export function itemKey(item) {
  const link = String(item?.link || "").trim();
  if (link) {
    try {
      const u = new URL(link);
      return `${u.origin}${u.pathname}`.replace(/\/$/, "").toLowerCase();
    } catch {
      return link.toLowerCase();
    }
  }
  return `title:${String(item?.title || "").trim().toLowerCase()}`;
}

// Merge a fetch into the pool. An item already held keeps its ORIGINAL firstSeen
// and position — the position it held when it broke is the editorial signal, and
// letting it drift down as the feed moves on would penalise a story for ageing
// twice (recency already does that).
export function mergeIntoPool(pool, incoming, nowISO) {
  const byKey = new Map(pool.map((i) => [itemKey(i), i]));
  for (const item of incoming) {
    const key = itemKey(item);
    const held = byKey.get(key);
    if (held) {
      held.lastSeen = nowISO;
      // A feed with no pubDate gets its first-seen time as a stand-in, but if a
      // real date shows up later, prefer it.
      if (!held.date && item.date) held.date = item.date;
      continue;
    }
    byKey.set(key, { ...item, firstSeen: nowISO, lastSeen: nowISO });
  }
  return [...byKey.values()];
}

export function prunePool(pool, now, retentionHours = RETENTION_HOURS) {
  const cutoff = now.getTime() - retentionHours * 3_600_000;
  return pool.filter((i) => {
    const stamp = Date.parse(i.firstSeen || i.date || "");
    return Number.isNaN(stamp) ? false : stamp >= cutoff;
  });
}

// ---- I/O --------------------------------------------------------------------

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const items = parseRss(await res.text());
  if (!items.length) throw new Error("no items");
  // Position is where the outlet placed it — borrowed editorial ranking.
  return items.map((item, position) => ({
    title: item.title,
    link: item.link,
    desc: item.desc,
    date: item.date,
    feedId: feed.id,
    feedName: feed.name,
    position,
  }));
}

export async function readPool(path = POOL) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return []; // first run, or a truncated write — rebuild from this fetch
  }
}

export async function main({ now = new Date() } = {}) {
  const nowISO = now.toISOString();
  const existing = await readPool();

  const incoming = [];
  const sources = [];
  for (const feed of FEEDS) {
    try {
      const items = await fetchFeed(feed);
      incoming.push(...items);
      sources.push({ id: feed.id, items: items.length, ok: true });
      console.log(`${feed.id}: ${items.length} items`);
    } catch (e) {
      sources.push({ id: feed.id, items: 0, ok: false, error: e.message });
      console.warn(`${feed.id}: FAILED — ${e.message}`);
    }
  }

  // Every feed failing is a network or CI problem, not a quiet news day. Keep
  // the pool we have rather than pruning it against an empty fetch.
  if (!incoming.length) {
    console.error("every feed failed — leaving the pool untouched");
    process.exitCode = 1;
    return { failed: true, kept: existing.length };
  }

  const merged = mergeIntoPool(existing, incoming, nowISO);
  const items = prunePool(merged, now);
  const added = items.length - existing.length;

  await writeFile(
    POOL,
    JSON.stringify({ updatedAt: nowISO, retentionHours: RETENTION_HOURS, sources, counts: { items: items.length }, items }, null, 2),
  );
  console.log(`pool: ${items.length} items (${added >= 0 ? "+" : ""}${added} vs last run, ${merged.length - items.length} pruned)`);
  return { items: items.length, added, sources };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
