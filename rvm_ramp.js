/**
 * rvm_ramp.js
 * Enforces RVM daily cap, per-batch size limit, and minimum gap between batches.
 * Tracks submitted campaigns with Slybroadcast session IDs.
 *
 * Env vars (all optional):
 *   RVM_DAILY_CAP      — max RVMs per calendar day (default 50)
 *   RVM_BATCH_SIZE     — max per batch, hard-capped at 25 (default 20)
 *   RVM_BATCH_GAP_MIN  — min minutes between batch end and next batch start (default 30)
 *
 * Persists to DATA_DIR/rvm_ramp.json (Railway volume).
 * Resets automatically at midnight (date change detected on first read).
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const DATA_DIR  = process.env.DATA_DIR || ".";
const RAMP_FILE = path.join(DATA_DIR, "rvm_ramp.json");

export const RVM_DAILY_CAP     = parseInt(process.env.RVM_DAILY_CAP     || "50");
export const RVM_BATCH_SIZE    = Math.min(parseInt(process.env.RVM_BATCH_SIZE   || "20"), 25);
export const RVM_BATCH_GAP_MIN = parseInt(process.env.RVM_BATCH_GAP_MIN || "30");

function freshState() {
  return { date: new Date().toDateString(), submitted: 0, lastBatchAt: null, campaigns: [] };
}

function loadRamp() {
  try {
    const d = JSON.parse(fs.readFileSync(RAMP_FILE, "utf8"));
    return d.date === new Date().toDateString() ? d : freshState();
  } catch { return freshState(); }
}

function saveRamp(d) {
  try {
    fs.mkdirSync(path.dirname(RAMP_FILE), { recursive: true });
    fs.writeFileSync(RAMP_FILE, JSON.stringify(d, null, 2));
  } catch {}
}

/**
 * Check if we're allowed to start a new RVM batch right now.
 * Returns { allowed: true } or { allowed: false, reason, ... }
 */
export function checkRVMBatchAllowed() {
  const d = loadRamp();
  if (d.submitted >= RVM_DAILY_CAP) {
    return {
      allowed: false,
      reason: `daily cap reached (${d.submitted}/${RVM_DAILY_CAP})`,
      submitted: d.submitted,
      cap: RVM_DAILY_CAP,
    };
  }
  if (d.lastBatchAt) {
    const elapsed = (Date.now() - new Date(d.lastBatchAt).getTime()) / 60000;
    if (elapsed < RVM_BATCH_GAP_MIN) {
      return {
        allowed: false,
        reason: `batch gap not met — ${Math.floor(elapsed)}/${RVM_BATCH_GAP_MIN} min since last send`,
        nextAllowedIn: Math.ceil(RVM_BATCH_GAP_MIN - elapsed),
        submitted: d.submitted,
        cap: RVM_DAILY_CAP,
      };
    }
  }
  return {
    allowed: true,
    submitted: d.submitted,
    cap: RVM_DAILY_CAP,
    remaining: RVM_DAILY_CAP - d.submitted,
  };
}

/** How many to send this batch (bounded by batch size AND remaining daily cap). */
export function getRVMBatchLimit() {
  const d = loadRamp();
  const remaining = RVM_DAILY_CAP - d.submitted;
  return Math.min(RVM_BATCH_SIZE, remaining, 25);
}

/**
 * Record one successful RVM submission.
 * Updates lastBatchAt so the gap timer starts from this send.
 */
export function recordRVMSent(sessionId, phone) {
  const d = loadRamp();
  d.submitted++;
  d.lastBatchAt = new Date().toISOString();
  d.campaigns.push({
    sessionId: sessionId || null,
    phone,
    submittedAt: new Date().toISOString(),
    status: "submitted",
  });
  saveRamp(d);
}

/** Stats for /report — includes recent campaign list for dashboard. */
export function getRVMStats() {
  const d = loadRamp();
  const failed = d.campaigns.filter(c => c.status === "failed").length;
  return {
    date:         d.date,
    submitted:    d.submitted,
    failed,
    cap:          RVM_DAILY_CAP,
    remaining:    Math.max(0, RVM_DAILY_CAP - d.submitted),
    batchSize:    RVM_BATCH_SIZE,
    batchGapMin:  RVM_BATCH_GAP_MIN,
    lastBatchAt:  d.lastBatchAt,
    recentCampaigns: d.campaigns.slice(-10),
  };
}
