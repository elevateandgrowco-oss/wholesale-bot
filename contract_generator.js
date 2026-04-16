/**
 * contract_generator.js
 * Generates a real estate wholesale purchase contract as plain text
 * and emails it to the seller via Resend.
 */

import { Resend } from "resend";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { WHOLESALING_KNOWLEDGE } from "./knowledge.js";
dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Generate contract text with Claude ────────────────────────────────────────
async function generateContract(lead, analysis, closingDate) {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const closing = closingDate || new Date(Date.now() + 21 * 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const msg = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: WHOLESALING_KNOWLEDGE,
    messages: [{
      role: "user",
      content: `Generate a real estate wholesale purchase and sale agreement with these details:

Property Address: ${lead.address}
Buyer: Jon Dior and/or assigns
Seller: [SELLER NAME]
Purchase Price: $${analysis.ourOffer?.toLocaleString()}
Earnest Money: $100 (held in escrow)
Closing Date: ${closing}
Date of Agreement: ${today}

Include:
- Property description clause
- "And/or assigns" buyer clause
- As-is condition clause
- Inspection period: 10 days
- Earnest money terms
- Closing cost split (each party pays own)
- Assignment rights clause
- Default clause
- Signature lines for buyer and seller

Format as a clean, professional contract. Use standard real estate legal language.`,
    }],
  });

  return msg.content[0].text;
}

// ── Send contract via email ────────────────────────────────────────────────────
export async function sendContract(lead, analysis, sellerEmail, sellerName) {
  console.log(`  📄 Generating contract for ${lead.address}...`);

  const contractText = await generateContract(lead, analysis);

  const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px;">
  <h2>Purchase and Sale Agreement</h2>
  <p>Dear ${sellerName || "Property Owner"},</p>
  <p>Thank you for speaking with us about ${lead.address}. As discussed, please find our purchase agreement below.</p>
  <p>To accept this offer, please reply to this email with your signature (typed name + date is acceptable), or we can arrange a DocuSign if preferred.</p>
  <hr>
  <pre style="white-space: pre-wrap; font-family: Georgia, serif; font-size: 13px; line-height: 1.8;">
${contractText}
  </pre>
  <hr>
  <p>Questions? Reply to this email or call/text us directly.</p>
  <p>— Jon Dior<br>${process.env.YOUR_PHONE || ""}</p>
</body>
</html>`;

  await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to: sellerEmail,
    subject: `Purchase Agreement — ${lead.address}`,
    html: emailHtml,
  });

  console.log(`  ✅ Contract sent to ${sellerEmail}`);
  return contractText;
}
