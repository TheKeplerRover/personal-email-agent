# Cloudflare Email Assistant

Cloudflare-hosted version of Email Assistant. It runs without your Mac being on.

## What It Does

- Runs at 7:30 AM America/Vancouver using Cloudflare Cron.
- Sends a daily report for recent mail.
- Sends an additional weekly report on Mondays.
- Reads Inbox metadata and previews only.
- Uses a configurable AI provider to summarize the filtered mail.
- Sends the report by email with Microsoft Graph `Mail.Send`.
- Keeps Pushover wiring disabled until `PUSHOVER_ENABLED=true`.

## Schedule

Cloudflare Cron is UTC-only. The worker has two cron entries:

- `30 14 * * *`
- `30 15 * * *`

The worker checks whether the local Vancouver time is actually 7:30 AM before running. This handles PDT/PST without editing the schedule every season.

## Required Accounts

1. Cloudflare account.
2. Anthropic Claude API account and API key. OpenAI is still supported as a fallback.
3. Microsoft Azure/Entra app registration for your personal Outlook OAuth app.
4. Pushover account later, only when push notifications are enabled.

## Required Microsoft Permissions

The cloud worker needs:

- `offline_access`
- `User.Read`
- `Mail.Read`
- `Mail.Send`

`Mail.Send` is required only because you asked for the report to arrive by email. The worker does not reply to existing messages.

To create a refresh token with these scopes, copy the repo root `config.cloudflare.example.json` to `config.json`, set your Microsoft application client ID, then run `npm run auth` from the repo root. Use the resulting `.secrets/tokens.json` refresh token as `MS_REFRESH_TOKEN`.

## Secrets

Set these with `wrangler secret put`:

- `MS_CLIENT_ID`
- `MS_REFRESH_TOKEN`
- `ANTHROPIC_API_KEY`
- `EMAIL_REPORT_TO`
- `RUN_SECRET`

Optional later:

- `PUSHOVER_USER_KEY`
- `PUSHOVER_API_TOKEN`

## KV

Create a KV namespace for refresh-token rotation:

```bash
npx wrangler kv namespace create TOKEN_STORE
```

Put the returned namespace id into `wrangler.jsonc`.

Why KV? Microsoft may rotate refresh tokens. Cloudflare secrets cannot be updated by code at runtime, so the worker stores the newest refresh token in KV after each refresh.

## Deploy

```bash
cd cloudflare-worker
npm install
npx wrangler login
npx wrangler kv namespace create TOKEN_STORE
npx wrangler secret put MS_CLIENT_ID
npx wrangler secret put MS_REFRESH_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put EMAIL_REPORT_TO
npx wrangler secret put RUN_SECRET
npm run deploy
```

## Manual Test

```bash
curl "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/run?type=daily&secret=YOUR_RUN_SECRET"
curl "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/run?type=weekly&secret=YOUR_RUN_SECRET"
```

## Current Safety Defaults

- Does not move mail.
- Does not delete mail.
- Does not mark read/unread.
- Does not reply to threads.
- Does not fetch full message bodies.
- Redacts likely one-time codes before sending mail data to the configured AI provider.
- Over-reads the daily window from yesterday 00:00 local through run time to avoid missing messages.

## AI Provider

The worker is designed so the summary provider can be switched by configuration. It currently supports Anthropic and OpenAI, with Anthropic as the default:

- `AI_PROVIDER=anthropic`
- `ANTHROPIC_MODEL=claude-sonnet-4-6`

OpenAI remains supported by changing `AI_PROVIDER` to `openai` and setting `OPENAI_API_KEY`.
