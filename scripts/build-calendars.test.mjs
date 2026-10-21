// The calendars, parsed strictly. No offline ICS validator exists in this
// zero-dependency repo, so the parser below is the validator: CRLF only,
// 75-octet physical lines that decode as UTF-8 on their own, balanced
// components, the required properties, TEXT escaping — then the behaviour
// (no scores, alarms only where they belong, byte-stable SEQUENCE state).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeText, fold, fmtUtc, eventFor, buildCalendars, writeCalendars, compNamesFrom, rebuildFromCommitted,
  TRACKED_CODES, STATE_PATH,
} from "./build-calendars.mjs";

// ---- the strict parser ------------------------------------------------------

const NAME_RE = /^[A-Z][A-Z0-9-]*$/;
const TEXT_PROPS = new Set(["SUMMARY", "LOCATION", "DESCRIPTION", "NAME", "X-WR-CALNAME", "X-WR-CALDESC"]);

// Every ; and , in a TEXT value must be escaped; a backslash only escapes
// \ ; , n N.
function assertEscaped(value, where) {
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\") {
      assert.ok("\\;,nN".includes(value[i + 1] ?? ""), `${where}: bad escape \\${value[i + 1]}`);
      i++;
    } else {
      assert.ok(c !== ";" && c !== ",", `${where}: unescaped "${c}" in ${JSON.stringify(value)}`);
    }
  }
}
const unescapeText = (v) => v.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));

function parseIcs(text) {
  assert.ok(!/\r(?!\n)/.test(text), "no bare CR");
  assert.ok(!/(?<!\r)\n/.test(text), "no bare LF — CRLF only");
  assert.ok(text.endsWith("\r\n"), "ends with CRLF");
  assert.ok(!text.includes("�"), "no replacement characters");

  // Physical lines, checked as BYTES: ≤75 octets each, each decodable alone.
  const bytes = Buffer.from(text, "utf8");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0x0d || bytes[i + 1] !== 0x0a) continue;
    const line = bytes.subarray(start, i);
    assert.ok(line.length <= 75, `line over 75 octets (${line.length}): ${line.toString()}`);
    assert.doesNotThrow(() => decoder.decode(line), `line splits a character: ${line.toString("hex")}`);
    start = i + 2;
    i++;
  }
  // Continuations start with exactly the one fold space (a tab is legal
  // RFC-wise, but this writer never emits one).
  const physical = text.slice(0, -2).split("\r\n");
  assert.ok(!physical[0].startsWith(" "), "first line is not a continuation");
  for (const l of physical) assert.ok(!l.startsWith("\t"), "folds use a space");

  const lines = text.replace(/\r\n /g, "").slice(0, -2).split("\r\n");
  const root = { name: null, props: [], children: [] };
  const stack = [root];
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/);
    assert.ok(m, `not a content line: ${JSON.stringify(line)}`);
    const [, name, params, value] = m;
    assert.match(name, NAME_RE, `property name ${name}`);
    if (name === "BEGIN") {
      const comp = { name: value, props: [], children: [] };
      stack.at(-1).children.push(comp);
      stack.push(comp);
    } else if (name === "END") {
      assert.equal(stack.at(-1).name, value, `END:${value} closes BEGIN:${stack.at(-1).name}`);
      stack.pop();
    } else {
      if (TEXT_PROPS.has(name)) assertEscaped(value, name);
      stack.at(-1).props.push({ name, params, value });
    }
  }
  assert.equal(stack.length, 1, "every BEGIN has its END");
  assert.equal(root.children.length, 1, "exactly one VCALENDAR");
  const cal = root.children[0];
  assert.equal(cal.name, "VCALENDAR");
  for (const p of ["VERSION", "PRODID", "METHOD"]) assert.ok(prop(cal, p) != null, `VCALENDAR has ${p}`);
  assert.equal(prop(cal, "VERSION"), "2.0");
  const events = cal.children.filter((c) => c.name === "VEVENT");
  const uids = new Set();
  for (const e of events) {
    for (const p of ["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY", "SEQUENCE"]) {
      assert.equal(e.props.filter((x) => x.name === p).length, 1, `VEVENT ${prop(e, "UID")} has exactly one ${p}`);
    }
    for (const p of ["DTSTART", "DTEND", "DTSTAMP", "LAST-MODIFIED"]) {
      assert.match(prop(e, p), /^\d{8}T\d{6}Z$/, `${p} in UTC form`);
    }
    assert.match(prop(e, "SEQUENCE"), /^\d+$/);
    assert.ok(!uids.has(prop(e, "UID")), `duplicate UID ${prop(e, "UID")}`);
    uids.add(prop(e, "UID"));
    for (const a of e.children) {
      assert.equal(a.name, "VALARM");
      for (const p of ["ACTION", "TRIGGER", "DESCRIPTION"]) assert.ok(prop(a, p) != null, `VALARM has ${p}`);
    }
  }
  return { cal, events };
}
function prop(comp, name) {
  return comp.props.find((p) => p.name === name)?.value ?? null;
}
const byUid = (parsed, id) => parsed.events.find((e) => prop(e, "UID") === `${id}@rugby-nations-tracker`);
const desc = (e) => unescapeText(prop(e, "DESCRIPTION"));

