/**
 * skip_tracer.js
 * BatchData API integration (formerly BatchSkipTracing).
 * Takes property addresses, returns owner phone numbers.
 * Cost: ~$0.18/record
 * Sign up: batchdata.com
 */

import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const API_KEY = process.env.BATCH_SKIP_TRACING_API_KEY;
const API_URL = "https://api.batchdata.com/api/v1/property/skip-trace";

/**
 * Skip trace a batch of leads to get owner phone numbers.
 * @param {Array} leads - Array of lead objects with address/city fields
 * @returns {Array} - Same leads with phone numbers filled in
 */
export async function skipTraceLeads(leads) {
  if (!API_KEY) {
    console.log("  ⚠️  BATCH_SKIP_TRACING_API_KEY not set — skipping phone lookup");
    return leads;
  }

  // Only skip trace leads that have a real street address (not just "City, ST")
  const leadsNeedingPhones = leads.filter(l => {
    if (l.phone) return false;
    const addr = l.address || "";
    // Must have a number in the address (real street address, not just "Columbus, OH")
    return /\d/.test(addr.split(",")[0]);
  });

  // Return leads that already have phones
  const leadsWithPhones = leads.filter(l => l.phone);

  if (leadsNeedingPhones.length === 0) {
    console.log("  ✓ All leads already have phone numbers");
    return leadsWithPhones;
  }

  console.log(`\n📞 Skip tracing ${leadsNeedingPhones.length} leads for phone numbers...`);

  // Build request objects for all leads
  const allRequests = leadsNeedingPhones.map((lead, i) => {
    const parts = lead.address.split(",").map(p => p.trim());
    const streetAddress = parts[0] || "";
    const cityState = parts[1] || lead.city || "";
    const cityParts = cityState.trim().split(" ");
    const state = cityParts[cityParts.length - 1] || "";
    const city = cityParts.slice(0, -1).join(" ") || cityState;
    const zip = (parts[2] || "").replace(/[^0-9]/g, "").slice(0, 5);
    return {
      id: String(i),
      propertyAddress: { street: streetAddress, city, state, zip },
    };
  });

  // BatchData hard limit: 100 items per request — chunk accordingly
  const CHUNK = 100;
  const allPersons = [];
  for (let start = 0; start < allRequests.length; start += CHUNK) {
    const requests = allRequests.slice(start, start + CHUNK);
    try {
      const response = await axios.post(
        API_URL,
        { requests },
        {
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
          timeout: 60000,
        }
      );
      const persons = response.data?.results?.persons || [];
      // Re-map IDs to global index
      for (const p of persons) {
        const localIdx = parseInt(p?.request?.id ?? p?.meta?.id ?? "0");
        allPersons.push({ ...p, _globalIdx: start + localIdx });
      }
    } catch (chunkErr) {
      const status = chunkErr.response?.status;
      const msg = chunkErr.response?.data?.message || chunkErr.message;
      if (status === 402) console.error("  ❌ Insufficient BatchData credits — add funds at batchdata.com");
      else console.error(`  ❌ Skip trace chunk error (${start}-${start + CHUNK}): ${msg?.slice(0, 100)}`);
    }
  }

  try {
    console.log(`  📞 Got results for ${allPersons.length} addresses`);

    let phonesFound = 0;
    for (const person of allPersons) {
      const idx = person._globalIdx;
      const lead = leadsNeedingPhones[idx];
      if (!lead) continue;

      // Phone numbers: person.phoneNumbers array [{number, type, ...}]
      const phoneList = person.phoneNumbers || person.phones || [];
      const flatPhones = [person.phone1, person.phone2, person.mobilePhone].filter(Boolean);

      // Collect ALL phone numbers (mobile first, then others)
      const allPhoneNumbers = [];
      if (phoneList.length > 0) {
        const mobiles = phoneList.filter(p => (p.type || p.phoneType || "").toLowerCase().includes("mobile"));
        const others = phoneList.filter(p => !(p.type || p.phoneType || "").toLowerCase().includes("mobile"));
        for (const p of [...mobiles, ...others]) {
          const num = p.number || p.phone;
          if (num) allPhoneNumbers.push(String(num).replace(/[^0-9]/g, ""));
        }
      }
      for (const p of flatPhones) {
        const digits = String(p).replace(/[^0-9]/g, "");
        if (digits && !allPhoneNumbers.includes(digits)) allPhoneNumbers.push(digits);
      }

      // Normalize to 10-digit
      const cleanedPhones = allPhoneNumbers
        .map(d => d.length === 11 && d.startsWith("1") ? d.slice(1) : d)
        .filter(d => d.length === 10);

      if (cleanedPhones.length > 0) {
        lead.phone = cleanedPhones[0];
        lead.allPhones = cleanedPhones; // Keep all for multi-attempt follow-ups

        // Name from person.name object
        const name = person.name || {};
        if (name.first || name.last) {
          lead.ownerName = `${name.first || ""} ${name.last || ""}`.trim();
        }

        // Email from person.emails array
        const emails = person.emails || [];
        if (emails.length > 0) lead.email = emails[0].email || emails[0];

        phonesFound++;
        console.log(`  ✓ ${lead.address} → ${cleanedPhones.length} phone(s)${lead.ownerName ? ` (${lead.ownerName})` : ""}`);
      } else {
        if (person.meta?.matched) console.log(`  ✗ ${lead.address} → matched but no phone`);
      }
    }

    console.log(`  📞 Skip trace complete: ${phonesFound}/${leadsNeedingPhones.length} phones found`);

  } catch (err) {
    if (err.response?.status === 401) {
      console.error("  ❌ Invalid BatchData API token — check BATCH_SKIP_TRACING_API_KEY");
    } else if (err.response?.status === 402) {
      console.error("  ❌ Insufficient BatchData credits — add funds at batchdata.com");
    } else {
      console.error(`  ❌ Skip trace error: ${err.message}`);
      if (err.response?.data) console.error("  Response:", JSON.stringify(err.response.data).slice(0, 200));
    }
  }

  return leads.filter(l => l.phone);
}
