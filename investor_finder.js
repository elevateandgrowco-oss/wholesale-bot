/**
 * investor_finder.js
 * Finds cash buyers/investors nationwide by:
 * 1. Scraping recent cash sales from public records (Zillow sold listings)
 * 2. Searching Craigslist "we buy houses" ads
 * 3. Maintains a growing investor database
 */

import * as cheerio from "cheerio";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

let puppeteerReady = false;
let puppeteer;
async function initPuppeteer() {
  if (puppeteerReady) return;
  const { default: p } = await import("puppeteer");
  puppeteer = p;
  puppeteerReady = true;
}

const INVESTOR_DB = "investors.json";

function loadInvestors() {
  if (!fs.existsSync(INVESTOR_DB)) return { investors: [] };
  try { return JSON.parse(fs.readFileSync(INVESTOR_DB, "utf8")); }
  catch { return { investors: [] }; }
}

function saveInvestors(db) {
  fs.writeFileSync(INVESTOR_DB, JSON.stringify(db, null, 2));
}

// ── Find investors from Craigslist "we buy houses" ───────────────────────────
export async function findCraigslistInvestors(city) {
  await initPuppeteer();
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const investors = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36");

    const url = `https://${city}.craigslist.org/search/rea?query=we+buy+houses+cash&sort=date`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

    const html = await page.content();
    const $ = cheerio.load(html);

    const listings = [];
    $(".cl-search-result").slice(0, 10).each((_, el) => {
      const title = $(el).find(".title-blob a").text().trim();
      const href = $(el).find(".title-blob a").attr("href");
      if (title && href) listings.push({ title, href });
    });

    // Get contact info from each listing
    for (const listing of listings.slice(0, 5)) {
      try {
        await page.goto(listing.href, { waitUntil: "domcontentloaded", timeout: 15000 });
        const detailHtml = await page.content();
        const $d = cheerio.load(detailHtml);
        const bodyText = $d("body").text();

        const phoneMatch = bodyText.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
        const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

        if (phoneMatch || emailMatch) {
          investors.push({
            source: "craigslist",
            city,
            name: listing.title.slice(0, 50),
            phone: phoneMatch ? phoneMatch[0].replace(/[^0-9]/g, "") : null,
            email: emailMatch && !emailMatch[0].includes("craigslist") ? emailMatch[0] : null,
            addedAt: new Date().toISOString(),
          });
        }
        await new Promise(r => setTimeout(r, 1000));
      } catch { /* skip */ }
    }

  } finally {
    await browser.close();
  }

  return investors;
}

// ── Add investors to database ─────────────────────────────────────────────────
export async function updateInvestorDatabase(city) {
  console.log(`\n💼 Finding investors in ${city}...`);
  const db = loadInvestors();
  const newInvestors = await findCraigslistInvestors(city);

  let added = 0;
  for (const inv of newInvestors) {
    const exists = db.investors.some(i =>
      (i.phone && i.phone === inv.phone) || (i.email && i.email === inv.email)
    );
    if (!exists && (inv.phone || inv.email)) {
      db.investors.push(inv);
      added++;
    }
  }

  saveInvestors(db);
  console.log(`  Added ${added} new investors (total: ${db.investors.length})`);
  return db.investors;
}

// ── Find best investor match for a deal ──────────────────────────────────────
export function matchInvestor(lead, analysis) {
  const db = loadInvestors();
  const cityInvestors = db.investors.filter(i =>
    i.city && lead.city && i.city.toLowerCase().includes(lead.city.toLowerCase().slice(0, 5))
  );

  if (cityInvestors.length > 0) {
    return cityInvestors[0]; // Return first match for now
  }

  // Fallback — return any investor with contact info
  return db.investors.find(i => i.phone || i.email) || null;
}

// ── Get investor count ────────────────────────────────────────────────────────
export function getInvestorCount() {
  return loadInvestors().investors.length;
}
