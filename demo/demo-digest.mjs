import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const messages = JSON.parse(await readFile(join(root, "messages.json"), "utf8"));

const categoryRules = [
  { key: "urgent", label: "Urgent / Time-Sensitive", pattern: /\b(today|tomorrow|urgent|deadline|interview|meeting|appointment)\b/i },
  { key: "needsReply", label: "Likely Needs Reply", pattern: /\b(can you|could you|please confirm|send|review|reply|respond)\b/i },
  { key: "security", label: "Security / Sign-In", pattern: /\b(security|verification code|one-time|login|password|account)\b/i },
  { key: "finance", label: "Finance / Bills", pattern: /\b(invoice|statement|payment|billing|bill|usage)\b/i },
  { key: "newsletter", label: "Newsletters / Promotions", pattern: /\b(newsletter|roundup|webinar|promo|offer)\b/i },
];

function redactSensitiveText(text = "") {
  return text
    .replace(/\b(verification code is|code is|code:)(\s*)([A-Z0-9]{4,10})\b/gi, "$1$2[REDACTED]")
    .replace(/\b(one-time passcode|security code)(.{0,80}?)([A-Z0-9]{4,10})\b/gi, "$1$2[REDACTED]");
}

function classify(message) {
  const text = `${message.fromName} ${message.from} ${message.subject} ${message.preview}`;
  const matches = categoryRules
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => rule.key);
  return matches.length > 0 ? matches : ["other"];
}

function isLowValue(message, categories) {
  if (categories.includes("newsletter")) return "newsletter_or_promo";
  if (categories.includes("security") && /\bverification code|security code\b/i.test(message.preview)) {
    return "plain_verification_code";
  }
  return "";
}

const normalized = messages.map((message, index) => {
  const redacted = {
    ...message,
    sourceId: `m${index + 1}`,
    preview: redactSensitiveText(message.preview),
  };
  return { ...redacted, categories: classify(redacted) };
});

const kept = [];
const filtered = [];
for (const message of normalized) {
  const reason = isLowValue(message, message.categories);
  if (reason) filtered.push({ reason, subject: message.subject });
  else kept.push(message);
}

const actions = kept
  .filter((message) => message.categories.includes("urgent") || message.categories.includes("needsReply"))
  .slice(0, 5);

const report = [
  "# Demo Email Digest",
  "",
  `Scanned: ${messages.length}`,
  `Included: ${kept.length}`,
  `Filtered out: ${filtered.length}`,
  "",
  "## Important",
  ...actions.map((message) => `- ${message.fromName}: ${message.subject} — ${message.preview}`),
  "",
  "## Noise Removed",
  ...filtered.map((item) => `- ${item.reason}: ${item.subject}`),
  "",
].join("\n");

console.log(report);
