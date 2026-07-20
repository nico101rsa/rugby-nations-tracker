// Daily briefing email: the twelve editions plus the run report, sent after the
// digest workflow publishes.
//
// Transport is Resend's HTTP API, not SMTP and not Gmail. Two reasons, both
// deliberate (Nico's call 2026-07-20):
//   - SMTP from a GitHub runner gets 535'd on datacenter IP reputation.
//   - This workflow lives in a PUBLIC repo. A Gmail send-scope token here could
//     send mail as him from his personal account; a Resend key can only send
//     from a sending domain and is revocable in one click. Same exposure, much
//     smaller blast radius.
//
// The whole thing is skipped, loudly but harmlessly, when RESEND_API_KEY is
// unset — exactly like the model keys. A missing email must never fail a run
// whose editions already published.
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TZ = "Australia/Sydney";

// No default recipient in the source. This repo is PUBLIC — a hard-coded
// address would be committed in the clear, which is exactly what the secret
// exists to avoid. No address configured means no email, loudly.
const TO = process.env.DIGEST_EMAIL_TO || "";

// Logs of this workflow are public. Actions masks secrets, but only if they
// appear verbatim — never print the address, masked or not.
export const redact = (addr) => {
  const [user = "", domain = ""] = String(addr).split("@");
  return user && domain ? `${user.slice(0, 2)}***@${domain.replace(/^[^.]*/, "***")}` : "(unset)";
};
// Sender comes from the DIGEST_EMAIL_FROM repo variable, set to an address on
// Nico's already-verified pbimodel.com. Preferred over Resend's shared
// onboarding@resend.dev for two reasons: the shared sender only ever delivers
// to the Resend account owner, and Outlook treats a sender shared by thousands
// of accounts far more harshly than a DKIM-signed domain of one's own.
const FROM = process.env.DIGEST_EMAIL_FROM || "Rugby Nations Tracker <onboarding@resend.dev>";
const RESEND_URL = "https://api.resend.com/emails";

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---- pure composition -------------------------------------------------------

export function subjectFor(report) {
  const { editions = 0, quiet = 0, failed = 0 } = report?.counts ?? {};
  const bits = [`${editions}/12 editions`];
  if (quiet) bits.push(`${quiet} quiet`);
  if (failed) bits.push(`${failed} FAILED`);
  return `Rugby briefings — ${report?.date ?? "today"} (${bits.join(", ")})`;
}

// One team block: what published, and underneath it what retrieval offered, so
// a bland edition can be diagnosed without opening the Actions log.
function teamBlock(t) {
  const candidates = (t.candidates ?? [])
    .map((c, n) => {
      const picked = t.lead?.candidate === n + 1;
      const corrob = c.corroboration > 1 ? ` · ${c.corroboration} outlets` : "";
      return `<li style="margin:0 0 2px;${picked ? "color:#111;font-weight:600" : "color:#8a8a8a"}">
        ${picked ? "▸ " : ""}${esc(c.title)} <span style="color:#aaa">(${c.score}${esc(corrob)})</span>
      </li>`;
    })
    .join("");

  return `<div style="margin:0 0 26px;padding:0 0 20px;border-bottom:1px solid #e6e6e6">
    <div style="font:600 11px/1.4 -apple-system,Segoe UI,sans-serif;letter-spacing:1.6px;text-transform:uppercase;color:#6b7f70">
      ${esc(t.team)}${t.quiet ? ' <span style="color:#b26b00">· quiet</span>' : ""} · ${esc(t.kicker)}
    </div>
    <div style="font:700 19px/1.25 Georgia,serif;color:#111;margin:5px 0 0">${esc(t.heading)}</div>
    <p style="font:400 15px/1.6 Georgia,serif;color:#333;margin:8px 0 0">${esc(t.body)}</p>
    ${t.source ? `<div style="font:400 12px/1.4 -apple-system,sans-serif;color:#999;margin:8px 0 0">Source: ${esc(t.source)}</div>` : ""}
    ${candidates ? `<details style="margin:10px 0 0"><summary style="font:400 12px/1.4 -apple-system,sans-serif;color:#999;cursor:pointer">What retrieval offered${t.lead?.why ? " · why this one" : ""}</summary>
      ${t.lead?.why ? `<div style="font:400 12px/1.5 -apple-system,sans-serif;color:#777;margin:6px 0 4px"><em>${esc(t.lead.why)}</em></div>` : ""}
      <ul style="font:400 12px/1.5 -apple-system,sans-serif;margin:4px 0 0;padding:0 0 0 16px">${candidates}</ul>
    </details>` : ""}
  </div>`;
}

