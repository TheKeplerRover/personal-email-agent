const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
const VANCOUVER_TIME_ZONE = "America/Vancouver";
const ANTHROPIC_SONNET_PRICING = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheWritePerMillion: 3.75,
  cacheReadPerMillion: 0.3,
};

const categoryRules = [
  { key: "interviews_jobs", label: "Interviews / Jobs", pattern: /interview|recruiter|talent acquisition|hiring team|application|candidate|position|role|assessment|workday|greenhouse|lever|ashby|bamboohr|thank you for applying|application received|status update|not moving forward/i },
  { key: "needs_reply", label: "Likely Needs Reply", pattern: /please confirm|let me know|your availability|are you available|could you|can you|follow(?:ing)? up|waiting for your response/i },
  { key: "security", label: "Security / Sign-In", pattern: /security alert|new sign-in|sign-in|login|password|passcode|verification code|one-time|2fa|mfa|account protection|new app|connected to your microsoft account/i },
  { key: "finance", label: "Finance / Bills", pattern: /invoice|receipt|statement|payment|paid|billing|bill|tax|refund|subscription|bank|credit card|insurance|withdrawal|deposit|account alert|filled/i },
  { key: "orders", label: "Orders / Shopping", pattern: /order|shipped|delivered|delivery|tracking|return|purchase|parcel|package|locker/i },
  { key: "newsletters_promos", label: "Newsletters / Promotions", pattern: /newsletter|unsubscribe|sale|offer|promo|discount|rewards|points|weekly|digest|updates|webinar|survey/i },
];

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },

  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, service: "email-assistant-worker" });
      }
      if (url.pathname === "/debug") {
        assertRunSecret(request, env, url);
        const localParts = getLocalParts(new Date(), env.TIME_ZONE || VANCOUVER_TIME_ZONE);
        return Response.json({
          ok: true,
          localParts,
          shouldRunNow: shouldRunNow(env),
          hasRunSecret: Boolean(env.RUN_SECRET),
          hasTokenStore: Boolean(env.TOKEN_STORE),
          hasMicrosoftClientId: Boolean(env.MS_CLIENT_ID),
          hasMicrosoftRefreshToken: Boolean(env.MS_REFRESH_TOKEN),
          hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY),
          hasOpenAIKey: Boolean(env.OPENAI_API_KEY),
          hasReportRecipient: Boolean(env.EMAIL_REPORT_TO),
          aiProvider: env.AI_PROVIDER || "openai",
          anthropicModel: env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
          emailReportsEnabled: env.EMAIL_REPORTS_ENABLED !== "false",
          pushoverEnabled: env.PUSHOVER_ENABLED === "true",
        });
      }
      if (url.pathname === "/run") {
        assertRunSecret(request, env, url);
        const reportType = url.searchParams.get("type") === "weekly" ? "weekly" : "daily";
        const result = await runReport(env, reportType, { force: true });
        return Response.json(result);
      }
      return new Response("Email Assistant Worker", { status: 200 });
    } catch (error) {
      return Response.json({
        ok: false,
        error: String(error?.message || error),
        stack: String(error?.stack || "").split("\n").slice(0, 6).join("\n"),
      }, { status: 500 });
    }
  },
};

async function handleScheduled(event, env) {
  if (shouldRunOneTimeTest(event, env)) {
    console.log("Running one-time validation email report.");
    await runReport(env, "daily");
    return;
  }

  if (!shouldRunNow(env)) {
    console.log("Skipping cron because local time is not 07:30.");
    return;
  }

  await runReport(env, "daily");

  if (getLocalWeekday(new Date(), env.TIME_ZONE) === "Mon") {
    await runReport(env, "weekly");
  }
}

async function runReport(env, reportType, options = {}) {
  validateEnv(env);
  const accessToken = await getMicrosoftAccessToken(env);
  const window = getReportWindow(reportType, env);
  const listed = await listMessages(accessToken, window.start, window.end, reportType === "weekly" ? 1200 : 500);
  const messages = listed.messages;
  const digestInput = buildDigestInput(messages, window, reportType);
  const result = await summarizeWithAI(env, digestInput, reportType);
  const reports = validateReports(result.reports, digestInput);
  const title = makeReportTitle(reportType === "weekly" ? "Weekly Email Report" : "Daily Email Report", window.end, env);

  if (env.EMAIL_REPORTS_ENABLED !== "false") {
    await sendMail(accessToken, env.EMAIL_REPORT_TO, title, reports.zh, "zh", result.meta, digestInput);
    await sendMail(accessToken, env.EMAIL_REPORT_TO, title, reports.en, "en", result.meta, digestInput);
  }

  if (env.PUSHOVER_ENABLED === "true") {
    await sendPushover(env, title, makeShortPush(reports.zh, digestInput, "zh"));
  }

  return {
    ok: true,
    reportType,
    forced: Boolean(options.force),
    window,
    scanned: messages.length,
    excludedDeleted: listed.excludedDeleted,
    included: digestInput.included,
    filteredOut: digestInput.filteredOut,
    approximateCostUsd: result.meta.approximateCostUsd,
    model: result.meta.modelDisplayName,
    deliveredEmail: env.EMAIL_REPORTS_ENABLED !== "false",
    deliveredEmailCount: env.EMAIL_REPORTS_ENABLED !== "false" ? 2 : 0,
    deliveredPushover: env.PUSHOVER_ENABLED === "true",
  };
}

function assertRunSecret(request, env, url) {
  if (!env.RUN_SECRET) {
    throw new Error("RUN_SECRET is required before manual /run triggers are enabled.");
  }
  const provided = request.headers.get("x-run-secret") || url.searchParams.get("secret");
  if (provided !== env.RUN_SECRET) {
    throw new Error("Unauthorized manual run.");
  }
}

