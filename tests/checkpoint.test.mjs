// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Room } from "quick-presenter-relay-core";

function setup(checkpoint, options = {}) {
  const clock = { now: 0 };
  const messages = [];
  const closed = [];
  const metadata = checkpoint
    ? structuredClone(checkpoint.metadata)
    : {
        id: "synthetic",
        state: "Created",
        expiresAt: 1000,
        presenterEpoch: "0",
        displayEpoch: "0",
        revision: "0",
        graceUntil: null,
      };
  const ports = {
    now: () => clock.now,
    id: () => "synthetic-event",
    save: () => {},
    send: (connection, message) => messages.push({ connection, message }),
    close: (id, code) => closed.push({ id, code }),
    fingerprint: (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    ...options,
  };
  return {
    room: new Room(metadata, ports, { receiptMs: 10 }, checkpoint),
    messages,
    closed,
    clock,
  };
}
function pending() {
  const t = setup();
  t.room.attach("p", "presenter");
  t.room.attach("a", "audience");
  t.room.receive("a", {
    type: "comment",
    request_id: "r",
    body: "synthetic-content",
    handle: "synthetic",
  });
  return t;
}
const receipt = {
  type: "receipt",
  presenter_epoch: "1",
  event_id: "synthetic-event",
  status: "accepted",
};

test("checkpoint restores topology, epochs, pending receipt and opaque dedup without event replay", () => {
  const first = pending();
  const checkpoint = first.room.checkpoint();
  assert.equal(JSON.stringify(checkpoint).includes("synthetic-content"), false);
  const restored = setup(checkpoint);
  assert.deepEqual(restored.room.metadata, first.room.metadata);
  assert.equal(restored.room.audienceCount, 1);
  assert.deepEqual(restored.messages, []);
  restored.room.receive("p", receipt);
  assert.equal(restored.messages.at(-1).message.status, "accepted");
  const accepted = setup(restored.room.checkpoint());
  accepted.room.receive("a", {
    type: "comment",
    request_id: "r",
    body: "synthetic-content",
    handle: "synthetic",
  });
  assert.equal(accepted.messages.at(-1).message.status, "accepted");
  assert.equal(
    accepted.messages.some(({ message }) => message.type === "event"),
    false,
  );
  accepted.room.receive("a", {
    type: "comment",
    request_id: "r",
    body: "different",
    handle: "synthetic",
  });
  assert.equal(accepted.closed.at(-1).code, 1002);
  accepted.room.attach("replacement", "presenter");
  assert.equal(accepted.room.metadata.presenterEpoch, "2");
});

test("expired pending, unresolved external decisions and terminal checkpoints fail closed", () => {
  const t = pending();
  const expired = t.room.checkpoint();
  expired.pending[0].deadline = 0;
  assert.equal(setup(expired).messages.at(-1).message.status, "unknown");
  const evaluating = t.room.checkpoint();
  evaluating.pending[0].forwarded = false;
  assert.equal(setup(evaluating).messages.at(-1).message.status, "unknown");
  t.room.end();
  const ended = setup(t.room.checkpoint());
  assert.equal(ended.room.attach("late", "presenter"), false);
  const disconnected = pending();
  disconnected.room.disconnect("p");
  assert.equal(setup(disconnected.room.checkpoint()).room.metadata.state, "PresenterDisconnected");
  const created = setup();
  assert.equal(setup(created.room.checkpoint()).room.metadata.state, "Created");
  assert.throws(() => setup(undefined, { fingerprint: undefined }).room.checkpoint());
  const invalidFingerprint = setup(undefined, { fingerprint: () => "raw content" });
  invalidFingerprint.room.attach("p", "presenter");
  invalidFingerprint.room.attach("a", "audience");
  assert.throws(() =>
    invalidFingerprint.room.receive("a", { type: "reaction", request_id: "r", kind: "heart" }),
  );
});

test("checkpoint validation rejects mismatched metadata, identities, cached results and reservations", () => {
  const t = pending();
  const base = t.room.checkpoint();
  const corrupt = (change) => {
    const value = structuredClone(base);
    change(value);
    assert.throws(() => setup(value));
  };
  assert.throws(() => setup(base, { fingerprint: undefined }));
  corrupt((s) => {
    s.version = 2;
  });
  const metadata = { ...base.metadata, revision: "999" };
  assert.throws(() => new Room(metadata, { fingerprint: () => "opaque" }, {}, base));
  corrupt((s) => {
    s.presenter = "bad id";
  });
  corrupt((s) => {
    s.presenter = undefined;
  });
  corrupt((s) => {
    s.presenter = null;
  });
  corrupt((s) => {
    s.members = null;
  });
  corrupt((s) => {
    s.pending = null;
  });
  corrupt((s) => {
    s.pending = Array(129).fill(s.pending[0]);
  });
  for (const change of [
    (s) => {
      s.members[0].connection = "bad id";
    },
    (s) => {
      s.members[0].connection = "p";
    },
    (s) => {
      s.members.push(structuredClone(s.members[0]));
    },
    (s) => {
      s.members[0].requests = null;
    },
    (s) => {
      s.members[0].requests = Array(257).fill(s.members[0].requests[0]);
    },
    (s) => {
      s.members[0].requests[0].request = "bad id";
    },
    (s) => {
      s.members[0].requests.push(structuredClone(s.members[0].requests[0]));
    },
    (s) => {
      s.members[0].requests[0].fingerprint = "raw content";
    },
    (s) => {
      s.members[0].requests[0].finished = -1;
    },
    (s) => {
      s.members[0].requests[0].finished = 1.5;
    },
    (s) => {
      s.members[0].requests[0].finished = 0;
    },
    (s) => {
      s.pending[0].event = "bad id";
    },
    (s) => {
      s.pending.push(structuredClone(s.pending[0]));
    },
    (s) => {
      s.pending[0].connection = "missing";
    },
    (s) => {
      s.pending[0].deadline = -1;
    },
    (s) => {
      s.pending[0].deadline = 1.5;
    },
    (s) => {
      s.pending[0].forwarded = "yes";
    },
    (s) => {
      s.pending = [];
    },
  ])
    corrupt(change);
  t.room.receive("p", receipt);
  const done = t.room.checkpoint();
  for (const field of ["protocol", "version", "type", "request_id", "status"]) {
    const value = structuredClone(done);
    value.members[0].requests[0].result[field] = "invalid";
    assert.throws(() => setup(value));
  }
  const extra = structuredClone(done);
  extra.members[0].requests[0].result.body = "content";
  assert.throws(() => setup(extra));
  const invalidPending = structuredClone(done);
  invalidPending.pending = base.pending;
  assert.throws(() => setup(invalidPending));
  const duplicateReservation = structuredClone(base);
  duplicateReservation.pending.push({ ...base.pending[0], event: "other" });
  assert.throws(() => setup(duplicateReservation));
  const terminal = structuredClone(base);
  terminal.metadata.state = "Ended";
  terminal.presenter = null;
  assert.throws(() => setup(terminal));
});
