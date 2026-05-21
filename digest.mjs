import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const configPath = join(root, "config.json");
const tokenPath = join(root, ".secrets", "tokens.json");

const categories = [
  {
    key: "urgent",
    title: "Urgent / Time-Sensitive",
    patterns: [
      /\b(today|tomorrow|by end of day|asap|urgent|expires?|deadline|last chance|action required)\b/i,
      /\b(interview|meeting|calendar|schedule|reschedule|availability|appointment)\b/i,
    ],
  },
  {
    key: "needsReply",
    title: "Likely Needs Reply",
    patterns: [
      /\b(can you|could you|please confirm|let me know|your availability|are you available|would you like|follow(?:ing)? up)\b/i,
      /\b(reply|respond|response requested|waiting for your response)\b/i,
    ],
  },
  {
    key: "jobs",
    title: "Jobs / Interviews",
    patterns: [
      /\b(interview|recruiter|talent acquisition|hiring team|application|applied|applying|candidate|position|role|assessment|take[- ]home|workday|greenhouse|lever|ashby|bamboohr)\b/i,
      /\b(thank you for applying|application received|status update|not moving forward)\b/i,
    ],
  },
  {
    key: "security",
    title: "Security / Sign-In",
    patterns: [
      /\b(security alert|new sign-in|sign-in|login|password|passcode|verification code|one-time|2fa|mfa|account protection|new app|connected to your microsoft account)\b/i,
    ],
  },
  {
    key: "finance",
    title: "Finance / Bills",
    patterns: [
      /\b(invoice|receipt|statement|payment|paid|billing|bill|tax|refund|subscription|bank|credit card|insurance|withdrawal|deposit|account alert|filled)\b/i,
    ],
  },
  {
    key: "shopping",
    title: "Orders / Shopping",
    patterns: [
      /\b(order|shipped|delivered|delivery|tracking|return|purchase|store pickup)\b/i,
    ],
  },
  {
    key: "newsletters",
    title: "Newsletters / Promotions",
    patterns: [
      /\b(newsletter|unsubscribe|sale|offer|promo|discount|rewards|weekly|digest|updates|webinar)\b/i,
    ],
  },
];

function formEncode(values) {
  return new URLSearchParams(values).toString();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function refreshAccessToken(config, tokens) {
  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formEncode({
      client_id: config.clientId,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(" "),
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(payload, null, 2));
  }

  const nextTokens = {
    ...tokens,
    ...payload,
    refreshed_at: new Date().toISOString(),
  };
  await writeFile(tokenPath, JSON.stringify(nextTokens, null, 2), { mode: 0o600 });
  return nextTokens.access_token;
}

function parseArgs(argv) {
  const options = {
    days: 1,
    limit: 400,
    json: false,
    write: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") options.json = true;
    if (value === "--write") options.write = true;
    if (value === "--days") options.days = Number(argv[index + 1] ?? options.days);
    if (value === "--limit") options.limit = Number(argv[index + 1] ?? options.limit);
  }

  if (!Number.isFinite(options.days) || options.days <= 0) {
    throw new Error("--days must be a positive number.");
  }
  if (!Number.isFinite(options.limit) || options.limit <= 0) {
    throw new Error("--limit must be a positive number.");
  }

  return options;
}

function decodeEntities(text = "") {
  return text
    .replace(/[\u034f\u200b-\u200f\u202a-\u202e\u2060-\u206f]+/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#xa;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function redactSensitiveText(text = "") {
  return text
    .replace(/\b(one-time passcode|verification code|security code|login code)(.{0,80}?)(?:is:?\s*)?([A-Z0-9]{4,10})\b/gi, "$1$2[REDACTED]")
    .replace(/\b(code is|code:)(\s*)([A-Z0-9]{4,10})\b/gi, "$1$2[REDACTED]")
    .replace(/\b(service is:?\s*)([A-Z0-9]{4,10})\b/gi, "$1[REDACTED]")
    .replace(/\b(your code is:?\s*)([A-Z0-9]{4,10})\b/gi, "$1[REDACTED]")
    .replace(/\b(passcode is|password is)(\s*)([A-Z0-9]{4,10})\b/gi, "$1$2[REDACTED]");
}

async function graph(accessToken, urlOrPath) {
  const url = urlOrPath.startsWith("https://")
    ? urlOrPath
    : `https://graph.microsoft.com/v1.0${urlOrPath}`;
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      prefer: 'outlook.body-content-type="text"',
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(payload, null, 2));
  }
  return payload;
}

async function listRecentMessages(accessToken, since, limit) {
  const select = [
    "id",
    "receivedDateTime",
    "from",
    "subject",
    "bodyPreview",
    "isRead",
    "importance",
    "webLink",
  ].join(",");

  let url = `/me/messages?$top=100&$orderby=receivedDateTime desc&$filter=receivedDateTime ge ${since.toISOString()}&$select=${encodeURIComponent(select)}`;
  const messages = [];

  while (url && messages.length < limit) {
    const page = await graph(accessToken, url);
    messages.push(...(page.value ?? []));
    url = page["@odata.nextLink"] ?? "";
  }

  return messages.slice(0, limit);
}

function simplifyMessage(message) {
  const from = message.from?.emailAddress ?? {};
  return {
    id: message.id,
    receivedAt: message.receivedDateTime,
    fromName: from.name ?? "",
    from: from.address ?? "unknown",
    subject: decodeEntities(message.subject ?? "(no subject)"),
    preview: redactSensitiveText(decodeEntities(message.bodyPreview ?? "")).slice(0, 360),
    isRead: Boolean(message.isRead),
    importance: message.importance ?? "normal",
    webLink: message.webLink,
  };
}