function validateEnv(env) {
  const required = ["MS_CLIENT_ID", "MS_REFRESH_TOKEN", "EMAIL_REPORT_TO"];
  const aiProvider = env.AI_PROVIDER || "openai";
  if (aiProvider === "anthropic") required.push("ANTHROPIC_API_KEY");
  else required.push("OPENAI_API_KEY");
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env/secrets: ${missing.join(", ")}`);
  }
}

function shouldRunNow(env) {
  const parts = getLocalParts(new Date(), env.TIME_ZONE || VANCOUVER_TIME_ZONE);
  return parts.hour === 7 && parts.minute === 30;
}

function shouldRunOneTimeTest(event, env) {
  if (event.cron !== "20 0 * * *") return false;
  const target = env.ONE_TIME_TEST_RUN_LOCAL;
  if (!target) return false;
  const match = String(target).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return false;
  const parts = getLocalParts(new Date(), env.TIME_ZONE || VANCOUVER_TIME_ZONE);
  return parts.year === Number(match[1])
    && parts.month === Number(match[2])
    && parts.day === Number(match[3])
    && parts.hour === Number(match[4])
    && parts.minute === Number(match[5]);
}

function getReportWindow(reportType, env) {
  const timeZone = env.TIME_ZONE || VANCOUVER_TIME_ZONE;
  const now = new Date();
  const nowParts = getLocalParts(now, timeZone);

  if (reportType === "weekly") {
    const currentMonday = getLocalWeekStart(now, timeZone);
    const previousMonday = new Date(currentMonday.getTime() - 7 * 24 * 60 * 60 * 1000);
    return {
      start: previousMonday.toISOString(),
      end: now.toISOString(),
      label: "previous Monday 00:00 local through this run",
    };
  }

  if ((env.MAIL_WINDOW_MODE || "generous") === "strict24h") {
    return {
      start: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      end: now.toISOString(),
      label: "previous 24 hours",
    };
  }

  const yesterdayDate = shiftLocalDate(nowParts, -1);
  const start = zonedTimeToUtc(yesterdayDate.year, yesterdayDate.month, yesterdayDate.day, 0, 0, timeZone);
  return {
    start: start.toISOString(),
    end: now.toISOString(),
    label: "yesterday 00:00 local through this run, intentionally over-reading to avoid misses",
  };
}

function makeReportTitle(baseTitle, endIso, env) {
  const timeZone = env.TIME_ZONE || VANCOUVER_TIME_ZONE;
  const parts = getLocalParts(new Date(endIso), timeZone);
  const month = new Intl.DateTimeFormat("en-US", { timeZone, month: "long" }).format(new Date(endIso));
  return `${baseTitle} - ${parts.day} ${month} ${parts.year}`;
}

async function getMicrosoftAccessToken(env) {
  const storedRefreshToken = await env.TOKEN_STORE?.get("ms_refresh_token");
  const refreshToken = storedRefreshToken || env.MS_REFRESH_TOKEN;
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    redirect_uri: env.MS_REDIRECT_URI || "http://localhost:53682/callback",
    scope: "offline_access User.Read Mail.Read Mail.Send",
  });

  const response = await fetch(MICROSOFT_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Microsoft token refresh failed: ${JSON.stringify(payload)}`);
  }

  if (payload.refresh_token && env.TOKEN_STORE) {
    await env.TOKEN_STORE.put("ms_refresh_token", payload.refresh_token);
  }
  return payload.access_token;
}

async function listMessages(accessToken, startIso, endIso, limit) {
  const deletedFolderId = await getDeletedFolderId(accessToken);
  const select = [
    "id",
    "parentFolderId",
    "receivedDateTime",
    "from",
    "subject",
    "bodyPreview",
    "isRead",
    "importance",
    "webLink",
  ].join(",");
  const filter = `receivedDateTime ge ${startIso} and receivedDateTime le ${endIso}`;
  const byId = new Map();
  let excludedDeleted = 0;
  let url = `${GRAPH_ROOT}/me/messages?$top=100&$orderby=receivedDateTime desc&$filter=${encodeURIComponent(filter)}&$select=${encodeURIComponent(select)}`;

  while (url && byId.size < limit) {
    const page = await graphGet(accessToken, url, "Graph list all messages failed");
    for (const message of page.value || []) {
      if (deletedFolderId && message.parentFolderId === deletedFolderId) {
        excludedDeleted += 1;
        continue;
      }
      if (!byId.has(message.id)) {
        byId.set(message.id, message);
      }
    }
    url = page["@odata.nextLink"] || "";
  }

  const messages = [...byId.values()]
    .sort((a, b) => String(b.receivedDateTime).localeCompare(String(a.receivedDateTime)))
    .slice(0, limit)
    .map(simplifyMessage);
  return { messages, excludedDeleted };
}

async function getDeletedFolderId(accessToken) {
  const folder = await graphGet(accessToken, "/me/mailFolders/deleteditems?$select=id", "Graph get Deleted Items folder failed");
  return folder.id || "";
}

async function graphGet(accessToken, urlOrPath, errorPrefix = "Graph request failed") {
  const url = urlOrPath.startsWith("https://") ? urlOrPath : `${GRAPH_ROOT}${urlOrPath}`;
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      prefer: 'outlook.body-content-type="text"',
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${errorPrefix}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function simplifyMessage(message) {
  const email = message.from?.emailAddress || {};
  const subject = cleanText(message.subject || "(no subject)");
  const preview = redactSensitiveText(cleanText(message.bodyPreview || "")).slice(0, 500);
  const text = `${email.name || ""} ${email.address || ""} ${subject} ${preview}`;
  const categories = categoryRules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.key);

  return {
    receivedAt: message.receivedDateTime,
    fromName: email.name || "",
    from: email.address || "unknown",
    subject,
    preview,
    isRead: Boolean(message.isRead),
    importance: message.importance || "normal",
    categories: categories.length > 0 ? categories : ["other"],
    id: message.id || "",
    parentFolderId: message.parentFolderId || "",
    folder: message.folderPath || "",
    webLink: message.webLink || "",
  };
}

