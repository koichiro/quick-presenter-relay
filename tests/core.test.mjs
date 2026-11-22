// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { Room, strictJSON } from "quick-presenter-relay-core";
import { validate } from "../scripts/contracts.mjs";

function setup(limits = {}, state = "Created", extraPorts = {}) {
  let time = 0;
  let count = 0;
  const sent = [];
  const closed = [];
  const saved = [];
  const room = new Room(
    {
      id: "test",
      expiresAt: 1000,
      state,
      presenterEpoch: "0",
      displayEpoch: "0",
      revision: "0",
      graceUntil: null,
    },
    {
      now: () => time,
      id: () => `e${++count}`,
      save: (m) => saved.push(m),
      send: (id, value) => {
        assert.ok(validate("messages", value));
        sent.push({ id, value });
      },
      close: (id, code) => closed.push({ id, code }),
      ...extraPorts,
    },
    limits,
  );
  return {
    room,
    sent,
    closed,
    saved,
    setTime: (value) => {
      time = value;
    },
    next: (type) => sent.findLast((e) => e.value.type === type)?.value,
  };
}
const reaction = (id, kind = "heart") => ({ type: "reaction", request_id: id, kind });
const receipt = (room, event, status = "accepted") => ({
  type: "receipt",
  presenter_epoch: room.metadata.presenterEpoch,
  event_id: event,
  status,
});

test("strict JSON rejects decoded duplicate keys, nested keys, size and depth", () => {
  assert.deepEqual(strictJSON(' {"a":[1,{"b":"c\\"d"}],"n":null,"t":true} '), {
    a: [1, { b: 'c"d' }],
    n: null,
    t: true,
  });
  assert.equal(strictJSON("42"), 42);
  assert.equal(strictJSON('"hi"'), "hi");
  for (const value of [
    '{"a":1,"\\u0061":2}',
    '{"x":{"k":1,"k":2}}',
    "[]".repeat(2),
    '"' + "x".repeat(4096) + '"',
    `${"[".repeat(33)}0${"]".repeat(33)}`,
  ])
    assert.throws(() => strictJSON(value));
});

test("receipts, multiple members, normalization ownership and dedup", () => {
  const t = setup();
  assert.equal(t.room.attach("early", "audience"), false);
  t.room.attach("p", "presenter");
  t.room.attach("a", "audience");
  t.room.attach("b", "audience");
  assert.equal(t.room.audienceCount, 2);
  t.room.receive("a", reaction("r"));
  const event = t.next("event");
  assert.equal(t.next("result"), undefined);
  t.room.receive("a", reaction("r"));
  assert.equal(t.sent.filter((e) => e.value.type === "event").length, 1);
  t.room.receive("p", receipt(t.room, "missing"));
  t.room.receive("p", receipt(t.room, event.event_id));
  assert.equal(t.next("result").status, "accepted");
  t.room.receive("a", reaction("r"));
  t.room.receive("a", reaction("r", "laugh"));
  assert.equal(t.closed.at(-1).code, 1002);
  t.room.receive("b", {
    type: "comment",
    request_id: "c",
    body: "  Hello 世界  ",
    handle: " Original ",
  });
  assert.equal(t.next("event").payload.handle, " Original ");
  t.room.receive("p", receipt(t.room, t.next("event").event_id, "busy"));
  assert.equal(t.next("result").status, "busy");
  t.room.disconnect("a");
  t.room.disconnect("a");
  assert.equal(t.room.audienceCount, 1);
});

test("presenter fencing, display epochs, pause and no replay", () => {
  const t = setup();
  t.room.attach("p", "presenter");
  t.room.attach("a", "audience");
  t.room.receive("p", { type: "display", presenter_epoch: "1", display_epoch: "8", paused: true });
  t.room.receive("p", { type: "display", presenter_epoch: "1", display_epoch: "7", paused: false });
  t.room.receive("a", reaction("pending"));
  assert.equal(t.next("event").display_epoch, "8");
  t.room.attach("p2", "presenter");
  assert.equal(t.next("result").status, "unknown");
  t.room.disconnect("p");
  assert.equal(t.room.metadata.state, "Active");
  t.room.receive("p", { type: "display", presenter_epoch: "1", display_epoch: "9", paused: false });
  t.room.receive("p2", {
    type: "display",
    presenter_epoch: "1",
    display_epoch: "9",
    paused: false,
  });
  assert.equal(t.closed.at(-1).code, 1008);
  t.room.receive("outsider", reaction("x"));
  assert.equal(t.closed.at(-1).code, 1008);
  t.room.receive("a", reaction("fresh"));
  t.room.receive("p2", receipt(t.room, t.next("event").event_id));
  assert.equal(t.next("result").status, "accepted");
});

