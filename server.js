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

// ── Run tracking + daily stats ────────────────────────────────────────────────
let lastRunAt = null;
let lastRunStatus = "never";
let lastRunDuration = null;
let runCount = 0;

const _stats = {
  date: new Date().toISOString().slice(0, 10),
  leadsScraped: 0, rvmSent: 0, rvmBlocked: 0,
  smsSent: 0, smsBlocked: 0, smsRampBlocked: 0,
  emailsSent: 0, callsExported: 0,
  dncBlocks: 0, quietBlocks: 0, unknownTzBlocks: 0, dupBlocks: 0,
  lastOutreachAt: null,
};
function _stat(key, n = 1) {
  const d = new Date().toISOString().slice(0, 10);
  if (_stats.date !== d) Object.assign(_stats, { date: d, leadsScraped:0, rvmSent:0, rvmBlocked:0, smsSent:0, smsBlocked:0, smsRampBlocked:0, emailsSent:0, callsExported:0, dncBlocks:0, quietBlocks:0, unknownTzBlocks:0, dupBlocks:0, lastOutreachAt:null });
  if (key in _stats) _stats[key] += n;
}

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

// ── Health check (Railway probes this) ───────────────────────────────────────
app.get("/health", (req, res) => {
  const etHour = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false });
  const h = parseInt(etHour);
  const stale = lastRunAt && h >= 9 && h < 21 && (Date.now() - new Date(lastRunAt).getTime()) > 3 * 60 * 60 * 1000;
  res.status(stale ? 503 : 200).json({
    status: stale ? "stale" : "ok",
    bot: "wholesale-bot",
    modReady,
    lastRun: lastRunAt,
    lastRunStatus,
    smsOutboundEnabled: process.env.SMS_OUTBOUND_ENABLED !== "false",
    twilioA2pApproved: process.env.TWILIO_A2P_APPROVED !== "false",
    slybroadcastEnabled: !!(process.env.SLYBROADCAST_EMAIL && process.env.SLYBROADCAST_PASSWORD),
    uptime: process.uptime(),
  });
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