function buildDigestInput(messages, window, reportType) {
  const { kept, filteredOut } = filterLowValueMessages(messages);
  const runAt = new Date(window.end);
  const annotatedMessages = kept.map((message, index) => ({
    ...message,
    sourceId: `m${index + 1}`,
    timeHints: extractTimeHints(message, runAt, VANCOUVER_TIME_ZONE),
  }));
  const counts = kept.reduce((acc, message) => {
    for (const category of message.categories) acc[category] = (acc[category] || 0) + 1;
    return acc;
  }, {});
  const filteredCounts = filteredOut.reduce((acc, item) => {
    acc[item.reason] = (acc[item.reason] || 0) + 1;
    return acc;
  }, {});

  return {
    reportType,
    window,
    scanned: messages.length,
    included: kept.length,
    filteredOut: {
      count: filteredOut.length,
      reasons: filteredCounts,
    },
    unread: kept.filter((message) => !message.isRead).length,
    counts,
    messages: annotatedMessages.map((message) => ({
      sourceId: message.sourceId,
      receivedAt: message.receivedAt,
      from: message.fromName ? `${message.fromName} <${message.from}>` : message.from,
      subject: message.subject,
      isRead: message.isRead,
      importance: message.importance,
      categories: message.categories,
      folder: message.folder,
      timeHints: message.timeHints,
      preview: message.preview,
    })),
    sourceLinks: annotatedMessages.map((message) => ({
      sourceId: message.sourceId,
      subject: message.subject,
      webLink: message.webLink,
    })),
  };
}

function filterLowValueMessages(messages) {
  const kept = [];
  const filteredOut = [];

  for (const message of messages) {
    const reason = getLowValueFilterReason(message);
    if (reason) {
      filteredOut.push({
        reason,
        receivedAt: message.receivedAt,
        from: message.fromName || message.from,
        subject: message.subject,
      });
    } else {
      kept.push(message);
    }
  }

  return { kept, filteredOut };
}

function getLowValueFilterReason(message) {
  const text = `${message.fromName} ${message.from} ${message.subject} ${message.preview}`;
  const lower = text.toLowerCase();

  if (isSelfGeneratedReport(message, lower)) return "self_generated_report";
  if (isAlwaysKeepMessage(lower)) return "";
  if (isHumanOrConversationalMessage(message, lower)) return "";

  if (isPlainVerificationCode(lower)) return "plain_verification_code";
  if (isLowValueSocialNotification(lower)) return "low_value_social";
  if (isNewsletterOrDigest(lower)) return "newsletter_or_digest";
  if (isPureMarketing(lower)) return "marketing";
  if (isTravelPromo(lower)) return "travel_promo";
  if (isRewardsPromo(lower)) return "rewards_promo";

  return "";
}

function isSelfGeneratedReport(message, text) {
  const subject = String(message.subject || "").trim();
  return /^(re:\s*)?(daily|weekly) email report\b/i.test(subject)
    || /每日邮件日报|邮件日报|powered by claude sonnet|approx\. cost/i.test(text);
}

function isAlwaysKeepMessage(text) {
  return /\b(ircc|pgwp|cic\.gc\.ca|service canada|servicebc|msp|cra|canada revenue|gc ?key|auth\.canada\.ca)\b/i.test(text)
    || /\b(bank|bmo|cibc|wealthsimple|investorline|kraken|e-transfer|etransfer|interac|withdrawal|deposit|statement|invoice|pay stub|payroll|tax|insurance|bill|payment due)\b/i.test(text)
    || /\b(interview|recruiter|hiring manager|offer letter|employment offer|contract|application status|not moving forward|thank you for applying|application received|workday|greenhouse|lever|ashby|indeed|linkedin jobs)\b/i.test(text)
    || /\b(security alert|new sign-in|password changed|new app|connected to your microsoft account|account protection|suspicious|unusual activity)\b/i.test(text)
    || /\b(order confirmation|your order|shipped|delivered|tracking|delivery|appointment|reservation|booking|janeapp|calendly|clinic|dental|repair|property|strata)\b/i.test(text);
}

function isHumanOrConversationalMessage(message, text) {
  if (/\b(you have an invitation|sent you a message)\b/i.test(text)) return true;
  if (/\b(re:|fw:|fwd:)\b/i.test(message.subject)) return true;
  const from = `${message.fromName} ${message.from}`.toLowerCase();
  if (/\b(no-?reply|do-?not-?reply|donotreply|notification|notifications|newsletter|marketing|promo|offers?|alerts?|mailer|automated|auto ?notification)\b/.test(from)) {
    return false;
  }
  return Boolean(message.fromName)
    && /\s/.test(message.fromName)
    && !/\b(team|support|service|customer|account|billing|careers|recruiting|hiring|info|admin)\b/i.test(message.fromName);
}

function isPlainVerificationCode(text) {
  return /\b(verification code|one-time passcode|login code|secure link to log in|your code is|code:)\b/i.test(text)
    && !/\b(security alert|new sign-in|password changed|new app|connected|suspicious|unusual activity)\b/i.test(text);
}

function isLowValueSocialNotification(text) {
  return /\b(profile was viewed|viewed your profile|people you may know|friend posted|just posted a story|story expires|new notification|shared .* post|birthday reminder)\b/i.test(text)
    && !/\b(you have an invitation|sent you a message|recruiter|job|interview|application)\b/i.test(text);
}

