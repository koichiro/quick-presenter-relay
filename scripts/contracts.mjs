// SPDX-License-Identifier: Apache-2.0
// Conformance helpers; not a production wire parser or relay runtime.
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { normalizeBody } from "quick-presenter-relay-core";

export { normalizeBody };
export const ajv = new Ajv2020({ allErrors: true, strict: true });
export function load(relative) {
  return JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), "utf8"));
}
const names = ["messages", "create-request", "create-response", "end-response", "policy-decision"];
export const validators = Object.fromEntries(
  names.map((name) => {
    const schema = load(`protocol/schemas/${name}.schema.json`);
    if (!ajv.validateSchema(schema)) throw new Error(`Invalid schema ${name}`);
    return [name, ajv.compile(schema)];
  }),
);
function validString(value, scalars, bytes) {
  const chars = [...value];
  return (
    chars.length <= scalars &&
    Buffer.byteLength(value, "utf8") <= bytes &&
    chars.every((c) => {
      const p = c.codePointAt(0);
      return (
        !(p >= 0xd800 && p <= 0xdfff) &&
        (!(p < 32 || (p >= 127 && p <= 159)) || ["\r", "\n", "\t"].includes(c))
      );
    })
  );
}
export function validate(name, value) {
  if (!validators[name]?.(value)) return false;
  if (name === "messages" && Buffer.byteLength(JSON.stringify(value), "utf8") > 4096) return false;
  const event = value.type === "event" ? value.payload : value;
  if (name === "messages" && event.type === "comment") {
    return (
      validString(event.body, 200, 800) &&
      validString(event.handle, 32, 128) &&
      normalizeBody(event.body).length > 0
    );
  }
  return true;
}