// ---- synthetic rows -----------------------------------------------------------

const T = (code, name) => ({ code, name, tracked: true });
const U = (code, name) => ({ code, name, tracked: false });
const rows = () => [
  { // short ESPN date form, series
    id: "espn-603464", date: "2026-10-17T05:00Z", timeTBC: false,
    home: T("AUS", "Australia"), away: T("NZL", "New Zealand"),
    comp: { key: "series-nzl-aus-2026", label: "NZ v AUS", kind: "series" },
    venue: "Accor Stadium, Sydney", series: { label: "NZ v AUS", game: 2, of: 2 },
  },
  { // seed: TBC, competition, round
    id: "seed-6n2027-ire-eng", date: "2027-02-05T20:10:00Z", timeTBC: true, round: "1",
    home: T("IRE", "Ireland"), away: T("ENG", "England"),
    comp: { key: "6n-2027", label: "6N '27", kind: "competition" },
    venue: "Aviva Stadium, Dublin", seeded: true,
  },
  { // played test, non-ASCII venue that must fold on a character boundary
    id: "espn-603498", date: "2026-08-08T19:00:00.000Z", timeTBC: false,
    home: T("ARG", "Argentina"), away: T("RSA", "South Africa"),
    comp: { key: "test", label: "TEST", kind: "test" },
    venue: "Estadio José Amalfitani, Buenos Aires", homeScore: 71, awayScore: 86,
  },
  { // api-sports date form, NC round
    id: "espn-603993", date: "2026-11-06T20:10:00+00:00", timeTBC: false, round: "4",
    home: T("IRE", "Ireland"), away: T("ARG", "Argentina"),
    comp: { key: "rnc-2026", label: "RNC '26", kind: "competition" },
    venue: "Aviva Stadium, Dublin",
  },
  { // untracked v untracked (registered competition): all.ics only
    id: "espn-700001", date: "2027-09-30T08:00:00.000Z", timeTBC: false,
    home: U("CHI", "Chile"), away: U("HKG", "Hong Kong"),
    comp: { key: "rwc-2027", label: "RWC '27", kind: "competition" }, venue: null,
  },
  { // tour game, unplayed
    id: "seed-tour-x", date: "2026-10-20T14:05:00Z", timeTBC: false,
    home: U("STO", "Stormers"), away: T("NZL", "New Zealand"),
    comp: { key: "tour-nzl-2026", label: "TOUR", kind: "tour" }, venue: "Cape Town Stadium, Cape Town",
  },
];
const COMP_NAMES = {
  "6n-2027": { name: "Six Nations", season: 2027 },
  "rnc-2026": { name: "Nations Championship", season: 2026 },
};
const T1 = "2026-10-11T06:38:50.511Z";
const T2 = "2026-10-12T01:02:03.000Z";
const build = (fixtures = rows(), updatedAt = T1, state = {}) => buildCalendars({ fixtures, updatedAt, state, compNames: COMP_NAMES });
const utcForm = (iso) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");