function isNewsletterOrDigest(text) {
  return /\b(newsletter|weekly digest|monthly digest|roundup|what'?s new|product updates|blog update|webinar|survey)\b/i.test(text)
    && !isAlwaysKeepMessage(text);
}

function isPureMarketing(text) {
  return /\b(sale|promo|discount|deal|offer ends|last chance|limited time|shop now|buy now|new arrivals|spring sale|weekly offers|activate your offers)\b/i.test(text)
    && !isAlwaysKeepMessage(text);
}

function isTravelPromo(text) {
  return /\b(dream bigger|limited fares|earn miles|bonus points|destination promo|flight sale|disney adventure)\b/i.test(text)
    && !/\b(boarding pass|itinerary|booking confirmation|hotel reservation|visa|immigration|travel document)\b/i.test(text);
}

function isRewardsPromo(text) {
  return /\b(points|rewards|cashback offer|bonus offer|activate offer|monthly rewards)\b/i.test(text)
    && !/\b(cashback redemption|e-transfer|withdrawal|deposit|statement|bill|payment)\b/i.test(text);
}

function extractTimeHints(message, runAt, timeZone) {
  const text = `${message.subject || ""} ${message.preview || ""}`;
  const event = parseExplicitEventDateTime(text, timeZone) || parseRelativeEventDateTime(text, runAt, timeZone);
  if (!event) return null;
  const minutesFromRun = Math.round((event.startUtc.getTime() - runAt.getTime()) / 60000);
  return {
    eventStartLocal: event.startLocal,
    eventEndLocal: event.endLocal || "",
    eventStatus: minutesFromRun >= 0 ? "upcoming" : "past",
    minutesFromRun,
  };
}

function parseExplicitEventDateTime(text, timeZone) {
  const monthNames = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };
  const match = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (!match) return null;
  const month = monthNames[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  const startHour = toTwentyFourHour(Number(match[4]), match[6]);
  const startMinute = Number(match[5] || 0);
  const startUtc = zonedTimeToUtc(year, month, day, startHour, startMinute, timeZone);
  let endLocal = "";
  if (match[7]) {
    const endHour = toTwentyFourHour(Number(match[7]), match[9] || match[6]);
    const endMinute = Number(match[8] || 0);
    endLocal = `${year}-${pad2(month)}-${pad2(day)} ${pad2(endHour)}:${pad2(endMinute)} ${timeZone}`;
  }
  return {
    startUtc,
    startLocal: `${year}-${pad2(month)}-${pad2(day)} ${pad2(startHour)}:${pad2(startMinute)} ${timeZone}`,
    endLocal,
  };
}

function parseRelativeEventDateTime(text, runAt, timeZone) {
  const match = text.match(/\b(today|tomorrow)\b.{0,40}?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return null;
  const runParts = getLocalParts(runAt, timeZone);
  const date = shiftLocalDate(runParts, match[1].toLowerCase() === "tomorrow" ? 1 : 0);
  const hour = toTwentyFourHour(Number(match[2]), match[4]);
  const minute = Number(match[3] || 0);
  const startUtc = zonedTimeToUtc(date.year, date.month, date.day, hour, minute, timeZone);
  return {
    startUtc,
    startLocal: `${date.year}-${pad2(date.month)}-${pad2(date.day)} ${pad2(hour)}:${pad2(minute)} ${timeZone}`,
    endLocal: "",
  };
}

function toTwentyFourHour(hour, meridiem = "") {
  const lower = String(meridiem || "").toLowerCase();
  if (lower === "pm" && hour < 12) return hour + 12;
  if (lower === "am" && hour === 12) return 0;
  return hour;
}

async function summarizeWithAI(env, digestInput, reportType) {
  const system = [
    "You are the inbox owner's private email chief of staff.",
    "Summarize only from supplied email metadata and previews.",
    "Do not invent facts. If uncertain, say 'unclear'.",
    "Never reveal one-time codes, passcodes, or sensitive account numbers; preserve redactions.",
    "",
    "Default posture: silence. Most emails do not deserve a mention.",
    "An item earns a bullet only if it meets at least one threshold:",
    "  (a) Concrete event or deadline within 48 hours of run time",
    "  (b) A real person is waiting for the owner's reply",
    "  (c) Anomaly from the owner's baseline behavior",
    "  (d) Status change in something the owner is actively tracking (job applications progressing, packages shipped, statements issued)",
    "",
    "Treat the following as noise unless they cross the anomaly bar:",
    "  - Routine bank deposits/withdrawals/transfers initiated by the owner",
    "  - Login notifications, 2FA codes, sign-in alerts from the owner's own sessions",
    "  - Self-installed integrations connecting (e.g., \"Personal Outlook Bridge\")",
    "  - LinkedIn connection requests, generic recruiter blasts",
    "  - Job rejections or auto-closed positions (no action possible)",
    "  - \"If not you, ignore\" verification emails",
    "  - Promotional emails, newsletters, automated digests",
    "  - Daily reports generated by this tool",
    "",
    "Finance: aggregate, do not enumerate.",
    "  - Do not list each transfer or deposit individually.",
    "  - Mention only: unusual amounts, bills due, autopay deductions, income events, charges the owner did not initiate.",
    "  - If nothing meets the bar, omit the finance section entirely.",
    "",
    "Security: omit unless anomalous.",
    "  - Unfamiliar device or location -> mention",
    "  - Password reset the owner did not request -> mention",
    "  - Routine self-initiated logins -> omit",
    "",
    "Create both reports from the same judgment pass: first decide what matters, then write a Chinese version for the owner and a demo-ready English version for external viewing.",
    "Write concise Chinese and concise English with Vancouver time.",
    "The English report should be a faithful translation/adaptation of the Chinese report, not a second independent interpretation of the inbox.",
    "For all time reasoning, anchor strictly to the supplied Run time and America/Vancouver timezone. If an event time is before Run time, treat it as past; if after Run time, treat it as upcoming.",
    "Prefer structured message.timeHints over natural-language guesses. If timeHints.eventStatus is upcoming, do not describe the event as completed or past.",
    "Concrete upcoming events within 48 hours belong in 今日要事. If the owner should attend, confirm, prepare, or check a link, include a matching 今日行动.",
    "Use relative time only when the direction and duration are unambiguous from Run time; otherwise use absolute Vancouver date/time.",
    "Total report should fit on one phone screen. If it does not, you are over-reporting.",
    "Return strict JSON only. Do not include Markdown, prose outside JSON, or code fences.",
    "Do not put emoji anywhere in headline, section titles, items, or actions. The renderer will add fixed section emoji.",
    "Use canonical Chinese section titles in JSON for both languages.",
    "Each input message has sourceId. For 今日要事 and 今日行动 items based on one or more important source emails, return the item as an object with text and sourceIds.",
    "Do not attach sourceIds to sections other than 今日要事 or 今日行动.",
    "JSON schema:",
    "{",
    "  \"zh\": {",
    "    \"headline\": \"short Chinese one-line summary, or empty string\",",
    "    \"sections\": [{\"title\": \"canonical section title\", \"items\": [{\"text\": \"short Chinese bullet without leading bullet marker\", \"sourceIds\": [\"m1\"]}]}],",
    "    \"actionsTitle\": \"今日行动 or 下周行动, or empty string\",",
    "    \"actions\": [{\"text\": \"short Chinese action without leading bullet marker\", \"sourceIds\": [\"m1\"]}]",
    "  },",
    "  \"en\": {",
    "    \"headline\": \"short English one-line summary, or empty string\",",
    "    \"sections\": [{\"title\": \"canonical section title\", \"items\": [{\"text\": \"short English bullet without leading bullet marker\", \"sourceIds\": [\"m1\"]}]}],",
    "    \"actionsTitle\": \"今日行动 or 下周行动, or empty string\",",
    "    \"actions\": [{\"text\": \"short English action without leading bullet marker\", \"sourceIds\": [\"m1\"]}]",
    "  }",
    "}",
    "Items may be plain strings only when no source email link is useful.",
    "Allowed daily section titles: 今日要事, 待回复, 异常关注, 知悉, 可以忽略.",
    "Allowed weekly section titles: 本周总览, 待回复, 求职进展, 异常关注, 知悉, 可以忽略.",
    "Omit empty sections entirely. Keep 可以忽略 to one item if present.",
  ].join("\n");
  const task = reportType === "weekly"
    ? [
        "Generate this week's email digest.",
        "Report window: previous Monday 00:00 through current run time (America/Vancouver).",
        "All emails in the input JSON are already within this window — no filtering needed.",
        "",
        "Structure (omit any empty section):",
        "  本周总览      2-3 sentences on the week's signal (job search momentum, key events, anything the owner should remember)",
        "  待回复        Real humans still awaiting the owner's reply from this week",
        "  求职进展      Application status changes, interviews booked/completed, recruiter conversations",
        "  异常关注      Anomalies in finance, security, or account activity",
        "  知悉          Other status changes worth noting (max 5 bullets)",
        "  可以忽略      Single-line summary of noise volume",
        "",
        "End with '下周行动' (3-5 items max) only if there are genuine forward actions.",
        "Apply the same noise filters and finance aggregation rules as daily.",
      ].join("\n")
    : [
        "Generate today's email digest.",
        "Report window: yesterday 00:00 through current run time (America/Vancouver).",
        "All emails in the input JSON are already within this window — no filtering needed.",
        "Focus on the last 24 hours; if earlier items in the window still need action, keep them in 今日要事 or 待回复.",
        "",
        "Structure (omit any empty section, do not write placeholder text):",
        "  今日要事      Concrete events/deadlines today or tomorrow",
        "  待回复        Real humans awaiting the owner's reply",
        "  异常关注      Anomalies only — not routine activity",
        "  知悉          Status changes worth noting, no action required (max 5 bullets)",
        "  可以忽略      Single-line summary of noise categories",
        "",
        "End with '今日行动' (3-5 items max) only if 今日要事 or 待回复 contains genuine actions.",
        "If a section would only contain low-value items, omit it entirely.",
      ].join("\n");
  const runTime = formatLocalDateTime(new Date(), VANCOUVER_TIME_ZONE);
  const userContent = [
    task,
    "",
    "Output both zh and en objects. Use canonical Chinese section titles exactly as specified in both objects.",
    "Use sourceIds from Input JSON only for 今日要事 and 今日行动 items that should link back to an original email.",
    "",
    `Run time: ${runTime}`,
    "",
    "Input JSON:",
    JSON.stringify(aiDigestInput(digestInput)),
  ].join("\n");

  if ((env.AI_PROVIDER || "openai") === "anthropic") {
    return summarizeWithAnthropic(env, system, userContent, reportType);
  }

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.5",
      input: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      max_output_tokens: reportType === "weekly" ? 2600 : 1600,
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI summary failed: ${JSON.stringify(payload)}`);
  }

  return {
    reports: parseBilingualReportJson(extractOpenAIText(payload)),
    meta: buildUnknownCostMeta(env.OPENAI_MODEL || "gpt-5.5"),
  };
}

async function summarizeWithAnthropic(env, system, userContent, reportType) {
  const model = env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: reportType === "weekly" ? 2600 : 1600,
      system,
      messages: [
        { role: "user", content: userContent },
      ],
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Anthropic summary failed: ${JSON.stringify(payload)}`);
  }

  return {
    reports: parseBilingualReportJson(extractAnthropicText(payload)),
    meta: buildAnthropicCostMeta(model, payload.usage),
  };
}

