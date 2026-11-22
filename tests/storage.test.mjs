// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Storage } from "../dist/src/storage.js";

test("SQLite metadata, encrypted idempotency, rollback, expiry and key mismatch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-storage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "rooms.sqlite");
  const key = Buffer.alloc(32, 1);
  assert.throws(() => new Storage(path, Buffer.alloc(2)));
  const storage = new Storage(path, key);
  const room = {
    metadata: {
      id: "r",
      expiresAt: 100,
      state: "Created",
      presenterEpoch: "0",
      displayEpoch: "0",
      revision: "0",
      graceUntil: null,
    },
    audienceHash: "a".repeat(64),
    presenterHash: "b".repeat(64),
  };
  const config = { room_id: "r", presenter_token: "secret-not-in-cleartext" };
  storage.create(room, "key", config, 200);
  assert.deepEqual(storage.cached("key", 0), config);
  assert.equal(storage.cached("missing", 0), null);
  assert.throws(() =>
    storage.create({ ...room, metadata: { ...room.metadata, id: "rollback" } }, "key", config, 200),
  );
  assert.equal(storage.rooms().length, 1);
  storage.close();
  const bytes = await readFile(path);
  assert.equal(bytes.includes(Buffer.from(config.presenter_token)), false);
  const wrong = new Storage(path, Buffer.alloc(32, 2));
  assert.throws(() => wrong.cached("key", 0));
  wrong.close();
  const reopened = new Storage(path, key);
  assert.equal(reopened.rooms()[0].metadata.id, "r");
  assert.equal(reopened.cached("key", 200), null);
  reopened.prune(86400101);
  assert.deepEqual(reopened.rooms(), []);
  reopened.close();
});
