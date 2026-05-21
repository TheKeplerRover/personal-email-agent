export const categories = [
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

export function decodeEntities(text = "") {
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

export function redactSensitiveText(text = "") {
  return text
    .replace(/\b(one-time passcode|verification code|security code|login code)(.{0,80}?)(?:is:?\s*)?((?=[A-Z0-9]*\d)[A-Z0-9]{4,10})\b/gi, "$1$2[REDACTED]")
    .replace(/\b(code is|code:)(\s*)((?=[A-Z0-9]*\d)[A-Z0-9]{4,10})\b/gi, "$1$2[REDACTED]")
    .replace(/\b(service is:?\s*)((?=[A-Z0-9]*\d)[A-Z0-9]{4,10})\b/gi, "$1[REDACTED]")
    .replace(/\b(your code is:?\s*)((?=[A-Z0-9]*\d)[A-Z0-9]{4,10})\b/gi, "$1[REDACTED]")
    .replace(/\b(passcode is|password is)(\s*)((?=[A-Z0-9]*\d)[A-Z0-9]{4,10})\b/gi, "$1$2[REDACTED]");
}

export function simplifyMessage(message) {
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

export function classify(message) {
  const text = `${message.fromName} ${message.from} ${message.subject} ${message.preview}`;
  const matches = categories
    .filter((category) => category.patterns.some((pattern) => pattern.test(text)))
    .map((category) => category.key);

  if (matches.length === 0) matches.push("other");
  return matches;
}

export function isPromotional(message) {
  const text = `${message.fromName} ${message.from} ${message.subject} ${message.preview}`;
  return /\b(unsubscribe|sale|discount|promo|rewards?|points|survey|newsletter|weekly offer|activate your offers|last chance|deal|shop now|buy now)\b/i.test(text)
    || /(offers@|news@|updates@|campaigns|jobalert|jobalerts|jobs-noreply|match\.indeed|invitations@linkedin|newsletters-noreply|clearly|kits\.com|sceneplus|airmiles|canadiantire|mcdonald|ticketleader)/i.test(text);
}

export function isAutomatedSocial(message) {
  const text = `${message.fromName} ${message.from} ${message.subject}`;
  return /(invitations@linkedin|messages-noreply@linkedin|updates-noreply@linkedin|I want to connect|You have an invitation)/i.test(text);
}

export function isCalendarOrInterview(message) {
  return /\b(interview|meeting|availability|schedule|reschedule|confirmed|accepted:|declined:)\b/i.test(`${message.subject} ${message.preview}`);
}

export function isActionableSecurity(message) {
  return /\b(security alert|new sign-in|new app|connected to your microsoft account|account protection)\b/i.test(`${message.subject} ${message.preview}`);
}

export function isActionableFinance(message) {
  return /\b(withdrawal|deposit|payment due|bill due|invoice|statement|account alert)\b/i.test(`${message.subject} ${message.preview}`);
}

export function buildDigest(messages, since) {
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

export function formatMessage(message) {
  const unread = message.isRead ? "" : " unread";
  const preview = message.preview ? ` — ${message.preview}` : "";
  return `- ${message.receivedAt.slice(0, 16).replace("T", " ")}${unread} | ${message.fromName || message.from} | ${message.subject}${preview}`;
}

export function formatDigest(digest) {
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
