// Shared email helper for the watchdog + weekly health check.
//
// Sends from nico101rsa@gmail.com via Gmail SMTP (app password). The Life-os
// gmail_send.py uses local OAuth (Mac-only), which a headless Actions runner
// can't use — so cloud jobs authenticate with a Gmail App Password instead,
// stored as the GMAIL_APP_PASSWORD secret (GMAIL_USER overrides the address).
//
// If the secret isn't set yet the send is a no-op that returns { sent:false }:
// the job still runs and still writes its report file, it just can't email.

const GMAIL_USER = process.env.GMAIL_USER || "nico101rsa@gmail.com";
const RECIPIENT = process.env.NOTIFY_TO || "nico.mcdonald@outlook.com";
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

export async function sendEmail({ subject, text }) {
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!pass) {
    console.log("::notice::GMAIL_APP_PASSWORD not set — email skipped (report still written)");
    return { sent: false, reason: "no-credentials" };
  }
  // nodemailer is npm-installed --no-save by the workflow, same pattern the
  // digest job uses for the Anthropic SDK.
  const { default: nodemailer } = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass },
  });
  await transport.sendMail({
    from: `Rugby Tracker Ops <${GMAIL_USER}>`,
    to: RECIPIENT,
    subject,
    text,
  });
  console.log(`Emailed "${subject}" to ${RECIPIENT}`);
  return { sent: true };
}
