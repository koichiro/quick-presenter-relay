// SPDX-License-Identifier: Apache-2.0
// Explicit fixture cache saturation; excluded from automatic CI.
import assert from "node:assert/strict";
import test from "node:test";
import { connect, fixtureFor, reaction } from "../fixture-helpers.mjs";

test("pending and result caches stay bounded", { timeout: 10000 }, async (t) => {
  const fixture = await fixtureFor(t, { receiptMs: 60000 });
  const p = await connect(fixture, "presenter");
  const a = await connect(fixture, "audience");
  for (let i = 0; i < 128; i++) {
    a.send(reaction(`r${i}`));
    await p.next("event");
  }
  a.send(reaction("overflow"));
  assert.equal((await a.next("result")).status, "busy");
  // Closing the audience removes its pending timers; no accepted result is invented.
  a.ws.close();
  await a.closed;
  p.ws.close();
  await p.closed;
  const b = await connect(fixture, "audience");
  for (let i = 0; i < 256; i++) {
    b.send(reaction(`r${i}`));
    assert.equal((await b.next("result")).status, "unavailable");
  }
  b.send(reaction("overflow"));
  await b.closed;
});