function extractAnthropicText(payload) {
  return (payload.content || [])
    .filter((content) => content.type === "text" && content.text)
    .map((content) => content.text)
    .join("\n");
}

function extractOpenAIText(payload) {
  if (payload.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (content.type === "text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

async function sendMail(accessToken, recipient, subject, report, language = "zh", meta = {}, digestInput = {}) {
  const html = reportToHtml(report, language, meta, digestInput);
  const response = await fetch(`${GRAPH_ROOT}/me/sendMail`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: html },
        toRecipients: [{ emailAddress: { address: recipient } }],
      },
      saveToSentItems: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph sendMail failed: ${text}`);
  }
}

async function sendPushover(env, title, message) {
  if (!env.PUSHOVER_USER_KEY || !env.PUSHOVER_API_TOKEN) {
    throw new Error("Pushover is enabled but PUSHOVER_USER_KEY or PUSHOVER_API_TOKEN is missing.");
  }
  const response = await fetch(PUSHOVER_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: env.PUSHOVER_API_TOKEN,
      user: env.PUSHOVER_USER_KEY,
      title,
      message: message.slice(0, 1024),
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pushover failed: ${text}`);
  }
}

function makeShortPush(report, digestInput, language = "zh") {
  return [
    `${digestInput.reportType === "weekly" ? "周报" : "日报"}: 扫描 ${digestInput.scanned} 封，未读 ${digestInput.unread} 封。`,
    reportToPlainText(report, language).replace(/\s+/g, " ").slice(0, 850),
  ].join("\n");
}

function reportToHtml(report, language = "zh", meta = {}, digestInput = {}) {
  const normalized = normalizeReport(report);
  const sourceMap = buildSourceMap(digestInput);
  const headline = normalized.headline
    ? `<div style="font-size:16px;line-height:1.45;color:#374151;margin:0 0 20px 0">${escapeHtml(normalized.headline)}</div>`
    : "";
  const sections = normalized.sections.map((section) => renderSection(section, language, false, sourceMap)).join("");
  const actions = normalized.actions.length > 0
    ? renderSection({ title: normalized.actionsTitle || "今日行动", items: normalized.actions }, language, true, sourceMap)
    : "";
  const footer = renderCostFooter(meta);

  return [
    `<html>`,
    `<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">`,
    `<div style="max-width:720px;margin:0 auto;padding:24px 18px">`,
    `<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px 24px 20px 24px">`,
    headline,
    sections,
    actions,
    footer,
    `</div>`,
    `</div>`,
    `</body>`,
    `</html>`,
  ].join("");
}

