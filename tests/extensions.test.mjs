// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AdmissionPolicies } from "quick-presenter-relay-core";

const allow = { api_version: "1-draft.1", outcome: "allow" };
const deny = { api_version: "1-draft.1", outcome: "deny", reason: "synthetic_denial" };
const ctx = { operationId: "synthetic-op", role: "operator", idempotencyKey: "synthetic-key" };
const policy = (fields = {}) => ({ id: "synthetic", api_version: "1-draft.1", ...fields });
export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle() {
  await delay(0);
}

test("SDK defaults, immutable ordered context, namespaced state and denial short circuit", async () => {
  const empty = new AdmissionPolicies();
  assert.equal(empty.has("beforeRoomCreate"), false);
  assert.equal((await empty.check("beforeRoomCreate", ctx)).outcome, "allow");
  const order = [];
  const namespaces = [];
  const state = new Map();
  const host = new AdmissionPolicies(
    [
      policy({
        beforeRoomCreate: async (c, tools) => {
          order.push("first");
          assert.ok(Object.isFrozen(c));
          assert.ok(Object.isFrozen(tools));
          assert.equal(c.policyRevision, "1");
          assert.equal(c.role, "operator");
          await tools.state.set("key", { value: 1 });
          assert.deepEqual(await tools.state.get("key"), { value: 1 });
          await tools.state.delete("key");
          return allow;
        },
      }),
      policy({
        id: "second",
        beforeRoomCreate: () => {
          order.push("second");
          return deny;
        },
      }),
      policy({
        id: "third",
        beforeRoomCreate: () => {
          assert.fail("After denial");
        },
      }),
    ],
    {
      state: (id) => {
        namespaces.push(id);
        return {
          async get(key) {
            return state.get(`${id}:${key}`);
          },
          async set(key, value) {
            state.set(`${id}:${key}`, value);
          },
          async delete(key) {
            state.delete(`${id}:${key}`);
          },
        };
      },
    },
  );
  assert.deepEqual(await host.check("beforeRoomCreate", ctx), {
    outcome: "deny",
    reason: "synthetic_denial",
  });
  assert.deepEqual(order, ["first", "second"]);
  assert.deepEqual(namespaces, ["synthetic", "second"]);
  await settle();
  assert.equal(host.diagnostics().running, 0);
  assert.equal(state.size, 0);
  empty.close();
  host.close();
});

test("SDK rejects malformed decisions and catches thrown/rejected hooks without revealing errors", async () => {
  for (const value of [
    null,
    {},
    { ...allow, api_version: "2" },
    { ...allow, extra: true },
    { ...deny, reason: "private details with spaces" },
    { ...deny, reason: 42 },
    { ...deny, extra: true },
    { ...allow, outcome: "hold" },
  ]) {
    const h = new AdmissionPolicies([policy({ beforeRoomCreate: () => value })]);
    assert.deepEqual(await h.check("beforeRoomCreate", ctx), { outcome: "policy_unavailable" });
    h.close();
  }
  for (const fn of [
    () => {
      throw new Error("SYNTHETIC_SECRET");
    },
    async () => {
      throw new Error("SYNTHETIC_SECRET");
    },
  ]) {
    const h = new AdmissionPolicies([policy({ beforeRoomCreate: fn })]);
    assert.deepEqual(await h.check("beforeRoomCreate", ctx), { outcome: "policy_unavailable" });
    h.close();
  }
});

test("timeouts keep uncooperative work bounded and ignore late allow", async () => {
  const pending = deferred();
  let calls = 0;
  let signal;
  const h = new AdmissionPolicies(
    [
      policy({
        beforeRoomCreate: (_, tools) => {
          calls++;
          signal = tools.signal;
          return pending.promise;
        },
      }),
    ],
    { timeoutMs: 10, maxPending: 1 },
  );
  const check = h.check("beforeRoomCreate", ctx);
  assert.equal((await h.check("beforeRoomCreate", ctx)).outcome, "policy_unavailable");
  assert.equal((await check).outcome, "policy_unavailable");
  assert.equal(signal.aborted, true);
  assert.equal(h.diagnostics().running, 1);
  assert.equal((await h.check("beforeRoomCreate", ctx)).outcome, "policy_unavailable");
  assert.equal(calls, 1);
  pending.resolve(allow);
  await settle();
  assert.equal(h.diagnostics().running, 0);
  assert.equal((await h.check("beforeRoomCreate", ctx)).outcome, "allow");
  h.close();
});

test("cancellation, revision replacement and close fence deferred completion", async () => {
  for (const mode of ["abort", "replace", "close"]) {
    const pending = deferred();
    const h = new AdmissionPolicies([policy({ beforeRoomCreate: () => pending.promise })]);
    const controller = new AbortController();
    const result = h.check("beforeRoomCreate", ctx, controller.signal);
    if (mode === "abort") controller.abort();
    if (mode === "replace") {
      h.replace([]);
      assert.equal(h.revision, "2");
    }
    if (mode === "close") h.close();
    assert.equal((await result).outcome, "policy_unavailable");
    pending.resolve(allow);
    await settle();
    assert.equal(h.diagnostics().running, 0);
    h.close();
    assert.throws(() => h.replace([]), /configuration/);
    assert.equal((await h.check("beforeRoomCreate", ctx)).outcome, "policy_unavailable");
  }
  const controller = new AbortController();
  controller.abort();
  const h = new AdmissionPolicies();
  assert.equal(
    (await h.check("beforeRoomCreate", ctx, controller.signal)).outcome,
    "policy_unavailable",
  );
  h.close();
});

