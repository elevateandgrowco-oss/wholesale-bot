/**
 * skip_tracer.js
 * BatchSkipTracing.com API integration.
 * Takes property addresses, returns owner phone numbers.
 * Cost: ~$0.18/record
 * Sign up: batchskiptracing.com
 */

import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const API_KEY = process.env.BATCH_SKIP_TRACING_API_KEY;
const API_URL = "https://api.batchskiptracing.com/api/SkipTrace";

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

  const leadsNeedingPhones = leads.filter(l => !l.phone);
  if (leadsNeedingPhones.length === 0) {
    console.log("  ✓ All leads already have phone numbers");
    return leads;
  }

  console.log(`\n📞 Skip tracing ${leadsNeedingPhones.length} leads for phone numbers...`);

  // Build input array for BatchSkipTracing
  const input = leadsNeedingPhones.map((lead, i) => {
    // Parse address into components
    const parts = lead.address.split(",").map(p => p.trim());
    const streetAddress = parts[0] || "";
    const cityState = parts[1] || lead.city || "";
    const cityParts = cityState.trim().split(" ");
    const state = cityParts[cityParts.length - 1] || "";
    const city = cityParts.slice(0, -1).join(" ") || cityState;

    return {
      id: String(i),
      propertyAddress: streetAddress,
      propertyCity: city,
      propertyState: state,
      propertyZip: parts[2] || "",
    };
  });

  try {
    const response = await axios.post(
      API_URL,
      { input },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": API_KEY,
        },
        timeout: 60000,
      }
    );

    const results = response.data?.output || response.data?.results || [];
    console.log(`  📞 Got results for ${results.length} addresses`);

    // Map results back to leads
    let phonesFound = 0;
    for (const result of results) {
      const idx = parseInt(result.id || "0");
      const lead = leadsNeedingPhones[idx];
      if (!lead) continue;

      // BatchSkipTracing returns multiple phone numbers — grab best one
      const phones = [
        result.phone1,
        result.phone2,
        result.phone3,
        result.mobilePhone,
        result.landlinePhone,
      ].filter(Boolean);

      // Prefer mobile phones
      const mobilePhone = result.mobilePhone || phones[0];

      if (mobilePhone) {
        const digits = mobilePhone.replace(/[^0-9]/g, "");
        lead.phone = digits.length === 11 && digits.startsWith("1")
          ? digits.slice(1)
          : digits;

        // Also grab owner name and email if available
        if (result.firstName || result.lastName) {
          lead.ownerName = `${result.firstName || ""} ${result.lastName || ""}`.trim();
        }
        if (result.email1) lead.email = result.email1;

        phonesFound++;
        console.log(`  ✓ ${lead.address} → ${lead.phone}${lead.ownerName ? ` (${lead.ownerName})` : ""}`);
      } else {
        console.log(`  ✗ ${lead.address} → no phone found`);
      }
    }

    console.log(`  📞 Skip trace complete: ${phonesFound}/${leadsNeedingPhones.length} phones found`);

  } catch (err) {
    if (err.response?.status === 401) {
      console.error("  ❌ Invalid BatchSkipTracing API key — check BATCH_SKIP_TRACING_API_KEY");
    } else if (err.response?.status === 402) {
      console.error("  ❌ Insufficient BatchSkipTracing credits — add funds at batchskiptracing.com");
    } else {
      console.error(`  ❌ Skip trace error: ${err.message}`);
    }
  }

  // Return all leads (with phones filled in where found), filter out ones still missing phones
  return leads.filter(l => l.phone);
}
