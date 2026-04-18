/**
 * server.js — Wholesale Bot combined entry point
 * - Runs webhook server (always-on, handles incoming SMS replies)
 * - Runs lead outreach cron at 9am and 5pm Mon-Fri EDT
 */

import cron from "node-cron";
import express from "express";
import dotenv from "dotenv";
dotenv.config();

import { findLeads } from "./lead_finder.js";
import { analyzeProperty, generateOfferMessage } from "./property_analyzer.js";
import { sendOfferSMS, runFollowUps, handleIncomingSMS } from "./sms_bot.js";
import { updateInvestorDatabase } from "./investor_finder.js";
import { loadLog, saveLog, hasBeenContacted, addLead, updateLead, printSummary } from "./leads_log.js";

const app = express();
const PORT = process.env.PORT || 3000;
const DRY_RUN = process.env.DRY_RUN === "true";
const MAX_LEADS = parseInt(process.env.MAX_LEADS_PER_RUN || "20");

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Twilio SMS webhook ────────────────────────────────────────────────────────
app.post("/sms", async (req, res) => {
  const from = req.body.From || req.body.from;
  const body = req.body.Body || req.body.body;
  console.log(`\n📱 Incoming SMS from ${from}: "${body}"`);

  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  try {
    await handleIncomingSMS(from, body);
  } catch (err) {
    console.error("❌ SMS handler error:", err.message);
  }
});

// ── Phone lookup — used by sms-router ────────────────────────────────────────
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
  res.json({ status: "ok", service: "wholesale-bot", time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n✅ Wholesale Bot webhook server running on port ${PORT}`);
});

// ── Main outreach run ─────────────────────────────────────────────────────────
async function runOutreach() {
  console.log(`\n${"=".repeat(55)}`);
  console.log(`  REAL ESTATE WHOLESALE BOT — SCHEDULED RUN`);
  console.log(`  ${new Date().toLocaleString()}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`${"=".repeat(55)}\n`);

  const log = loadLog();
  const leads = await findLeads(MAX_LEADS);

  if (!leads.length) {
    console.log("⚠️  No leads found this run.");
  } else {
    console.log(`\n🚀 Processing ${leads.length} leads...\n`);
    for (const lead of leads) {
      if (hasBeenContacted(log, lead.address)) {
        console.log(`⏭️  Already contacted: ${lead.address}`);
        continue;
      }
      if (!lead.phone) {
        addLead(log, { ...lead, skipReason: "no phone" });
        saveLog(log);
        continue;
      }
      if (!lead.askingPrice || lead.askingPrice < 30000 || lead.askingPrice > 2000000) {
        console.log(`⚠️  Price out of range ($${lead.askingPrice}) — skipping`);
        continue;
      }

      let analysis;
      try {
        analysis = await analyzeProperty(lead);
      } catch (err) {
        console.error(`❌ Analysis failed: ${err.message}`);
        continue;
      }

      if (analysis.dealScore === "pass" || analysis.ourOffer <= 0) {
        addLead(log, { ...lead, analysis, skipReason: "numbers dont work" });
        saveLog(log);
        continue;
      }

      const loggedLead = addLead(log, { ...lead, analysis });
      saveLog(log);

      const offerMessage = await generateOfferMessage(lead, analysis);
      console.log(`📱 Texting ${lead.phone}: "${offerMessage}"`);

      if (!DRY_RUN) {
        try {
          await sendOfferSMS(lead.phone, offerMessage, loggedLead.id);
          updateLead(log, loggedLead.id, { status: "contacted" });
          saveLog(log);
        } catch (err) {
          console.error(`❌ SMS failed: ${err.message}`);
        }
      } else {
        console.log(`[DRY RUN] Would text ${lead.phone}`);
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n📬 Running follow-ups...`);
  await runFollowUps(DRY_RUN);

  try {
    const cities = ["atlanta", "houston", "dallas", "phoenix", "memphis"];
    const city = cities[Math.floor(Math.random() * cities.length)];
    await updateInvestorDatabase(city);
  } catch (err) {
    console.log(`⚠️  Investor scrape failed: ${err.message}`);
  }

  printSummary(loadLog());
}

// ── Cron: 9am and 5pm Mon-Fri EDT ────────────────────────────────────────────
cron.schedule("0 9 * * 1-5", () => {
  console.log("\n⏰ Cron fired: 9am EDT run");
  runOutreach().catch(err => console.error("Outreach error:", err.message));
}, { timezone: "America/New_York" });

cron.schedule("0 17 * * 1-5", () => {
  console.log("\n⏰ Cron fired: 5pm EDT run");
  runOutreach().catch(err => console.error("Outreach error:", err.message));
}, { timezone: "America/New_York" });

console.log("📅 Cron scheduled: 9am and 5pm EDT, Mon-Fri");
