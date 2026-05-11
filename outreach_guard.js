/**
 * outreach_guard.js
 * Central safety gate for all outreach actions.
 *
 * Checks (in order):
 *   1. SMS outbound lock (pending Twilio A2P approval)
 *   2. Quiet hours / contact window for lead's timezone
 *   3. DNC / opt-out / do-not-contact
 *
 * Statuses logged when blocked:
 *   SMS_BLOCKED_PENDING_TWILIO_APPROVAL
 *   QUIET_HOURS_BLOCKED
 *   DNC_BLOCKED
 *   OPTED_OUT_BLOCKED
 *   BAD_NUMBER_BLOCKED
 *   UNKNOWN_TIMEZONE_BLOCKED
 */

// ── State → IANA timezone ─────────────────────────────────────────────────────
const STATE_TZ = {
  AL:"America/Chicago",AR:"America/Chicago",CT:"America/New_York",
  DC:"America/New_York",DE:"America/New_York",FL:"America/New_York",
  GA:"America/New_York",IA:"America/Chicago",ID:"America/Denver",
  IL:"America/Chicago",IN:"America/Indiana/Indianapolis",KS:"America/Chicago",
  KY:"America/Kentucky/Louisville",LA:"America/Chicago",MA:"America/New_York",
  MD:"America/New_York",ME:"America/New_York",MI:"America/Detroit",
  MN:"America/Chicago",MO:"America/Chicago",MS:"America/Chicago",
  MT:"America/Denver",NC:"America/New_York",ND:"America/Chicago",
  NE:"America/Chicago",NH:"America/New_York",NJ:"America/New_York",
  NM:"America/Denver",NV:"America/Los_Angeles",NY:"America/New_York",
  OH:"America/New_York",OK:"America/Chicago",OR:"America/Los_Angeles",
  PA:"America/New_York",RI:"America/New_York",SC:"America/New_York",
  SD:"America/Chicago",TN:"America/Chicago",TX:"America/Chicago",
  UT:"America/Denver",VA:"America/New_York",VT:"America/New_York",
  WA:"America/Los_Angeles",WI:"America/Chicago",WV:"America/New_York",
  WY:"America/Denver",CA:"America/Los_Angeles",CO:"America/Denver",
  AZ:"America/Phoenix",AK:"America/Anchorage",HI:"Pacific/Honolulu",
};

