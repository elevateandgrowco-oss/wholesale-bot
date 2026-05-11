/**
 * cold_caller.js
 * Sends land leads to the AI cold call bot for automated outbound calling.
 */

const COLDCALL_URL = process.env.COLDCALL_BOT_URL || "https://ai-coldcall-bot-production.up.railway.app";

export async function queueForColdCall(lead) {
  try {
    const payload = {
      id: lead.id,
      source: "wholesale_bot",
      ownerName: lead.owner || lead.ownerName || "there",
      phone: lead.phone,
      address: lead.address,
      ourOffer: lead.analysis?.ourOffer || lead.ourOffer || null,
    };

    if (!payload.phone) return;

    const res = await fetch(`${COLDCALL_URL}/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      console.log(`   📞 Queued for cold call: ${payload.ownerName}`);
    }
  } catch {
    // Non-fatal — cold call bot might not be up yet
  }
}

// ── Bulk push all existing leads that haven't been called ──────────────────────
export async function bulkQueueLeads(leads) {
  const eligible = leads.filter(l => l.phone && l.status !== "do_not_call");
  if (!eligible.length) return 0;

  const payload = eligible.map(l => ({
    id: l.id,
    source: "wholesale_bot",
    ownerName: l.owner || l.ownerName || "there",
    phone: l.phone,
    address: l.address,
    ourOffer: l.analysis?.ourOffer || null,
  }));

  try {
    const res = await fetch(`${COLDCALL_URL}/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    console.log(`📞 Cold call queue: ${data.added} leads added`);
    return data.added || 0;
  } catch (err) {
    console.log(`⚠️  Cold call bulk queue failed: ${err.message}`);
    return 0;
  }
}
