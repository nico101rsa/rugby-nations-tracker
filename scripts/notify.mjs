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