// Area code → state (common US area codes)
const AREA_CODE_STATE = {
  "201":"NJ","202":"DC","203":"CT","205":"AL","206":"WA","207":"ME","208":"ID",
  "209":"CA","210":"TX","212":"NY","213":"CA","214":"TX","215":"PA","216":"OH",
  "217":"IL","218":"MN","219":"IN","220":"OH","224":"IL","225":"LA","228":"MS",
  "229":"GA","231":"MI","234":"OH","239":"FL","240":"MD","248":"MI","251":"AL",
  "252":"NC","253":"WA","254":"TX","256":"AL","260":"IN","262":"WI","267":"PA",
  "270":"KY","272":"PA","276":"VA","281":"TX","301":"MD","302":"DE","303":"CO",
  "304":"WV","305":"FL","307":"WY","308":"NE","309":"IL","310":"CA","312":"IL",
  "313":"MI","314":"MO","315":"NY","316":"KS","317":"IN","318":"LA","319":"IA",
  "320":"MN","321":"FL","323":"CA","325":"TX","330":"OH","331":"IL","334":"AL",
  "336":"NC","337":"LA","339":"MA","340":"VI","347":"NY","351":"MA","352":"FL",
  "360":"WA","361":"TX","385":"UT","386":"FL","401":"RI","402":"NE","404":"GA",
  "405":"OK","406":"MT","407":"FL","408":"CA","409":"TX","410":"MD","412":"PA",
  "413":"MA","414":"WI","415":"CA","417":"MO","419":"OH","423":"TN","424":"CA",
  "425":"WA","430":"TX","432":"TX","434":"VA","435":"UT","440":"OH","442":"CA",
  "443":"MD","458":"OR","469":"TX","470":"GA","475":"CT","478":"GA","479":"AR",
  "480":"AZ","484":"PA","501":"AR","502":"KY","503":"OR","504":"LA","505":"NM",
  "507":"MN","508":"MA","509":"WA","510":"CA","512":"TX","513":"OH","515":"IA",
  "516":"NY","517":"MI","518":"NY","520":"AZ","530":"CA","539":"OK","540":"VA",
  "541":"OR","551":"NJ","559":"CA","561":"FL","562":"CA","563":"IA","567":"OH",
  "570":"PA","571":"VA","573":"MO","574":"IN","580":"OK","585":"NY","586":"MI",
  "601":"MS","602":"AZ","603":"NH","605":"SD","606":"KY","607":"NY","608":"WI",
  "609":"NJ","610":"PA","612":"MN","614":"OH","615":"TN","616":"MI","617":"MA",
  "618":"IL","619":"CA","620":"KS","623":"AZ","626":"CA","628":"CA","630":"IL",
  "631":"NY","636":"MO","641":"IA","646":"NY","650":"CA","651":"MN","657":"CA",
  "660":"MO","661":"CA","662":"MS","667":"MD","669":"CA","671":"GU","678":"GA",
  "681":"WV","682":"TX","701":"ND","702":"NV","703":"VA","704":"NC","706":"GA",
  "707":"CA","708":"IL","712":"IA","713":"TX","714":"CA","715":"WI","716":"NY",
  "717":"PA","718":"NY","719":"CO","720":"CO","724":"PA","725":"NV","727":"FL",
  "731":"TN","732":"NJ","734":"MI","737":"TX","740":"OH","743":"NC","747":"CA",
  "754":"FL","757":"VA","760":"CA","762":"GA","763":"MN","765":"IN","769":"MS",
  "770":"GA","772":"FL","773":"IL","774":"MA","775":"NV","779":"IL","781":"MA",
  "785":"KS","786":"FL","801":"UT","802":"VT","803":"SC","804":"VA","805":"CA",
  "806":"TX","808":"HI","810":"MI","812":"IN","813":"FL","814":"PA","815":"IL",
  "816":"MO","817":"TX","818":"CA","820":"CA","828":"NC","830":"TX","831":"CA",
  "832":"TX","843":"SC","845":"NY","847":"IL","848":"NJ","850":"FL","854":"SC",
  "856":"NJ","857":"MA","858":"CA","859":"KY","860":"CT","862":"NJ","863":"FL",
  "864":"SC","865":"TN","870":"AR","872":"IL","878":"PA","901":"TN","903":"TX",
  "904":"FL","906":"MI","907":"AK","908":"NJ","909":"CA","910":"NC","912":"GA",
  "913":"KS","914":"NY","915":"TX","916":"CA","917":"NY","918":"OK","919":"NC",
  "920":"WI","925":"CA","928":"AZ","929":"NY","931":"TN","936":"TX","937":"OH",
  "940":"TX","941":"FL","947":"MI","949":"CA","951":"CA","952":"MN","954":"FL",
  "956":"TX","959":"CT","970":"CO","971":"OR","972":"TX","973":"NJ","978":"MA",
  "979":"TX","980":"NC","984":"NC","985":"LA","989":"MI",
};

/**
 * Detect lead timezone from any available field.
 * Returns { timezone, source, confidence } or null if unknown.
 */
export function detectTimezone(lead) {
  // 1. Explicit timezone field already set
  if (lead.timezone) return { timezone: lead.timezone, source: "stored", confidence: "high" };

  // 2. State field
  const state = (lead.state || lead.propertyState || "").toUpperCase().trim();
  if (state && STATE_TZ[state]) return { timezone: STATE_TZ[state], source: "state", confidence: "high" };

  // 3. Address parsing — try to extract state from address string
  if (lead.address) {
    const m = lead.address.match(/,\s*([A-Z]{2})\s*\d{5}/i)
           || lead.address.match(/\b([A-Z]{2})\s*\d{5}/i)
           || lead.address.match(/,\s*([A-Z]{2})\s*$/i);
    if (m) {
      const st = m[1].toUpperCase();
      if (STATE_TZ[st]) return { timezone: STATE_TZ[st], source: "address", confidence: "medium" };
    }
  }

  // 4. ZIP code prefix → rough region (not exact, but usable as fallback)
  const zip = (lead.zip || lead.zipCode || "").replace(/[^0-9]/g, "").slice(0, 3);
  if (zip) {
    const zipTz = _zipPrefixTZ(zip);
    if (zipTz) return { timezone: zipTz, source: "zip", confidence: "low" };
  }

  // 5. Phone area code
  const phone = (lead.phone || "").replace(/[^0-9]/g, "");
  const areaCode = phone.startsWith("1") ? phone.slice(1, 4) : phone.slice(0, 3);
  if (areaCode && AREA_CODE_STATE[areaCode]) {
    const st = AREA_CODE_STATE[areaCode];
    if (STATE_TZ[st]) return { timezone: STATE_TZ[st], source: "area_code", confidence: "medium" };
  }

  return null; // unknown
}

