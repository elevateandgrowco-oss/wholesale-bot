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

// ── Run tracking ──────────────────────────────────────────────────────────────
let lastRunAt = null;
let lastRunStatus = "never";
let lastRunDuration = null;
let runCount = 0;

async function runAndTrack() {
  const start = Date.now();
  runCount++;
  lastRunStatus = "running";
  try {
    await runOutreach();
    lastRunStatus = "success";
  } catch (err) {
    lastRunStatus = "error: " + err.message;
    console.error("Run error:", err.message);
  } finally {
    lastRunAt = new Date().toISOString();
    lastRunDuration = ((Date.now() - start) / 1000).toFixed(1) + "s";
  }
}

// ── Health check — always responds immediately ────────────────────────────────
app.get("/", (req, res) => {
  const modStatus = modReady ? "ready" : (modError ? `error: ${modError}` : "loading");
  const modClass = modReady ? "ok" : (modError ? "err" : "warn");
  const log = modReady ? m.loadLog() : null;
  const leads = log?.leads || [];
  const contacted = leads.filter(l => l.smsSent).length;
  const replied = leads.filter(l => l.conversation?.some(c => c.role === "user")).length;
  const underContract = leads.filter(l => l.status === "under_contract").length;
  res.send(`<!DOCTYPE html><html><head><title>Wholesale Bot</title>
<style>body{font-family:monospace;background:#0a0a0a;color:#e0e0e0;padding:32px;max-width:600px}
h1{color:#22c55e}table{width:100%;border-collapse:collapse;margin-top:16px}
td{padding:8px 12px;border-bottom:1px solid #222}td:first-child{color:#888;width:40%}
.ok{color:#22c55e}.err{color:#ef4444}.warn{color:#f59e0b}</style></head>
<body><h1>Wholesale Bot</h1>
<table>
<tr><td>Status</td><td class="${modClass}">${modStatus}</td></tr>
<tr><td>Mode</td><td>${DRY_RUN ? "DRY RUN" : "LIVE"}</td></tr>
<tr><td>Last run</td><td>${lastRunAt || "never"}</td></tr>
<tr><td>Last status</td><td class="${lastRunStatus === "success" ? "ok" : lastRunStatus === "running" ? "warn" : lastRunStatus === "never" ? "" : "err"}">${lastRunStatus}</td></tr>
<tr><td>Last duration</td><td>${lastRunDuration || "—"}</td></tr>
<tr><td>Total runs</td><td>${runCount}</td></tr>
<tr><td>Total leads</td><td>${leads.length}</td></tr>
<tr><td>SMS sent</td><td>${contacted}</td></tr>
<tr><td>Replied</td><td>${replied}</td></tr>
<tr><td>Under contract</td><td class="${underContract > 0 ? "ok" : ""}">${underContract}</td></tr>
<tr><td>Schedule</td><td>9am &amp; 5pm EDT daily</td></tr>
<tr><td>Max leads/run</td><td>${MAX_LEADS}</td></tr>
<tr><td>Server time</td><td>${new Date().toISOString()}</td></tr>
</table>
<br><a href="/run" style="display:inline-block;padding:12px 28px;background:#22c55e;color:#000;font-weight:bold;text-decoration:none;border-radius:6px;font-size:1.1em">▶ Run Now</a>
</body></html>`);
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

// ── Stats JSON endpoint ───────────────────────────────────────────────────────
app.get("/stats", (req, res) => {
  const log = modReady ? m.loadLog() : null;
  const leads = log?.leads || [];
  const contacted = leads.filter(l => l.smsSent).length;
  const voicemails = leads.filter(l => l.voicemailSent).length;
  const replied = leads.filter(l => l.conversation?.some(c => c.role === "user")).length;
  const underContract = leads.filter(l => l.status === "under_contract").length;
  res.json({
    status: modReady ? "ready" : (modError ? "error" : "loading"),
    lastRun: lastRunAt,
    lastRunStatus,
    totalLeads: leads.length,
    smsSent: contacted,
    voicemailsSent: voicemails,
    replied,
    underContract,
  });
});

// ── Manual trigger — POST (API) or GET (browser button) ──────────────────────
async function triggerRun(res) {
  if (!modReady) return res.json({ status: "error", message: "modules not ready" });
  res.json({ status: "ok", message: "run started — check Railway logs" });
  runAndTrack().catch(err => console.error("Manual run error:", err.message));
}
app.post("/run", (req, res) => triggerRun(res));
app.get("/run",  (req, res) => triggerRun(res));

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
    const eo = await import("./email_outreach.js");

    m = {
      findLeads: lf.findLeads,
      analyzeProperty: pa.analyzeProperty,
      generateOfferMessage: pa.generateOfferMessage,
      sendOfferSMS: sb.sendOfferSMS,
      runFollowUps: sb.runFollowUps,
      handleIncomingSMS: sb.handleIncomingSMS,
      updateInvestorDatabase: inf.updateInvestorDatabase,
      sendOutreachEmail: eo.sendOutreachEmail,
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

        // Also email if skip trace found one (double touch = more responses)
        if (lead.email) {
          try {
            await m.sendOutreachEmail(lead, analysis);
            console.log(`   📧 Email sent to ${lead.email}`);
            m.updateLead(log, loggedLead.id, { emailSent: true });
            m.saveLog(log);
          } catch (err) {
            console.error(`❌ Email failed: ${err.message}`);
          }
        }
      } else {
        console.log(`[DRY RUN] Would text ${lead.phone}${lead.email ? ` + email ${lead.email}` : ""}`);
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

// ── Cron: every 2 hours, 8am–8pm ET, Mon–Fri ─────────────────────────────────
cron.schedule("0 8,10,12,14,16,18,20 * * 1-5", () => {
  const hour = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: true });
  console.log(`\n⏰ Scheduled run (${hour} ET)`);
  runAndTrack().catch(err => console.error("Outreach error:", err.message));
}, { timezone: "America/New_York" });

console.log("📅 Cron scheduled: every 2 hours, 8am–8pm ET, Mon–Fri (7 runs/day)");
