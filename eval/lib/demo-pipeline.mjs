// Token-free demo pipeline used only by the eval harness.
//
// This intentionally does not import production files. The private production
// agent currently runs as CLI scripts and does not expose testable functions, so
// this additive eval seam mirrors the public demo path without touching Graph,
// OAuth tokens, Cloudflare, or email delivery.

const categoryRules = [
  { key: "urgent", label: "Urgent / Time-Sensitive", pattern: /\b(today|tomorrow|urgent|deadline|interview|meeting|appointment|confirm|schedule|friday|wednesday|thursday)\b/i },
  { key: "needs_reply", label: "Likely Needs Reply", pattern: /\b(can you|could you|please confirm|send|review|reply|respond|let me know|confirm)\b/i },
  { key: "security", label: "Security / Sign-In", pattern: /\b(security|verification code|one-time|login|password|passcode|account)\b/i },
  { key: "finance", label: "Finance / Bills", pattern: /\b(invoice|statement|payment|billing|bill|usage)\b/i },
  { key: "marketing", label: "Marketing / Promotions", pattern: /\b(newsletter|roundup|webinar|promo|offer|discount|sale|shop now|unsubscribe|优惠|优惠券|限时)\b/i },
  { key: "non_english_action", label: "Non-English Action", pattern: /确认|回复|会议|明天|下午|今天/u },
];

export function runDemoPipeline(inbox, caseId = "synthetic-case") {
  const normalized = inbox.map((message, index) => normalizeMessage(message, index));
  const kept = [];
  const filtered = [];

  for (const message of normalized) {
    const reason = getLowValueReason(message);
    if (reason) filtered.push({ reason, from: message.from, subject: message.subject });
    else kept.push(message);
  }

  const actions = kept
    .filter((message) => message.categories.includes("urgent")
      || message.categories.includes("needs_reply")
      || message.categories.includes("non_english_action"))
    .slice(0, 8);

  const digest = {
    caseId,
    scanned: normalized.length,
    included: kept.length,
    filteredOut: filtered,
    sections: {
      important: actions,
      noiseRemoved: filtered,
    },
  };

  return {
    digest,
    output: formatDigest(digest),
  };
}

function normalizeMessage(message, index) {
  const subject = cleanText(message.subject || "(no subject)");
  const body = addEnglishActionHints(redactSensitiveText(cleanText(message.body || message.preview || "")));
  const from = cleanText(message.from || "unknown@example.test");
  const text = `${from} ${subject} ${body}`;
  const categories = categoryRules
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => rule.key);

  return {
    id: `m${index + 1}`,
    from,
    subject,
    body,
    categories: categories.length > 0 ? categories : ["other"],
  };
}

function addEnglishActionHints(text) {
  if (/明天下午三点.*会议|会议.*明天下午三点/u.test(text)) {
    return `${text} (confirm tomorrow 3 PM meeting)`;
  }
  return text;
}

function cleanText(text) {
  return String(text)
    .replace(/[\u034f\u200b-\u200f\u202a-\u202e\u2060-\u206f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function redactSensitiveText(text = "") {
  return String(text)
    .replace(/\b(verification code is|code is|code:|passcode is|login code is)(\s*)([A-Z0-9]{4,10})\b/gi, "$1$2[REDACTED]")
    .replace(/\b(one-time passcode|security code|verification code|login code)(.{0,80}?)([A-Z0-9]{4,10})\b/gi, "$1$2[REDACTED]")
    .replace(/\b(\d{6})\b/g, "[REDACTED]");
}

function getLowValueReason(message) {
  const text = `${message.from} ${message.subject} ${message.body}`;
  if (message.categories.includes("marketing")) return "marketing_or_newsletter";
  if (message.categories.includes("security") && /\bverification code|security code|passcode|login code\b/i.test(text)) {
    return "plain_verification_code";
  }
  return "";
}

function formatDigest(digest) {
  const lines = [
    "# Demo Email Digest",
    "",
    `Case: ${digest.caseId}`,
    `Scanned: ${digest.scanned}`,
    `Included: ${digest.included}`,
    `Filtered out: ${digest.filteredOut.length}`,
    "",
    "## Important",
  ];

  if (digest.sections.important.length === 0) {
    lines.push("- No urgent or reply-worthy messages found.");
  } else {
    for (const message of digest.sections.important) {
      lines.push(`- ${message.from}: ${message.subject} — ${message.body}`);
    }
  }

  lines.push("", "## Noise Removed");
  if (digest.sections.noiseRemoved.length === 0) {
    lines.push("- None.");
  } else {
    for (const item of digest.sections.noiseRemoved) {
      lines.push(`- ${item.reason}: ${item.subject}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