function _zipPrefixTZ(prefix) {
  const n = parseInt(prefix, 10);
  if (n >= 0   && n <= 99)  return "America/New_York";  // 00x-09x: Northeast
  if (n >= 100 && n <= 199) return "America/New_York";  // 10x-19x: NY/PA/NJ
  if (n >= 200 && n <= 299) return "America/New_York";  // 20x-29x: DC/VA/NC/SC
  if (n >= 300 && n <= 399) return "America/New_York";  // 30x-39x: GA/FL/AL
  if (n >= 400 && n <= 499) return "America/New_York";  // 40x-49x: OH/IN/KY
  if (n >= 500 && n <= 599) return "America/Chicago";   // 50x-59x: IA/MN/MO
  if (n >= 600 && n <= 699) return "America/Chicago";   // 60x-69x: IL/WI/MI
  if (n >= 700 && n <= 749) return "America/Chicago";   // 70x-74x: LA/TX/OK
  if (n >= 750 && n <= 799) return "America/Chicago";   // 75x-79x: TX
  if (n >= 800 && n <= 849) return "America/Denver";    // 80x-84x: CO/UT/MT
  if (n >= 850 && n <= 899) return "America/Phoenix";   // 85x-89x: AZ/NV
  if (n >= 900 && n <= 999) return "America/Los_Angeles"; // 90x-99x: CA/OR/WA
  return null;
}

/**
 * Check if current time is within the allowed contact window for a given timezone.
 * Rules:
 *   - Weekdays:  9:00 AM – 8:45 PM lead local time
 *   - Saturday: 10:00 AM – 4:00 PM lead local time
 *   - Sunday:   NEVER (unless overridden)
 *   - Calls/RVM/SMS stop at 8:45 PM
 *   - Email: 8:00 AM – 8:45 PM
 */
export function isWithinContactHours(timezone, channel = "call") {
  try {
    const now = new Date();
    const localStr = now.toLocaleString("en-US", { timeZone: timezone });
    const local = new Date(localStr);
    const hour   = local.getHours();
    const minute = local.getMinutes();
    const dow    = local.getDay(); // 0=Sun 6=Sat
    const decimalHour = hour + minute / 60;

    // Hard cutoff: nothing after 20:45 (8:45 PM) local
    if (decimalHour >= 20.75) return false;

    // Sundays: no outreach
    if (dow === 0) return false;

    // Saturday: calls/RVM/SMS 10am-4pm only
    if (dow === 6) {
      if (channel === "email") return decimalHour >= 8 && decimalHour < 20.75;
      return decimalHour >= 10 && decimalHour < 16;
    }

    // Weekdays
    if (channel === "email") return decimalHour >= 8 && decimalHour < 20.75;
    return decimalHour >= 9 && decimalHour < 20.75;
  } catch {
    return false; // unknown timezone → block
  }
}

/**
 * Get next allowed contact time string for a blocked lead.
 */
export function nextAllowedContactTime(timezone) {
  try {
    const now = new Date();
    const localStr = now.toLocaleString("en-US", { timeZone: timezone });
    const local = new Date(localStr);
    const hour = local.getHours();
    const dow  = local.getDay();

    let nextDate = new Date(local);

    if (dow === 0 || (dow === 6 && hour >= 16) || (dow !== 6 && hour >= 21)) {
      // Move to next weekday 9am
      nextDate.setDate(nextDate.getDate() + (dow === 0 ? 1 : dow === 6 ? 2 : 1));
      nextDate.setHours(9, 0, 0, 0);
    } else if (dow === 6 && hour < 10) {
      nextDate.setHours(10, 0, 0, 0);
    } else {
      nextDate.setHours(9, 0, 0, 0);
      nextDate.setDate(nextDate.getDate() + 1);
    }

    return nextDate.toISOString();
  } catch {
    return null;
  }
}

