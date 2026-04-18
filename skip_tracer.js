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

  // Build request for BatchData
  const requests = leadsNeedingPhones.map((lead, i) => {
    const parts = lead.address.split(",").map(p => p.trim());
    const streetAddress = parts[0] || "";
    const cityState = parts[1] || lead.city || "";
    const cityParts = cityState.trim().split(" ");
    const state = cityParts[cityParts.length - 1] || "";
    const city = cityParts.slice(0, -1).join(" ") || cityState;
    const zip = (parts[2] || "").replace(/[^0-9]/g, "").slice(0, 5);

    return {
      id: String(i),
      propertyAddress: {
        street: streetAddress,
        city,
        state,
        zip,
      },
    };
  });

  try {
    const response = await axios.post(
      API_URL,
      { requests },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${API_KEY}`,
        },
        timeout: 60000,
      }
    );

    // BatchData response format: { results: { persons: [...] } }
    const raw = response.data;
    const persons = raw?.results?.persons || [];

    console.log(`  📞 Got results for ${persons.length} addresses`);

    let phonesFound = 0;
    for (const person of persons) {
      const idx = parseInt(person?.request?.id ?? person?.meta?.id ?? "0");
      const lead = leadsNeedingPhones[idx];
      if (!lead) continue;

      // Phone numbers: person.phoneNumbers array [{number, type, ...}]
      const phoneList = person.phoneNumbers || person.phones || [];
      const flatPhones = [person.phone1, person.phone2, person.mobilePhone].filter(Boolean);

      let bestPhone = null;
      if (phoneList.length > 0) {
        const mobile = phoneList.find(p => (p.type || p.phoneType || "").toLowerCase().includes("mobile"));
        const anyPhone = phoneList[0];
        bestPhone = mobile?.number || mobile?.phone || anyPhone?.number || anyPhone?.phone;
      }
      bestPhone = bestPhone || flatPhones[0];

      if (bestPhone) {
        const digits = String(bestPhone).replace(/[^0-9]/g, "");
        lead.phone = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;

        // Name from person.name object
        const name = person.name || {};
        if (name.first || name.last) {
          lead.ownerName = `${name.first || ""} ${name.last || ""}`.trim();
        }

        // Email from person.emails array
        const emails = person.emails || [];
        if (emails.length > 0) lead.email = emails[0].email || emails[0];

        phonesFound++;
        console.log(`  ✓ ${lead.address} → ${lead.phone}${lead.ownerName ? ` (${lead.ownerName})` : ""}`);
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
