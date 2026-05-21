import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDemoPipeline } from "./lib/demo-pipeline.mjs";
import { scoreRules } from "./lib/score-rules.mjs";
import { printTable, summarize } from "./lib/table.mjs";
import { judgeCase } from "./lib/judge.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const datasetDir = join(root, "dataset");
const useJudge = process.argv.includes("--judge");

const cases = await loadCases();
const rows = [];

for (const testCase of cases) {
  const { output } = runDemoPipeline(testCase.inbox, testCase.id);
  const score = scoreRules(testCase, output);
  const row = { id: testCase.id, ...score };

  if (useJudge) {
    row.judge = await judgeCase(testCase, output);
  }

  rows.push(row);
}

printTable(rows);
const aggregate = summarize(rows);
console.log("");
console.log("Aggregate:");
console.log(JSON.stringify(aggregate, null, 2));

if (useJudge) {
  console.log("");
  console.log("Judge results:");
  for (const row of rows) {
    console.log(JSON.stringify({ case: row.id, judge: row.judge }, null, 2));
  }
}

if (aggregate.failed > 0 || aggregate.secret_leak_count > 0) {
  process.exitCode = 1;
}

async function loadCases() {
  const files = (await readdir(datasetDir))
    .filter((file) => file.endsWith(".json"))
    .sort();

  const loaded = [];
  for (const file of files) {
    const fullPath = join(datasetDir, file);
    const parsed = JSON.parse(await readFile(fullPath, "utf8"));
    validateCase(parsed, file);
    loaded.push(parsed);
  }
  return loaded;
}

function validateCase(testCase, file) {
  if (!testCase.id) throw new Error(`${file}: missing id`);
  if (!Array.isArray(testCase.inbox)) throw new Error(`${file}: inbox must be an array`);
  if (!testCase.expect || typeof testCase.expect !== "object") throw new Error(`${file}: missing expect`);

  for (const [index, message] of testCase.inbox.entries()) {
    if (!message.from) throw new Error(`${file}: inbox[${index}].from is required`);
    if (!message.subject) throw new Error(`${file}: inbox[${index}].subject is required`);
    if (!message.body) throw new Error(`${file}: inbox[${index}].body is required`);
  }

  for (const key of ["important_senders", "action_items", "must_redact", "must_exclude_senders"]) {
    if (!Array.isArray(testCase.expect[key])) {
      throw new Error(`${file}: expect.${key} must be an array`);
    }
  }
}