// ── Provider checks ───────────────────────────────────────────────────────────
/** SMS outbound — requires Twilio A2P 10DLC approval */
export function isSMSOutboundEnabled() {
  const enabled  = process.env.SMS_OUTBOUND_ENABLED  !== "false";
  const a2p      = process.env.TWILIO_A2P_APPROVED   !== "false";
  return enabled && a2p;
}

/** RVM outbound — uses Slybroadcast, independent of Twilio A2P */
export function isSlybroadcastEnabled() {
  return !!(process.env.SLYBROADCAST_EMAIL && process.env.SLYBROADCAST_PASSWORD);
}

/** Vapi outbound calls */
export function isVapiEnabled() {
  return !!process.env.VAPI_API_KEY;
}

/**
 * Master pre-send check.
 * Call before EVERY outbound call, email, RVM, or SMS.
 *
 * Channels: "sms" | "rvm" | "call" | "email"
 *
 * Guard order (all channels):
 *   1. DNC / opt-out / bad number  — permanent, never queued
 *   2. Provider lock               — channel-specific
 *   3. Quiet hours                 — temporary, always queued for next window
 *
 * NOTE: RVM (Slybroadcast) is NOT gated by Twilio A2P approval.
 *       SMS is the only channel that requires Twilio A2P.
 *
 * Returns: { allowed: true } or { allowed: false, reason, queued, status }
 */
export function checkOutreachAllowed(lead, channel = "call") {
  // 1. DNC / opt-out / bad number — permanent suppression, always checked first.
  //    These leads must NEVER be queued under any circumstance.
  if (lead.doNotCall || lead.dnc || lead.dncFlag) {
    return { allowed: false, reason: "DNC_BLOCKED", queued: false, status: "DNC" };
  }
  if (lead.unsubscribed || lead.optedOut) {
    return { allowed: false, reason: "OPTED_OUT_BLOCKED", queued: false, status: "OPTED_OUT" };
  }
  if (lead.badNumber || lead.wrongNumber) {
    return { allowed: false, reason: "BAD_NUMBER_BLOCKED", queued: false, status: "BAD_NUMBER" };
  }
  if (lead.badEmail && channel === "email") {
    return { allowed: false, reason: "BAD_EMAIL_BLOCKED", queued: false, status: "BAD_EMAIL" };
  }

  // 2a. SMS outbound lock — requires Twilio A2P approval (10DLC).
  //     Queued (not dropped) — will auto-send once A2P is approved.
  if (channel === "sms") {
    if (!isSMSOutboundEnabled()) {
      return {
        allowed: false,
        reason: "SMS_BLOCKED_PENDING_TWILIO_APPROVAL",
        queued: true,
        status: "SMS_QUEUED",
      };
    }
  }

  // 2b. RVM (Slybroadcast) — independent of Twilio. Check provider credentials.
  //     NOT blocked by SMS_OUTBOUND_ENABLED or TWILIO_A2P_APPROVED.
  if (channel === "rvm") {
    if (!isSlybroadcastEnabled()) {
      return {
        allowed: false,
        reason: "RVM_BLOCKED_NO_PROVIDER",
        queued: false,
        status: "RVM_SKIP",
      };
    }
  }

  // 2c. Vapi outbound call — check API key is configured.
  if (channel === "call") {
    if (!isVapiEnabled()) {
      return {
        allowed: false,
        reason: "CALL_BLOCKED_NO_VAPI_KEY",
        queued: false,
        status: "CALL_SKIP",
      };
    }
  }

  // 3. Skip quiet-hours check for email (can be queued anytime, sent during window)
  if (channel !== "email") {
    const tzResult = detectTimezone(lead);
    if (!tzResult) {
      return {
        allowed: false,
        reason: "UNKNOWN_TIMEZONE_BLOCKED",
        queued: true,
        status: "QUEUED_FOR_NEXT_CONTACT_WINDOW",
        timezone: null,
      };
    }
    if (!isWithinContactHours(tzResult.timezone, channel)) {
      return {
        allowed: false,
        reason: "QUIET_HOURS_BLOCKED",
        queued: true,
        status: "QUEUED_FOR_NEXT_CONTACT_WINDOW",
        timezone: tzResult.timezone,
        tzSource: tzResult.source,
        nextAllowedAt: nextAllowedContactTime(tzResult.timezone),
      };
    }
  }

  return { allowed: true };
}
