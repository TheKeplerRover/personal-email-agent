import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDigest, formatDigest } from "./lib/digest-core.mjs";

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
