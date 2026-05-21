# Email Agent Eval

This eval harness is token-free by default.

It does not call Microsoft Graph, read OAuth tokens, read a real mailbox, send email, or touch the Cloudflare worker. The dataset is fully synthetic. The runner adapts synthetic messages into Graph-like message objects and then calls the shared production digest core in `lib/digest-core.mjs`.

## Run

```bash
npm run eval
```

Optional LLM-as-judge mode:

```bash
OPENAI_API_KEY=... npm run eval:judge
```

Judge mode is gated behind `--judge` and only receives synthetic inbox cases plus the synthetic digest output.

The fixed judge model is `gpt-5.5`. If `OPENAI_API_KEY` is not set, judge mode reports `skipped` instead of making a network call.

## Dataset Shape

```json
{
  "id": "case-001-otp-and-noise",
  "inbox": [
    { "from": "person@example.com", "subject": "Question", "body": "Can you confirm tomorrow?" }
  ],
  "expect": {
    "important_senders": ["person@example.com"],
    "action_items": ["confirm tomorrow"],
    "must_redact": ["882913"],
    "must_exclude_senders": ["promo@example.test"]
  }
}
```

## Metrics

- `secret_leak_count`: any expected secret or common OTP/passcode pattern appearing in output.
- `filtering_pass`: expected excluded senders do not appear in the Important section.
- `format_valid`: the digest has the expected sections and counters.
- `important_sender_recall`: expected important senders captured in the digest.
- `action_item_recall`: expected action items captured in the digest.

## Current Result

```text
cases: 5
required_cases: 3
known_gaps: 2
passed: 3
failed: 0
required_pass_rate: 1.000
secret_leak_count: 0
avg_important_sender_recall: 0.600
avg_action_item_recall: 0.600
```

This covers the local triage and redaction path through the shared digest core. It is not an end-to-end test of Microsoft Graph, Cloudflare Cron, LLM summarization, or email delivery.

## Known Gaps

The eval intentionally includes known-gap cases instead of forcing a perfect score. Current gaps:

- Indirect action requests buried inside a long thread recap can be missed by the local rule-based digest.
- Non-English action requests are not reliably identified by the local rule-based digest.

These are marked with `expected_failure` in the dataset and reported as `known-gap` rather than hidden.

These gaps are limitations of the local rule-based triage layer, not expected failures of the hosted AI summary path. The deterministic layer is meant to cover safety and basic routing invariants such as redaction, sender filtering, and obvious action capture. Deeper semantic understanding, including long-thread interpretation and multilingual action extraction, is handled in the hosted workflow by the LLM summarization layer.
