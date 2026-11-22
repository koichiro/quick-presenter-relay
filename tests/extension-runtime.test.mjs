// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AdmissionPolicies } from "quick-presenter-relay-core";
import { startRelay } from "../dist/src/runtime.js";
import { connectRuntime, reaction, receipt } from "./runtime-helpers.mjs";

const allow = { api_version: "1-draft.1", outcome: "allow" };
const deny = { api_version: "1-draft.1", outcome: "deny", reason: "synthetic_denial" };
const policy = (fields) => ({ id: "synthetic", api_version: "1-draft.1", ...fields });
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.ok(predicate(), "Expected synthetic hook/cleanup");
}
async function client(t, ...args) {
  const c = await connectRuntime(...args);
  t.after(() => c.ws.terminate());
  return c;
}
async function setup(t, descriptors = [], limits = {}, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "relay-hook-runtime-"));
  const extensions = new AdmissionPolicies([], { timeoutMs: 1000, ...limits });
  const options = {
    database: join(dir, "rooms.sqlite"),
    storageKey: Buffer.alloc(32, 1),
    createToken: "A".repeat(43),
    publicOrigin: "https://relay.example",
    heartbeatMs: 20,
    extensions,
    ...extra,
  };
  const runtime = await startRelay(options);
  t.after(async () => {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${runtime.port}`;
  async function create(key = "synthetic-new") {
    const r = await fetch(`${base}/api/relay/v1/rooms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.createToken}` },
      body: JSON.stringify({ idempotency_key: key }),
    });
    return { status: r.status, body: await r.json() };
  }
  const config = (await create("bootstrap")).body;
  extensions.replace(descriptors);
  return {
    runtime,
    options,
    extensions,
    base,
    config,
    create,
    async end() {
      const r = await fetch(`${base}/api/relay/v1/rooms/${config.room_id}/end`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.presenter_token}` },
      });
      await r.json();
      return r.status;
    },
  };
}
function hello(a, config) {
  a.send({ type: "hello", token: new URL(config.join_url).hash.slice(3) });
}

test("creation hook is credential-free, single-flight and idempotent; denial/fault are fail-closed", {
  timeout: 10000,
}, async (t) => {
  const pending = deferred();
  let calls = 0;
  let context;
  const s = await setup(t, [
    policy({
      beforeRoomCreate: (c) => {
        calls++;
        context = c;
        return pending.promise;
      },
    }),
  ]);
  assert.equal((await s.create("bootstrap")).status, 200);
  assert.equal(calls, 0);
  const one = s.create();
  const two = s.create();
  await waitFor(() => calls === 1);
  await delay(20);
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(context).sort(), [
    "idempotencyKey",
    "operationId",
    "policyRevision",
    "role",
  ]);
  assert.equal(context.role, "operator");
  pending.resolve(allow);
  const results = await Promise.all([one, two]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(results[0].body, results[1].body);
  s.extensions.replace([policy({ beforeRoomCreate: () => deny })]);
  assert.deepEqual(await s.create("deny"), {
    status: 403,
    body: { error: "denied", reason: "synthetic_denial" },
  });
  s.extensions.replace([
    policy({
      beforeRoomCreate: () => {
        throw new Error("SYNTHETIC_SECRET");
      },
    }),
  ]);
  assert.deepEqual(await s.create("fault"), { status: 503, body: { error: "policy_unavailable" } });
  assert.equal(s.runtime.diagnostics().rooms, 2);
});

