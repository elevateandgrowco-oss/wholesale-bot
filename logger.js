/**
 * logger.js — shared status logger for all bots
 * Drop this file into any bot directory.
 * Usage:
 *   import { sendLog } from './logger.js';
 *   const BOT = 'my-bot-name';
 *   await sendLog(BOT, 'RUNNING', 'Starting scan');
 *   await sendLog(BOT, 'OK_ACTION', 'Executed trade: BUY BTC @ $104k', durationMs);
 *   await sendLog(BOT, 'OK_NO_ACTION', 'No signals found', durationMs);
 *   await sendLog(BOT, 'FAILED', err.message);
 *
 * Valid statuses: RUNNING | OK_ACTION | OK_NO_ACTION | FAILED | PAUSED
 */

const STATUS_BOT_URL = "https://status-bot-dashboard-production.up.railway.app/log";

export async function sendLog(bot, status, message = "", duration = null) {
  try {
    await fetch(STATUS_BOT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot, status, message: String(message).slice(0, 200), duration }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Never block the bot — logging failures are silent
  }
}