// ---- primitives ----------------------------------------------------------------

test("escapeText escapes backslash, semicolon, comma and every newline form", () => {
  assert.equal(escapeText("a\\b;c,d\ne\r\nf\rg"), "a\\\\b\\;c\\,d\\ne\\nf\\ng");
  assert.equal(escapeText("plain: colon stays"), "plain: colon stays");
  assert.equal(escapeText(null), "");
});

test("fold: ≤75 octets per physical line, one-space continuations, never inside a character", () => {
  const long = `LOCATION:${"x".repeat(60)}José Amalfitani — 🏉 Buenos Aires ${"y".repeat(80)}`;
  for (let pad = 0; pad < 8; pad++) {
    const line = "X".repeat(pad) + long;
    const folded = fold(line);
    const parts = folded.split("\r\n");
    for (const p of parts) {
      assert.ok(Buffer.byteLength(p) <= 75, `pad ${pad}: ${Buffer.byteLength(p)} octets`);
      assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(p)));
      assert.ok(!p.includes("�"));
    }
    parts.slice(1).forEach((p) => assert.ok(p.startsWith(" ")));
    assert.equal(folded.replace(/\r\n /g, ""), line, "unfolds to the original");
  }
  assert.equal(fold("SHORT:line"), "SHORT:line");
  assert.equal(fold("A".repeat(75)), "A".repeat(75));
  assert.equal(fold("A".repeat(76)), `${"A".repeat(75)}\r\n A`);
});

test("fmtUtc normalises all three feed date forms; garbage throws", () => {
  assert.equal(fmtUtc("2026-10-17T05:00Z"), "20261017T050000Z");
  assert.equal(fmtUtc("2026-10-17T05:00:00.000Z"), "20261017T050000Z");
  assert.equal(fmtUtc("2026-10-17T05:00:00+00:00"), "20261017T050000Z");
  assert.equal(fmtUtc("2026-10-17T16:00:00+11:00"), "20261017T050000Z");
  assert.throws(() => fmtUtc("nope"));
});

test("compNamesFrom reads name + season by key from competitions.json", () => {
  assert.deepEqual(compNamesFrom({ competitions: [{ key: "6n-2027", name: "Six Nations", season: 2027, label: "6N '27" }] }),
    { "6n-2027": { name: "Six Nations", season: 2027 } });
  assert.deepEqual(compNamesFrom(null), {});
});

// ---- the files -----------------------------------------------------------------

test("exactly 13 files: one per tracked nation plus all.ics, every one parses strictly", () => {
  const { files } = build();
  assert.equal(TRACKED_CODES.length, 12);
  assert.deepEqual([...files.keys()], [...TRACKED_CODES.map((c) => `calendar/${c}.ics`), "calendar/all.ics"]);
  for (const [path, text] of files) {
    const { cal } = parseIcs(text);
    assert.equal(prop(cal, "METHOD"), "PUBLISH", path);
    assert.equal(prop(cal, "PRODID"), "-//Rugby Nations Tracker//fixtures//EN");
    assert.equal(prop(cal, "CALSCALE"), "GREGORIAN");
    assert.equal(cal.props.find((p) => p.name === "REFRESH-INTERVAL").params, ";VALUE=DURATION");
    assert.equal(prop(cal, "REFRESH-INTERVAL"), "PT6H");
    assert.equal(prop(cal, "X-PUBLISHED-TTL"), "PT6H");
  }
  const aus = parseIcs(files.get("calendar/AUS.ics")).cal;
  assert.equal(unescapeText(prop(aus, "X-WR-CALNAME")), "Australia fixtures · Rugby Nations Tracker");
  assert.equal(prop(aus, "NAME"), prop(aus, "X-WR-CALNAME"));
  const all = parseIcs(files.get("calendar/all.ics")).cal;
  assert.equal(unescapeText(prop(all, "X-WR-CALNAME")), "All tracked nations · Rugby Nations Tracker");
  // A nation with nothing scheduled still gets a valid, empty calendar.
  assert.equal(parseIcs(files.get("calendar/JPN.ics")).events.length, 0);
});