test("small pending/cache boundaries, unknown timeouts and departure cleanup", () => {
  const t = setup({ receiptMs: 10, cacheMs: 20, maxPending: 1, maxRequests: 3 });
  t.room.attach("p", "presenter");
  t.room.attach("a", "audience");
  t.room.receive("a", reaction("one"));
  t.room.receive("a", reaction("two"));
  assert.equal(t.next("result").status, "busy");
  t.setTime(10);
  t.room.tick();
  assert.equal(t.next("result").status, "unknown");
  t.setTime(30);
  t.room.receive("a", reaction("one"));
  t.room.receive("a", reaction("three"));
  t.room.receive("a", reaction("four"));
  t.room.receive("a", reaction("five"));
  assert.equal(t.closed.at(-1).code, 1013);
  t.room.disconnect("a");
  t.room.tick();
  t.room.attach("b", "audience");
  t.room.receive("b", reaction("lost"));
  t.room.disconnect("p");
  assert.equal(t.next("result").status, "unknown");
  t.room.receive("b", reaction("absent"));
  assert.equal(t.next("result").status, "unavailable");
});

test("terminal rooms, grace expiry, recovery and persistence before welcome", () => {
  const t = setup({ graceMs: 10 }, "Active");
  assert.equal(t.room.metadata.state, "PresenterDisconnected");
  t.setTime(10);
  t.room.tick();
  assert.equal(t.room.metadata.state, "Expired");
  t.room.end();
  assert.equal(t.room.attach("p", "presenter"), false);
  t.room.receive("p", reaction("ignored"));
  const end = setup();
  end.room.attach("p", "presenter");
  end.room.attach("a", "audience");
  end.room.receive("a", reaction("lost"));
  end.room.end();
  assert.equal(end.next("result").status, "unknown");
  assert.equal(end.room.audienceCount, 0);
  end.room.disconnect("p");
  end.room.end();
  const expiry = setup();
  expiry.setTime(1000);
  expiry.room.tick();
  assert.equal(expiry.room.metadata.state, "Expired");
  assert.equal(end.saved.at(-1).state, "Ended");
});

test("counter exhaustion never wraps or emits an invalid wire epoch", () => {
  const presenter = setup();
  presenter.room.metadata.presenterEpoch = "9".repeat(20);
  assert.throws(() => presenter.room.attach("p", "presenter"), /Counter exhausted/);
  const revision = setup();
  revision.room.metadata.revision = "9".repeat(20);
  assert.throws(() => revision.room.attach("p", "presenter"), /Counter exhausted/);
});

test("lost results are cached only until the idle retention deadline; late receipts cannot accept", () => {
  const t = setup({ receiptMs: 10, cacheMs: 20 });
  t.room.attach("p", "presenter");
  t.room.attach("a", "audience");
  t.room.receive("a", reaction("lost"));
  const event = t.next("event");
  assert.deepEqual(t.room.diagnostics(), { audiences: 1, pending: 1, requests: 1 });
  t.setTime(10);
  t.room.receive("p", receipt(t.room, event.event_id));
  assert.equal(t.next("result").status, "unknown");
  t.room.receive("a", reaction("lost"));
  assert.equal(t.sent.filter((e) => e.value.type === "event").length, 1);
  assert.equal(t.next("result").status, "unknown");
  t.setTime(30);
  t.room.tick();
  assert.deepEqual(t.room.diagnostics(), { audiences: 1, pending: 0, requests: 0 });
  t.room.receive("a", reaction("lost"));
  assert.equal(t.sent.filter((e) => e.value.type === "event").length, 2);
  t.room.end();
  assert.deepEqual(t.room.diagnostics(), { audiences: 0, pending: 0, requests: 0 });
});

test("async core admission rejects fault, closing connection and post-decision configuration change", async () => {
  for (const mode of ["fault", "closing", "revision", "ttl"]) {
    let revision = "1";
    const t = setup({ receiptMs: 100 }, "Created", {
      connected: (id) => mode !== "closing" || id !== "a",
      admission: {
        revision: () => revision,
        evaluate: async () => {
          if (mode === "fault") throw new Error("Synthetic hook fault");
          return { outcome: "allow" };
        },
        commit: (action) => {
          if (mode === "revision") revision = "2";
          action();
        },
      },
    });
    t.room.attach("p", "presenter");
    t.room.attach("a", "audience");
    t.room.receive("a", reaction(mode));
    t.setTime(90);
    await new Promise((resolve) => setImmediate(resolve));
    if (mode === "ttl") {
      assert.equal(t.next("event").offer_ttl_ms, 10);
      t.setTime(100);
      t.room.tick();
      assert.equal(t.next("result").status, "unknown");
    } else {
      assert.equal(t.next("event"), undefined);
      assert.equal(t.next("result").status, mode === "closing" ? "unknown" : "policy_unavailable");
    }
  }
});

test("deadline reached between reservation and forwarding never emits a zero-TTL offer", () => {
  let clock = 0;
  let advance = false;
  const t = setup({ receiptMs: 1 }, "Created", {
    now: () => {
      const value = clock;
      if (advance) clock++;
      return value;
    },
  });
  t.room.attach("p", "presenter");
  t.room.attach("a", "audience");
  advance = true;
  t.room.receive("a", reaction("deadline"));
  assert.equal(t.next("event"), undefined);
  assert.equal(t.next("result").status, "unknown");
});