function renderCostFooter(meta = {}) {
  const model = meta.modelDisplayName || meta.model || "AI";
  const cost = typeof meta.approximateCostUsd === "number"
    ? formatUsd(meta.approximateCostUsd)
    : "n/a";
  return `<div style="font-size:10px;line-height:1.35;color:#9ca3af;text-align:right;margin:18px 0 0 0;white-space:nowrap;font-style:italic">Powered by ${escapeHtml(model)} · Approx. cost ${escapeHtml(cost)}</div>`;
}

function renderSection(section, language = "zh", isAction = false, sourceMap = new Map()) {
  const linksEnabled = ["今日要事", "今日行动"].includes(normalizeSectionTitle(section.title));
  const items = section.items
    .filter(Boolean)
    .map((item) => renderReportItem(item, language, linksEnabled ? sourceMap : new Map()))
    .join("");
  const title = sectionDisplayTitle(section.title, language);
  return [
    `<section style="margin:0 0 20px 0">`,
    `<div style="font-size:15px;font-weight:700;color:#111827;margin:0 0 8px 0;border-left:3px solid #9ca3af;padding-left:9px">${escapeHtml(`${sectionEmoji(section.title)} ${title}`)}</div>`,
    `<div style="font-size:15px;line-height:1.52;color:#1f2937;margin:0">${items}</div>`,
    `</section>`,
  ].join("");
}

function renderReportItem(item, language = "zh", sourceMap = new Map()) {
  const text = typeof item === "string" ? item : item.text;
  const sourceIds = Array.isArray(item?.sourceIds) ? item.sourceIds : [];
  const links = sourceIds
    .map((sourceId) => sourceMap.get(sourceId))
    .filter((source) => source?.webLink)
    .slice(0, 3);
  const linkLabel = language === "en" ? "Open email" : "打开原邮件";
  const link = links.length > 0
    ? ` —— <a href="${escapeHtml(links[0].webLink)}" target="_blank" rel="noopener noreferrer" style="color:#7DD3FC;text-decoration:none">${escapeHtml(linkLabel)}</a>`
    : "";
  return `<div style="margin:6px 0">${escapeHtml(`- ${stripLeadingBullet(text)}`)}${link}</div>`;
}

function parseReportJson(text) {
  const raw = String(text || "").trim();
  try {
    return normalizeReport(JSON.parse(raw));
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return normalizeReport(JSON.parse(match[0]));
      } catch {
        // Fall through to text fallback.
      }
    }
  }
  return normalizeReport({
    headline: "",
    sections: [{ title: "邮件摘要", items: [raw || "没有值得报告的邮件。"] }],
    actionsTitle: "",
    actions: [],
  });
}

function parseBilingualReportJson(text) {
  const raw = String(text || "").trim();
  const fallback = normalizeReport({
    headline: "",
    sections: [{ title: "邮件摘要", items: [raw || "没有值得报告的邮件。"] }],
    actionsTitle: "",
    actions: [],
  });
  const parsed = parseJsonObject(raw);
  if (!parsed) return { zh: fallback, en: fallback };
  if (parsed.zh || parsed.en) {
    const zh = normalizeReport(parsed.zh || parsed.en);
    const en = normalizeReport(parsed.en || parsed.zh);
    return { zh, en };
  }
  const report = normalizeReport(parsed);
  return { zh: report, en: report };
}

function validateReports(reports, digestInput) {
  const events = importantUpcomingEvents(digestInput);
  if (events.length === 0) return reports;
  return {
    zh: validateReportLanguage(reports.zh, events, "zh"),
    en: validateReportLanguage(reports.en, events, "en"),
  };
}

function validateReportLanguage(report, events, language) {
  let nextReport = normalizeReport(report);
  for (const event of events) {
    nextReport = removeContradictoryEventItems(nextReport, event);
    nextReport = removeUpcomingEventFromNonActionSections(nextReport, event);
    nextReport = ensureEventInKeyItems(nextReport, event, language);
    nextReport = ensureEventAction(nextReport, event, language);
    nextReport.headline = safeHeadline(nextReport.headline, event, language);
  }
  return nextReport;
}

function removeUpcomingEventFromNonActionSections(report, event) {
  const matcher = eventMatcher(event);
  return {
    ...report,
    sections: report.sections
      .map((section) => {
        const title = normalizeSectionTitle(section.title);
        if (title === "今日要事") return section;
        return {
          ...section,
          items: section.items.filter((item) => !matcher.test(reportItemText(item))),
        };
      })
      .filter((section) => section.items.length > 0),
  };
}

function importantUpcomingEvents(digestInput = {}) {
  return (digestInput.messages || [])
    .filter((message) => message?.timeHints?.eventStatus === "upcoming")
    .filter((message) => Number(message.timeHints.minutesFromRun) <= 48 * 60)
    .filter((message) => {
      const text = `${message.subject || ""} ${message.preview || ""}`.toLowerCase();
      return (message.categories || []).includes("interviews_jobs")
        || /\b(interview|meeting|appointment|teams|meet)\b/i.test(text);
    })
    .slice(0, 5)
    .map((message) => ({
      sourceId: message.sourceId,
      subject: message.subject,
      preview: message.preview,
      from: message.from,
      timeHints: message.timeHints,
      key: eventKey(message),
    }));
}

function removeContradictoryEventItems(report, event) {
  const matcher = eventMatcher(event);
  return {
    ...report,
    sections: report.sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => !isContradictoryUpcomingEventItem(item, matcher)),
      }))
      .filter((section) => section.items.length > 0),
    actions: report.actions.filter((item) => !isContradictoryUpcomingEventItem(item, matcher)),
  };
}

function isContradictoryUpcomingEventItem(item, matcher) {
  const text = reportItemText(item);
  return matcher.test(text) && /(已完成|完成|结束|completed|done|finished|already happened)/i.test(text);
}

function ensureEventInKeyItems(report, event, language) {
  const item = eventReportItem(event, language);
  return upsertSectionItem(report, "今日要事", item, event);
}

function ensureEventAction(report, event, language) {
  const action = eventActionItem(event, language);
  const unrelatedActions = report.actions.filter((item) => !isEventRelatedAction(item, event));
  const actions = [action, ...unrelatedActions].slice(0, 5);
  return {
    ...report,
    actionsTitle: report.actionsTitle || "今日行动",
    actions,
  };
}

