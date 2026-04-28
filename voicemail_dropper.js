/**
 * voicemail_dropper.js
 * Drops a ringless voicemail via slybroadcast before SMS outreach.
 *
 * Required env vars:
 *   SLYBROADCAST_EMAIL       — your slybroadcast login email
 *   SLYBROADCAST_PASSWORD    — your slybroadcast password
 *   SLYBROADCAST_AUDIO_FILE  — audio filename as it appears in your account (e.g. "realestate")
 *
 * Optional:
 *   SLYBROADCAST_CALLER_ID   — callback number shown to recipient (defaults to TWILIO_PHONE)
 */

import dotenv from "dotenv";
dotenv.config();

const API_URL = "https://www.mobile-sphere.com/gateway/vmb.php";

function formatPhone(phone) {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 11 && digits[0] === "1") return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

export async function dropVoicemail(phone) {
  const email = process.env.SLYBROADCAST_EMAIL;
  const password = process.env.SLYBROADCAST_PASSWORD;
  const audioFile = process.env.SLYBROADCAST_AUDIO_FILE || "realestate";
  const callerId = formatPhone(process.env.SLYBROADCAST_CALLER_ID || process.env.TWILIO_PHONE || "") || "";

  if (!email || !password) {
    console.log("   ⏭️  Voicemail skip — SLYBROADCAST credentials not configured");
    return null;
  }

  const formatted = formatPhone(phone);
  if (!formatted) {
    console.log(`   ⚠️  Voicemail skip — invalid phone: ${phone}`);
    return null;
  }

  const form = new FormData();
  form.append("c_uid", email);
  form.append("c_password", password);
  form.append("c_method", "new_campaign");
  form.append("c_phone", formatted);
  form.append("c_record_audio", audioFile);
  form.append("c_date", "now");
  form.append("c_callerID", callerId);
  form.append("mobile_only", "1");

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      body: form,
    });

    const text = await res.text();

    if (text.startsWith("OK")) {
      console.log(`   📞 Voicemail queued for ${phone}`);
      return { success: true, response: text };
    } else {
      console.log(`   ⚠️  Slybroadcast: ${text}`);
      return { success: false, response: text };
    }
  } catch (err) {
    console.error(`   ❌ Voicemail drop failed: ${err.message}`);
    return null;
  }
}
