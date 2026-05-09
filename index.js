/**
 * Real Estate Wholesale Bot
 * Trained on: Max Maxwell, Jamil Damji, Brent Daniels, Jerry Norton, Wholesaling Inc
 *
 * Pipeline:
 * 1. Find motivated sellers (Craigslist FSBO, price reduced listings)
 * 2. Analyze property — calculate ARV, repairs, cash offer
 * 3. Text seller with cash offer via Twilio
 * 4. AI handles all replies automatically (Claude)
 * 5. Generate purchase contract when seller accepts
 * 6. Find cash buyer/investor to assign contract to
 * 7. You collect assignment fee ($10K-$30K) at closing
 */

import dotenv from "dotenv";
dotenv.config();

import http from "http";
import cron from "node-cron";

// Keep-alive HTTP server — prevents Railway from auto-sleeping the container
const PORT = process.env.PORT || 3000;
let _lastRunTime = Date.now();
function isBusinessHours() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = now.getHours(), d = now.getDay();
  return d >= 1 && d <= 5 && h >= 8 && h < 21;
}
http.createServer((req, res) => {
  const stale = isBusinessHours() && Date.now() - _lastRunTime > 90 * 60 * 1000;
  if (stale) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: `STALE - no run in ${Math.floor((Date.now() - _lastRunTime) / 60000)}m` }));
  } else {
    res.writeHead(200);
    res.end("wholesale-bot running\n");
  }
}).listen(PORT, () => console.log(`✅ Health server on port ${PORT}`));

import { findLeads } from "./lead_finder.js";
import { analyzeProperty, generateOfferMessage } from "./property_analyzer.js";
import { sendOfferSMS, runFollowUps } from "./sms_bot.js";
import { sendOutreachEmail } from "./email_outreach.js";
import { updateInvestorDatabase, getInvestorCount } from "./investor_finder.js";
import { loadLog, saveLog, hasBeenContacted, addLead, updateLead, printSummary } from "./leads_log.js";
import { queueForColdCall } from "./cold_caller.js";

const DRY_RUN = process.env.DRY_RUN === "true" || process.argv.includes("--dry-run");
const MAX_LEADS = parseInt(process.env.MAX_LEADS_PER_RUN || "50");

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function processLead(lead, log) {
  console.log(`\n${"─".repeat(55)}`);
  console.log(`🏠 ${lead.address || lead.title}`);
  const auctionTag = lead.daysToAuction ? ` | ⏰ AUCTION IN ${lead.daysToAuction} DAYS` : "";
  console.log(`   Asking: $${lead.askingPrice?.toLocaleString() || "unknown"} | Source: ${lead.source}${auctionTag}`);

  // Skip if already contacted
  if (hasBeenContacted(log, lead.address, lead.phone)) {
    console.log(`   ⏭️  Already contacted — skipping`);
    return;
  }

  // Skip if no phone number
  if (!lead.phone) {
    console.log(`   ⚠️  No phone number found — skipping`);
    addLead(log, { ...lead, skipReason: "no phone" });
    saveLog(log);
    return;
  }

  // Skip if asking price is 0 or unrealistic
  if (!lead.askingPrice || lead.askingPrice < 30000 || lead.askingPrice > 2000000) {
    console.log(`   ⚠️  Price out of range ($${lead.askingPrice}) — skipping`);
    return;
  }

  // Analyze property
  let analysis;
  try {
    analysis = await analyzeProperty(lead);
  } catch (err) {
    console.error(`   ❌ Analysis failed: ${err.message}`);
    return;
  }

  console.log(`   ARV: ~$${analysis.estimatedARV?.toLocaleString()} | Repairs: ~$${analysis.estimatedRepairs?.toLocaleString()}`);
  console.log(`   Our offer: $${analysis.ourOffer?.toLocaleString()} | Potential profit: $${analysis.potentialProfit?.toLocaleString()}`);
  console.log(`   Deal score: ${analysis.dealScore}`);

  // Skip bad deals
  if (analysis.dealScore === "pass" || analysis.ourOffer <= 0) {
    console.log(`   🚫 Deal doesn't work at their asking price — skipping`);
    addLead(log, { ...lead, analysis, skipReason: "numbers dont work" });
    saveLog(log);
    return;
  }

  // Add to log
  const loggedLead = addLead(log, { ...lead, analysis });
  saveLog(log);

  // Queue for AI cold call
  await queueForColdCall({ ...lead, id: loggedLead.id, analysis });

  // Generate offer message
  const offerMessage = await generateOfferMessage(lead, analysis);
  console.log(`   📱 Offer message: "${offerMessage}"`);

  // Send SMS
  if (!DRY_RUN) {
    try {
      await sendOfferSMS(lead.phone, offerMessage, loggedLead.id);
      updateLead(log, loggedLead.id, { status: "contacted" });
      saveLog(log);
    } catch (err) {
      console.error(`   ❌ SMS failed: ${err.message}`);
    }

    // Also email if skip trace found one
    if (lead.email) {
      try {
        await sendOutreachEmail(lead, analysis);
        console.log(`   📧 Email sent to ${lead.email}`);
        updateLead(log, loggedLead.id, { emailSent: true });
        saveLog(log);
      } catch (err) {
        console.error(`   ❌ Email failed: ${err.message}`);
      }
    }
  } else {
    console.log(`   [DRY RUN] Would text ${lead.phone}${lead.email ? ` + email ${lead.email}` : ""}`);
  }

  await sleep(1000);
}

