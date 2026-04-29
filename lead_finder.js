/**
 * lead_finder.js
 * Finds motivated house sellers from ALL sources:
 * 1. BatchData property lists  — tax delinquent, pre-foreclosure, absentee, vacant, high equity
 * 2. Craigslist FSBO           — sellers posting their own listings with phones
 * 3. Zillow FSBO + price drops — for sale by owner, price reduced
 * 4. Foreclosure.com           — pre-foreclosures and bank-owned
 * 5. HUD Homes                 — government-owned distressed properties
 * 6. Facebook Marketplace      — FSBO listings
 * 7. Manual CSV import         — your own list (always included)
 */

import * as cheerio from "cheerio";
import axios from "axios";
import fs from "fs";

// ── Robust Zillow listing extractor ──────────────────────────────────────────
function extractZillowListings(html) {
  const $ = cheerio.load(html);
  const found = [];

  const nextData = $("script#__NEXT_DATA__").html();
  if (nextData) {
    try {
      const parsed = JSON.parse(nextData);
      function dig(obj) {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) {
          if (obj.length > 0 && (obj[0]?.address?.streetAddress || obj[0]?.streetAddress)) {
            found.push(...obj);
            return;
          }
          obj.forEach(dig);
          return;
        }
        for (const key of ["listResults", "relaxedResults", "mapResults", "results", "homes", "listings"]) {
          if (obj[key]) { dig(obj[key]); if (found.length) return; }
        }
        if (!found.length) Object.values(obj).forEach(v => { if (!found.length) dig(v); });
      }
      dig(parsed);
    } catch { /* ignore */ }
  }

  if (found.length === 0) {
    $("[data-test='property-card'], article").each((_, el) => {
      const address = $(el).find("address, [data-test='property-card-addr']").text().trim();
      const price = parseInt($(el).find("[data-test='property-card-price']").text().replace(/[^0-9]/g, "")) || 0;
      if (address && address.length > 5) found.push({ address, price });
    });
  }

  return found;
}
import dotenv from "dotenv";
import { skipTraceLeads } from "./skip_tracer.js";
dotenv.config();

// Lazy-load puppeteer so the HTTP server starts without heavy module init
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

const BATCH_API_KEY = process.env.BATCH_SKIP_TRACING_API_KEY;