test("DTSTART is the row's kickoff in UTC form for every date form; DTEND two hours on", () => {
  const all = parseIcs(build().files.get("calendar/all.ics"));
  for (const r of rows()) {
    const e = byUid(all, r.id);
    assert.equal(prop(e, "DTSTART"), utcForm(r.date), r.id);
    assert.equal(prop(e, "DTEND"), utcForm(new Date(new Date(r.date).getTime() + 2 * 3600e3).toISOString()));
  }
});

test("team files hold only that nation's rows, all.ics every row, sorted by date then id", () => {
  const extra = { ...rows()[3], id: "espn-603992" }; // same kickoff as espn-603993, lower id
  const fixtures = [...rows(), extra];
  const { files } = build(fixtures);
  for (const code of TRACKED_CODES) {
    const got = parseIcs(files.get(`calendar/${code}.ics`)).events.map((e) => prop(e, "UID"));
    const want = fixtures
      .filter((r) => r.home.code === code || r.away.code === code)
      .sort((a, b) => new Date(a.date) - new Date(b.date) || (a.id < b.id ? -1 : 1))
      .map((r) => `${r.id}@rugby-nations-tracker`);
    assert.deepEqual(got, want, code);
  }
  const all = parseIcs(files.get("calendar/all.ics")).events.map((e) => prop(e, "UID").split("@")[0]);
  assert.deepEqual(all, ["espn-603498", "espn-603464", "seed-tour-x", "espn-603992", "espn-603993", "seed-6n2027-ire-eng", "espn-700001"]);
});

test("SUMMARY, LOCATION and DESCRIPTION are escaped and read back exactly", () => {
  const odd = {
    id: "espn-800001", date: "2026-12-01T10:00:00.000Z", timeTBC: false,
    home: U("BAR", "Barbarians; Invitational, XV\\Test"), away: T("JPN", "Japan"),
    comp: { key: "test", label: "TEST", kind: "test" },
    venue: "Line one\nLine two; with, punctuation \\ slash",
  };
  const parsed = parseIcs(build([odd]).files.get("calendar/JPN.ics"));
  const e = byUid(parsed, "espn-800001");
  assert.equal(unescapeText(prop(e, "SUMMARY")), "Barbarians; Invitational, XV\\Test v Japan");
  assert.equal(unescapeText(prop(e, "LOCATION")), odd.venue);
  assert.equal(desc(e).split("\n")[0], "Test match.");
});

test("SUMMARY and DESCRIPTION per kind: series, competition round, tour, test", () => {
  const all = parseIcs(build().files.get("calendar/all.ics"));
  const s = (id) => unescapeText(prop(byUid(all, id), "SUMMARY"));
  assert.equal(s("espn-603464"), "Australia v New Zealand · NZ v AUS Game 2/2");
  assert.equal(desc(byUid(all, "espn-603464")).split("\n")[0], "NZ v AUS series, game 2 of 2.");
  assert.equal(s("espn-603993"), "Ireland v Argentina · RNC '26 R4");
  assert.equal(desc(byUid(all, "espn-603993")).split("\n")[0], "Nations Championship 2026, Round 4.");
  assert.equal(s("espn-700001"), "Chile v Hong Kong · RWC '27");
  assert.equal(desc(byUid(all, "espn-700001")).split("\n")[0], "RWC '27.", "unregistered key falls back to the label");
  assert.equal(prop(byUid(all, "espn-700001"), "LOCATION"), null, "no venue, no LOCATION");
  assert.equal(s("seed-tour-x"), "Stormers v New Zealand · Tour");
  assert.equal(desc(byUid(all, "seed-tour-x")).split("\n")[0], "Tour match.");
  for (const e of all.events) {
    const d = desc(e).split("\n");
    assert.equal(d.at(-1), "https://nico101rsa.github.io/rugby-nations-tracker/");
    assert.equal(d.at(-2), "Kickoff times come from ESPN and can move — the app is the live source.");
    assert.equal(prop(e, "TRANSP"), "TRANSPARENT");
    assert.equal(prop(e, "CATEGORIES"), "Rugby");
  }
});

