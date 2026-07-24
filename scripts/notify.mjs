// Shared alert helpers for the watchdog + weekly health check.
//
// Email goes out over the RESEND HTTP API (map #202). It used to go over Gmail
// SMTP with an app password, which does not work from Actions at all: Google
// rejects app-password auth from datacenter IPs with a 535, and the
// 2026-07-12 weekly-health run hard-failed on exactly that. The job has been
// sending nothing ever since. HTTPS to api.resend.com has no such problem, and
// scripts/email-digests.mjs has been delivering the daily briefing over it for
// weeks — this reuses that proven path rather than inventing a second one.
//
// If RESEND_API_KEY isn't set the send is a no-op returning { sent:false }:
// the job still runs and still writes its report file, it just can't email.
//
// ⚠️ Email is the SECONDARY channel. postIssue below is the one that provably
// reaches Nico, and every caller treats email as best-effort.

const RESEND_URL = "https://api.resend.com/emails";
// Same verified sender the daily briefing uses. The recipient is held in a
// secret because this repo is public and its workflow logs are public with it.
const FROM = process.env.NOTIFY_EMAIL_FROM || "Rugby Tracker Ops <rugby@pbimodel.com>";
// Falls back to DIGEST_EMAIL_TO, which already holds the same address and is
// already set — so this port needs no new secret and starts working on merge.
// NOTIFY_TO stays supported for the case where ops mail should go elsewhere.
const RECIPIENT = process.env.NOTIFY_TO || process.env.DIGEST_EMAIL_TO || "";
const ALERT_OWNER = process.env.ALERT_OWNER || "nico101rsa";

// The working delivery channel. Gmail SMTP app-passwords are rejected (535
// BadCredentials) from Actions datacenter IPs — the 2026-07-12 weekly-health run
// hard-failed on exactly that — so email cannot be relied on to reach anyone.
// A GitHub issue can: assigning + @mentioning notifies under GitHub's default
// "Participating and @mentions", whatever the repo's watch setting is.
export async function postIssue({ title, body, assignee = ALERT_OWNER }) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync("gh", [
    "issue", "create",
    "--title", title,
    "--body", `@${assignee}\n\n${body}`,
    "--assignee", assignee,
  ]);
  const url = stdout.trim();
  console.log(`Opened issue: ${url}`);
  return url;
}

// Never print the recipient — these logs are public.
const redact = (addr) => String(addr).replace(/^(.).*(@.*)$/, "$1***$2");

export async function sendEmail({ subject, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log("::notice::RESEND_API_KEY not set — email skipped (report still written, issue still filed)");
    return { sent: false, reason: "no-credentials" };
  }
  if (!RECIPIENT) {
    console.log("::notice::NOTIFY_TO not set — email skipped (report still written, issue still filed)");
    return { sent: false, reason: "no-recipient" };
  }

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [RECIPIENT], subject, text }),
  });

  if (!res.ok) {
    // Loud but never fatal: the committed report is the durable record, and
    // the GitHub issue is the channel that actually reaches him.
    const detail = await res.text();
    console.log(`::warning::email send failed (HTTP ${res.status}): ${detail.slice(0, 200)}`);
    return { sent: false, reason: `http-${res.status}` };
  }
  console.log(`Emailed "${subject}" to ${redact(RECIPIENT)}`);
  return { sent: true };
}