test("revision abort skips later hooks, notification failure is non-vetoing, shutdown does not await hooks", async () => {
  const h = new AdmissionPolicies([
    policy({
      beforeRoomCreate: () => {
        h.replace([]);
        return allow;
      },
    }),
    policy({
      id: "second",
      beforeRoomCreate: () => {
        assert.fail("Stale continuation");
      },
    }),
  ]);
  assert.equal((await h.check("beforeRoomCreate", ctx)).outcome, "policy_unavailable");
  h.close();
  const notified = [];
  const notifications = new AdmissionPolicies([
    policy({
      onDisconnect: (c) => {
        notified.push(c.connectionId);
      },
      onRoomEnd: async () => {
        throw new Error("Synthetic notification fault");
      },
    }),
  ]);
  notifications.notify("onDisconnect", {
    operationId: "op",
    role: "audience",
    roomId: "r",
    connectionId: "c",
  });
  notifications.notify("onRoomEnd", { operationId: "op2", roomId: "r", state: "Ended" });
  await settle();
  assert.deepEqual(notified, ["c"]);
  assert.equal(notifications.diagnostics().notificationFailures, 1);
  notifications.close();
  const p = deferred();
  let signal;
  const stuck = new AdmissionPolicies([
    policy({
      onRoomEnd: (_, t) => {
        signal = t.signal;
        return p.promise;
      },
    }),
  ]);
  stuck.notify("onRoomEnd", { operationId: "op", roomId: "r", state: "Ended" });
  stuck.close();
  assert.equal(signal.aborted, true);
  p.resolve();
  await settle();
  assert.equal(stuck.diagnostics().running, 0);
});

test("descriptor validation is atomic and rejects incompatible or unbounded configuration", () => {
  for (const options of [{ timeoutMs: 0 }, { maxPending: 0 }, { maxPending: 1.5 }])
    assert.throws(() => new AdmissionPolicies([], options));
  for (const policies of [
    [null],
    [policy({ api_version: "2" })],
    [policy({ id: "bad id" })],
    [policy({ id: 1 })],
    [policy(), policy()],
    [policy({ beforeEventForward: true })],
    Array(17).fill(policy()),
  ])
    assert.throws(() => new AdmissionPolicies(policies), /descriptor|configuration/);
  const h = new AdmissionPolicies([policy()]);
  assert.throws(() => h.replace([policy({ id: "!" })]));
  assert.equal(h.revision, "1");
  h.close();
});

test("SDK decisions conform to the checked-in protocol fixtures", async () => {
  const { readFile } = await import("node:fs/promises");
  const { validate } = await import("../scripts/contracts.mjs");
  const fixtures = JSON.parse(
    await readFile(new URL("../protocol/fixtures/wire.json", import.meta.url)),
  );
  for (const fixture of fixtures.filter((f) => f.schema === "policy-decision")) {
    assert.equal(validate(fixture.schema, fixture.value), fixture.valid, fixture.name);
    const h = new AdmissionPolicies([policy({ beforeRoomCreate: () => fixture.value })]);
    const result = await h.check("beforeRoomCreate", ctx);
    assert.equal(
      result.outcome,
      fixture.valid ? fixture.value.outcome : "policy_unavailable",
      fixture.name,
    );
    h.close();
  }
});

test("SDK snapshots event payloads so caller/plugin mutations cannot rewrite deferred input", async () => {
  const payload = { type: "reaction", kind: "heart" };
  let received;
  const pending = deferred();
  const h = new AdmissionPolicies([
    policy({
      beforeEventForward: (c) => {
        received = c.payload;
        assert.ok(Object.isFrozen(c.payload));
        assert.throws(() => {
          c.payload.kind = "laugh";
        }, TypeError);
        return pending.promise;
      },
    }),
  ]);
  const result = h.check("beforeEventForward", {
    operationId: "op",
    role: "audience",
    roomId: "r",
    connectionId: "a",
    presenterEpoch: "1",
    displayEpoch: "0",
    requestId: "r1",
    payload,
  });
  payload.kind = "clap";
  assert.equal(received.kind, "heart");
  pending.resolve(allow);
  assert.equal((await result).outcome, "allow");
  h.close();
});

test("descriptor snapshot preserves class hooks and bindings without silently dropping a hook", async () => {
  class SyntheticPolicy {
    id = "class-synthetic";
    api_version = "1-draft.1";
    calls = 0;
    beforeRoomCreate() {
      this.calls++;
      return deny;
    }
  }
  const p = new SyntheticPolicy();
  const h = new AdmissionPolicies([p]);
  p.beforeRoomCreate = () => allow;
  assert.equal(h.has("beforeRoomCreate"), true);
  assert.equal((await h.check("beforeRoomCreate", ctx)).outcome, "deny");
  assert.equal(p.calls, 1);
  h.close();
});
