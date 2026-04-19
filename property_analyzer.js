/**
 * property_analyzer.js
 * Calculates ARV, repairs estimate, and cash offer using
 * Jerry Norton / Max Maxwell formula:
 * MAO = ARV × 70% - Repairs
 * Offer = MAO - Assignment Fee ($15K-$25K)
 */

import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import * as cheerio from "cheerio";
import dotenv from "dotenv";
import { WHOLESALING_KNOWLEDGE } from "./knowledge.js";
dotenv.config();

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ASSIGNMENT_FEE = 20000; // Target $20K per deal
const ARV_MULTIPLIER = 0.70;  // Standard 70% rule

// ── Estimate ARV from Zillow Zestimate ────────────────────────────────────────
async function getZestimate(address, city) {
  try {
    const query = encodeURIComponent(`${address} ${city}`);
    const res = await axios.get(`https://www.zillow.com/search/GetSearchPageState.htm?searchQueryState={"usersSearchTerm":"${query}"}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      timeout: 10000,
    });
    // Try to extract zestimate from response
    const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
    const results = data?.cat1?.searchResults?.listResults || [];
    if (results.length > 0) {
      return results[0].zestimate || results[0].price || null;
    }
  } catch {
    // Zestimate fetch failed — use AI estimation
  }
  return null;
}

// ── Estimate repairs based on property description ────────────────────────────
async function estimateRepairs(description, askingPrice) {
  try {
    const msg = await claude.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `Based on this property description, estimate repair costs in USD. Return ONLY a number (no $ sign, no text).

Property description: "${description || "No description available"}"
Asking price: $${askingPrice}

Repair estimate (just the number):`,
      }],
    });
    const num = parseInt(msg.content[0].text.replace(/[^0-9]/g, ""));
    return isNaN(num) ? 25000 : Math.min(num, 150000);
  } catch {
    return 25000; // Default $25K repairs if AI fails
  }
}

// ── Main analysis function ─────────────────────────────────────────────────────
export async function analyzeProperty(lead) {
  const { address, city, askingPrice, description } = lead;

  console.log(`  📊 Analyzing: ${address}`);

  // Step 1: Get ARV
  let arv = await getZestimate(address, city);

  if (!arv) {
    // Estimate ARV from asking price (FSBO sellers usually ask near market value)
    arv = askingPrice * 1.05; // Assume listed slightly below market
  }

  // Step 2: Estimate repairs
  const repairs = await estimateRepairs(description, askingPrice);

  // Step 3: Calculate MAO and offer
  const mao = (arv * ARV_MULTIPLIER) - repairs;
  const ourOffer = Math.max(mao - ASSIGNMENT_FEE, 0);
  const potentialProfit = mao - ourOffer;

  // Step 4: Deal score (is this worth pursuing?)
  const discount = ((askingPrice - ourOffer) / askingPrice) * 100;
  const dealScore = ourOffer > 0 && askingPrice > ourOffer ? "good" :
    ourOffer > askingPrice * 0.85 ? "marginal" : "pass";

  return {
    address,
    askingPrice,
    estimatedARV: Math.round(arv),
    estimatedRepairs: repairs,
    mao: Math.round(mao),
    ourOffer: Math.round(ourOffer),
    potentialProfit: Math.round(potentialProfit),
    discountFromAsking: Math.round(discount),
    dealScore,
  };
}

// ── Generate AI offer message for seller ─────────────────────────────────────
export async function generateOfferMessage(lead, analysis) {
  const firstName = lead.ownerName ? lead.ownerName.split(" ")[0] : null;
  const greeting = firstName ? `Hey ${firstName}` : "Hey";
  const shortAddr = lead.address.split(",")[0];

  const msg = await claude.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 120,
    system: "You write text messages that sound exactly like a real person texting. No sales language. No buzzwords. Output ONLY the message text — nothing else.",
    messages: [{
      role: "user",
      content: `Write a first text to someone who owns a house you want to buy.

Start with: "${greeting}"
Address: ${shortAddr}
${lead.source?.includes("distressed") || lead.motivation ? `Situation: ${lead.motivation || "may need to sell"}` : ""}

Rules:
- Sound like a real person, not an investor or wholesaler
- 1-2 sentences MAX
- Do NOT say: "cash offer", "fast close", "as-is", "motivated seller", "I'm a buyer", "no obligation"
- Just ask if they'd be open to selling or entertaining an offer — casual and direct
- End with "- Jon"
- Output the message only`,
    }],
  });
  // Strip any markdown or headers that leaked through
  return msg.content[0].text
    .trim()
    .replace(/^#+\s+.+\n?/g, "")  // Remove markdown headers
    .replace(/\*\*/g, "")          // Remove bold
    .replace(/---[\s\S]*/g, "")    // Remove everything after ---
    .trim();
}

// ── Handle seller reply with AI ───────────────────────────────────────────────
export async function handleSellerReply(lead, analysis, sellerMessage, conversationHistory = []) {
  const messages = [
    ...conversationHistory,
    { role: "user", content: sellerMessage },
  ];

  const msg = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    system: `${WHOLESALING_KNOWLEDGE}

You are texting a motivated seller about their property at ${lead.address}.
Their asking price: $${lead.askingPrice?.toLocaleString()}
Our offer: $${analysis.ourOffer?.toLocaleString()}
Our max we can go: $${analysis.mao?.toLocaleString()}

Keep replies SHORT — 1-2 sentences, casual texting tone. Sound like a real person, not an investor.
Never use: "cash offer", "fast close", "as-is", "no obligation", "I'm a buyer" — just talk normally.
Goal: keep the conversation going and move toward agreeing on a number.
If they give a price, work toward middle ground naturally.
If they want to move forward, ask for their email to send paperwork.
Sign as "- Jon"`,
    messages,
  });

  return msg.content[0].text.trim();
}