// ── Operational report ────────────────────────────────────────────────────────
app.get("/report", (req, res) => {
  const log = modReady ? m.loadLog() : null;
  const leads = log?.leads || [];

  // Guard status
  const smsEnabled   = process.env.SMS_OUTBOUND_ENABLED !== "false";
  const a2pApproved  = process.env.TWILIO_A2P_APPROVED  !== "false";
  const slybr        = !!(process.env.SLYBROADCAST_EMAIL && process.env.SLYBROADCAST_PASSWORD);
  const vapiReady    = !!process.env.VAPI_API_KEY;
  const resendReady  = !!(process.env.RESEND_API_KEY && process.env.FROM_EMAIL);
  const smsBlocked   = !smsEnabled || !a2pApproved;

  // Per-channel eligibility (DNC/opted-out/bad-number filtered out first)
  const activeLeads = leads.filter(l => !l.doNotCall && !l.dnc && !l.unsubscribed && !l.badNumber);
  const eligSMS   = activeLeads.filter(l => l.phone && !l.smsSent && !["under_contract","assigned","closed"].includes(l.status)).length;
  const eligRVM   = activeLeads.filter(l => l.phone && !l.voicemailSent).length;
  const eligCall  = activeLeads.filter(l => l.phone && !l.coldCalledAt).length;
  const eligEmail = activeLeads.filter(l => l.email && !l.emailSent).length;
  const eligFollowUp = activeLeads.filter(l => l.phone && l.smsSentAt && !l.followUp4SentAt && !["under_contract","assigned","closed"].includes(l.status)).length;

  // Queue by state (top markets)
  const byState = {};
  for (const l of activeLeads) {
    const s = l.state || (l.address || "").match(/,\s*([A-Z]{2})/i)?.[1]?.toUpperCase() || "?";
    byState[s] = (byState[s] || 0) + 1;
  }
  const topMarkets = Object.entries(byState).sort((a,b) => b[1]-a[1]).slice(0,10).map(([s,n]) => ({ state: s, leads: n }));

  // Next scheduled runs
  const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h = etNow.getHours(), dow = etNow.getDay();
  const isWorkHours = dow >= 1 && dow <= 5 && h >= 9 && h < 21;

  const OUTREACH_HOURS = [8,10,12,14,16,18,20];
  const EMAIL_HOURS    = [8,11,14,17];
  const nextOutreach = OUTREACH_HOURS.find(x => x > h) ?? OUTREACH_HOURS[0];
  const nextEmail    = EMAIL_HOURS.find(x => x > h)    ?? EMAIL_HOURS[0];

  const aliveNoWork = isWorkHours && runCount > 0 && _stats.smsSent === 0 && _stats.rvmSent === 0 && _stats.emailsSent === 0;

  res.json({
    status: "ok",
    bot: "wholesale-bot",
    generatedAt: new Date().toISOString(),
    aliveButZeroWork: aliveNoWork,
    warning: aliveNoWork ? "ALIVE BUT ZERO WORK — check provider credentials and lead data" : null,

    providers: {
      smsOutboundEnabled: smsEnabled,
      twilioA2pApproved: a2pApproved,
      smsBlocked,
      slybroadcastConfigured: slybr,
      vapiConfigured: vapiReady,
      emailConfigured: resendReady,
    },

    today: {
      date: _stats.date,
      leadsScraped:    _stats.leadsScraped,
      smsSent:         _stats.smsSent,
      smsBlocked:      _stats.smsBlocked,
      smsRampBlocked:  _stats.smsRampBlocked,
      rvmSent:         _stats.rvmSent,
      rvmBlocked:      _stats.rvmBlocked,
      emailsSent:      _stats.emailsSent,
      callsExported:   _stats.callsExported,
      dncBlocks:       _stats.dncBlocks,
      quietBlocks:     _stats.quietBlocks,
      unknownTzBlocks: _stats.unknownTzBlocks,
      dupBlocks:       _stats.dupBlocks,
      lastOutreachAt:  _stats.lastOutreachAt,
    },

    queue: {
      total:          leads.length,
      active:         activeLeads.length,
      dncOptOut:      leads.length - activeLeads.length,
    },

    eligible: {
      sms:      { count: eligSMS,      note: smsBlocked ? "BLOCKED — pending Twilio A2P" : "ready" },
      rvm:      { count: eligRVM,      note: slybr ? "ready" : "BLOCKED — no Slybroadcast credentials" },
      call:     { count: eligCall,     note: vapiReady ? "ready" : "BLOCKED — no VAPI_API_KEY" },
      email:    { count: eligEmail,    note: resendReady ? "ready" : "BLOCKED — no RESEND_API_KEY/FROM_EMAIL" },
      followUp: { count: eligFollowUp, note: smsBlocked ? "BLOCKED — pending Twilio A2P" : "ready" },
    },

    topMarkets,

    schedule: {
      nextOutreachRun: `${nextOutreach}:00 ET`,
      nextEmailRun:    `${nextEmail}:00 ET`,
      nextFollowUpRun: "every 20 min",
      nextReportLog:   "every hour",
    },

    health: {
      modReady,
      lastRun: lastRunAt,
      lastRunStatus,
      lastRunDuration,
      runCount,
      isWorkHours,
      dryRun: DRY_RUN,
    },
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

// ── Cold call leads export — pulled by ai-coldcall-bot ───────────────────────
app.get("/cold-call-leads", (req, res) => {
  if (!modReady) return res.json([]);
  const log = m.loadLog();
  const leads = (log?.leads || [])
    .filter(l => l.phone && !l.unsubscribed && !l.coldCalledAt && !l.doNotCall && !["under_contract", "assigned", "closed"].includes(l.status))
    .slice(0, 50)
    .map(l => ({
      id: l.id,
      source: "wholesale_bot",
      ownerName: l.owner || l.ownerName || "there",
      phone: l.phone,
      address: l.address || null,
      ourOffer: l.analysis?.ourOffer || null,
    }));
  res.json(leads);
});

// ── Cold call update — ai-coldcall-bot notifies outcome ───────────────────────
app.post("/cold-call-update", (req, res) => {
  if (!modReady) return res.json({ ok: false });
  const { id, phone, status } = req.body;
  const log = m.loadLog();
  const digits = (phone || "").replace(/\D/g, "").slice(-10);
  const lead = log.leads.find(l => l.id === id || (digits && l.phone?.replace(/\D/g, "").slice(-10) === digits));
  if (lead) {
    lead.coldCalledAt = new Date().toISOString();
    if (status === "do_not_call") lead.doNotCall = true;
    m.saveLog(log);
    _stat("callsExported");
  }
  res.json({ ok: true });
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

// ── Cron: Email pending leads — 8am, 11am, 2pm, 5pm ET ──────────────────────
cron.schedule("0 8,11,14,17 * * *", async () => {
  if (!modReady) return;
  console.log("\n📧 Email batch run starting...");
  const log = m.loadLog();
  let sent = 0;
  for (const lead of log.leads) {
    if (!lead.email || lead.emailSent || lead.unsubscribed || lead.doNotCall) continue;
    if (!lead.analysis) continue;
    try {
      await m.sendOutreachEmail(lead, lead.analysis);
      m.updateLead(log, lead.id, { emailSent: true, emailSentAt: new Date().toISOString() });
      _stat("emailsSent");
      _stats.lastOutreachAt = new Date().toISOString();
      sent++;
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`  ❌ Email failed for ${lead.email}: ${err.message}`);
    }
  }
  m.saveLog(log);
  console.log(`  📧 Email batch done — ${sent} sent`);
}, { timezone: "America/New_York" });

// ── Cron: Check for SMS/follow-up replies — every 20 min ─────────────────────
cron.schedule("*/20 * * * *", async () => {
  if (!modReady) return;
  try {
    await m.runFollowUps(DRY_RUN);
  } catch (err) {
    console.error("Follow-up check error:", err.message);
  }
});

// ── Cron: Hourly + EOD report log ─────────────────────────────────────────────
cron.schedule("0 * * * *", () => {
  const log = modReady ? m.loadLog() : null;
  const leads = log?.leads || [];
  console.log(`\n📊 HOURLY REPORT — ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}`);
  console.log(`   Today: SMS=${_stats.smsSent} RVM=${_stats.rvmSent} Email=${_stats.emailsSent} Calls=${_stats.callsExported}`);
  console.log(`   Blocks: DNC=${_stats.dncBlocks} Quiet=${_stats.quietBlocks} UnkTZ=${_stats.unknownTzBlocks} Dup=${_stats.dupBlocks}`);
  console.log(`   Queue: ${leads.length} total | Last run: ${lastRunAt || "never"}`);
});

console.log("📅 Cron scheduled: every 2 hours, 8am–8pm ET, Mon–Fri (7 runs/day)");
