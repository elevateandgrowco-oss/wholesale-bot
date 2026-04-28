/**
 * sms_bot.js
 * Handles all SMS outreach and AI-powered conversation via Twilio.
 * - Sends initial offer texts
 * - Handles seller replies with Claude AI
 * - Manages follow-up sequences
 */

import twilio from "twilio";
import dotenv from "dotenv";
import { dropVoicemail } from "./voicemail_dropper.js";
import { handleSellerReply } from "./property_analyzer.js";
import { loadLog, saveLog, getLead, updateLead } from "./leads_log.js";
dotenv.config();

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const FROM = process.env.TWILIO_PHONE;

// ── Send initial offer SMS ────────────────────────────────────────────────────
export async function sendOfferSMS(phone, message, leadId) {
  if (!phone) throw new Error("No phone number");

  // Format phone
  const formatted = phone.replace(/[^0-9]/g, "");
  const e164 = formatted.startsWith("1") ? `+${formatted}` : `+1${formatted}`;

  await dropVoicemail(phone);

  // Mark voicemail sent immediately so lead isn't re-processed if SMS fails
  const log = loadLog();
  updateLead(log, leadId, {
    voicemailSent: true,
    voicemailSentAt: new Date().toISOString(),
  });
  saveLog(log);

  try {
    const result = await client.messages.create({ body: message, from: FROM, to: e164 });
    console.log(`   ✉️  SMS sent to ${e164} — SID: ${result.sid}`);
    updateLead(log, leadId, {
      smsSent: true,
      smsSentAt: new Date().toISOString(),
      twilioSid: result.sid,
      conversation: [{ role: "assistant", content: message, timestamp: new Date().toISOString() }],
    });
    saveLog(log);
    return result.sid;
  } catch (err) {
    console.log(`   ⏭️  SMS skipped (Twilio not ready): ${err.message}`);
    return null;
  }
}

// ── Send follow-up SMS ────────────────────────────────────────────────────────
export async function sendFollowUpSMS(phone, message, leadId, followUpNum) {
  const formatted = phone.replace(/[^0-9]/g, "");
  const e164 = formatted.startsWith("1") ? `+${formatted}` : `+1${formatted}`;

  const result = await client.messages.create({
    body: message,
    from: FROM,
    to: e164,
  });

  console.log(`   ✉️  Follow-up #${followUpNum} sent to ${e164}`);

  const log = loadLog();
  const lead = getLead(log, leadId);
  if (lead) {
    const conv = lead.conversation || [];
    conv.push({ role: "assistant", content: message, timestamp: new Date().toISOString() });
    updateLead(log, leadId, {
      [`followUp${followUpNum}SentAt`]: new Date().toISOString(),
      conversation: conv,
    });
    saveLog(log);
  }

  return result.sid;
}

// ── Handle incoming SMS reply from seller ─────────────────────────────────────
export async function handleIncomingSMS(fromPhone, body) {
  console.log(`\n📱 Incoming SMS from ${fromPhone}: "${body}"`);

  // Find lead by phone number
  const log = loadLog();
  const lead = log.leads.find(l =>
    l.phone && l.phone.replace(/[^0-9]/g, "").endsWith(fromPhone.replace(/[^0-9]/g, "").slice(-10))
  );

  if (!lead) {
    console.log(`   ⚠️  No lead found for ${fromPhone}`);
    return;
  }

  console.log(`   📍 Matched lead: ${lead.address}`);

  // Check for unsubscribe
  const unsubscribeWords = ["stop", "unsubscribe", "quit", "cancel", "remove"];
  if (unsubscribeWords.some(w => body.toLowerCase().includes(w))) {
    updateLead(log, lead.id, { unsubscribed: true });
    saveLog(log);
    await client.messages.create({
      body: "You've been removed from our list. Sorry to bother you!",
      from: FROM,
      to: fromPhone,
    });
    return;
  }

  // Build conversation history
  const conv = lead.conversation || [];
  const history = conv.map(m => ({ role: m.role, content: m.content }));

  // Generate AI reply
  const aiReply = await handleSellerReply(lead, lead.analysis, body, history);
  console.log(`   🤖 AI reply: "${aiReply}"`);

  // Send reply
  await client.messages.create({
    body: aiReply,
    from: FROM,
    to: fromPhone,
  });

  // Update conversation log
  conv.push({ role: "user", content: body, timestamp: new Date().toISOString() });
  conv.push({ role: "assistant", content: aiReply, timestamp: new Date().toISOString() });
  updateLead(log, lead.id, {
    conversation: conv,
    lastReplyAt: new Date().toISOString(),
    status: "in_conversation",
  });
  saveLog(log);

  // Check if seller seems interested — notify owner by SMS
  const interestedKeywords = ["interested", "offer", "how much", "cash", "when", "close", "yes", "sure", "tell me more", "okay", "deal", "accept"];
  if (interestedKeywords.some(w => body.toLowerCase().includes(w))) {
    console.log(`\n🔥 HOT LEAD — ${lead.address} — Seller replied: "${body}"`);
    console.log(`   Your offer: $${lead.analysis?.ourOffer?.toLocaleString()}`);
    console.log(`   Phone: ${fromPhone}`);
    // Alert owner
    try {
      await client.messages.create({
        body: `🔥 HOT LEAD (Houses)\n${lead.address}\nSeller said: "${body}"\nOffer: $${lead.analysis?.ourOffer?.toLocaleString()}\nCall/text them: ${fromPhone}`,
        from: FROM,
        to: "+14017716184",
      });
    } catch (e) {
      console.error("Alert failed:", e.message);
    }
  }
}

// ── Run follow-ups on leads that haven't replied ──────────────────────────────
export async function runFollowUps(dryRun = false) {
  const log = loadLog();
  const now = Date.now();

  const DAY = 24 * 60 * 60 * 1000;

  for (const lead of log.leads) {
    if (!lead.phone || lead.unsubscribed || lead.status === "closed") continue;

    const sentAt = lead.smsSentAt ? new Date(lead.smsSentAt).getTime() : null;
    if (!sentAt) continue;

    const daysSinceSent = (now - sentAt) / DAY;
    const hasReplied = lead.conversation?.some(m => m.role === "user");

    const firstName = lead.ownerName ? lead.ownerName.split(" ")[0] : null;
    const hey = firstName ? `Hey ${firstName}` : "Hey";
    const shortAddr = lead.address.split(",")[0];
    const offer = lead.analysis?.ourOffer ? `$${lead.analysis.ourOffer.toLocaleString()}` : "something fair";

    // Follow-up 1: Day 3
    if (!lead.followUp1SentAt && daysSinceSent >= 3 && !hasReplied) {
      const msg = `${hey}, did my text come through about ${shortAddr}? - Jon`;
      if (!dryRun) {
        await sendFollowUpSMS(lead.phone, msg, lead.id, 1);
      } else {
        console.log(`[DRY RUN] Would send follow-up 1 to ${lead.phone}`);
      }
    }

    // Follow-up 2: Day 7
    if (!lead.followUp2SentAt && daysSinceSent >= 7 && !hasReplied) {
      const msg = `${hey}, still interested in ${shortAddr} if you'd consider ${offer}. No rush either way — Jon`;
      if (!dryRun) {
        await sendFollowUpSMS(lead.phone, msg, lead.id, 2);
      } else {
        console.log(`[DRY RUN] Would send follow-up 2 to ${lead.phone}`);
      }
    }
  }
}