export function buildEmailHtml(report, reviewMarkdown = "") {
  const { editions = 0, quiet = 0, failed = 0, noLead = 0 } = report?.counts ?? {};
  const teams = report?.teams ?? [];

  const summary = `<div style="background:#f4f6f4;border-radius:8px;padding:12px 14px;margin:0 0 26px;font:400 13px/1.6 -apple-system,Segoe UI,sans-serif;color:#333">
    <strong>${editions}/12 editions</strong>${quiet ? ` · <span style="color:#b26b00">${quiet} written on thin coverage</span>` : ""}${noLead ? ` · ${noLead} recorded no lead` : ""}${failed ? ` · <span style="color:#b00020">${failed} failed</span>` : ""}
    ${(report?.failed ?? []).length ? `<div style="margin:6px 0 0;color:#b00020">${report.failed.map((f) => `${esc(f.team)}: ${esc(f.reason)}`).join("<br>")}</div>` : ""}
  </div>`;

  // The review is markdown; keep it as preformatted text rather than pulling in
  // a renderer for one block a day.
  const review = reviewMarkdown
    ? `<div style="margin:30px 0 0;padding:16px 0 0;border-top:2px solid #111">
        <div style="font:600 11px/1.4 -apple-system,sans-serif;letter-spacing:1.6px;text-transform:uppercase;color:#6b7f70;margin:0 0 8px">Editorial review</div>
        <pre style="font:400 12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#444;white-space:pre-wrap;margin:0">${esc(reviewMarkdown)}</pre>
      </div>`
    : "";

  return `<div style="max-width:640px;margin:0 auto;padding:24px 18px;background:#fff">
    <div style="font:700 22px/1.2 Georgia,serif;color:#111">Rugby Nations Tracker</div>
    <div style="font:400 13px/1.4 -apple-system,sans-serif;color:#999;margin:2px 0 22px">Daily briefings · ${esc(report?.date ?? "")}</div>
    ${summary}
    ${teams.map(teamBlock).join("")}
    ${review}
    <div style="font:400 11px/1.5 -apple-system,sans-serif;color:#bbb;margin:26px 0 0">
      Generated by the generate-digests workflow. Briefings are written from published team news.
    </div>
  </div>`;
}

// ---- I/O --------------------------------------------------------------------

function todayISO(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function main({ now = new Date() } = {}) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log("RESEND_API_KEY not set — daily briefing email skipped");
    return { skipped: "no-key" };
  }
  if (!TO) {
    console.log("DIGEST_EMAIL_TO not set — daily briefing email skipped");
    return { skipped: "no-recipient" };
  }

  const dateISO = todayISO(now);
  const raw = await readIfPresent(join(ROOT, "editorial", "runs", `${dateISO}.json`));
  if (!raw) {
    console.warn(`no run report for ${dateISO} — nothing to email`);
    return { skipped: "no-report" };
  }
  const report = JSON.parse(raw);
  const review = await readIfPresent(join(ROOT, "editorial", "reviews", `${dateISO}.md`));

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [TO], subject: subjectFor(report), html: buildEmailHtml(report, review) }),
  });

  if (!res.ok) {
    // Loud, but never fatal — the editions are already published and live.
    const detail = await res.text();
    console.error(`email send failed (HTTP ${res.status}): ${detail.slice(0, 300)}`);
    return { failed: res.status };
  }
  console.log(`daily briefing email sent to ${redact(TO)} (${report.counts?.editions ?? 0} editions)`);
  return { sent: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
