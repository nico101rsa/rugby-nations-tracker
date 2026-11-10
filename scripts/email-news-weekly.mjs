// Weekly news-quality email: the week's daily review grades, the trend, which
// teams kept missing, and the spend. Nico, 10 Nov 2026: "can i get a weekly
// email of how the newsletter ratings and summary?" One email a week, Monday
// morning Sydney time, covering the previous Monday to Sunday. The daily
// briefing email stays off (#187, 9 Nov: he didn't want daily mails).
//
// Reads only committed files: editorial/reviews/<date>.md (the post-run
// Sonnet review, one per day, the last run's) and editorial/runs/<date>.json
// (that run's report). Transport, secrets and the never-fail rule are the same
// as email-digests.mjs: Resend, DIGEST_EMAIL_TO as a secret, and a skipped
// send never fails the job.
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TZ = "Australia/Sydney";
const RESEND_URL = "https://api.resend.com/emails";
const REVIEW_URL = "https://github.com/nico101rsa/rugby-nations-tracker/blob/main/editorial/reviews";

// ---- grades -----------------------------------------------------------------

const BASE = { A: 4, B: 3, C: 2, D: 1, F: 0 };
export function gradePoints(grade) {
  const m = /^([A-F])([+-])?$/.exec(String(grade ?? "").trim());
  if (!m) return null;
  return Math.round((BASE[m[1]] + (m[2] === "+" ? 0.33 : m[2] === "-" ? -0.33 : 0)) * 100) / 100;
}
export function pointsToGrade(p) {
  if (p === null || !Number.isFinite(p)) return null;
  const letter = ["F", "D", "C", "B", "A"][Math.max(0, Math.min(4, Math.round(p)))];
  const rest = p - BASE[letter];
  return letter + (rest >= 0.165 ? "+" : rest <= -0.165 ? "-" : "");
}
export function averageGrade(grades) {
  const pts = grades.map(gradePoints).filter((x) => x !== null);
  if (!pts.length) return { grade: null, points: null, days: 0 };
  const points = pts.reduce((a, b) => a + b, 0) / pts.length;
  return { grade: pointsToGrade(points), points, days: pts.length };
}

// ---- one daily review ---------------------------------------------------------

const teamsIn = (s) => String(s ?? "").split(/,|\band\b/).map((t) => t.replace(/;.*$/, "").trim()).filter(Boolean);

// The review has drifted in layout since July, but two things are stable: the
// "**Grade: X**" line, and the tally phrases "N retrieval-starved (teams)" and
// "N badly-chosen (teams)".
export function parseReview(md) {
  const text = String(md ?? "");
  const g = /\*\*Grade:\s*([A-F][+-]?)\.?\*\*\s*(.*)/.exec(text);
  if (!g) return null;
  let summary = g[2].trim();
  if (!summary) {
    // "**Grade: C+**" on its own line: the verdict is the next paragraph.
    const after = text.slice(g.index + g[0].length).split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#"));
    summary = after ?? "";
  }
  // "3 retrieval-starved (…)", "3 editions were retrieval-starved (…)",
  // "2 were badly chosen (…)": the count, a few words at most, the label.
  const starved = /(\d+)\s+(?:[a-z]+\s+){0,2}retrieval[- ]starved\s*\(([^)]*)\)/i.exec(text);
  const badly = /(\d+)\s+(?:[a-z]+\s+){0,2}badly[- ]chosen\s*\(([^)]*)\)/i.exec(text);
  return {
    grade: g[1],
    summary: firstSentence(summary.replace(/\*\*/g, "")),
    starved: starved ? teamsIn(starved[2]) : [],
    badlyChosen: badly ? teamsIn(badly[2]) : [],
  };
}

export function firstSentence(s, max = 220) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const one = m ? m[1] : t;
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

// ---- the week -----------------------------------------------------------------

