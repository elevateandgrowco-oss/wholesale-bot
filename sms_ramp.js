/**
 * sms_ramp.js
 * SMS sending rate limiter for post-Twilio-A2P-approval ramp.
 *
 * Ramp schedule (per bot, per day):
 *   Day 1:  max 50
 *   Day 2:  max 100
 *   Day 3:  max 150
 *   ...
 *   Day 10+: max 500 (steady state)
 *
 * Override with SMS_DAILY_LIMIT env var.
 * Approval date read from TWILIO_A2P_APPROVED_DATE env var (ISO date: "2026-05-15").
 */

import fs from "fs";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const RAMP_FILE = path.join(DATA_DIR, "sms_ramp.json");

function loadRamp() {
  try {
    if (fs.existsSync(RAMP_FILE)) return JSON.parse(fs.readFileSync(RAMP_FILE, "utf8"));
  } catch {}
  return { approvedDate: null, history: [] };
}

function saveRamp(r) {
  fs.mkdirSync(path.dirname(RAMP_FILE), { recursive: true });
  fs.writeFileSync(RAMP_FILE, JSON.stringify(r, null, 2));
}

/** Return the maximum SMS allowed today based on ramp schedule. */
export function getDailySMSLimit() {
  if (process.env.SMS_DAILY_LIMIT) return parseInt(process.env.SMS_DAILY_LIMIT, 10);

  // Get approval date from env var or stored ramp file
  const approvedDate = process.env.TWILIO_A2P_APPROVED_DATE || loadRamp().approvedDate;
  if (!approvedDate) return 0; // Not approved yet

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysSince = Math.floor((Date.now() - new Date(approvedDate).getTime()) / msPerDay);
  const dayNum = Math.max(1, daysSince + 1); // Day 1 on approval day
  return Math.min(50 * dayNum, 500); // Cap at 500/day steady state
}

/** How many SMS have been sent today by this bot. */
export function getSMSSentToday() {
  const ramp = loadRamp();
  const today = new Date().toISOString().slice(0, 10);
  return ramp.history.find(h => h.date === today)?.sent || 0;
}

/** Record that N SMS were sent (call after successful send). */
export function recordSMSSent(n = 1) {
  const ramp = loadRamp();
  const today = new Date().toISOString().slice(0, 10);
  let entry = ramp.history.find(h => h.date === today);
  if (!entry) {
    entry = { date: today, sent: 0 };
    ramp.history.push(entry);
    if (ramp.history.length > 30) ramp.history.shift(); // keep 30 days
  }
  entry.sent += n;
  saveRamp(ramp);
  return entry.sent;
}

/**
 * Check if sending another SMS is within today's ramp limit.
 * Call AFTER checkOutreachAllowed(lead, "sms") passes.
 */
export function checkSMSRampAllowed() {
  const limit = getDailySMSLimit();
  const sent = getSMSSentToday();
  if (limit === 0) {
    return { allowed: false, reason: "SMS_RAMP_NOT_APPROVED", sent, limit };
  }
  if (sent >= limit) {
    return { allowed: false, reason: "SMS_RAMP_DAILY_LIMIT", sent, limit, remaining: 0 };
  }
  return { allowed: true, sent, limit, remaining: limit - sent };
}
