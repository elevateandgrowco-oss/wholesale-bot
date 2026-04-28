/**
 * leads_log.js
 * JSON database for tracking all leads, conversations, and deals
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const DATA_DIR = process.env.DATA_DIR || ".";
const LOG_FILE = path.join(DATA_DIR, "leads.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadLog() {
  if (!fs.existsSync(LOG_FILE)) return { leads: [], stats: { totalLeads: 0, smsSent: 0, replied: 0, underContract: 0, closed: 0 } };
  try { return JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); }
  catch { return { leads: [], stats: {} }; }
}

export function saveLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

export function hasBeenContacted(log, address) {
  return log.leads.some(l => l.address === address && (l.smsSent || l.voicemailSent));
}

export function addLead(log, leadData) {
  const id = crypto.randomBytes(6).toString("hex");
  const lead = { id, ...leadData, addedAt: new Date().toISOString(), status: "new" };
  log.leads.push(lead);
  log.stats = log.stats || {};
  log.stats.totalLeads = (log.stats.totalLeads || 0) + 1;
  return lead;
}

export function getLead(log, id) {
  return log.leads.find(l => l.id === id);
}

export function updateLead(log, id, updates) {
  const lead = log.leads.find(l => l.id === id);
  if (lead) Object.assign(lead, updates);
  return lead;
}

export function printSummary(log) {
  const stats = log.stats || {};
  const leads = log.leads || [];
  const contacted = leads.filter(l => l.smsSent).length;
  const replied = leads.filter(l => l.conversation?.some(m => m.role === "user")).length;
  const contracts = leads.filter(l => l.status === "under_contract").length;
  const closed = leads.filter(l => l.status === "closed").length;

  console.log(`\n${"=".repeat(55)}`);
  console.log(`  WHOLESALE BOT SUMMARY`);
  console.log(`${"=".repeat(55)}`);
  console.log(`  Total leads:      ${leads.length}`);
  console.log(`  SMS sent:         ${contacted}`);
  console.log(`  Replies received: ${replied}`);
  console.log(`  Under contract:   ${contracts}`);
  console.log(`  Closed deals:     ${closed}`);
  console.log(`${"=".repeat(55)}\n`);
}
