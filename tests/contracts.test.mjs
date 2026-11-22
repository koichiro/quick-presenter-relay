// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { ContractModel } from "../scripts/contract-model.mjs";
import { load, normalizeBody, validate } from "../scripts/contracts.mjs";

for (const fixture of load("protocol/fixtures/wire.json")) {
  test(`wire: ${fixture.name}`, () =>
    assert.equal(validate(fixture.schema, fixture.value), fixture.valid));
}
for (const trace of load("protocol/fixtures/state-traces.json")) {
  test(`state: ${trace.name}`, () => {
    const model = new ContractModel(trace);
    for (const [i, step] of trace.steps.entries()) {
      assert.equal(model.step(step), step.expect, `step ${i}: ${step.op}`);
    }
  });
}
test("body normalization pins Unicode whitespace without HTML interpretation", () => {
  assert.equal(normalizeBody(" \u00a0Hello\n\tworld\u3000 "), "Hello world");
  assert.equal(
    normalizeBody("<script>https://example.test</script>"),
    "<script>https://example.test</script>",
  );
});
test("connection bookkeeping tracks independent live members", () => {
  const m = new ContractModel();
  m.step({ op: "attach" });
  for (let i = 0; i < 400; i++) assert.equal(m.step({ op: "join", id: String(i) }), "joined");
  assert.equal(m.members.size, 400);
});
test("repeated deadline checks do not extend room lifetime", () => {
  const m = new ContractModel({ expires_at: 100 });
  m.step({ op: "attach" });
  assert.equal(m.step({ op: "tick", now: 99 }), "active");
  assert.equal(m.step({ op: "tick", now: 100 }), "expired");
});
test("delayed hook cannot survive presenter replacement", () => {
  const m = new ContractModel();
  m.step({ op: "attach" });
  m.step({ op: "policy_start", id: "p" });
  m.step({ op: "attach" });
  assert.equal(m.step({ op: "policy_complete", id: "p" }), "stale");
});

test("delayed hook cannot survive a pause generation change", () => {
  const m = new ContractModel();
  m.step({ op: "attach" });
  m.step({ op: "policy_start", id: "p" });
  m.step({ op: "display", epoch: "1", display: "1", paused: true });
  assert.equal(m.step({ op: "policy_complete", id: "p" }), "stale");
});
test("delayed hook cannot use an outdated policy configuration", () => {
  const m = new ContractModel();
  m.step({ op: "attach" });
  m.step({ op: "policy_start", id: "p" });
  m.step({ op: "policy_revision", revision: "1" });
  assert.equal(m.step({ op: "policy_complete", id: "p" }), "stale");
});
