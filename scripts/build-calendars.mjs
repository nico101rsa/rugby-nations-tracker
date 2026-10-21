// Subscribable fixture calendars, served by GitHub Pages next to the JSON:
//
//   https://nico101rsa.github.io/rugby-nations-tracker/calendar/<CODE>.ics
//   https://nico101rsa.github.io/rugby-nations-tracker/calendar/all.ics
//
// one per tracked nation (ESPN_TEAM_IDS keys) plus one with every row, all
// built from fixtures.json AFTER the kickoff corrections — so a calendar
// carries the same time the app shows. Never from nations.json: it carries
// only the Nations Championship, and only api-sports' times. Subscribe with
// webcal://… on Apple devices, or paste the https:// URL into Google
// Calendar / Outlook.
//
// Called from build-fixtures.mjs right after every fixtures.json write (daily
// build, live-window ticks, each 3-min burst pass, the push-triggered rebuild),
// so it costs no vendor call and needs no workflow of its own. The command
// line (rebuildFromCommitted, below) lays the same corrections over the
// committed fixtures.json first, so a hand run can never publish a vendor
// time the app no longer shows. Zero
// dependencies: RFC 5545 is small enough to write by hand, and
// build-calendars.test.mjs parses the output strictly.
//
// BYTE-STABLE BY DESIGN. A file is rewritten only when an event in it really
// changed, so the 3-min burst commits nothing here:
//   - no scores anywhere (a title flipping to "32–35" is a score on a lock
//     screen, and GROWTH_STRATEGY rules out score-carrying pushes because they
//     spoil overnight recordings). A played row's DESCRIPTION flips once, to
//     "Full time — result in the app."; a live row reads as unplayed.
//   - no generation timestamp. DTSTAMP/LAST-MODIFIED/SEQUENCE come from
//     calendar/state.json (committed), one entry per UID:
//       new UID              → SEQUENCE 0, LAST-MODIFIED = fixtures.json updatedAt
//       body hash unchanged  → previous SEQUENCE and LAST-MODIFIED, byte for byte
//       body changed         → LAST-MODIFIED = updatedAt
//       DTSTART/STATUS moved → and SEQUENCE + 1 (RFC 5545 §3.8.7.4)
//       UID gone             → pruned (subscribers delete it by UID)
//
// Alarms: a 30-minute VALARM on the 12 team calendars, on confirmed unplayed
// games only (an Android or non-app subscriber has no other reminder). none in
// all.ics, which would ping 18 times on a Nations Championship weekend. A
// "(time TBC)" row stays timed at its expected slot, TENTATIVE, without an
// alarm: an all-day event on the UTC date lands on the wrong Sydney day.
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ESPN_TEAM_IDS, CODE_NAMES } from "./fetch-espn-fixtures.mjs";
import { applyKickoffOverrides, keyOf, KICKOFF_OVERRIDES } from "./kickoff-overrides.mjs";

export const TRACKED_CODES = Object.keys(ESPN_TEAM_IDS);
export const SITE_URL = "https://nico101rsa.github.io/rugby-nations-tracker/";
export const STATE_PATH = "calendar/state.json";
export const ALARM_MINUTES = 30;

const UID_DOMAIN = "rugby-nations-tracker";
const MATCH_MS = 2 * 3600 * 1000;
const CAVEAT = "Kickoff times come from ESPN and can move — the app is the live source.";
const TBC_LINE = "Kickoff time not yet confirmed — this is the expected slot.";
const FULL_TIME = "Full time — result in the app.";

const ms = (iso) => new Date(iso).getTime();

