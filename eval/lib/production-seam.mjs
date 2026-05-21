import { buildDigest, formatDigest } from "../../lib/digest-core.mjs";

const BASE_TIME = new Date("2026-05-21T16:00:00.000Z");

export function runProductionSeam(inbox, caseId = "synthetic-case") {
  const graphMessages = inbox.map((message, index) => toGraphMessage(message, index, caseId));
  const since = new Date(BASE_TIME.getTime() - 24 * 60 * 60 * 1000);
  const digest = buildDigest(graphMessages, since);

  return {
    digest,
    output: formatDigest({
      ...digest,
      generatedAt: BASE_TIME.toISOString(),
    }),
    caseId,
  };
}

function toGraphMessage(message, index, caseId) {
  return {
    id: `synthetic-${index + 1}`,
    receivedDateTime: new Date(BASE_TIME.getTime() - index * 60 * 60 * 1000).toISOString(),
    from: {
      emailAddress: {
        name: message.fromName || senderName(message.from),
        address: message.from,
      },
    },
    subject: message.subject,
    bodyPreview: message.body,
    isRead: Boolean(message.isRead),
    importance: message.importance || "normal",
    webLink: `https://example.test/${caseId}/message-${index + 1}`,
  };
}

function senderName(address = "") {
  const local = address.split("@")[0] || "Synthetic Sender";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