test("a TBC row: TENTATIVE, '(time TBC)' prefix, the caveat line, no alarm — even in a team file", () => {
  const ire = parseIcs(build().files.get("calendar/IRE.ics"));
  const e = byUid(ire, "seed-6n2027-ire-eng");
  assert.equal(prop(e, "STATUS"), "TENTATIVE");
  assert.equal(unescapeText(prop(e, "SUMMARY")), "(time TBC) Ireland v England · 6N '27 R1");
  assert.deepEqual(desc(e).split("\n").slice(0, 2), ["Six Nations 2027, Round 1.", "Kickoff time not yet confirmed — this is the expected slot."]);
  assert.equal(e.children.length, 0);
});

test("a confirmed unplayed row: 30-minute alarm in the team files, none in all.ics", () => {
  const { files } = build();
  for (const code of ["AUS", "NZL"]) {
    const e = byUid(parseIcs(files.get(`calendar/${code}.ics`)), "espn-603464");
    assert.equal(prop(e, "STATUS"), "CONFIRMED");
    assert.equal(e.children.length, 1, code);
    const alarm = e.children[0];
    assert.equal(prop(alarm, "ACTION"), "DISPLAY");
    assert.equal(prop(alarm, "TRIGGER"), "-PT30M");
    assert.equal(unescapeText(prop(alarm, "DESCRIPTION")), "Kick-off in 30 minutes: Australia v New Zealand");
  }
  const all = files.get("calendar/all.ics");
  assert.ok(!all.includes("BEGIN:VALARM"), "all.ics carries no alarms at all");
});

test("a scored row carries no score anywhere — 'Full time' in DESCRIPTION, no alarm", () => {
  const { files } = build();
  for (const path of ["calendar/ARG.ics", "calendar/RSA.ics", "calendar/all.ics"]) {
    const text = files.get(path);
    assert.ok(!/71|86/.test(text), `${path} must not carry 71 or 86`);
    const e = byUid(parseIcs(text), "espn-603498");
    assert.equal(desc(e).split("\n")[0], "Full time — result in the app.");
    assert.equal(e.children.length, 0);
    assert.equal(unescapeText(prop(e, "SUMMARY")), "Argentina v South Africa");
  }
});

test("a live row reads as unplayed: the files are byte-identical to before kickoff", () => {
  const before = build();
  const live = rows();
  Object.assign(live[0], { homeScore: 7, awayScore: 3, status: { short: "1H", live: true } });
  const during = build(live, T2, before.state);
  for (const [path, text] of before.files) assert.equal(during.files.get(path), text, path);
  // Full time flips the DESCRIPTION once, and drops the alarm.
  const ft = rows();
  Object.assign(ft[0], { homeScore: 24, awayScore: 31 });
  const after = build(ft, T2, during.state);
  const e = byUid(parseIcs(after.files.get("calendar/AUS.ics")), "espn-603464");
  assert.equal(desc(e).split("\n")[0], "Full time — result in the app.");
  assert.equal(e.children.length, 0);
  assert.equal(prop(e, "SEQUENCE"), "0", "a result is not a reschedule");
  assert.equal(prop(e, "LAST-MODIFIED"), "20261012T010203Z");
  assert.ok(!/24|31/.test(after.files.get("calendar/AUS.ics").replace(/\d{8}T\d{6}Z/g, "")));
});

// ---- state: SEQUENCE / LAST-MODIFIED / DTSTAMP ------------------------------------

test("no previous state: every SEQUENCE is 0 and every stamp is fixtures.json's updatedAt", () => {
  const all = parseIcs(build().files.get("calendar/all.ics"));
  for (const e of all.events) {
    assert.equal(prop(e, "SEQUENCE"), "0");
    assert.equal(prop(e, "DTSTAMP"), "20261011T063850Z");
    assert.equal(prop(e, "LAST-MODIFIED"), "20261011T063850Z");
  }
});

