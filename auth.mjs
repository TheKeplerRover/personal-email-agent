import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const configPath = join(root, "config.json");
const tokenPath = join(root, ".secrets", "tokens.json");

function formEncode(values) {
  return new URLSearchParams(values).toString();
}

async function readConfig() {
  if (!existsSync(configPath)) {
    throw new Error(`Missing ${configPath}. Copy config.example.json to config.json and set clientId.`);
  }
  return JSON.parse(await readFile(configPath, "utf8"));
}

async function exchangeCode(config, code) {
  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formEncode({
      client_id: config.clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(" "),
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(payload, null, 2));
  }
  return payload;
}

async function main() {
  const config = await readConfig();
  const redirectUrl = new URL(config.redirectUri);
  const state = crypto.randomUUID();
  const authUrl = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  authUrl.search = formEncode({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    response_mode: "query",
    scope: config.scopes.join(" "),
    state,
    prompt: "select_account",
  });

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", config.redirectUri);
      if (requestUrl.pathname !== redirectUrl.pathname) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      if (requestUrl.searchParams.get("state") !== state) {
        response.writeHead(400);
        response.end("State mismatch. Close this tab and retry.");
        return;
      }

      const error = requestUrl.searchParams.get("error");
      if (error) {
        response.writeHead(400);
        response.end(`${error}: ${requestUrl.searchParams.get("error_description") ?? ""}`);
        return;
      }

      const code = requestUrl.searchParams.get("code");
      if (!code) {
        response.writeHead(400);
        response.end("Missing authorization code.");
        return;
      }

      const tokens = await exchangeCode(config, code);
      await mkdir(dirname(tokenPath), { recursive: true });
      await writeFile(tokenPath, JSON.stringify({
        ...tokens,
        saved_at: new Date().toISOString(),
      }, null, 2), { mode: 0o600 });

      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Outlook OAuth complete. You can close this tab.");
      server.close();
      console.log(`\nSaved tokens to ${tokenPath}`);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error?.message ?? error));
      console.error(error);
      server.close();
      process.exitCode = 1;
    }
  });

  await new Promise((resolve) => server.listen(Number(redirectUrl.port), redirectUrl.hostname, resolve));
  console.log("Open this URL in your browser and sign in with your personal Outlook account:\n");
  console.log(authUrl.toString());
  console.log("\nWaiting for Microsoft to redirect back...");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
