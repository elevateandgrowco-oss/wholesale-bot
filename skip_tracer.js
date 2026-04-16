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

  const leadsNeedingPhones = leads.filter(l => !l.phone);
  if (leadsNeedingPhones.length === 0) {
    console.log("  ✓ All leads already have phone numbers");
    return leads;
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
      { requests },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${API_KEY}`,
        },
        timeout: 60000,
      }
    );

    // BatchData v1 response format
    const results = response.data?.results
      || response.data?.output
      || response.data?.data
      || [];

    console.log(`  📞 Got results for ${results.length} addresses`);

    let phonesFound = 0;
    for (const result of results) {
      const idx = parseInt(result.id || "0");
      const lead = leadsNeedingPhones[idx];
      if (!lead) continue;

      // Extract phones — BatchData returns nested person/phones arrays
      const personData = result.person || result;
      const phoneList = personData.phones || personData.phoneNumbers || [];

      // Also check flat fields
      const flatPhones = [
        result.mobilePhone,
        result.phone1,
        result.phone2,
        personData.mobilePhone,
        personData.phone1,
      ].filter(Boolean);

      // Prefer mobile from list
      let bestPhone = null;
      if (phoneList.length > 0) {
        const mobile = phoneList.find(p => p.type === "mobile" || p.phoneType === "mobile");
        bestPhone = mobile?.number || mobile?.phone || phoneList[0]?.number || phoneList[0]?.phone;
      }
      bestPhone = bestPhone || flatPhones[0];

      if (bestPhone) {
        const digits = String(bestPhone).replace(/[^0-9]/g, "");
        lead.phone = digits.length === 11 && digits.startsWith("1")
          ? digits.slice(1)
          : digits;

        if (result.firstName || result.lastName || personData.firstName) {
          lead.ownerName = `${result.firstName || personData.firstName || ""} ${result.lastName || personData.lastName || ""}`.trim();
        }
        const email = result.email1 || personData.email1 || (personData.emails || [])[0]?.email;
        if (email) lead.email = email;

        phonesFound++;
        console.log(`  ✓ ${lead.address} → ${lead.phone}${lead.ownerName ? ` (${lead.ownerName})` : ""}`);
      } else {
        console.log(`  ✗ ${lead.address} → no phone found`);
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
