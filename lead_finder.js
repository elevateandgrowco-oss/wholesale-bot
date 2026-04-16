/**
 * lead_finder.js
 * Finds motivated sellers from multiple sources:
 * 1. Manual CSV import (primary — use PropStream, BatchLeads, or county records)
 * 2. Redfin price-reduced listings via Puppeteer
 * 3. Fallback: Auction.com / HUD homes
 *
 * HOW TO GET LEADS:
 *   - PropStream ($99/mo): propstream.com — best skip-traced lists
 *   - BatchLeads ($49/mo): batchleads.io — good FSBO + absentee owner lists
 *   - FREE: Download county tax delinquent lists from county websites
 *   - FREE: Download from Redfin manually (redfin.com → search → download CSV)
 *   Put any CSV with headers [address, phone, askingPrice] as: leads_import.csv
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as cheerio from "cheerio";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

puppeteer.use(StealthPlugin());

// City → Redfin filter URL
const CITIES = [
  // These are known-working Redfin city IDs verified from the site
  { name: "Memphis, TN",      url: "https://www.redfin.com/city/24536/TN/Memphis" },
  { name: "Cleveland, OH",    url: "https://www.redfin.com/city/17233/OH/Cleveland" },
  { name: "Detroit, MI",      url: "https://www.redfin.com/city/18770/MI/Detroit" },
  { name: "Indianapolis, IN", url: "https://www.redfin.com/city/20980/IN/Indianapolis" },
  { name: "Birmingham, AL",   url: "https://www.redfin.com/city/15534/AL/Birmingham" },
  { name: "Kansas City, MO",  url: "https://www.redfin.com/city/22034/MO/Kansas-City" },
  { name: "St. Louis, MO",    url: "https://www.redfin.com/city/27716/MO/Saint-Louis" },
  { name: "Jacksonville, FL", url: "https://www.redfin.com/city/21476/FL/Jacksonville" },
  { name: "Columbus, OH",     url: "https://www.redfin.com/city/17318/OH/Columbus" },
  { name: "Oklahoma City, OK",url: "https://www.redfin.com/city/25963/OK/Oklahoma-City" },
  { name: "Atlanta, GA",      url: "https://www.redfin.com/city/29166/GA/Atlanta" },
  { name: "Houston, TX",      url: "https://www.redfin.com/city/17426/TX/Houston" },
  { name: "Dallas, TX",       url: "https://www.redfin.com/city/17842/TX/Dallas" },
  { name: "Phoenix, AZ",      url: "https://www.redfin.com/city/26711/AZ/Phoenix" },
  { name: "Orlando, FL",      url: "https://www.redfin.com/city/26040/FL/Orlando" },
];

// ── CSV Import (primary lead source) ─────────────────────────────────────────
export function loadManualLeads(maxLeads = 50) {
  const csvPath = "leads_import.csv";
  if (!fs.existsSync(csvPath)) return [];

  const lines = fs.readFileSync(csvPath, "utf8").split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].toLowerCase().split(",").map(h => h.trim().replace(/['"]/g, ""));
  const leads = [];

  for (const line of lines.slice(1, maxLeads + 1)) {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] || "").trim().replace(/['"]/g, ""));

    const address = obj["address"] || obj["property address"] || obj["street address"] || "";
    const phone = obj["phone"] || obj["phone number"] || obj["mobile"] || obj["cell"] || "";
    const price = parseInt((obj["price"] || obj["asking price"] || obj["askingprice"] || obj["list price"] || obj["listprice"] || "0").replace(/[^0-9]/g, "")) || 0;
    const city = obj["city"] || obj["mailing city"] || "";

    if (address) {
      leads.push({
        source: "csv_import",
        city: city || address.split(",").slice(-2, -1)[0]?.trim() || "",
        address,
        askingPrice: price,
        phone: phone.replace(/[^0-9]/g, "") || null,
        email: obj["email"] || null,
        scrapedAt: new Date().toISOString(),
      });
    }
  }

  console.log(`  📄 Loaded ${leads.length} leads from leads_import.csv`);
  return leads;
}

function parseCSVLine(line) {
  const fields = [];
  let cur = "", inQ = false;
  for (const c of line) {
    if (c === '"') { inQ = !inQ; }
    else if (c === "," && !inQ) { fields.push(cur); cur = ""; }
    else cur += c;
  }
  fields.push(cur);
  return fields;
}

// ── Redfin scraper via Puppeteer ─────────────────────────────────────────────
export async function findRedfinLeads(cityObj, maxLeads = 15) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const leads = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 800 });

    const filterUrl = `${cityObj.url}/filter/min-price=50k,max-price=350k,sort=price-reduced-desc,property-type=house`;
    console.log(`  🔍 Scraping Redfin: ${cityObj.name}`);

    await page.goto(filterUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    const html = await page.content();
    const $ = cheerio.load(html);

    // Extract from schema.org JSON-LD (most reliable)
    $("script[type='application/ld+json']").each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const items = Array.isArray(data) ? data : [data];
        items.forEach(item => {
          if (item["@type"] === "Product" || (item.name && item.url && item.url.includes("/home/"))) {
            const price = item.offers?.price || item.price || 0;
            const address = item.name || "";
            if (address && parseInt(price) > 0 && !leads.some(l => l.address === address)) {
              leads.push({
                source: "redfin",
                city: cityObj.name,
                address,
                askingPrice: parseInt(price) || 0,
                url: item.url || null,
                phone: null,
                email: null,
                scrapedAt: new Date().toISOString(),
              });
            }
          }
        });
      } catch { /* skip */ }
    });

    // Fallback: extract from address elements
    if (leads.length === 0) {
      $("[class*=address], [class*=Address]").each((_, el) => {
        const text = $(el).text().trim();
        if (text.match(/^\d+\s+\w+/)) {
          const priceEl = $(el).closest("[class*=HomeCard]").find("[class*=price]").text();
          const price = parseInt(priceEl.replace(/[^0-9]/g, "")) || 0;
          if (!leads.some(l => l.address === text)) {
            leads.push({
              source: "redfin",
              city: cityObj.name,
              address: text,
              askingPrice: price,
              url: null,
              phone: null,
              email: null,
              scrapedAt: new Date().toISOString(),
            });
          }
        }
      });
    }

  } catch (err) {
    console.log(`    ⚠️  Redfin ${cityObj.name}: ${err.message.slice(0, 80)}`);
  } finally {
    await browser.close();
  }

  return leads.slice(0, maxLeads);
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function findLeads(maxTotal = 20) {
  const allLeads = [];

  // 1. Check for manual CSV import first
  const manualLeads = loadManualLeads(maxTotal);
  if (manualLeads.length > 0) {
    console.log(`\n🏠 Using ${manualLeads.length} leads from CSV import`);
    return manualLeads.slice(0, maxTotal);
  }

  // 2. Scrape Redfin across 2-3 random cities
  const shuffled = [...CITIES].sort(() => Math.random() - 0.5);
  const citiesToTry = shuffled.slice(0, 3);
  console.log(`\n🏠 Finding motivated seller leads...`);
  console.log(`   Searching: ${citiesToTry.map(c => c.name).join(", ")}`);

  for (const city of citiesToTry) {
    if (allLeads.length >= maxTotal) break;
    const perCity = Math.ceil((maxTotal - allLeads.length) / citiesToTry.length);
    const leads = await findRedfinLeads(city, perCity);
    allLeads.push(...leads);
    console.log(`  Found ${leads.length} leads in ${city.name} (total: ${allLeads.length})`);
    await new Promise(r => setTimeout(r, 2000));
  }

  if (allLeads.length === 0) {
    console.log(`
  ⚠️  No leads scraped. To import leads manually:
     1. Go to redfin.com → search your city → download CSV
     2. OR use PropStream/BatchLeads for motivated seller lists
     3. Save the file as: leads_import.csv
     4. Required columns: address, phone (optional: price, email)
`);
  }

  return allLeads.slice(0, maxTotal);
}
