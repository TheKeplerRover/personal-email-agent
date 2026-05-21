import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const configPath = join(root, "config.json");
const tokenPath = join(root, ".secrets", "tokens.json");

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

function stripHtml(html = "") {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function redactSensitiveText(text = "") {
  return text
    .replace(/\b(one-time passcode|verification code|security code|login code)(.{0,40}?)([A-Z0-9]{4,10})\b/gi, "$1$2[REDACTED]")
    .replace(/\b(passcode is|code is|code:)(\s*)([A-Z0-9]{4,10})\b/gi, "$1$2[REDACTED]");
}

async function graph(accessToken, path) {
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
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

async function main() {
  if (!existsSync(configPath) || !existsSync(tokenPath)) {
    throw new Error("Run auth first. Need config.json and .secrets/tokens.json.");
  }

  const config = await readJson(configPath);
  const tokens = await readJson(tokenPath);
  const accessToken = await refreshAccessToken(config, tokens);
  const top = Number(process.argv[2] ?? 10);
  const select = "id,receivedDateTime,from,subject,bodyPreview,isRead,importance,webLink";
  const messages = await graph(
    accessToken,
    `/me/mailFolders/inbox/messages?$top=${top}&$orderby=receivedDateTime desc&$select=${encodeURIComponent(select)}`
  );

  const simplified = messages.value.map((message) => ({
    receivedAt: message.receivedDateTime,
    from: message.from?.emailAddress?.address ?? message.from?.emailAddress?.name ?? "unknown",
    subject: message.subject ?? "(no subject)",
    isRead: Boolean(message.isRead),
    importance: message.importance,
    preview: redactSensitiveText(stripHtml(message.bodyPreview ?? "")).slice(0, 500),
    webLink: message.webLink,
  }));

  console.log(JSON.stringify(simplified, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