function upsertSectionItem(report, title, item, event) {
  const sections = [...report.sections];
  const index = sections.findIndex((section) => normalizeSectionTitle(section.title) === title);
  if (index >= 0) {
    if (!hasEventItem(sections[index].items, event)) {
      sections[index] = {
        ...sections[index],
        items: [item, ...sections[index].items].slice(0, 8),
      };
    }
  } else {
    sections.unshift({ title, items: [item] });
  }
  return { ...report, sections };
}

function hasEventItem(items, event) {
  const matcher = eventMatcher(event);
  return (items || []).some((item) => (item.sourceIds || []).includes(event.sourceId) || matcher.test(reportItemText(item)));
}

function isEventRelatedAction(item, event) {
  const text = reportItemText(item);
  if ((item.sourceIds || []).includes(event.sourceId)) return true;
  if (eventMatcher(event).test(text)) return true;
  const time = parseLocalStamp(event.timeHints.eventStartLocal);
  const hasEventTime = time && new RegExp(`\\b${pad2(time.hour)}:${pad2(time.minute)}\\b|\\b${time.hour}:${pad2(time.minute)}\\b`).test(text);
  const eventWords = /(面试|会议|预约|interview|meeting|appointment|teams)/i.test(text);
  return Boolean(hasEventTime && eventWords);
}

function eventReportItem(event, language) {
  return {
    text: language === "en"
      ? `${eventName(event, "en")}: ${eventTimeText(event, "en")}, confirmed`
      : `${eventName(event, "zh")}：${eventTimeText(event, "zh")}，已确认`,
    sourceIds: [event.sourceId],
  };
}

function eventActionItem(event, language) {
  return {
    text: language === "en"
      ? `Prepare and join the ${eventName(event, "en")} at ${eventTimeText(event, "en")}`
      : `准备并在 ${eventTimeText(event, "zh")} 准时参加${eventName(event, "zh")}`,
    sourceIds: [event.sourceId],
  };
}

function safeHeadline(headline, event, language) {
  if (!isContradictoryUpcomingEventItem({ text: headline }, eventMatcher(event)) && headline) return headline;
  return language === "en"
    ? `${eventName(event, "en")} scheduled for ${eventTimeText(event, "en")}`
    : `${eventName(event, "zh")}安排在${eventTimeText(event, "zh")}`;
}

function eventName(event, language) {
  const text = `${event.subject || ""} ${event.preview || ""}`;
  const company = inferEventEntity(event.subject || event.from || "");
  if (/interview/i.test(text)) {
    if (!company) return language === "en" ? "interview" : "面试";
    return language === "en" ? `${company} interview` : `${company} 面试`;
  }
  if (/appointment/i.test(text)) return language === "en" ? "appointment" : "预约";
  if (/meeting|teams/i.test(text)) return language === "en" ? "meeting" : "会议";
  return cleanReportItem(event.subject || (language === "en" ? "event" : "日程"));
}

function inferEventEntity(text) {
  const subject = cleanReportItem(text);
  const beforeDash = subject.split(/\s[-–—]\s| - | – | — /)[0]?.trim() || "";
  const candidate = beforeDash
    .replace(/^(re|fw|fwd):\s*/i, "")
    .replace(/\b(interview|appointment|meeting|with|accepted|declined|confirmed)\b/gi, "")
    .trim();
  if (candidate && candidate.length <= 40 && /[A-Za-z]/.test(candidate)) return candidate;
  return "";
}

function eventTimeText(event, language) {
  const start = parseLocalStamp(event.timeHints.eventStartLocal);
  const end = parseLocalStamp(event.timeHints.eventEndLocal);
  if (!start) return language === "en" ? "the scheduled time" : "约定时间";
  const range = end ? `${pad2(start.hour)}:${pad2(start.minute)}–${pad2(end.hour)}:${pad2(end.minute)}` : `${pad2(start.hour)}:${pad2(start.minute)}`;
  if (language === "en") {
    const month = new Intl.DateTimeFormat("en-US", { month: "short" }).format(new Date(Date.UTC(start.year, start.month - 1, start.day, 12)));
    return `${month} ${start.day}, ${range} PT`;
  }
  return `${start.month}/${start.day} ${range} PT`;
}

function parseLocalStamp(stamp = "") {
  const match = String(stamp).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
}

function eventMatcher(event) {
  return new RegExp(event.key, "i");
}