test("byte-identical for identical input, and for a later updatedAt with no event change", () => {
  const a = build();
  const b = build();
  assert.deepEqual([...a.files], [...b.files]);
  const later = build(rows(), T2, a.state);
  assert.deepEqual([...later.files], [...a.files]);
  assert.deepEqual(later.state, a.state);
});

test("a DTSTART change bumps exactly that UID's SEQUENCE by one and its stamps; siblings untouched", () => {
  const first = build();
  const moved = rows();
  moved[0].date = "2026-10-17T04:45:00.000Z";
  const second = build(moved, T2, first.state);
  const was = parseIcs(first.files.get("calendar/all.ics"));
  const now = parseIcs(second.files.get("calendar/all.ics"));
  const e = byUid(now, "espn-603464");
  assert.equal(prop(e, "SEQUENCE"), "1");
  assert.equal(prop(e, "DTSTART"), "20261017T044500Z");
  assert.equal(prop(e, "LAST-MODIFIED"), "20261012T010203Z");
  assert.equal(prop(e, "DTSTAMP"), "20261012T010203Z");
  for (const r of rows().slice(1)) {
    const before = byUid(was, r.id);
    const after = byUid(now, r.id);
    for (const p of ["SEQUENCE", "DTSTAMP", "LAST-MODIFIED"]) assert.equal(prop(after, p), prop(before, p), `${r.id} ${p}`);
  }
  // Files that don't carry the game are byte-identical.
  for (const code of TRACKED_CODES.filter((c) => c !== "AUS" && c !== "NZL")) {
    assert.equal(second.files.get(`calendar/${code}.ics`), first.files.get(`calendar/${code}.ics`), code);
  }
  // Moving it again counts again.
  const back = rows();
  const third = build(back, "2026-10-13T00:00:00.000Z", second.state);
  assert.equal(prop(byUid(parseIcs(third.files.get("calendar/all.ics")), "espn-603464"), "SEQUENCE"), "2");
});

test("a TBC → confirmed flip at the same time bumps SEQUENCE (STATUS changed)", () => {
  const first = build();
  const confirmed = rows();
  confirmed[1].timeTBC = false;
  const e = byUid(parseIcs(build(confirmed, T2, first.state).files.get("calendar/IRE.ics")), "seed-6n2027-ire-eng");
  assert.equal(prop(e, "STATUS"), "CONFIRMED");
  assert.equal(prop(e, "SEQUENCE"), "1");
  assert.equal(e.children.length, 1, "confirmed now, so the team file gains the alarm");
});

test("a SUMMARY-only change bumps LAST-MODIFIED but not SEQUENCE", () => {
  const first = build();
  const relabelled = rows();
  relabelled[3].comp = { ...relabelled[3].comp, label: "NC '26" };
  const e = byUid(parseIcs(build(relabelled, T2, first.state).files.get("calendar/all.ics")), "espn-603993");
  assert.equal(unescapeText(prop(e, "SUMMARY")), "Ireland v Argentina · NC '26 R4");
  assert.equal(prop(e, "SEQUENCE"), "0");
  assert.equal(prop(e, "LAST-MODIFIED"), "20261012T010203Z");
  assert.equal(prop(e, "DTSTAMP"), "20261012T010203Z");
});

test("a vanished id is pruned from state and from every file", () => {
  const first = build();
  assert.ok(first.state["seed-tour-x@rugby-nations-tracker"]);
  const second = build(rows().filter((r) => r.id !== "seed-tour-x"), T2, first.state);
  assert.equal(second.state["seed-tour-x@rugby-nations-tracker"], undefined);
  for (const text of second.files.values()) assert.ok(!text.includes("seed-tour-x"));
  assert.deepEqual(Object.keys(second.state).sort(), Object.keys(first.state).filter((k) => !k.startsWith("seed-tour-x")).sort());
});