test("audience hook runs after authentication, before membership; notifications cannot veto end", {
  timeout: 10000,
}, async (t) => {
  const notifications = [];
  const pending = deferred();
  let joins = 0;
  let context;
  const s = await setup(t, [
    policy({
      beforeAudienceJoin: (c) => {
        joins++;
        context = c;
        return pending.promise;
      },
      onDisconnect: (c) => {
        notifications.push(c);
      },
      onRoomEnd: (c) => {
        notifications.push(c);
        throw new Error("Synthetic notification failure");
      },
    }),
  ]);
  const p = await client(t, s.base, s.config, "presenter");
  const bad = await client(t, s.base, s.config, "audience", false);
  bad.send({ type: "hello", token: "B".repeat(43) });
  await bad.closed;
  assert.equal(joins, 0);
  const a = await client(t, s.base, s.config, "audience", false);
  hello(a, s.config);
  await waitFor(() => joins === 1);
  assert.equal(s.runtime.diagnostics().unauthenticated, 1);
  assert.equal(context.role, "audience");
  assert.equal(JSON.stringify(context).includes(s.config.presenter_token), false);
  pending.resolve(allow);
  await a.next("welcome");
  a.send(reaction("allowed"));
  p.send(receipt(await p.next("event")));
  assert.equal((await a.next("result")).status, "accepted");
  a.ws.close();
  await a.closed;
  await waitFor(() => notifications.some((c) => c.connectionId === context.connectionId));
  assert.equal(await s.end(), 200);
  await p.closed;
  assert.equal(await s.end(), 200);
  await waitFor(() => s.extensions.diagnostics().notificationFailures === 1);
  assert.equal(notifications.filter((c) => c.state === "Ended").length, 1);
});

test("join deny, timeout, repeated hello and generation changes never reserve membership", {
  timeout: 10000,
}, async (t) => {
  for (const mode of [
    "deny",
    "timeout",
    "repeat",
    "replace",
    "display",
    "disconnect",
    "end",
    "revision",
  ]) {
    const pending = deferred();
    let started = false;
    let signal;
    const s = await setup(
      t,
      [
        policy({
          beforeAudienceJoin: (_, tools) => {
            started = true;
            signal = tools.signal;
            return mode === "deny" ? deny : pending.promise;
          },
        }),
      ],
      { timeoutMs: mode === "timeout" ? 10 : 1000 },
    );
    const p = await client(t, s.base, s.config, "presenter");
    const a = await client(t, s.base, s.config, "audience", false);
    hello(a, s.config);
    await waitFor(() => started);
    if (mode === "repeat") {
      hello(a, s.config);
      await a.closed;
    }
    if (mode === "replace") await client(t, s.base, s.config, "presenter");
    if (mode === "display") {
      p.send({ type: "display", presenter_epoch: "1", display_epoch: "1", paused: true });
      await waitFor(() => p.messages.some((m) => m.display_epoch === "1"));
    }
    if (mode === "disconnect") {
      a.ws.close();
      await a.closed;
      await waitFor(() => signal.aborted);
    }
    if (mode === "end") await s.end();
    if (mode === "revision") s.extensions.replace([]);
    if (!["timeout", "deny"].includes(mode)) pending.resolve(allow);
    const code = await a.closed;
    assert.ok([1000, 1005, 1008, 1013].includes(code), mode);
    if (mode === "deny") assert.equal(code, 1008);
    if (mode === "timeout") assert.equal(code, 1013);
    await waitFor(() => s.runtime.diagnostics().unauthenticated === 0);
    assert.equal(
      a.messages.some((m) => m.type === "welcome"),
      false,
    );
    if (mode === "disconnect" || mode === "timeout") assert.equal(signal.aborted, true);
    pending.resolve(allow);
    await s.runtime.stop();
  }
});

test("event hooks preserve dedup, normalization, immutable input and receipt-only acceptance", {
  timeout: 10000,
}, async (t) => {
  const pending = deferred();
  let calls = 0;
  let context;
  const s = await setup(t, [
    policy({
      beforeEventForward: (c) => {
        calls++;
        context = c;
        return pending.promise;
      },
    }),
  ]);
  const p = await client(t, s.base, s.config, "presenter");
  const a = await client(t, s.base, s.config, "audience");
  const input = { type: "comment", request_id: "dedup", body: "  世界  ", handle: " Original " };
  a.send(input);
  a.send(input);
  await waitFor(() => calls === 1);
  assert.equal(s.runtime.diagnostics().pending, 1);
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.payload));
  assert.equal(context.payload.body, "世界");
  assert.equal(context.payload.handle, " Original ");
  p.send({
    type: "receipt",
    presenter_epoch: "1",
    event_id: context.operationId,
    status: "accepted",
  });
  await delay(10);
  assert.equal(
    a.messages.some((m) => m.type === "result"),
    false,
  );
  pending.resolve(allow);
  const event = await p.next("event");
  assert.equal(event.event_id, context.operationId);
  p.send(receipt(event));
  assert.equal((await a.next("result")).status, "accepted");
  a.send(input);
  assert.equal((await a.next("result")).status, "accepted");
  assert.equal(calls, 1);
  s.extensions.replace([policy({ beforeEventForward: () => deny })]);
  a.send(reaction("deny"));
  assert.equal((await a.next("result")).status, "denied");
  a.send(reaction("deny"));
  assert.equal((await a.next("result")).status, "denied");
  s.extensions.replace([
    policy({
      beforeEventForward: () => {
        throw new Error("Synthetic fault");
      },
    }),
  ]);
  a.send(reaction("fault"));
  assert.equal((await a.next("result")).status, "policy_unavailable");
});