function classify(message) {
  const text = `${message.fromName} ${message.from} ${message.subject} ${message.preview}`;
  const matches = categories
    .filter((category) => category.patterns.some((pattern) => pattern.test(text)))
    .map((category) => category.key);

  if (matches.length === 0) matches.push("other");
  return matches;
}

function isPromotional(message) {
  const text = `${message.fromName} ${message.from} ${message.subject} ${message.preview}`;
  return /\b(unsubscribe|sale|discount|promo|rewards?|points|survey|newsletter|weekly offer|activate your offers|last chance|deal|shop now|buy now)\b/i.test(text)
    || /(offers@|news@|updates@|campaigns|jobalert|jobalerts|jobs-noreply|match\.indeed|invitations@linkedin|newsletters-noreply|clearly|kits\.com|sceneplus|airmiles|canadiantire|mcdonald|ticketleader)/i.test(text);
}

function isAutomatedSocial(message) {
  const text = `${message.fromName} ${message.from} ${message.subject}`;
  return /(invitations@linkedin|messages-noreply@linkedin|updates-noreply@linkedin|I want to connect|You have an invitation)/i.test(text);
}

function isCalendarOrInterview(message) {
  return /\b(interview|meeting|availability|schedule|reschedule|confirmed|accepted:|declined:)\b/i.test(`${message.subject} ${message.preview}`);
}

function isActionableSecurity(message) {
  return /\b(security alert|new sign-in|new app|connected to your microsoft account|account protection)\b/i.test(`${message.subject} ${message.preview}`);
}

function isActionableFinance(message) {
  return /\b(withdrawal|deposit|payment due|bill due|invoice|statement|account alert)\b/i.test(`${message.subject} ${message.preview}`);
}

function buildDigest(messages, since) {
  const buckets = Object.fromEntries([
    ...categories.map((category) => [category.key, []]),
    ["other", []],
  ]);

  const simplified = messages.map(simplifyMessage);
  for (const message of simplified) {
    const matchedCategories = classify(message);
    for (const key of matchedCategories) {
      buckets[key].push(message);
    }
  }

  const importantCandidates = [
    ...buckets.urgent.filter((message) => !isPromotional(message) && (isCalendarOrInterview(message) || isActionableSecurity(message) || isActionableFinance(message))),
    ...buckets.needsReply.filter((message) => !isPromotional(message) && !isAutomatedSocial(message)),
    ...buckets.jobs.filter(isCalendarOrInterview),
    ...buckets.security.filter((message) => !message.isRead || isActionableSecurity(message)),
    ...buckets.finance.filter(isActionableFinance),
  ];

  const important = [...new Map(importantCandidates.map((message) => [message.id, message])).values()];

  return {
    generatedAt: new Date().toISOString(),
    since: since.toISOString(),
    scanned: simplified.length,
    unread: simplified.filter((message) => !message.isRead).length,
    important,
    buckets,
  };
}

function formatMessage(message) {
  const unread = message.isRead ? "" : " unread";
  const preview = message.preview ? ` — ${message.preview}` : "";
  return `- ${message.receivedAt.slice(0, 16).replace("T", " ")}${unread} | ${message.fromName || message.from} | ${message.subject}${preview}`;
}

function formatDigest(digest) {
  const lines = [
    "# Daily Email Digest",
    "",
    `Generated: ${digest.generatedAt}`,
    `Window start: ${digest.since}`,
    `Scanned: ${digest.scanned}`,
    `Unread: ${digest.unread}`,
    "",
    "## Important",
  ];

  if (digest.important.length === 0) {
    lines.push("- No urgent or reply-worthy messages found.");
  } else {
    lines.push(...digest.important.slice(0, 20).map(formatMessage));
  }

  for (const category of categories) {
    const messages = digest.buckets[category.key];
    lines.push("", `## ${category.title} (${messages.length})`);
    if (messages.length === 0) {
      lines.push("- None.");
    } else {
      lines.push(...messages.slice(0, 12).map(formatMessage));
      if (messages.length > 12) {
        lines.push(`- …and ${messages.length - 12} more.`);
      }
    }
  }

  lines.push("", `## Other (${digest.buckets.other.length})`);
  if (digest.buckets.other.length === 0) {
    lines.push("- None.");
  } else {
    lines.push(...digest.buckets.other.slice(0, 8).map(formatMessage));
    if (digest.buckets.other.length > 8) {
      lines.push(`- …and ${digest.buckets.other.length - 8} more.`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  if (!existsSync(configPath) || !existsSync(tokenPath)) {
    throw new Error("Run auth first. Need config.json and .secrets/tokens.json.");
  }

  const options = parseArgs(process.argv.slice(2));
  const config = await readJson(configPath);
  const tokens = await readJson(tokenPath);
  const accessToken = await refreshAccessToken(config, tokens);
  const since = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);
  const messages = await listRecentMessages(accessToken, since, options.limit);
  const digest = buildDigest(messages, since);
  const output = options.json ? JSON.stringify(digest, null, 2) : formatDigest(digest);

  if (options.write) {
    const reportsDir = join(root, "reports");
    await mkdir(reportsDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const extension = options.json ? "json" : "md";
    const reportPath = join(reportsDir, `${date}-email-digest.${extension}`);
    await writeFile(reportPath, output, "utf8");
    console.error(`Wrote ${reportPath}`);
  }

  console.log(output);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