test("eventFor: the body excludes the state-driven lines, so its hash is the change detector", () => {
  const ev = eventFor(rows()[0], { teamFile: true, compNames: COMP_NAMES });
  assert.equal(ev.uid, "espn-603464@rugby-nations-tracker");
  assert.equal(ev.dtstart, "20261017T050000Z");
  assert.equal(ev.dtend, "20261017T070000Z");
  assert.equal(ev.status, "CONFIRMED");
  assert.ok(!ev.body.some((l) => /^(DTSTAMP|LAST-MODIFIED|SEQUENCE|UID):/.test(l)));
  assert.ok(ev.body.includes("BEGIN:VALARM"));
  assert.ok(!eventFor(rows()[0], { teamFile: false, compNames: COMP_NAMES }).body.includes("BEGIN:VALARM"));
});

test("rows without an id or a parseable date are skipped, and a duplicated id appears once", () => {
  const fixtures = [...rows(), { ...rows()[0] }, { ...rows()[3], id: null }, { ...rows()[3], id: "espn-bad", date: "TBC" }];
  const all = parseIcs(build(fixtures).files.get("calendar/all.ics"));
  assert.equal(all.events.length, rows().length);
});

// ---- writeCalendars: only what changed reaches the disk ------------------------------

function memoryFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  const writes = [];
  return {
    files,
    writes,
    fs: {
      readFile: async (path) => {
        if (!files.has(path)) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
        return files.get(path);
      },
      writeFile: async (path, text) => { writes.push(path); files.set(path, text); },
      mkdir: async () => {},
    },
  };
}

test("writeCalendars: first run writes 13 files + state; an identical rerun writes nothing; a change writes only its files", async () => {
  const mem = memoryFs({
    "/r/competitions.json": JSON.stringify({ competitions: [{ key: "6n-2027", name: "Six Nations", season: 2027 }] }),
  });
  const payload = { updatedAt: T1, fixtures: rows() };
  const first = await writeCalendars(payload, { root: "/r", fs: mem.fs });
  assert.equal(first.written.length, 14);
  assert.ok(first.written.includes(STATE_PATH));
  assert.equal(first.unchanged.length, 0);
  // competitions.json reached the DESCRIPTION.
  const ire = parseIcs(mem.files.get("/r/calendar/IRE.ics"));
  assert.equal(desc(byUid(ire, "seed-6n2027-ire-eng")).split("\n")[0], "Six Nations 2027, Round 1.");

  mem.writes.length = 0;
  const again = await writeCalendars({ ...payload, updatedAt: T2 }, { root: "/r", fs: mem.fs });
  assert.deepEqual(again.written, []);
  assert.equal(again.unchanged.length, 14);
  assert.deepEqual(mem.writes, []);

  const moved = rows();
  moved[0].date = "2026-10-17T04:45:00.000Z";
  const third = await writeCalendars({ updatedAt: T2, fixtures: moved }, { root: "/r", fs: mem.fs });
  assert.deepEqual(third.written.sort(), ["calendar/AUS.ics", "calendar/NZL.ics", "calendar/all.ics", STATE_PATH].sort());
  assert.deepEqual(mem.writes.sort(), third.written.map((p) => `/r/${p}`).sort());
  const state = JSON.parse(mem.files.get(`/r/${STATE_PATH}`));
  assert.equal(state["espn-603464@rugby-nations-tracker"].seq, 1);
  assert.equal(state["espn-603464@rugby-nations-tracker"].dtstart, "20261017T044500Z");
  assert.deepEqual(Object.keys(state), Object.keys(state).sort(), "state.json keys are sorted");
});

test("writeCalendars: a missing or corrupt state.json / competitions.json is survivable", async () => {
  const mem = memoryFs({ "/r/calendar/state.json": "{not json", "/r/competitions.json": "also not json" });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const out = await writeCalendars({ updatedAt: T1, fixtures: rows() }, { root: "/r", fs: mem.fs });
    assert.equal(out.written.length, 14);
  } finally {
    console.warn = warn;
  }
});

test("writeCalendars rejects (rather than writing garbage) when updatedAt is unusable", async () => {
  const mem = memoryFs();
  await assert.rejects(() => writeCalendars({ fixtures: rows() }, { root: "/r", fs: mem.fs }));
  assert.deepEqual(mem.writes, []);
});

// ---- the command line: the committed fixtures.json, corrected ------------------