export function sydneyDate(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// The Monday-to-Sunday week before the one `now` falls in, in Sydney dates.
export function previousWeek(now) {
  const today = sydneyDate(now);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat
  const thisMonday = addDays(today, -((dow + 6) % 7));
  const start = addDays(thisMonday, -7);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};

// days: [{ date, review: parseReview() | null, run: runs/<date>.json | null }]
export function summariseWeek(days, previousDays = []) {
  const reviewed = days.filter((d) => d.review);
  const avg = averageGrade(reviewed.map((d) => d.review.grade));
  const prev = averageGrade(previousDays.filter((d) => d.review).map((d) => d.review.grade));
  const count = (key) => {
    const m = new Map();
    for (const d of reviewed) for (const t of d.review[key]) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const runs = days.map((d) => d.run).filter(Boolean);
  // The paid-model block is runs/<date>.json model.anthropic (12 Oct on).
  const paid = (r) => r.model?.anthropic ?? r.model ?? {};
  const spend = runs.reduce((a, r) => a + (paid(r).costUSD ?? 0), 0);
  const failed = runs.reduce((a, r) => a + (paid(r).failed ?? 0), 0);
  const fellBack = runs.reduce((a, r) => a + (paid(r).fellBack ?? 0), 0);
  const ranked = [...reviewed].sort((a, b) => gradePoints(b.review.grade) - gradePoints(a.review.grade));
  return {
    from: days[0]?.date, to: days.at(-1)?.date,
    average: avg, previous: prev,
    trend: avg.points === null || prev.points === null ? null : avg.points - prev.points,
    best: ranked[0] ?? null, worst: ranked.at(-1) ?? null,
    starved: count("starved"), badlyChosen: count("badlyChosen"),
    spend, failed, fellBack, runDays: runs.length,
    days,
  };
}

const trendWords = (t) => (t === null ? "" : t >= 0.165 ? "up" : t <= -0.165 ? "down" : "level");

export function subjectFor(w) {
  const span = `${dayLabel(w.from)} – ${dayLabel(w.to)}`;
  if (!w.average.grade) return `Rugby news, ${span}: no reviews this week`;
  const vs = w.previous.grade ? `, ${trendWords(w.trend)} from ${w.previous.grade}` : "";
  return `Rugby news, ${span}: ${w.average.grade} average${vs}`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const listTeams = (pairs) => pairs.map(([t, n]) => `${t} ${n}×`).join(", ");

export function buildText(w) {
  const L = [subjectFor(w), ""];
  if (w.average.grade) {
    L.push(`Average ${w.average.grade} over ${w.average.days} reviewed day${w.average.days === 1 ? "" : "s"}` +
      (w.previous.grade ? ` (week before: ${w.previous.grade}, ${trendWords(w.trend)}).` : "."));
    if (w.best && w.worst && w.best !== w.worst) L.push(`Best day ${dayLabel(w.best.date)} (${w.best.review.grade}); weakest ${dayLabel(w.worst.date)} (${w.worst.review.grade}).`);
  }
  L.push("", "DAY BY DAY");
  for (const d of w.days) L.push(`- ${dayLabel(d.date)}: ${d.review ? `${d.review.grade}. ${d.review.summary}` : "no review"}`);
  L.push("", "TEAMS THAT KEPT MISSING");
  L.push(`- Short of their own news (retrieval-starved): ${listTeams(w.starved) || "none"}`);
  L.push(`- Led with the wrong story (badly chosen): ${listTeams(w.badlyChosen) || "none"}`);
  L.push("", `SPEND: about US$${w.spend.toFixed(2)} logged over ${w.runDays} day${w.runDays === 1 ? "" : "s"} (each day's last run; Saturday extras are in the Actions log). ${w.failed} failed calls, ${w.fellBack} fell back to Gemini.`);
  L.push("", `Full daily reviews: ${REVIEW_URL}/`);
  return L.join("\n");
}

export function buildHtml(w) {
  const row = (d) => `<tr><td style="padding:4px 10px 4px 0;white-space:nowrap;vertical-align:top">${esc(dayLabel(d.date))}</td>` +
    `<td style="padding:4px 10px 4px 0;font-weight:bold;vertical-align:top">${d.review ? esc(d.review.grade) : "–"}</td>` +
    `<td style="padding:4px 0;vertical-align:top">${d.review ? `${esc(d.review.summary)} <a href="${REVIEW_URL}/${d.date}.md">Full review</a>` : "<i>no review</i>"}</td></tr>`;
  const head = w.average.grade
    ? `<p style="font-size:18px;margin:0 0 4px"><b>${esc(w.average.grade)}</b> average over ${w.average.days} day${w.average.days === 1 ? "" : "s"}` +
      (w.previous.grade ? ` · week before ${esc(w.previous.grade)} (${trendWords(w.trend)})` : "") + `</p>`
    : `<p>No reviews were written this week.</p>`;
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:640px;color:#222">
<h2 style="margin:0 0 8px">Rugby news quality, ${esc(dayLabel(w.from))} – ${esc(dayLabel(w.to))}</h2>
${head}
<h3 style="margin:18px 0 6px">Day by day</h3>
<table style="border-collapse:collapse;font-size:14px">${w.days.map(row).join("")}</table>
<h3 style="margin:18px 0 6px">Teams that kept missing</h3>
<p style="margin:0 0 4px;font-size:14px"><b>Short of their own news:</b> ${esc(listTeams(w.starved) || "none")}</p>
<p style="margin:0;font-size:14px"><b>Led with the wrong story:</b> ${esc(listTeams(w.badlyChosen) || "none")}</p>
<h3 style="margin:18px 0 6px">Spend</h3>
<p style="margin:0;font-size:14px">About US$${w.spend.toFixed(2)} logged over ${w.runDays} day${w.runDays === 1 ? "" : "s"} (each day's last run; Saturday extras are in the Actions log). ${w.failed} failed calls, ${w.fellBack} fell back to Gemini.</p>
<p style="margin:18px 0 0;font-size:12px;color:#777">Sent weekly on Monday morning, Sydney time, by the data repo's "Weekly news email" workflow.</p>
</div>`;
}

// ---- I/O ----------------------------------------------------------------------

async function readIfPresent(path) {
  try { return await readFile(path, "utf8"); } catch { return null; }
}
async function loadDay(date, root = ROOT) {
  const md = await readIfPresent(join(root, "editorial/reviews", `${date}.md`));
  const json = await readIfPresent(join(root, "editorial/runs", `${date}.json`));
  let run = null;
  try { run = json ? JSON.parse(json) : null; } catch { run = null; }
  return { date, review: md ? parseReview(md) : null, run };
}

export async function loadWeek(now, root = ROOT) {
  const week = previousWeek(now);
  const before = week.map((d) => addDays(d, -7));
  return summariseWeek(await Promise.all(week.map((d) => loadDay(d, root))), await Promise.all(before.map((d) => loadDay(d, root))));
}

// Never print the recipient: this repo's logs are public.
const redact = (addr) => String(addr).replace(/^(.).*(@.*)$/, "$1***$2");

export async function main({ now = new Date(), fetchImpl = fetch } = {}) {
  const w = await loadWeek(now);
  const subject = subjectFor(w);
  console.log(subject);
  console.log(buildText(w));
  const key = process.env.RESEND_API_KEY;
  const to = process.env.DIGEST_EMAIL_TO || "";
  const from = process.env.DIGEST_EMAIL_FROM || "Rugby Nations Tracker <onboarding@resend.dev>";
  if (!key) { console.log("::notice::RESEND_API_KEY not set — weekly news email skipped"); return { sent: false }; }
  if (!to) { console.log("::notice::DIGEST_EMAIL_TO not set — weekly news email skipped"); return { sent: false }; }
  const res = await fetchImpl(RESEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html: buildHtml(w), text: buildText(w) }),
  });
  if (!res.ok) {
    console.log(`::warning::weekly news email failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    return { sent: false };
  }
  console.log(`Emailed "${subject}" to ${redact(to)}`);
  return { sent: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // Never fail the job over an email.
    console.log(`::warning::weekly news email skipped: ${e.message}`);
  });
}