function isBusinessHours() {
  const hour = parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  return hour >= 8 && hour < 21;
}

// ── Catch-up emails: send to any existing leads with emails not yet contacted ──
async function catchUpEmails() {
  if (DRY_RUN || !isBusinessHours()) return;
  const log = loadLog();
  const pending = (log.leads || []).filter(l => l.email && !l.emailSent && !l.unsubscribed);
  if (!pending.length) return;
  console.log(`\n📧 Catch-up emails: ${pending.length} leads with emails not yet contacted`);
  for (const lead of pending) {
    try {
      await sendOutreachEmail(lead, lead.analysis || {});
      console.log(`   ✉️  Emailed ${lead.email} — ${lead.address}`);
      updateLead(log, lead.id, { emailSent: true, emailSentAt: new Date().toISOString() });
      saveLog(log);
      await sleep(1500);
    } catch (err) {
      console.error(`   ❌ Email failed for ${lead.email}: ${err.message}`);
    }
  }
}

async function main() {
  console.log(`\n${"=".repeat(55)}`);
  console.log(`  REAL ESTATE WHOLESALE BOT`);
  console.log(`  ${new Date().toLocaleString()}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`  Investors in database: ${getInvestorCount()}`);
  console.log(`${"=".repeat(55)}\n`);

  const log = loadLog();

  // Step 1: Find motivated seller leads
  const leads = await findLeads(MAX_LEADS);

  if (!leads.length) {
    console.log("⚠️  No leads found this run.");
  } else {
    console.log(`\n🚀 Processing ${leads.length} leads...\n`);
    for (const lead of leads) {
      await processLead(lead, log);
    }
  }

  // Step 2: Catch-up emails for existing leads
  await catchUpEmails();

  // Step 3: Run follow-ups on existing leads
  console.log(`\n${"─".repeat(55)}`);
  console.log(`📬 Running follow-ups...`);
  await runFollowUps(DRY_RUN);

  // Step 3: Build investor database in background
  console.log(`\n${"─".repeat(55)}`);
  console.log(`💼 Building investor database...`);
  try {
    const cities = ["atlanta", "houston", "dallas", "phoenix", "memphis"];
    const randomCity = cities[Math.floor(Math.random() * cities.length)];
    await updateInvestorDatabase(randomCity);
  } catch (err) {
    console.log(`   ⚠️  Investor scrape failed: ${err.message}`);
  }

  printSummary(log);
}

// Run immediately on startup (business hours only)
if (isBusinessHours()) main().catch(err => console.error("Startup run failed:", err.message));
else console.log("Outside business hours (8am–9pm ET) — skipping startup run");

// Every hour 8am–9pm ET
cron.schedule("0 8,9,10,11,12,13,14,15,16,17,18,19,20,21 * * *", () => {
  _lastRunTime = Date.now();
  console.log(`\n⏰ Scheduled run — ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}`);
  main().catch(err => console.error("Scheduled run failed:", err.message));
}, { timezone: "America/New_York" });

console.log("⏰ Scheduler active — runs at 9am, 12pm, 3pm, 6pm, 8pm ET daily");