function eventKey(event) {
  const text = `${event.subject || ""} ${event.preview || ""}`;
  const entity = inferEventEntity(event.subject || event.from || "");
  if (entity) return escapeRegex(entity);
  if (/interview/i.test(text)) return "interview";
  return escapeRegex(cleanReportItem(event.subject || "").split(/\s+/).slice(0, 3).join(" ")) || "event";
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aiDigestInput(digestInput) {
  const { sourceLinks, ...input } = digestInput;
  return input;
}

function buildSourceMap(digestInput = {}) {
  return new Map((digestInput.sourceLinks || [])
    .filter((source) => source?.sourceId && source?.webLink)
    .map((source) => [source.sourceId, source]));
}

function buildAnthropicCostMeta(model, usage = {}) {
  const inputTokens = Number(usage?.input_tokens || 0);
  const outputTokens = Number(usage?.output_tokens || 0);
  const cacheWriteTokens = Number(usage?.cache_creation_input_tokens || 0);
  const cacheReadTokens = Number(usage?.cache_read_input_tokens || 0);
  const cost = (inputTokens * ANTHROPIC_SONNET_PRICING.inputPerMillion
    + outputTokens * ANTHROPIC_SONNET_PRICING.outputPerMillion
    + cacheWriteTokens * ANTHROPIC_SONNET_PRICING.cacheWritePerMillion
    + cacheReadTokens * ANTHROPIC_SONNET_PRICING.cacheReadPerMillion) / 1_000_000;
  return {
    model,
    modelDisplayName: displayModelName(model),
    approximateCostUsd: cost,
    usage: {
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
    },
  };
}

function buildUnknownCostMeta(model) {
  return {
    model,
    modelDisplayName: displayModelName(model),
    approximateCostUsd: null,
    usage: {},
  };
}

function displayModelName(model) {
  if (/claude-sonnet-4-6/i.test(model)) return "Claude Sonnet 4.6";
  if (/claude-sonnet-4/i.test(model)) return "Claude Sonnet 4";
  if (/gpt-5\.5/i.test(model)) return "GPT-5.5";
  return String(model || "AI");
}

function formatUsd(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  if (value > 0 && value < 0.0001) return "<$0.0001";
  return `$${value.toFixed(4)}`;
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function normalizeReport(report) {
  const sections = Array.isArray(report?.sections)
    ? report.sections
      .map((section) => ({
        title: normalizeSectionTitle(section?.title || ""),
        items: Array.isArray(section?.items)
          ? section.items.map(normalizeReportItem).filter(Boolean).slice(0, 8)
          : [],
      }))
      .filter((section) => section.title && section.items.length > 0)
      .slice(0, 6)
    : [];
  return {
    headline: cleanReportItem(report?.headline || ""),
    sections,
    actionsTitle: normalizeSectionTitle(report?.actionsTitle || ""),
    actions: Array.isArray(report?.actions)
      ? report.actions.map(normalizeReportItem).filter(Boolean).slice(0, 5)
      : [],
  };
}

function reportToPlainText(report, language = "zh") {
  const normalized = normalizeReport(report);
  return [
    normalized.headline,
    ...normalized.sections.flatMap((section) => [`${sectionEmoji(section.title)} ${sectionDisplayTitle(section.title, language)}`, ...section.items.map((item) => `- ${stripLeadingBullet(reportItemText(item))}`)]),
    ...(normalized.actions.length > 0 ? [`${sectionEmoji(normalized.actionsTitle || "今日行动")} ${sectionDisplayTitle(normalized.actionsTitle || "今日行动", language)}`, ...normalized.actions.map((item) => `- ${stripLeadingBullet(reportItemText(item))}`)] : []),
  ].filter(Boolean).join("\n");
}

function normalizeSectionTitle(title) {
  const clean = stripEmoji(cleanText(title));
  const compact = clean.replace(/\s+/g, "");
  const aliases = new Map([
    ["今日要事", "今日要事"],
    ["待回复", "待回复"],
    ["异常关注", "异常关注"],
    ["知悉", "知悉"],
    ["可以忽略", "可以忽略"],
    ["今日行动", "今日行动"],
    ["本周总览", "本周总览"],
    ["求职进展", "求职进展"],
    ["下周行动", "下周行动"],
    ["KeyItems", "今日要事"],
    ["NeedReply", "待回复"],
    ["AwaitingReply", "待回复"],
    ["Anomalies", "异常关注"],
    ["FYI", "知悉"],
    ["Ignore", "可以忽略"],
    ["Actions", "今日行动"],
    ["WeeklyOverview", "本周总览"],
    ["JobSearchProgress", "求职进展"],
    ["NextWeekActions", "下周行动"],
  ]);
  return aliases.get(compact) || clean;
}

function sectionEmoji(title) {
  return {
    今日要事: "🎯",
    待回复: "💬",
    异常关注: "⚠️",
    知悉: "📋",
    可以忽略: "💤",
    今日行动: "✅",
    本周总览: "📋",
    求职进展: "🎯",
    下周行动: "✅",
  }[normalizeSectionTitle(title)] || "📋";
}

function sectionDisplayTitle(title, language = "zh") {
  const normalized = normalizeSectionTitle(title);
  if (language !== "en") return normalized;
  return {
    今日要事: "Key Items",
    待回复: "Awaiting Reply",
    异常关注: "Anomalies",
    知悉: "FYI",
    可以忽略: "Safe to Ignore",
    今日行动: "Actions",
    本周总览: "Weekly Overview",
    求职进展: "Job Search Progress",
    下周行动: "Next Week Actions",
  }[normalized] || normalized;
}

function cleanReportItem(text) {
  return stripLeadingBullet(stripEmoji(cleanText(text)));
}

function reportItemText(item) {
  return typeof item === "string" ? item : item?.text || "";
}

function normalizeReportItem(item) {
  if (typeof item === "string") {
    const text = cleanReportItem(item);
    return text ? { text, sourceIds: [] } : null;
  }
  const text = cleanReportItem(item?.text || item?.label || item?.content || "");
  if (!text) return null;
  const sourceIds = Array.isArray(item?.sourceIds)
    ? item.sourceIds.map((sourceId) => cleanText(sourceId)).filter(Boolean).slice(0, 3)
    : [];
  return { text, sourceIds };
}

function stripLeadingBullet(text) {
  return cleanText(text)
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

function stripEmoji(text) {
  return cleanText(text)
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, "")
    .replace(/[\u{1F300}-\u{1FAFF}]\uFE0F?/gu, "")
    .replace(/[\u2600-\u27BF]\uFE0F?/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanText(text) {
  return String(text)
    .replace(/[\u034f\u200b-\u200f\u202a-\u202e\u2060-\u206f]+/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#xa;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function redactSensitiveText(text) {
  return text
    .replace(/\b(one-time passcode|verification code|security code|login code)(.{0,80}?)(?:is:?\s*)?([A-Z0-9]{4,10})\b/gi, "$1$2[REDACTED]")
    .replace(/\b(code is|code:|your code is:?|service is:?|passcode is|password is)(\s*)([A-Z0-9]{4,10})\b/gi, "$1$2[REDACTED]")
    .replace(/\b\d{6}\b/g, "[REDACTED]");
}

function getLocalParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
    minute: Number(byType.minute),
    second: Number(byType.second),
  };
}

function formatLocalDateTime(date, timeZone) {
  const parts = getLocalParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)} ${timeZone}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function getLocalWeekday(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
}

function getLocalWeekStart(date, timeZone) {
  const parts = getLocalParts(date, timeZone);
  const weekday = getLocalWeekday(date, timeZone);
  const offsetDays = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekday] ?? 0;
  const monday = shiftLocalDate(parts, -offsetDays);
  return zonedTimeToUtc(monday.year, monday.month, monday.day, 0, 0, timeZone);
}

function shiftLocalDate(parts, deltaDays) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays, 12, 0, 0));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let index = 0; index < 3; index += 1) {
    const offset = getTimeZoneOffsetMs(new Date(guess), timeZone);
    guess = Date.UTC(year, month - 1, day, hour, minute, 0) - offset;
  }
  return new Date(guess);
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getLocalParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}