test("deferred event completion cannot cross pause, replacement, end, departure, deadline or policy revision", {
  timeout: 15000,
}, async (t) => {
  for (const mode of ["pause", "replace", "end", "departure", "deadline", "revision", "storage"]) {
    const pending = deferred();
    let started = false;
    let signal;
    let clock = 1000;
    const s = await setup(
      t,
      [
        policy({
          beforeEventForward: (_, tools) => {
            started = true;
            signal = tools.signal;
            return pending.promise;
          },
        }),
      ],
      {},
      { now: () => clock, receiptMs: 100 },
    );
    const p = await client(t, s.base, s.config, "presenter");
    const a = await client(t, s.base, s.config, "audience");
    a.send(reaction(mode));
    await waitFor(() => started);
    if (mode === "pause") {
      p.send({ type: "display", presenter_epoch: "1", display_epoch: "1", paused: true });
      await waitFor(() => p.messages.some((m) => m.display_epoch === "1"));
    }
    if (mode === "replace") await client(t, s.base, s.config, "presenter");
    if (mode === "end") await s.end();
    if (mode === "departure") {
      a.ws.close();
      await a.closed;
      await waitFor(() => signal.aborted);
    }
    if (mode === "deadline") clock += 100;
    if (mode === "revision") s.extensions.replace([]);
    if (mode === "storage") {
      const db = new DatabaseSync(s.options.database);
      db.exec("DROP TABLE rooms");
      db.close();
      p.send({ type: "display", presenter_epoch: "1", display_epoch: "1", paused: true });
      await p.closed;
    }
    pending.resolve(allow);
    if (["pause", "replace", "deadline"].includes(mode))
      assert.equal((await a.next("result")).status, "unknown");
    if (mode === "revision") assert.equal((await a.next("result")).status, "policy_unavailable");
    if (mode === "departure" || mode === "end" || mode === "storage")
      await waitFor(() => signal.aborted);
    await delay(10);
    assert.equal(
      p.messages.some((m) => m.type === "event"),
      false,
    );
    await s.runtime.stop();
  }
});

test("hook capacity and timeout fail closed; shutdown cancels hooks without awaiting uncooperative work", {
  timeout: 10000,
}, async (t) => {
  const pending = deferred();
  let calls = 0;
  let signal;
  const s = await setup(
    t,
    [
      policy({
        beforeEventForward: (_, tools) => {
          calls++;
          signal = tools.signal;
          return pending.promise;
        },
      }),
    ],
    { maxPending: 1, timeoutMs: 10 },
  );
  const p = await client(t, s.base, s.config, "presenter");
  const a = await client(t, s.base, s.config, "audience");
  a.send(reaction("first"));
  assert.equal((await a.next("result")).status, "policy_unavailable");
  a.send(reaction("second"));
  assert.equal((await a.next("result")).status, "policy_unavailable");
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  assert.equal(s.runtime.diagnostics().policy.running, 1);
  await s.runtime.stop();
  pending.resolve(allow);
  await waitFor(() => s.extensions.diagnostics().running === 0);
  assert.equal(
    p.messages.some((m) => m.type === "event"),
    false,
  );
  const creation = deferred();
  const stopped = await setup(t, [policy({ beforeRoomCreate: () => creation.promise })]);
  const request = stopped.create().catch(() => null);
  await waitFor(() => stopped.extensions.diagnostics().running === 1);
  await stopped.runtime.stop();
  creation.resolve(allow);
  await request;
  assert.equal(stopped.runtime.diagnostics().rooms, 1);
});