// ── Target markets ────────────────────────────────────────────────────────────
const MARKETS = [
  { name: "Memphis, TN",      city: "Memphis",      state: "TN", cl: "memphis" },
  { name: "Cleveland, OH",    city: "Cleveland",    state: "OH", cl: "cleveland" },
  { name: "Detroit, MI",      city: "Detroit",      state: "MI", cl: "detroit" },
  { name: "Indianapolis, IN", city: "Indianapolis", state: "IN", cl: "indianapolis" },
  { name: "Jacksonville, FL", city: "Jacksonville", state: "FL", cl: "jacksonville" },
  { name: "Columbus, OH",     city: "Columbus",     state: "OH", cl: "columbus" },
  { name: "Atlanta, GA",      city: "Atlanta",      state: "GA", cl: "atlanta" },
  { name: "Houston, TX",      city: "Houston",      state: "TX", cl: "houston" },
  { name: "Dallas, TX",       city: "Dallas",       state: "TX", cl: "dallas" },
  { name: "Phoenix, AZ",      city: "Phoenix",      state: "AZ", cl: "phoenix" },
  { name: "Orlando, FL",      city: "Orlando",      state: "FL", cl: "orlando" },
  { name: "Kansas City, MO",  city: "Kansas City",  state: "MO", cl: "kansascity" },
  { name: "St. Louis, MO",    city: "St. Louis",    state: "MO", cl: "stlouis" },
  { name: "Tampa, FL",        city: "Tampa",        state: "FL", cl: "tampa" },
  { name: "Charlotte, NC",    city: "Charlotte",    state: "NC", cl: "charlotte" },
  { name: "Birmingham, AL",   city: "Birmingham",   state: "AL", cl: "birmingham" },
  { name: "Baltimore, MD",    city: "Baltimore",    state: "MD", cl: "baltimore" },
  { name: "Cincinnati, OH",   city: "Cincinnati",   state: "OH", cl: "cincinnati" },
  { name: "Louisville, KY",   city: "Louisville",   state: "KY", cl: "louisville" },
  { name: "San Antonio, TX",  city: "San Antonio",  state: "TX", cl: "sanantonio" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractPhone(text) {
  const matches = text.match(/(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/g);
  if (!matches) return null;
  for (const m of matches) {
    const digits = m.replace(/\D/g, "");
    if (digits.length === 10 && !digits.startsWith("000")) return digits;
    if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  }
  return null;
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

function dedup(leads) {
  const seen = new Set();
  return leads.filter(l => {
    const key = (l.phone || l.address || "").replace(/\D/g, "").slice(-10);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── 1. CSV Import ─────────────────────────────────────────────────────────────
export function loadManualLeads(maxLeads = 100) {
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
    const price = parseInt((obj["price"] || obj["asking price"] || obj["list price"] || "0").replace(/[^0-9]/g, "")) || 0;
    if (address) {
      leads.push({
        source: "csv_import",
        city: obj["city"] || "",
        address,
        askingPrice: price,
        phone: phone.replace(/[^0-9]/g, "") || null,
        email: obj["email"] || null,
        ownerName: obj["owner"] || obj["name"] || null,
        motivation: obj["motivation"] || obj["list type"] || "csv",
        scrapedAt: new Date().toISOString(),
      });
    }
  }
  if (leads.length) console.log(`  📄 CSV import: ${leads.length} leads`);
  return leads;
}

// ── 2. BatchData Property Lists ───────────────────────────────────────────────
// Pulls targeted lists of motivated sellers directly from BatchData
// Requires property-search permission on your BatchData account
async function findBatchDataLeads(market, filterType, maxLeads = 25) {
  if (!BATCH_API_KEY) return [];

  const filterPresets = {
    taxDelinquent:  { taxDelinquent: true },
    preForeclosure: { preForeclosure: true },
    absentee:       { ownerOccupied: false, absenteeOwner: true },
    vacant:         { vacant: true },
    highEquity:     { equityPercent: { min: 50 }, yearsOwned: { min: 7 } },
  };

  const filters = filterPresets[filterType] || {};

  try {
    const res = await axios.post(
      "https://api.batchdata.com/api/v1/property/search",
      {
        data: {
          filters: {
            propertyType: ["SFR", "MFR", "Condo", "Townhouse"],
            state: market.state,
            city: market.city,
            maxValue: 400000,
            ...filters,
          },
          options: { size: maxLeads, page: 0 },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${BATCH_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const results = res.data?.data?.results
      || res.data?.results
      || res.data?.properties
      || [];

    const leads = results.map(p => ({
      source: `batchdata_${filterType}`,
      motivation: filterType,
      city: market.name,
      address: [p.propertyAddress, p.propertyCity, p.propertyState].filter(Boolean).join(", ")
        || p.address || "",
      askingPrice: p.estimatedValue || p.avm || p.assessedValue || 0,
      ownerName: [p.ownerFirstName, p.ownerLastName].filter(Boolean).join(" ") || p.ownerName || null,
      phone: null, // skip traced later
      email: p.ownerEmail || null,
      scrapedAt: new Date().toISOString(),
    })).filter(l => l.address);

    if (leads.length) console.log(`  🏦 BatchData ${filterType} (${market.name}): ${leads.length} properties`);
    return leads;

  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    if (status === 403 || status === 401) {
      console.log(`  ⚠️  BatchData property search not enabled on your plan — skipping list pull`);
    } else {
      console.log(`  ⚠️  BatchData ${filterType}: ${msg?.slice(0, 80)}`);
    }
    return [];
  }
}

// ── 3. Craigslist FSBO (Puppeteer — JS rendering required) ───────────────────
export async function findCraigslistLeads(market, maxLeads = 10) {
  await initPuppeteer();
  const leads = [];
  let browser;
  try {
    console.log(`  🔍 Craigslist FSBO: ${market.name}`);
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

    const searchUrl = `https://${market.cl}.craigslist.org/search/rea?srchType=T&max_price=350000&query=for+sale+by+owner&sort=priceasc`;
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const content = await page.content();
    const $ = cheerio.load(content);

    const listingUrls = [];
    $("a[href*='/rea/']").each((_, el) => {
      const href = $(el).attr("href");
      if (href && !listingUrls.includes(href)) {
        const fullUrl = href.startsWith("http") ? href : `https://${market.cl}.craigslist.org${href}`;
        listingUrls.push(fullUrl);
      }
    });

    console.log(`    Found ${listingUrls.length} listings, extracting contact info...`);

    for (const url of listingUrls.slice(0, maxLeads * 2)) {
      if (leads.length >= maxLeads) break;
      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
        await new Promise(r => setTimeout(r, 1000));
        const detailContent = await page.content();
        const $d = cheerio.load(detailContent);
        const bodyText = $d("#postingbody, .posting-body, body").text();
        const phone = extractPhone(bodyText);
        const price = parseInt($d(".price, [class*=price]").first().text().replace(/[^0-9]/g, "")) || 0;
        const address = $d(".mapaddress, [class*=mapaddress]").text().trim() || $d("h1, .postingtitletext").text().trim();
        if (address) {
          leads.push({ source: "craigslist", city: market.name, address, askingPrice: price, phone: phone || null, motivation: "fsbo", scrapedAt: new Date().toISOString() });
          console.log(`    ✓ ${address.slice(0, 40)} | ${phone || "(no phone — will skip trace)"}`);
        }
        await new Promise(r => setTimeout(r, 1000));
      } catch { /* skip */ }
    }
    if (leads.length) console.log(`  ✓ Craigslist ${market.name}: ${leads.length} leads`);
  } catch (err) {
    console.log(`  ⚠️  Craigslist ${market.name}: ${err.message.slice(0, 60)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return leads;
}

// ── 4. Zillow FSBO + Price Reduced ───────────────────────────────────────────
async function findZillowLeads(market, maxLeads = 15) {
  await initPuppeteer();
  const leads = [];
  let browser;
  try {
    console.log(`  🏠 Zillow FSBO: ${market.name}`);
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

    const citySlug = market.city.toLowerCase().replace(/\s+/g, "-");
    const stateSlug = market.state.toLowerCase();
    const url = `https://www.zillow.com/${citySlug}-${stateSlug}/fsbo/`;

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const content = await page.content();
    const listings = extractZillowListings(content);
    for (const r of listings.slice(0, maxLeads)) {
      const street = r.address?.streetAddress || r.address || r.streetAddress || "";
      const city   = r.address?.city  || market.city;
      const state  = r.address?.state || market.state;
      if (street) {
        leads.push({
          source: "zillow_fsbo",
          city: market.name,
          address: `${street}, ${city}, ${state}`,
          askingPrice: r.price || r.unformattedPrice || 0,
          phone: null,
          motivation: "fsbo",
          url: r.detailUrl ? `https://www.zillow.com${r.detailUrl}` : null,
          scrapedAt: new Date().toISOString(),
        });
      }
    }

    if (leads.length) console.log(`  ✓ Zillow FSBO ${market.name}: ${leads.length} leads`);
  } catch (err) {
    console.log(`  ⚠️  Zillow ${market.name}: ${err.message.slice(0, 60)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return leads.slice(0, maxLeads);
}

// ── 5. Redfin Price-Reduced Listings ─────────────────────────────────────────
// Sellers who already dropped their price = highly motivated
async function findRedfinLeads(market, maxLeads = 15) {
  await initPuppeteer();
  const leads = [];
  let browser;
  try {
    console.log(`  🔴 Redfin price-reduced: ${market.name}`);
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

    const citySlug = market.city.toLowerCase().replace(/\s+/g, "-");
    // Redfin URL for price-reduced homes under $350K
    const url = `https://www.redfin.com/${market.state}/${citySlug}/filter/max-price=350000,price-reduced=true,sort=lo-days`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const content = await page.content();
    const $ = cheerio.load(content);

    // Extract from Redfin's data JSON
    const dataScript = $("script").filter((_, el) => $(el).html()?.includes('"address"')).first().html() || "";
    const addressMatches = dataScript.match(/"streetLine":"([^"]+)","city":"([^"]+)","state":"([^"]+)"/g) || [];

    for (const match of addressMatches.slice(0, maxLeads)) {
      const parts = match.match(/"streetLine":"([^"]+)","city":"([^"]+)","state":"([^"]+)"/);
      if (parts) {
        leads.push({
          source: "redfin_price_reduced",
          motivation: "price_reduced",
          city: market.name,
          address: `${parts[1]}, ${parts[2]}, ${parts[3]}`,
          askingPrice: 0,
          phone: null,
          scrapedAt: new Date().toISOString(),
        });
      }
    }

    // Fallback: scrape visible cards
    if (leads.length === 0) {
      $("[data-rf-test-id='abp-streetLine'], .homeAddress, .street-address").each((_, el) => {
        if (leads.length >= maxLeads) return;
        const street = $(el).text().trim();
        if (street && /\d/.test(street)) {
          leads.push({ source: "redfin_price_reduced", motivation: "price_reduced", city: market.name, address: `${street}, ${market.city}, ${market.state}`, askingPrice: 0, phone: null, scrapedAt: new Date().toISOString() });
        }
      });
    }

    if (leads.length) console.log(`  ✓ Redfin price-reduced ${market.name}: ${leads.length} leads`);
  } catch (err) {
    console.log(`  ⚠️  Redfin ${market.name}: ${err.message.slice(0, 60)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return leads.slice(0, maxLeads);
}

// ── 6. Auction.com — Bank-owned & Pre-Foreclosure ─────────────────────────────
async function findAuctionLeads(market, maxLeads = 10) {
  const leads = [];
  try {
    console.log(`  🔨 Auction.com: ${market.name}`);
    const url = `https://www.auction.com/residential/?state=${market.state}&city=${encodeURIComponent(market.city)}&maxPrice=350000`;
    const res = await axios.get(url, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    const $ = cheerio.load(res.data);

    // Auction.com buries data in JSON script tags
    $("script").each((_, el) => {
      if (leads.length >= maxLeads) return;
      const text = $(el).html() || "";
      if (!text.includes("streetAddress")) return;
      const matches = text.match(/"streetAddress":"([^"]+)","addressLocality":"([^"]+)","addressRegion":"([^"]+)"/g) || [];
      for (const m of matches) {
        if (leads.length >= maxLeads) break;
        const parts = m.match(/"streetAddress":"([^"]+)","addressLocality":"([^"]+)","addressRegion":"([^"]+)"/);
        if (parts) {
          leads.push({ source: "auction_com", motivation: "bank_owned", city: market.name, address: `${parts[1]}, ${parts[2]}, ${parts[3]}`, askingPrice: 0, phone: null, scrapedAt: new Date().toISOString() });
        }
      }
    });

    // Fallback: visible address elements
    if (leads.length === 0) {
      $("[class*=address], [class*=street], [itemprop=streetAddress]").each((_, el) => {
        if (leads.length >= maxLeads) return;
        const address = $(el).text().trim();
        if (address && /\d/.test(address)) {
          leads.push({ source: "auction_com", motivation: "bank_owned", city: market.name, address: `${address}, ${market.city}, ${market.state}`, askingPrice: 0, phone: null, scrapedAt: new Date().toISOString() });
        }
      });
    }

    if (leads.length) console.log(`  ✓ Auction.com ${market.name}: ${leads.length} leads`);
  } catch (err) {
    console.log(`  ⚠️  Auction.com ${market.name}: ${err.message.slice(0, 60)}`);
  }
  return leads;
}

// ── 7. Fannie Mae HomePath — REO properties ───────────────────────────────────
async function findHomepathLeads(market, maxLeads = 10) {
  const leads = [];
  try {
    console.log(`  🏦 Fannie Mae HomePath: ${market.name}`);
    const res = await axios.get(
      `https://www.homepath.com/listings#&keyword=${encodeURIComponent(market.city + " " + market.state)}&listingTypes=R&maxListPrice=350000`,
      {
        timeout: 15000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          "Accept": "application/json, text/html",
        },
      }
    );
    const $ = cheerio.load(res.data);
    $("[class*=address], [class*=street], .property-address").each((_, el) => {
      if (leads.length >= maxLeads) return;
      const address = $(el).text().trim();
      if (address && /\d/.test(address) && address.length > 5) {
        leads.push({ source: "fannie_mae_reo", motivation: "reo", city: market.name, address: address.includes(market.state) ? address : `${address}, ${market.city}, ${market.state}`, askingPrice: 0, phone: null, scrapedAt: new Date().toISOString() });
      }
    });
    if (leads.length) console.log(`  ✓ HomePath ${market.name}: ${leads.length} leads`);
  } catch (err) {
    console.log(`  ⚠️  HomePath ${market.name}: ${err.message.slice(0, 60)}`);
  }
  return leads;
}

// ── 8. County Tax Delinquent Lists (public record, free) ──────────────────────
// Most motivated sellers on earth — can't pay taxes, need out fast
async function findTaxDelinquentLeads(market, maxLeads = 20) {
  const leads = [];
  try {
    console.log(`  📋 County tax delinquent: ${market.name}`);

    // Florida: county tax collector sites (excellent public access)
    const flCounties = {
      "Tampa":        "https://www.hillstax.org/search/taxcertificates",
      "Orlando":      "https://www.octaxcol.com/delinquent-tax",
      "Jacksonville": "https://taxcollector.coj.net/delinquent",
    };

    // Georgia: county tax commissioner sites
    const gaCounties = {
      "Atlanta": "https://www.fultoncountytaxes.org/property/delinquent-tax-sales",
    };

    // Texas: county appraisal district delinquent lists
    const txCounties = {
      "Houston": "https://www.hcad.org/records/delinquent.asp",
      "Dallas":  "https://www.dallascad.org/AcctDetailRes.aspx",
    };

    const countyMap = { ...flCounties, ...gaCounties, ...txCounties };
    const countyUrl = countyMap[market.city];

    if (countyUrl) {
      const res = await axios.get(countyUrl, {
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      });
      const $ = cheerio.load(res.data);
      $("table tr, [class*=result], [class*=record]").each((_, el) => {
        if (leads.length >= maxLeads) return;
        const text = $(el).text();
        const address = text.match(/\d+\s+[A-Za-z\s]+(St|Ave|Rd|Dr|Blvd|Way|Ln|Ct|Pl)\b/i)?.[0];
        if (address) {
          leads.push({ source: "tax_delinquent", motivation: "taxDelinquent", city: market.name, address: `${address}, ${market.city}, ${market.state}`, askingPrice: 0, phone: null, scrapedAt: new Date().toISOString() });
        }
      });
    }

    // Universal: scrape state-level delinquent tax sale listings
    if (leads.length === 0) {
      const stateUrls = {
        "FL": `https://www.bidspotter.com/en-us/auction-catalogues?keywords=tax+certificate+${market.city}`,
        "TX": `https://www.mvba.com/delinquent-tax-sales/?state=TX&city=${market.city}`,
        "GA": `https://www.tax-sale.info/`,
        "OH": `https://www.ohiopublicauctions.com/`,
        "TN": `https://www.tennessee.gov/finance/fa-risk/small-business-development/online-business-registration.html`,
      };
      const stateUrl = stateUrls[market.state];
      if (stateUrl) {
        try {
          const res = await axios.get(stateUrl, { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } });
          const $ = cheerio.load(res.data);
          $("table tr, [class*=listing], [class*=property]").each((_, el) => {
            if (leads.length >= maxLeads) return;
            const text = $(el).text();
            const address = text.match(/\d+\s+[A-Za-z\s]+(St|Ave|Rd|Dr|Blvd|Way|Ln|Ct|Pl)\b/i)?.[0];
            if (address) {
              leads.push({ source: "tax_delinquent", motivation: "taxDelinquent", city: market.name, address: `${address}, ${market.city}, ${market.state}`, askingPrice: 0, phone: null, scrapedAt: new Date().toISOString() });
            }
          });
        } catch { /* skip */ }
      }
    }

    if (leads.length) console.log(`  ✓ Tax delinquent ${market.name}: ${leads.length} leads`);
    else console.log(`  ℹ️  Tax delinquent ${market.name}: county site not scraped (add to CSV manually)`);
  } catch (err) {
    console.log(`  ⚠️  Tax delinquent ${market.name}: ${err.message.slice(0, 60)}`);
  }
  return leads;
}

// ── 7. Facebook Marketplace FSBO ─────────────────────────────────────────────
async function findFacebookLeads(market, maxLeads = 10) {
  await initPuppeteer();
  const leads = [];
  let browser;
  try {
    console.log(`  📘 Facebook Marketplace: ${market.name}`);
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

    // Facebook Marketplace doesn't require login for browsing
    const lat = { "GA": "33.749", "TX": "29.760", "FL": "28.538", "TN": "35.148", "OH": "39.961", "MI": "42.331", "IN": "39.768", "MO": "38.627", "AZ": "33.448", "NC": "35.227", "AL": "33.520", "MD": "39.290", "KY": "38.252" }[market.state] || "33.749";
    const lng = { "GA": "-84.388", "TX": "-95.370", "FL": "-81.379", "TN": "-90.051", "OH": "-82.998", "MI": "-83.047", "IN": "-86.158", "MO": "-90.199", "AZ": "-112.074", "NC": "-80.843", "AL": "-86.802", "MD": "-76.612", "KY": "-85.758" }[market.state] || "-84.388";

    const url = `https://www.facebook.com/marketplace/${market.city.toLowerCase().replace(/\s/g, "")}/propertyrentals?latitude=${lat}&longitude=${lng}&radius=50&sortBy=creation_time_descend&query=for%20sale%20by%20owner%20house`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const content = await page.content();
    const $ = cheerio.load(content);

    $("[data-testid='marketplace_feed_unit'], [class*='x1i10hfl'], div[role='article']").each((_, el) => {
      if (leads.length >= maxLeads) return;
      const text = $(el).text();
      const priceMatch = text.match(/\$[\d,]+/);
      const price = priceMatch ? parseInt(priceMatch[0].replace(/[^0-9]/g, "")) : 0;
      const phone = extractPhone(text);
      if (price > 20000 && price < 400000) {
        leads.push({ source: "facebook_marketplace", city: market.name, address: `${market.city}, ${market.state}`, askingPrice: price, phone: phone || null, motivation: "fsbo", scrapedAt: new Date().toISOString() });
      }
    });

    if (leads.length) console.log(`  ✓ Facebook ${market.name}: ${leads.length} leads`);
  } catch (err) {
    console.log(`  ⚠️  Facebook ${market.name}: ${err.message.slice(0, 60)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return leads.slice(0, maxLeads);
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function findLeads(maxTotal = 30) {
  console.log(`\n🏠 Finding motivated seller leads from all sources...`);

  const allLeads = [];

  // Always include CSV leads
  const csvLeads = loadManualLeads(50);
  allLeads.push(...csvLeads);

  // Pick random markets for this run
  const shuffled = [...MARKETS].sort(() => Math.random() - 0.5);
  const markets = shuffled.slice(0, 3);
  const market = markets[0];

  console.log(`\n   Markets this run: ${markets.map(m => m.name).join(", ")}`);

  // Run all sources in parallel for speed
  const [
    zillowLeads,
    redfinLeads,
    craigslistLeads,
    auctionLeads,
    homepathLeads,
    taxDelinquentLeads,
    facebookLeads,
  ] = await Promise.allSettled([
    findZillowLeads(market, 12),
    findRedfinLeads(markets[1] || market, 12),
    findCraigslistLeads(markets[2] || market, 8),
    findAuctionLeads(market, 10),
    findHomepathLeads(markets[1] || market, 8),
    findTaxDelinquentLeads(market, 15),
    findFacebookLeads(markets[2] || market, 8),
  ]);

  for (const result of [zillowLeads, redfinLeads, craigslistLeads, auctionLeads, homepathLeads, taxDelinquentLeads, facebookLeads]) {
    if (result.status === "fulfilled") allLeads.push(...(result.value || []));
  }

  console.log(`\n📊 Raw leads collected: ${allLeads.length} (before dedup + skip trace)`);

  // Dedup by phone/address
  const unique = dedup(allLeads);
  console.log(`   After dedup: ${unique.length}`);

  // Skip trace any without phone numbers
  const withPhones = await skipTraceLeads(unique);
  console.log(`   After skip trace: ${withPhones.length} with phone numbers`);

  // Sort: most motivated first
  const priority = { tax_delinquent: 0, auction_com: 1, fannie_mae_reo: 2, redfin_price_reduced: 3, zillow_fsbo: 4, craigslist: 5, facebook_marketplace: 6, csv_import: 7 };
  withPhones.sort((a, b) => (priority[a.source] ?? 99) - (priority[b.source] ?? 99));

  return withPhones.slice(0, maxTotal);
}
