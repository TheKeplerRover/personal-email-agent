import assert from "node:assert/strict";
import { redactSensitiveText } from "../lib/digest-core.mjs";

const cases = [
  {
    name: "verification code phrase",
    input: "Your verification code is 882913. Do not share it.",
    hidden: "882913",
  },
  {
    name: "security code phrase",
    input: "Your security code for sign-in is: AB19KQ.",
    hidden: "AB19KQ",
  },
  {
    name: "plain code label",
    input: "Code: 44ZX91 expires in ten minutes.",
    hidden: "44ZX91",
  },
  {
    name: "passcode phrase",
    input: "Your one-time passcode is 731204 for this login.",
    hidden: "731204",
  },
];

for (const item of cases) {
  const output = redactSensitiveText(item.input);
  assert(!output.includes(item.hidden), `${item.name}: leaked ${item.hidden}`);
  assert(output.includes("[REDACTED]"), `${item.name}: missing redaction marker`);
}

console.log(`redaction tests passed: ${cases.length}`);