const BLEDISLOE_TABLE = {
  "2026-10-17 AUS-NZL": { date: "2026-10-17T04:45:00.000Z", vendor: "2026-10-17T05:00:00.000Z", note: "test" },
};

test("rebuildFromCommitted: a vendor-time fixtures.json still gives the calendars the corrected kickoff, and is not rewritten", async () => {
  const fixturesJson = JSON.stringify({ updatedAt: T1, source: "espn", fixtures: rows() });
  const mem = memoryFs({ "/r/fixtures.json": fixturesJson });
  const logs = [];
  const out = await rebuildFromCommitted({ root: "/r", fs: mem.fs, table: BLEDISLOE_TABLE, log: (l) => logs.push(l) });
  assert.equal(out.written.length, 14);
  for (const file of ["calendar/AUS.ics", "calendar/NZL.ics", "calendar/all.ics"]) {
    const e = byUid(parseIcs(mem.files.get(`/r/${file}`)), "espn-603464");
    assert.equal(prop(e, "DTSTART"), "20261017T044500Z", file);
    assert.equal(prop(e, "DTEND"), "20261017T064500Z", file);
  }
  assert.deepEqual(logs, ["kickoff override applied: 2026-10-17 AUS-NZL 2026-10-17T05:00Z→2026-10-17T04:45:00.000Z"]);
  assert.equal(mem.files.get("/r/fixtures.json"), fixturesJson, "fixtures.json is the fixtures build's to write");
  assert.ok(!mem.writes.includes("/r/fixtures.json"));
});

test("rebuildFromCommitted: the same bytes as the fixtures build's own calendars, whichever time fixtures.json carries", async () => {
  // What publishFixtures hands writeCalendars: the corrected rows.
  const corrected = rows();
  corrected[0].date = "2026-10-17T04:45:00.000Z";
  const viaBuild = memoryFs();
  await writeCalendars({ updatedAt: T1, fixtures: corrected }, { root: "/r", fs: viaBuild.fs });

  for (const fixtures of [rows(), corrected]) {
    const viaCli = memoryFs({ "/r/fixtures.json": JSON.stringify({ updatedAt: T1, fixtures }) });
    await rebuildFromCommitted({ root: "/r", fs: viaCli.fs, table: BLEDISLOE_TABLE, log: () => {} });
    for (const [path, text] of viaBuild.files) {
      assert.equal(viaCli.files.get(path), text, `${path} (fixtures.json at ${fixtures[0].date})`);
    }
  }
});

test("rebuildFromCommitted: an empty table publishes fixtures.json's own times", async () => {
  const mem = memoryFs({ "/r/fixtures.json": JSON.stringify({ updatedAt: T1, fixtures: rows() }) });
  await rebuildFromCommitted({ root: "/r", fs: mem.fs, table: {}, log: () => {} });
  const e = byUid(parseIcs(mem.files.get("/r/calendar/AUS.ics")), "espn-603464");
  assert.equal(prop(e, "DTSTART"), "20261017T050000Z");
});

test("a projected finals pairing is not an appointment; a listed final is", () => {
  const projected = {
    id: "rnc-2026-final-1", date: "2026-11-29T16:40:00.000Z", timeTBC: false,
    home: T("IRE", "Ireland"), away: T("RSA", "South Africa"),
    comp: { key: "rnc-2026", label: "RNC '26", kind: "competition" }, venue: "Allianz Stadium, Twickenham",
    final: { label: "Grand final", rank: 1, title: true, projected: true },
  };
  const { files } = build([...rows(), projected]);
  const uids = (code) => parseIcs(files.get(`calendar/${code}.ics`)).events.map((e) => prop(e, "UID").split("@")[0]);
  assert.ok(!uids("IRE").includes("rnc-2026-final-1"));
  assert.ok(!uids("all").includes("rnc-2026-final-1"));
  const locked = { ...projected, final: { ...projected.final, projected: false } };
  const { files: f2 } = build([...rows(), locked]);
  assert.ok(parseIcs(f2.get("calendar/IRE.ics")).events.some((e) => prop(e, "UID") === "rnc-2026-final-1@rugby-nations-tracker"));
});
