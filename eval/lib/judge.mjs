// Optional LLM-as-judge. This is gated behind `npm run eval:judge`.
// It only receives synthetic dataset cases and the synthetic digest output.

const JUDGE_MODEL = "gpt-5.5";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export async function judgeCase(testCase, output) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      skipped: true,
      reason: "OPENAI_API_KEY is not set.",
    };
  }

  const rubric = [
    "You are judging a synthetic email digest eval.",
    "The source inbox is fake. Do not use outside knowledge.",
    "Score recall for expected important_senders and action_items.",
    "List any digest claim that is unsupported by the source inbox as hallucinations.",
    "Return strict JSON only with this shape:",
    "{",
    "  \"important_sender_recall\": [{\"item\":\"...\",\"captured\":true}],",
    "  \"action_item_recall\": [{\"item\":\"...\",\"captured\":true}],",
    "  \"hallucinations\": [\"...\"],",
    "  \"pass\": true",
    "}",
  ].join("\n");

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_output_tokens: 900,
      input: [
        { role: "system", content: rubric },
        {
          role: "user",
          content: JSON.stringify({
            case_id: testCase.id,
            source_inbox: testCase.inbox,
            expectations: testCase.expect,
            digest_output: output,
          }, null, 2),
        },
      ],
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    return {
      skipped: false,
      error: payload?.error?.message || JSON.stringify(payload),
    };
  }

  return parseJudgeJson(extractText(payload));
}

export function judgeModelName() {
  return JUDGE_MODEL;
}

function extractText(payload) {
  if (payload.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (content.type === "text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function parseJudgeJson(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return { error: "Judge did not return JSON.", raw };
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return { error: "Judge returned invalid JSON.", raw };
    }
  }
}
