/**
 * email_outreach.js
 * Sends a plain-text outreach email to land owners when skip trace finds their email.
 * Uses Resend — same as google-maps-bot.
 */

import { Resend } from "resend";
import dotenv from "dotenv";
dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_NAME  = process.env.FROM_NAME  || "Jon";
const FROM_EMAIL = process.env.FROM_EMAIL;
const PHYSICAL_ADDRESS = process.env.PHYSICAL_ADDRESS || "548 Market St PMB 12345, San Francisco, CA 94104";

const SUBJECTS = [
  (addr) => `Question about your property on ${addr}`,
  (addr) => `Your lot on ${addr}`,
  (addr) => `Interested in ${addr}`,
  (addr) => `Quick question — ${addr}`,
];

export async function sendOutreachEmail(lead, analysis) {
  if (!FROM_EMAIL || !process.env.RESEND_API_KEY) return;
  if (!lead.email) return;

  const shortAddr = lead.address.split(",")[0];
  const firstName = lead.ownerName ? lead.ownerName.split(" ")[0] : null;
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const subjectFn = SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)];
  const subject = subjectFn(shortAddr);

  const body = `${greeting}

I came across your property on ${shortAddr} and wanted to reach out directly to see if you'd ever consider selling.

I buy houses in this area and could make it pretty simple on your end — no agents, no listing, just a straightforward deal if the number works for both of us.

If you're open to it, what would you need to get for it?

- ${FROM_NAME}`;

  await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: lead.email,
    subject,
    text: `${body}\n\n---\n${FROM_NAME} · ${PHYSICAL_ADDRESS}`,
    html: `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;font-size:15px;line-height:1.8;color:#111">
      ${body.split("\n").map(l => l ? `<p style="margin:0 0 12px">${l}</p>` : "<br>").join("")}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0">
      <p style="font-size:12px;color:#9ca3af">${FROM_NAME} · ${PHYSICAL_ADDRESS}</p>
    </div>`,
  });
}
