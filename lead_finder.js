/**
 * lead_finder.js
 * Finds motivated house sellers from:
 * 1. Manual CSV import (primary)
 * 2. Craigslist FSBO listings (sellers post their phone in the listing)
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as cheerio from "cheerio";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";
import { skipTraceLeads } from "./skip_tracer.js";
dotenv.config();

puppeteer.use(StealthPlugin());

// Craigslist cities to search (real estate by owner)
const CITIES = [
  { name: "Memphis, TN",       cl: "memphis" },
  { name: "Cleveland, OH",     cl: "cleveland" },
  { name: "Detroit, MI",       cl: "detroit" },
  { name: "Indianapolis, IN",  cl: "indianapolis" },
  { name: "Jacksonville, FL",  cl: "jacksonville" },
  { name: "Columbus, OH",      cl: "columbus" },
  { name: "Atlanta, GA",       cl: "atlanta" },
  { name: "Houston, TX",       cl: "houston" },
  { name: "Dallas, TX",        cl: "dallas" },
  { name: "Phoenix, AZ",       cl: "phoenix" },
  { name: "Orlando, FL",       cl: "orlando" },
  { name: "Kansas City, MO",   cl: "kansascity" },
  { name: "St. Louis, MO",     cl: "stlouis" },
  { name: "Tampa, FL",         cl: "tampa" },
  { name: "Charlotte, NC",     cl: "charlotte" },
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
        city,
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

// ── Extract phone number from text ────────────────────────────────────────────
function extractPhone(text) {
  const matches = text.match(/(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/g);
  if (!matches) return null;
  // Filter out zip codes and short numbers
  for (const m of matches) {
    const digits = m.replace(/\D/g, "");
    if (digits.length === 10 && !digits.startsWith("000")) return digits;
    if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  }
  return null;
}

// ── Craigslist FSBO scraper ───────────────────────────────────────────────────
export async function findCraigslistLeads(cityObj, maxLeads = 10) {
  const leads = [];

  try {
    // Search Craigslist real estate by owner, price reduced / motivated keywords
    const searchUrl = `https://${cityObj.cl}.craigslist.org/search/rea?srchType=T&max_price=350000&query=for+sale+by+owner&sort=priceasc`;

    console.log(`  🔍 Craigslist FSBO: ${cityObj.name}`);

    const res = await axios.get(searchUrl, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    const $ = cheerio.load(res.data);
    const listings = [];

    // Extract listing URLs
    $("li.cl-search-result, .result-row, li[class*=result]").each((_, el) => {
      const link = $(el).find("a[href*='/rea/'], a[href*='/reo/'], a.posting-title").attr("href");
      const title = $(el).find(".posting-title, a.posting-title, .result-title").text().trim();
      const priceText = $(el).find(".priceinfo, .result-price").text().trim();
      const price = parseInt(priceText.replace(/[^0-9]/g, "")) || 0;

      if (link && title) {
        const fullUrl = link.startsWith("http") ? link : `https://${cityObj.cl}.craigslist.org${link}`;
        listings.push({ url: fullUrl, title, price });
      }
    });

    // Also try newer Craigslist markup
    if (listings.length === 0) {
      $("a.posting-title, .cl-app-anchor").each((_, el) => {
        const link = $(el).attr("href");
        const title = $(el).text().trim();
        if (link && link.includes("/rea/") && title) {
          const fullUrl = link.startsWith("http") ? link : `https://${cityObj.cl}.craigslist.org${link}`;
          listings.push({ url: fullUrl, title, price: 0 });
        }
      });
    }

    console.log(`    Found ${listings.length} listings, extracting contact info...`);

    // Visit each listing to extract phone number
    for (const listing of listings.slice(0, maxLeads * 2)) {
      if (leads.length >= maxLeads) break;

      try {
        const detailRes = await axios.get(listing.url, {
          timeout: 10000,
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          },
        });

        const $d = cheerio.load(detailRes.data);
        const bodyText = $d("#postingbody, .posting-body, body").text();
        const phone = extractPhone(bodyText);

        // Extract price if not found
        let price = listing.price;
        if (!price) {
          const priceMatch = $d(".price, [class*=price]").first().text();
          price = parseInt(priceMatch.replace(/[^0-9]/g, "")) || 0;
        }

        // Extract address if available
        const mapAddress = $d(".mapaddress, [class*=mapaddress]").text().trim();
        const address = mapAddress || listing.title;

        if (phone) {
          leads.push({
            source: "craigslist",
            city: cityObj.name,
            address,
            askingPrice: price,
            phone,
            url: listing.url,
            email: null,
            scrapedAt: new Date().toISOString(),
          });
          console.log(`    ✓ Found: ${address} | $${price.toLocaleString()} | ${phone}`);
        }

        await new Promise(r => setTimeout(r, 800));

      } catch { /* skip this listing */ }
    }

  } catch (err) {
    console.log(`    ⚠️  Craigslist ${cityObj.name}: ${err.message.slice(0, 80)}`);
  }

  return leads.slice(0, maxLeads);
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function findLeads(maxTotal = 20) {
  // 1. Check for manual CSV import first
  const manualLeads = loadManualLeads(maxTotal);
  if (manualLeads.length > 0) {
    console.log(`\n🏠 Using ${manualLeads.length} leads from CSV import`);
    return manualLeads.slice(0, maxTotal);
  }

  // 2. Scrape Craigslist FSBO across random cities
  const shuffled = [...CITIES].sort(() => Math.random() - 0.5);
  const citiesToTry = shuffled.slice(0, 4);

  console.log(`\n🏠 Finding motivated seller leads on Craigslist...`);
  console.log(`   Searching: ${citiesToTry.map(c => c.name).join(", ")}`);

  const allLeads = [];

  for (const city of citiesToTry) {
    if (allLeads.length >= maxTotal) break;
    const perCity = Math.ceil((maxTotal - allLeads.length) / citiesToTry.length);
    const leads = await findCraigslistLeads(city, perCity);
    allLeads.push(...leads);
    console.log(`  Found ${leads.length} leads with phones in ${city.name} (total: ${allLeads.length})`);
    await new Promise(r => setTimeout(r, 2000));
  }

  // 3. Skip trace any leads missing phone numbers
  const leadsWithPhones = await skipTraceLeads(allLeads);

  if (leadsWithPhones.length === 0) {
    console.log(`
  ⚠️  No leads with phone numbers found.
     Add BATCH_SKIP_TRACING_API_KEY to your .env file to enable automatic phone lookup.
     Sign up at batchskiptracing.com (~$0.18/record)
`);
  }

  return leadsWithPhones.slice(0, maxTotal);
}
