/**
 * hedge_fund_buyer.js
 * Submits wholesale deals to institutional hedge fund buyers:
 * 1. MaxAssets.com — nationwide hedge fund buyer network (Puppeteer form submission)
 * 2. Email fallback to deals@maxassets.com
 * 3. Owner SMS alert with deal summary
 */

import * as cheerio from "cheerio";
import twilio from "twilio";
import { Resend } from "resend";
import dotenv from "dotenv";
dotenv.config();

let puppeteerReady = false;
let puppeteer;

async function initPuppeteer() {
  if (puppeteerReady) return;
  const { default: pExtra } = await import("puppeteer-extra");
  const { default: StealthPlugin } = await import("puppeteer-extra-plugin-stealth");
  pExtra.use(StealthPlugin());
  puppeteer = pExtra;
  puppeteerReady = true;
}

// ── Build deal summary text ───────────────────────────────────────────────────
function buildDealSummary(lead, analysis) {
  const auctionNote = lead.daysToAuction
    ? `\nAUCTION IN ${lead.daysToAuction} DAYS (${lead.auctionDate})`
    : "";

  return `WHOLESALE DEAL — ${lead.address}${auctionNote}

FINANCIALS
  ARV:              $${analysis.estimatedARV?.toLocaleString()}
  Repair Estimate:  $${analysis.estimatedRepairs?.toLocaleString()}
  Contract Price:   $${analysis.ourOffer?.toLocaleString()}
  Assignment Fee:   $${analysis.potentialProfit?.toLocaleString()}
  Discount to ARV:  ${analysis.discountFromAsking}%

PROPERTY
  City:        ${lead.city}
  Source:      ${lead.source}
  Motivation:  ${lead.motivation || "pre-foreclosure"}

SELLER CONTACT
  Submitted by: Jon Dior
  Phone:  ${process.env.YOUR_PHONE || ""}
  Email:  ${process.env.FROM_EMAIL || ""}`.trim();
}

// ── Submit via MaxAssets.com web form ─────────────────────────────────────────
async function submitToMaxAssetsForm(lead, analysis) {
  await initPuppeteer();
  let browser;

  try {
    console.log(`  🏦 Attempting MaxAssets.com form submission...`);

    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );

    await page.goto("https://www.maxassets.com", { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Find deal submission link
    const content = await page.content();
    const $ = cheerio.load(content);
    const submitLink = $("a").filter((_, el) => {
      const text = $(el).text().toLowerCase();
      const href = $(el).attr("href") || "";
      return text.includes("submit") || text.includes("sell") || text.includes("deal") || href.includes("submit") || href.includes("deal");
    }).first().attr("href");

    if (submitLink) {
      const fullUrl = submitLink.startsWith("http") ? submitLink : `https://www.maxassets.com${submitLink}`;
      await page.goto(fullUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise(r => setTimeout(r, 1500));
    }

    // Fill form fields — try common field name patterns
    const fillField = async (selectors, value) => {
      for (const sel of selectors) {
        const el = await page.$(sel);
        if (el) { await el.type(String(value)); return true; }
      }
      return false;
    };

    await fillField(
      ["input[name*='address']", "input[placeholder*='ddress']", "input[id*='address']"],
      lead.address
    );
    await fillField(
      ["input[name*='price']", "input[placeholder*='rice']", "input[name*='offer']", "input[id*='price']"],
      String(analysis.ourOffer)
    );
    await fillField(
      ["input[name*='arv']", "input[placeholder*='ARV']", "input[id*='arv']"],
      String(analysis.estimatedARV)
    );
    await fillField(
      ["input[name*='name']", "input[placeholder*='ame']", "input[id*='name']"],
      "Jon Dior"
    );
    await fillField(
      ["input[type='email']", "input[name*='email']", "input[id*='email']"],
      process.env.FROM_EMAIL || ""
    );
    await fillField(
      ["input[type='tel']", "input[name*='phone']", "input[id*='phone']"],
      process.env.YOUR_PHONE || ""
    );

    // Notes / description
    const notes = await page.$("textarea, input[name*='notes'], input[name*='description'], input[name*='comment']");
    if (notes) await notes.type(buildDealSummary(lead, analysis));

    // Submit
    const submitBtn = await page.$(
      "button[type='submit'], input[type='submit'], button.submit, [class*='submit']"
    );
    if (submitBtn) {
      await submitBtn.click();
      await new Promise(r => setTimeout(r, 3000));
      console.log(`  ✅ MaxAssets.com form submitted — ${lead.address}`);
      return true;
    }

    console.log(`  ⚠️  MaxAssets.com submit button not found`);
    return false;

  } catch (err) {
    console.log(`  ⚠️  MaxAssets.com form: ${err.message.slice(0, 80)}`);
    return false;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Email deal to MaxAssets.com (always sent as confirmation/fallback) ─────────
async function emailMaxAssets(lead, analysis) {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const auctionUrgency = lead.daysToAuction ? `[URGENT — ${lead.daysToAuction} DAYS TO AUCTION] ` : "";

    await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to: "deals@maxassets.com",
      subject: `${auctionUrgency}Wholesale Deal — ${lead.address} | ARV $${analysis.estimatedARV?.toLocaleString()} | ${analysis.discountFromAsking}% Below ARV`,
      text: buildDealSummary(lead, analysis),
    });

    console.log(`  📧 Deal emailed to MaxAssets.com`);
    return true;
  } catch (err) {
    console.log(`  ⚠️  MaxAssets.com email: ${err.message.slice(0, 60)}`);
    return false;
  }
}

// ── Alert owner ───────────────────────────────────────────────────────────────
async function alertOwner(lead, analysis) {
  const auctionNote = lead.daysToAuction ? `\n⏰ ${lead.daysToAuction} days to auction!` : "";

  try {
    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await twilioClient.messages.create({
      body: `🏦 HEDGE FUND SUBMITTED\n${lead.address}\nARV: $${analysis.estimatedARV?.toLocaleString()}\nOffer: $${analysis.ourOffer?.toLocaleString()}\nFee: $${analysis.potentialProfit?.toLocaleString()}${auctionNote}\nMaxAssets.com notified`,
      from: process.env.TWILIO_PHONE,
      to: "+14017716184",
    });
  } catch (err) {
    console.log(`  ⚠️  Owner hedge fund alert: ${err.message}`);
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function submitDealToHedgeFunds(lead, analysis) {
  if (!lead?.address || !analysis?.ourOffer) return;

  console.log(`\n🏦 Submitting to hedge fund buyers: ${lead.address}`);
  if (lead.daysToAuction) {
    console.log(`  ⏰ ${lead.daysToAuction} days until auction — urgent deal`);
  }

  // Try form first, always email regardless (confirmation + fallback)
  await submitToMaxAssetsForm(lead, analysis);
  await emailMaxAssets(lead, analysis);
  await alertOwner(lead, analysis);
}