// RFC 5545 §3.3.11 TEXT: backslash first, then ; , and newlines.
export function escapeText(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// RFC 5545 §3.1: no physical line longer than 75 octets (CRLF excluded); a
// continuation starts with one space, which counts toward its 75. Breaks only
// between code points, so "José" or "—" never splits mid-character.
export function fold(line) {
  const out = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > 75) {
      out.push(cur);
      cur = " ";
      bytes = 1;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

// "2026-10-17T05:00Z", "…05:00:00.000Z" and "…05:00:00+00:00" all appear in
// the feeds → "20261017T050000Z" (UTC form, so no VTIMEZONE is needed).
export function fmtUtc(iso) {
  const t = ms(iso);
  if (!Number.isFinite(t)) throw new Error(`unparseable date: ${iso}`);
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

// Played = a full score and not still in play. A live row reads as unplayed
// so nothing in the file moves while the burst rewrites fixtures.json.
const played = (row) => row.homeScore != null && row.awayScore != null && !row.status?.live;

const sideName = (s) => s?.name ?? s?.code ?? "TBC";

function summarySuffix(row) {
  const { comp = {}, series, round } = row;
  if (series) return ` · ${series.label} Game ${series.game}/${series.of}`;
  if (comp.kind === "competition") return ` · ${comp.label}${round ? ` R${round}` : ""}`;
  if (comp.kind === "tour") return " · Tour";
  return "";
}

function descriptionLead(row, compNames) {
  if (played(row)) return FULL_TIME;
  if (row.series) return `${row.series.label} series, game ${row.series.game} of ${row.series.of}.`;
  switch (row.comp?.kind) {
    case "competition": {
      const reg = compNames[row.comp.key];
      const name = reg ? [reg.name, reg.season].filter(Boolean).join(" ") : row.comp.label ?? "Competition";
      return `${name}${row.round ? `, Round ${row.round}` : ""}.`;
    }
    case "tour":
      return "Tour match.";
    default:
      return "Test match.";
  }
}

// One fixtures.json row → its VEVENT. `body` is the canonical content lines
// (unfolded), without the three state-driven lines (DTSTAMP, LAST-MODIFIED,
// SEQUENCE): its hash is what decides whether the event changed.
export function eventFor(row, { teamFile = false, compNames = {} } = {}) {
  const uid = `${row.id}@${UID_DOMAIN}`;
  const dtstart = fmtUtc(row.date);
  const dtend = fmtUtc(new Date(ms(row.date) + MATCH_MS).toISOString());
  const tbc = row.timeTBC === true;
  const done = played(row);
  const status = tbc ? "TENTATIVE" : "CONFIRMED";
  const title = `${sideName(row.home)} v ${sideName(row.away)}`;
  const summary = `${tbc ? "(time TBC) " : ""}${title}${summarySuffix(row)}`;
  const description = [descriptionLead(row, compNames), ...(tbc && !done ? [TBC_LINE] : []), CAVEAT, SITE_URL].join("\n");
  const body = [
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${escapeText(summary)}`,
    ...(row.venue ? [`LOCATION:${escapeText(row.venue)}`] : []),
    `DESCRIPTION:${escapeText(description)}`,
    `STATUS:${status}`,
    "TRANSP:TRANSPARENT",
    "CATEGORIES:Rugby",
  ];
  if (teamFile && !tbc && !done) {
    body.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `TRIGGER:-PT${ALARM_MINUTES}M`,
      `DESCRIPTION:${escapeText(`Kick-off in ${ALARM_MINUTES} minutes: ${title}`)}`,
      "END:VALARM",
    );
  }
  return { uid, body, dtstart, dtend, status };
}

const sha1 = (s) => createHash("sha1").update(s).digest("hex");

function vcalendar({ name, description, events }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Rugby Nations Tracker//fixtures//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `NAME:${escapeText(name)}`,
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-WR-CALDESC:${escapeText(description)}`,
    `URL:${SITE_URL}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
    "X-APPLE-CALENDAR-COLOR:#C8F135",
  ];
  for (const { uid, body, seq, modified } of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeText(uid)}`,
      `DTSTAMP:${modified}`,
      `LAST-MODIFIED:${modified}`,
      `SEQUENCE:${seq}`,
      ...body,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

const byDateThenId = (a, b) => {
  const d = ms(a.date) - ms(b.date);
  if (d) return d;
  const x = String(a.id);
  const y = String(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
};

// Pure and deterministic: fixtures.json rows + the previous state → the 13
// files and the next state. Same input, same bytes — including a later
// updatedAt when no event changed.
export function buildCalendars({ fixtures, updatedAt, state = {}, compNames = {} }) {
  const now = fmtUtc(updatedAt);
  const seen = new Set();
  const rows = (fixtures ?? [])
    .filter((r) => r?.id != null && r.home && r.away && Number.isFinite(ms(r.date)))
    // A projected finals pairing (projected-finals.mjs) is not an appointment:
    // it moves with the table, and the real one arrives from ESPN with its own id.
    .filter((r) => !r.final?.projected)
    .filter((r) => !seen.has(String(r.id)) && seen.add(String(r.id)))
    .sort(byDateThenId);

  const nextState = {};
  const stamp = new Map(); // row id → { seq, modified }
  for (const row of rows) {
    // The team-file body is the fingerprint: it is the fuller of the two
    // (all.ics only drops the alarm, which follows from the same fields).
    const ev = eventFor(row, { teamFile: true, compNames });
    const hash = sha1(ev.body.join("\n"));
    const prev = state[ev.uid];
    let seq = 0;
    let modified = now;
    if (prev && prev.hash === hash) {
      seq = prev.seq ?? 0;
      modified = prev.modified ?? now;
    } else if (prev) {
      const moved = prev.dtstart !== ev.dtstart || (prev.status != null && prev.status !== ev.status);
      seq = (prev.seq ?? 0) + (moved ? 1 : 0);
    }
    nextState[ev.uid] = { seq, dtstart: ev.dtstart, status: ev.status, hash, modified };
    stamp.set(String(row.id), { seq, modified });
  }

  const eventsFor = (subset, teamFile) =>
    subset.map((row) => ({ ...eventFor(row, { teamFile, compNames }), ...stamp.get(String(row.id)) }));

  const files = new Map();
  for (const code of TRACKED_CODES) {
    const team = CODE_NAMES[code] ?? code;
    const mine = rows.filter((r) => r.home.code === code || r.away.code === code);
    files.set(`calendar/${code}.ics`, vcalendar({
      name: `${team} fixtures · Rugby Nations Tracker`,
      description: `Every announced ${team} match from Rugby Nations Tracker. ${CAVEAT}`,
      events: eventsFor(mine, true),
    }));
  }
  files.set("calendar/all.ics", vcalendar({
    name: "All tracked nations · Rugby Nations Tracker",
    description: `Every match on the Rugby Nations Tracker fixtures list. ${CAVEAT}`,
    events: eventsFor(rows, false),
  }));
  return { files, state: nextState };
}

// Keys sorted so the committed state.json diffs cleanly and is byte-stable.
export const stateJson = (state) =>
  JSON.stringify(Object.fromEntries(Object.keys(state).sort().map((k) => [k, state[k]])), null, 1) + "\n";

// competitions.json → { "<comp.key>": { name, season } } for the DESCRIPTION
// ("Six Nations 2027, Round 1."); a key it lacks falls back to comp.label.
export function compNamesFrom(registry) {
  return Object.fromEntries(
    (registry?.competitions ?? []).filter((c) => c?.key).map((c) => [c.key, { name: c.name, season: c.season }]),
  );
}

// Reads competitions.json and calendar/state.json, writes only the files whose
// bytes differ (state.json only when it changed). Never deletes anything.
export async function writeCalendars(fixturesPayload, { root = ".", fs = nodeFs } = {}) {
  const readText = (path) => fs.readFile(join(root, path), "utf8").catch(() => null);
  const parse = (text, what) => {
    if (text == null) return null;
    try {
      return JSON.parse(text);
    } catch {
      console.warn(`calendars: ${what} is not valid JSON — ignoring it`);
      return null;
    }
  };
  const compNames = compNamesFrom(parse(await readText("competitions.json"), "competitions.json"));
  const state = parse(await readText(STATE_PATH), STATE_PATH) ?? {};
  const { files, state: next } = buildCalendars({
    fixtures: fixturesPayload?.fixtures,
    updatedAt: fixturesPayload?.updatedAt,
    state,
    compNames,
  });

  await fs.mkdir(join(root, "calendar"), { recursive: true });
  const written = [];
  const unchanged = [];
  const put = async (path, text) => {
    if ((await readText(path)) === text) {
      unchanged.push(path);
      return;
    }
    await fs.writeFile(join(root, path), text);
    written.push(path);
  };
  for (const [path, text] of files) await put(path, text);
  await put(STATE_PATH, stateJson(next));
  return { written, unchanged };
}

// The command-line rebuild: calendar/ from the COMMITTED fixtures.json, with
// the kickoff corrections laid over it exactly as publishFixtures does before
// its write. Without them a hand run between a row's merge and the next
// fixtures build (or after a failed push-triggered rebuild) would put the
// vendor's later time back into every subscriber's calendar. fixtures.json
// itself is read, never written: the app's copy stays the fixtures build's
// job. Each correction logs `kickoff override applied: …`, as in the build.
export async function rebuildFromCommitted({ root = ".", fs = nodeFs, table = KICKOFF_OVERRIDES, log = console.log } = {}) {
  const payload = JSON.parse(await fs.readFile(join(root, "fixtures.json"), "utf8"));
  const fixtures = applyKickoffOverrides(payload?.fixtures, keyOf.fixture, table, { log });
  return writeCalendars({ ...payload, fixtures }, { root, fs });
}

// CLI: node scripts/build-calendars.mjs — rebuilds calendar/ from the
// committed fixtures.json (corrections applied). No network.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { written, unchanged } = await rebuildFromCommitted({ root });
  console.log(`calendars: ${written.length} file(s) changed, ${unchanged.length} unchanged`);
  for (const path of written) console.log(`  wrote ${path}`);
}
