// SPDX-License-Identifier: Apache-2.0
// Explicit socket/cache pressure and fan-out checks; excluded from automatic CI.
import assert from "node:assert/strict";
import test from "node:test";
import { connectClient, create, eventually, setup, token } from "../runtime-harness.mjs";
import { reaction, receipt } from "../runtime-helpers.mjs";

test("pending overload stays bounded, does not affect another room, and clears on departure", {
  timeout: 10000,
}, async (t) => {
  const s = await setup(t, { now: () => 1000 });
  const other = await create(s.base, "other");
  const p = await connectClient(t, s.base, s.config, "presenter");
  const a = await connectClient(t, s.base, s.config, "audience");
  const p2 = await connectClient(t, s.base, other, "presenter");
  const a2 = await connectClient(t, s.base, other, "audience");
  for (let index = 0; index < 128; index++) {
    a.send(reaction(`r${index}`));
    await p.next("event");
  }
  a.send(reaction("overload"));
  assert.equal((await a.next("result")).status, "busy");
  assert.equal(s.runtime.diagnostics().pending, 128);
  a2.send(reaction("healthy"));
  p2.send(receipt(await p2.next("event")));
  assert.equal((await a2.next("result")).status, "accepted");
  for (let index = 129; index < 256; index++) {
    a.send(reaction(`r${index}`));
    assert.equal((await a.next("result")).status, "busy");
  }
  assert.equal(s.runtime.diagnostics().requests, 257);
  a.send(reaction("cache-overflow"));
  assert.equal(await a.closed, 1013);
  await eventually(() => s.runtime.diagnostics().pending === 0);
  assert.equal(s.runtime.diagnostics().requests, 1);
});

test("audience fan-out has no small-room participant quota and cleanup releases per-client state", {
  timeout: 10000,
}, async (t) => {
  const s = await setup(t);
  const p = await connectClient(t, s.base, s.config, "presenter");
  const members = await Promise.all(
    Array.from({ length: 64 }, () => connectClient(t, s.base, s.config, "audience")),
  );
  let state;
  do {
    state = await p.next("state");
  } while (state.audience_connections !== 64);
  assert.equal(s.runtime.diagnostics().connections, 65);
  for (let i = 0; i < members.length; i++) members[i].send(reaction(`fanout-${i}`));
  for (let i = 0; i < members.length; i++) p.send(receipt(await p.next("event")));
  for (const member of members) assert.equal((await member.next("result")).status, "accepted");
  assert.equal(s.runtime.diagnostics().requests, 64);
  for (const member of members) member.ws.close();
  await Promise.all(members.map((member) => member.closed));
  await eventually(() => s.runtime.diagnostics().requests === 0);
  assert.equal(s.runtime.diagnostics().pending, 0);
});

test("terminal close bursts preserve confirmed end and release transient state", {
  timeout: 15000,
}, async (t) => {
  const s = await setup(t);
  const p = await connectClient(t, s.base, s.config, "presenter");
  const members = [];
  // Exercise the terminal burst independently of the host's TCP accept backlog.
  for (let batch = 0; batch < 20; batch++)
    members.push(
      ...(await Promise.all(
        Array.from({ length: 8 }, () => connectClient(t, s.base, s.config, "audience")),
      )),
    );
  members[0].send(reaction("confirmed-before-end"));
  p.send(receipt(await p.next("event")));
  assert.equal((await members[0].next("result")).status, "accepted");
  members[1].send(reaction("pending-before-end"));
  await p.next("event");
  assert.equal(s.runtime.diagnostics().pending, 1);
  assert.equal(s.runtime.diagnostics().requests, 2);
  const end = () =>
    fetch(`${s.base}/api/relay/v1/rooms/${s.config.room_id}/end`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.config.presenter_token}` },
    });
  assert.equal((await end()).status, 200);
  assert.equal(await p.closed, 1000);
  assert.deepEqual(
    await Promise.all(members.map((member) => member.closed)),
    Array(160).fill(1000),
  );
  await eventually(() => s.runtime.diagnostics().connections === 0);
  assert.equal(s.runtime.diagnostics().failedRooms, 0);
  assert.equal(s.runtime.diagnostics().pending, 0);
  assert.equal(s.runtime.diagnostics().requests, 0);
  assert.equal((await end()).status, 200);
  const repeated = await fetch(`${s.base}/api/relay/v1/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ idempotency_key: "failure-test" }),
  });
  assert.equal(repeated.status, 410);
});
