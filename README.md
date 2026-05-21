# Personal Email Agent

A privacy-first Outlook email digest agent that turns a noisy inbox into a daily or weekly action brief.

This public repo is a sanitized reference implementation extracted from a personal workflow. It keeps the production architecture intact while replacing private credentials, mailbox data, deployment IDs, and real reports with examples.

## What It Does

- Authenticates with Microsoft Graph through delegated OAuth.
- Reads recent Outlook messages and metadata.
- Filters low-value mail before sending anything to an AI provider.
- Redacts likely one-time codes and passcodes.
- Produces concise daily and weekly briefs in Chinese and English.
- Sends the finished report by email from a Cloudflare Worker.
- Rotates Microsoft refresh tokens through Cloudflare KV.

## Architecture

```text
Outlook inbox
  -> Microsoft Graph delegated OAuth
  -> Cloudflare Cron trigger
  -> message filtering + redaction
  -> Anthropic or OpenAI summary provider
  -> bilingual HTML email report
  -> Cloudflare KV refresh-token rotation
```

The local scripts are useful for first-time OAuth and read-only debugging. The Cloudflare Worker is the hosted version that runs without a laptop staying on.

## Safety Defaults

- Local mode requests `Mail.Read`, not send or write access.
- The worker only needs `Mail.Send` to send the report email.
- The agent does not delete, move, mark, reply to, or forward mail.
- Secrets are read from local `.secrets/` or Cloudflare secrets, never committed.
- `wrangler.example.jsonc` contains placeholders only.
- Real mailbox data is not included in this public repo.

## Quick Demo

Run a token-free mock digest:

```bash
npm install
npm run demo
```

Run syntax checks:

```bash
npm run check:all
```

## Evaluation

This repo includes a small synthetic eval harness for the inbox triage path:

```bash
npm run eval
```

Current deterministic eval result:

```text
cases: 5
passed: 5
pass_rate: 1.000
secret_leak_count: 0
avg_important_sender_recall: 1.000
avg_action_item_recall: 1.000
```

The dataset covers OTP/passcode redaction, urgent-looking marketing, long threads, non-English action mail, and an empty inbox. The default eval is rule-based and token-free. Optional LLM-as-judge mode is available with `npm run eval:judge`.

## Local Setup

1. Create a Microsoft app registration.
2. Copy `config.example.json` to `config.json`.
3. Paste your app registration `Application (client) ID`.
4. Run `npm run auth`.
5. Run `npm run digest`.

Local commands:

```bash
npm run auth
npm run mail
npm run digest
npm run digest:week
node digest.mjs --days 1 --write
```

## Cloudflare Setup

The hosted worker lives in `cloudflare-worker/`.

```bash
cd cloudflare-worker
npm install
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler kv namespace create TOKEN_STORE
npx wrangler secret put MS_CLIENT_ID
npx wrangler secret put MS_REFRESH_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put EMAIL_REPORT_TO
npx wrangler secret put RUN_SECRET
npm run deploy
```

Use `config.cloudflare.example.json` when authorizing the hosted worker because it needs `Mail.Send` for the report delivery path.

## Required Secrets

- `MS_CLIENT_ID`
- `MS_REFRESH_TOKEN`
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
- `EMAIL_REPORT_TO`
- `RUN_SECRET`

Optional:

- `PUSHOVER_USER_KEY`
- `PUSHOVER_API_TOKEN`

## Repository Layout

```text
auth.mjs                         Local OAuth bootstrap
mail.mjs                         Minimal Graph mailbox reader
digest.mjs                       Local read-only digest script
config.example.json              Local read-only OAuth config
config.cloudflare.example.json   Worker OAuth config with Mail.Send
demo/                            Mock inbox data and token-free demo
cloudflare-worker/               Hosted automation
```

## Production Notes

The interesting parts are not just the LLM call. The agent has to survive the real workflow edges: delegated OAuth, refresh-token rotation, DST-safe scheduling, over-reading mail windows to avoid missed messages, low-value-message filtering, passcode redaction, bilingual output validation, and manual run protection.

## Privacy

This repo intentionally excludes:

- `.secrets/`
- `tokens.json`
- `config.json`
- `.env`
- `.dev.vars`
- real reports
- real mailbox content
- real Cloudflare account IDs or KV namespace IDs
