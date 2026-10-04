// Shared alert helpers for the watchdog, the weekly health check and the data
// checks (rankings, competitions, vendor probe, box-score stats).
//
// WHO GETS PINGED (2026-10-04). Nico asked for the review to be done by Claude,
// not by him: the near-daily issue comments and Thursday reports were noise he
// was "not in the mood to review". So there are two tiers, and this file holds
// the one decision that separates them:
//
//   - SILENT (the default). A finding is written down — a committed report, a
//     status file, or an issue with no @mention and no assignee — and the
//     scheduled Claude weekly review reads it, triages it, and escalates only
//     what genuinely needs Nico (its own "🚨 Weekly review" issue).
//   - PAGE (`page: true`). Assigned to Nico and @mentioning him, which notifies
//     under GitHub's default "Participating and @mentions" whatever his watch
//     setting is. Only the watchdog pages, and only for a user-facing job still
//     down after an automatic re-run (see scripts/watchdog.mjs).
//
// A caller that wants Nico's attention has to say so; forgetting the flag
// fails quiet, which is the right way round for a hobby app with a weekly
// reviewer.
//
// Email goes out over the RESEND HTTP API (map #202) and works — the
// 2026-10-01 weekly-health and 2026-10-04 watchdog runs both logged a
// successful send. It is opt-in now (HEALTH_EMAIL=1 on the weekly report);
// nothing emails by default. Gmail SMTP, the old transport,
// is rejected from Actions datacenter IPs with a 535 and must not come back.
//
// If RESEND_API_KEY isn't set the send is a no-op returning { sent:false }.

const RESEND_URL = "https://api.resend.com/emails";
// Same verified sender the daily briefing uses. The recipient is held in a
// secret because this repo is public and its workflow logs are public with it.
const FROM = process.env.NOTIFY_EMAIL_FROM || "Rugby Tracker Ops <rugby@pbimodel.com>";
// Falls back to DIGEST_EMAIL_TO, which already holds the same address.
// NOTIFY_TO stays supported for the case where ops mail should go elsewhere.
const RECIPIENT = process.env.NOTIFY_TO || process.env.DIGEST_EMAIL_TO || "";
export const ALERT_OWNER = process.env.ALERT_OWNER || "nico101rsa";

// Pure: the `gh` argv for a new issue. Silent unless `page` is set — no
// @mention in the body and no assignee, so the issue reaches the weekly
// review's triage without notifying anyone. (Whether Nico is WATCHING the repo
// is his account setting; a watched repo still notifies on every new issue,
// which is why the silent tier files issues only for rare data-correctness
// tickets and keeps routine findings in committed files instead.)
export function issueCreateArgs({ title, body, page = false, owner = ALERT_OWNER }) {
  const args = ["issue", "create", "--title", title, "--body", page ? `@${owner}\n\n${body}` : body];
  if (page) args.push("--assignee", owner);
  return args;
}

async function defaultGh(args) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("gh", args);
  return stdout;
}

// Files an issue. Silent by default (see above); pass `page: true` only for a
// user-facing outage that has already outlived an automatic retry.
export async function postIssue({ title, body, page = false, owner = ALERT_OWNER, gh = defaultGh }) {
  const url = String(await gh(issueCreateArgs({ title, body, page, owner }))).trim();
  console.log(`Opened issue${page ? ` (paging ${owner})` : " (silent — for the weekly review)"}: ${url}`);
  return url;
}

// Never print the recipient — these logs are public.
const redact = (addr) => String(addr).replace(/^(.).*(@.*)$/, "$1***$2");

export async function sendEmail({ subject, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log("::notice::RESEND_API_KEY not set — email skipped (report still written)");
    return { sent: false, reason: "no-credentials" };
  }
  if (!RECIPIENT) {
    console.log("::notice::NOTIFY_TO not set — email skipped (report still written)");
    return { sent: false, reason: "no-recipient" };
  }

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [RECIPIENT], subject, text }),
  });

  if (!res.ok) {
    // Loud but never fatal: the committed report is the durable record, and
    // the Claude weekly review reads that, not the mailbox.
    const detail = await res.text();
    console.log(`::warning::email send failed (HTTP ${res.status}): ${detail.slice(0, 200)}`);
    return { sent: false, reason: `http-${res.status}` };
  }
  console.log(`Emailed "${subject}" to ${redact(RECIPIENT)}`);
  return { sent: true };
}
