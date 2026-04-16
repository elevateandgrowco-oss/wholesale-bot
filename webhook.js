/**
 * webhook.js
 * Twilio webhook server — handles incoming SMS replies from sellers.
 *
 * Setup:
 *   1. Run: node webhook.js
 *   2. Expose with ngrok: ngrok http 3001
 *   3. Set Twilio webhook URL in console:
 *      Messaging → Phone Numbers → +18663695752 → Messaging → Webhook
 *      Set "When a message comes in" to: https://YOUR-NGROK-URL/sms
 *
 * For permanent hosting: deploy this to Railway alongside the main bot.
 */

import express from "express";
import { handleIncomingSMS } from "./sms_bot.js";
import { loadLog } from "./leads_log.js";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Twilio SMS webhook ────────────────────────────────────────────────────────
app.post("/sms", async (req, res) => {
  const from = req.body.From || req.body.from;
  const body = req.body.Body || req.body.body;

  console.log(`\n📱 Webhook hit: from=${from}, body="${body}"`);

  // Respond to Twilio immediately (required within 15 sec)
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>"); // Empty response — we send reply separately

  // Handle reply asynchronously
  try {
    await handleIncomingSMS(from, body);
  } catch (err) {
    console.error("❌ Error handling SMS:", err.message);
  }
});

// ── Phone lookup — used by SMS router to find which bot owns a number ────────
app.post("/lookup", (req, res) => {
  const log = loadLog();
  const digits = (req.body.phone || "").replace(/[^0-9]/g, "").slice(-10);
  const found = log.leads.some(l =>
    l.phone && l.phone.replace(/[^0-9]/g, "").slice(-10) === digits && l.smsSent
  );
  res.json({ found });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "wholesale-bot-webhook", time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n✅ Webhook server running on port ${PORT}`);
  console.log(`   POST /sms — Twilio incoming message handler`);
  console.log(`\n   To expose publicly:`);
  console.log(`   ngrok http ${PORT}`);
  console.log(`   Then set Twilio webhook to: https://YOUR-NGROK/sms\n`);
});
