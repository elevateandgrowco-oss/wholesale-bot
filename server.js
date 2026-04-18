/**
 * server.js — Wholesale Bot combined entry point
 * - Starts HTTP server immediately (Railway health check passes)
 * - Loads local modules dynamically in background
 * - Runs lead outreach cron at 9am and 5pm EDT daily
 */

import cron from "node-cron";
import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const DRY_RUN = process.env.DRY_RUN === "true";
const MAX_LEADS = parseInt(process.env.MAX_LEADS_PER_RUN || "20");

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Module references — filled after dynamic load
let m = {};
let modReady = false;
let modError = null;

// ── Health check — always responds immediately ────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "wholesale-bot",
    modules: modReady ? "ready" : (modError ? "error: " + modError : "loading"),
    time: new Date().toISOString(),
  });
});

// ── Twilio SMS webhook ────────────────────────────────────────────────────────
app.post("/sms", async (req, res) => {
  const from = req.body.From || req.body.from;
  const body = req.body.Body || req.body.body;
  console.log(`\n📱 Incoming SMS from ${from}: "${body}"`);

  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  if (!modReady) return;
  try {
    await m.handleIncomingSMS(from, body);
  } catch (err) {
    console.error("❌ SMS handler error:", err.message);
  }
});

// ── Phone lookup — used by sms-router ────────────────────────────────────────
app.post("/lookup", (req, res) => {
  if (!modReady) return res.json({ found: false });
  const log = m.loadLog();
  const digits = (req.body.phone || "").replace(/[^0-9]/g, "").slice(-10);
  const found = log.leads.some(l =>
    l.phone && l.phone.replace(/[^0-9]/g, "").slice(-10) === digits && l.smsSent
  );
  res.json({ found });
});

// ── Start HTTP server FIRST ───────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ Wholesale Bot webhook server running on port ${PORT}`);
});

// ── Load modules dynamically (after server is up) ────────────────────────────
async function loadModules() {
  try {
    console.log("⏳ Loading modules...");
    const lf = await import("./lead_finder.js");
    const pa = await import("./property_analyzer.js");
    const sb = await import("./sms_bot.js");
    const inf = await import("./investor_finder.js");
    const ll = await import("./leads_log.js");

    m = {
      findLeads: lf.findLeads,
      analyzeProperty: pa.analyzeProperty,
      generateOfferMessage: pa.generateOfferMessage,
      sendOfferSMS: sb.sendOfferSMS,
      runFollowUps: sb.runFollowUps,
      handleIncomingSMS: sb.handleIncomingSMS,
      updateInvestorDatabase: inf.updateInvestorDatabase,
      loadLog: ll.loadLog,
      saveLog: ll.saveLog,
      hasBeenContacted: ll.hasBeenContacted,
      addLead: ll.addLead,
      updateLead: ll.updateLead,
      printSummary: ll.printSummary,
    };
    modReady = true;
    console.log("✅ All modules loaded — bot is ready");
  } catch (err) {
    modError = err.message;
    console.error("❌ Module load failed:", err.message, err.stack);
  }
}

loadModules();

// ── Main outreach run ─────────────────────────────────────────────────────────
async function runOutreach() {
  if (!modReady) {
    console.log("⚠️  Modules not ready yet — skipping run");
    return;
  }
  console.log(`\n${"=".repeat(55)}`);
  console.log(`  REAL ESTATE WHOLESALE BOT — SCHEDULED RUN`);
  console.log(`  ${new Date().toLocaleString()}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`${"=".repeat(55)}\n`);

  const log = m.loadLog();
  const leads = await m.findLeads(MAX_LEADS);

  if (!leads.length) {
    console.log("⚠️  No leads found this run.");
  } else {
    console.log(`\n🚀 Processing ${leads.length} leads...\n`);
    for (const lead of leads) {
      if (m.hasBeenContacted(log, lead.address)) {
        console.log(`⏭️  Already contacted: ${lead.address}`);
        continue;
      }
      if (!lead.phone) {
        m.addLead(log, { ...lead, skipReason: "no phone" });
        m.saveLog(log);
        continue;
      }
      if (!lead.askingPrice || lead.askingPrice < 30000 || lead.askingPrice > 2000000) {
        console.log(`⚠️  Price out of range ($${lead.askingPrice}) — skipping`);
        continue;
      }

      let analysis;
      try {
        analysis = await m.analyzeProperty(lead);
      } catch (err) {
        console.error(`❌ Analysis failed: ${err.message}`);
        continue;
      }

      if (analysis.dealScore === "pass" || analysis.ourOffer <= 0) {
        m.addLead(log, { ...lead, analysis, skipReason: "numbers dont work" });
        m.saveLog(log);
        continue;
      }

      const loggedLead = m.addLead(log, { ...lead, analysis });
      m.saveLog(log);

      const offerMessage = await m.generateOfferMessage(lead, analysis);
      console.log(`📱 Texting ${lead.phone}: "${offerMessage}"`);

      if (!DRY_RUN) {
        try {
          await m.sendOfferSMS(lead.phone, offerMessage, loggedLead.id);
          m.updateLead(log, loggedLead.id, { status: "contacted" });
          m.saveLog(log);
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
  await m.runFollowUps(DRY_RUN);

  try {
    const cities = ["atlanta", "houston", "dallas", "phoenix", "memphis"];
    const city = cities[Math.floor(Math.random() * cities.length)];
    await m.updateInvestorDatabase(city);
  } catch (err) {
    console.log(`⚠️  Investor scrape failed: ${err.message}`);
  }

  m.printSummary(m.loadLog());
}

// ── Cron: 9am and 5pm EDT daily ──────────────────────────────────────────────
cron.schedule("0 9 * * *", () => {
  console.log("\n⏰ Cron fired: 9am EDT run");
  runOutreach().catch(err => console.error("Outreach error:", err.message));
}, { timezone: "America/New_York" });

cron.schedule("0 17 * * *", () => {
  console.log("\n⏰ Cron fired: 5pm EDT run");
  runOutreach().catch(err => console.error("Outreach error:", err.message));
}, { timezone: "America/New_York" });

console.log("📅 Cron scheduled: 9am and 5pm EDT daily");
