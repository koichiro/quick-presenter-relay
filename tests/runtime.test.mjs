// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WebSocket } from "ws";
import { startRelay } from "../dist/src/runtime.js";
import { validate } from "../scripts/contracts.mjs";
import { emojiComments, emojiHandle } from "./fixtures/emoji-comments.mjs";
import { connectRuntime, reaction, receipt } from "./runtime-helpers.mjs";

const token = "A".repeat(43);
async function setup(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "relay-runtime-"));
  const options = {
    database: join(dir, "rooms.sqlite"),
    storageKey: Buffer.alloc(32, 1),
    createToken: token,
    publicOrigin: "https://relay.example",
    heartbeatMs: 10,
    ...extra,
  };
  let runtime = await startRelay(options);
  t.after(async () => {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const suite = {
    options,
    dir,
    runtime,
    base: `http://127.0.0.1:${runtime.port}`,
    async create(key = "test") {
      const response = await fetch(`${suite.base}/api/relay/v1/rooms`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ idempotency_key: key }),
      });
      assert.ok([200, 201].includes(response.status));
      const config = await response.json();
      assert.ok(validate("create-response", config));
      return config;
    },
    async restart() {
      await runtime.stop();
      runtime = await startRelay(options);
      suite.runtime = runtime;
      suite.base = `http://127.0.0.1:${runtime.port}`;
    },
  };
  return suite;
}
const pause = (p, epoch, paused) =>
  p.send({
    type: "display",
    presenter_epoch: p.welcome.presenter_epoch,
    display_epoch: epoch,
    paused,
  });
async function ended(s, config, bearer = config.presenter_token) {
  return fetch(`${s.base}/api/relay/v1/rooms/${config.room_id}/end`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

test("self-hosted API and real sockets exchange comments/reactions, pause epochs, resume and multiple rooms", {
  timeout: 10000,
}, async (t) => {
  const s = await setup(t);
  const config = await s.create();
  const second = await s.create("second");
  assert.notEqual(config.room_id, second.room_id);
  assert.deepEqual(await s.create(), config);
  const p = await connectRuntime(s.base, config, "presenter");
  const a = await connectRuntime(s.base, config, "audience");
  const b = await connectRuntime(s.base, config, "audience");
  pause(p, "9", true);
  let state;
  do {
    state = await p.next("state");
  } while (state.display_epoch !== "9");
  assert.equal(state.audience_connections, 2);
  a.send({ type: "comment", request_id: "c", body: "Hello 世界", handle: " Original " });
  const comment = await p.next("event");
  assert.equal(comment.display_epoch, "9");
  assert.equal(comment.payload.handle, " Original ");
  p.send(receipt(comment));
  assert.equal((await a.next("result")).status, "accepted");
  a.send({ type: "comment", request_id: "c", body: "Hello 世界", handle: " Original " });
  assert.equal((await a.next("result")).status, "accepted");
  pause(p, "10", false);
  b.send(reaction("r"));
  const event = await p.next("event");
  p.send(receipt(event));
  assert.equal((await b.next("result")).status, "accepted");
  a.send(reaction("lost"));
  await p.next("event");
  const replacement = await connectRuntime(s.base, config, "presenter");
  await p.closed;
  assert.equal((await a.next("result")).status, "unknown");
  assert.equal(replacement.welcome.presenter_epoch, "2");
  assert.equal(replacement.welcome.display_epoch, "10");
  a.send(reaction("fresh"));
  replacement.send(receipt(await replacement.next("event")));
  assert.equal((await a.next("result")).status, "accepted");
  assert.equal((await ended(s, config, new URL(config.join_url).hash.slice(3))).status, 401);
  const endedResponse = await ended(s, config);
  assert.equal(endedResponse.status, 200);
  assert.ok(validate("end-response", await endedResponse.json()));
  await replacement.closed;
  await a.closed;
  await b.closed;
  assert.equal((await ended(s, config)).status, 200);
  const repeated = await fetch(`${s.base}/api/relay/v1/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: '{"idempotency_key":"test"}',
  });
  assert.equal(repeated.status, 410);
  const page = await fetch(`${s.base}/join/${second.room_id}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Audience Live/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await fetch(`${s.base}/assets/audience.js`)).status, 200);
  assert.equal((await fetch(`${s.base}/missing`)).status, 404);
  assert.equal((await fetch(`${s.base}/missing`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${s.base}/api/relay/v1/rooms`, { method: "POST" })).status, 401);
  assert.equal(
    (
      await fetch(`${s.base}/api/relay/v1/rooms`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  for (const body of [
    "{}",
    '{"idempotency_key":"bad","idempotency_key":"worse"}',
    "x".repeat(4097),
  ]) {
    assert.equal(
      (
        await fetch(`${s.base}/api/relay/v1/rooms`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body,
        })
      ).status,
      400,
    );
  }
});

test("strict authentication, origin, role, binary, duplicate JSON, auth deadline and resource bounds", {
  timeout: 10000,
}, async (t) => {
  const s = await setup(t, { authMs: 30, maxRooms: 1 });
  const config = await s.create();
  const denied = await fetch(`${s.base}/api/relay/v1/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: '{"idempotency_key":"overflow"}',
  });
  assert.equal(denied.status, 503);
  const early = await connectRuntime(s.base, config, "audience", false);
  early.send({ type: "hello", token: new URL(config.join_url).hash.slice(3) });
  assert.equal(await early.closed, 1008);
  const idle = await connectRuntime(s.base, config, "presenter", false);
  await idle.closed;
  const p = await connectRuntime(s.base, config, "presenter");
  for (const input of [
    "invalid JSON",
    '{"type":"hello","type":"hello"}',
    Buffer.from("binary"),
    JSON.stringify({ protocol: "qp.audience", version: "1", type: "hello", token }),
  ]) {
    const socket = await connectRuntime(s.base, config, "presenter", false);
    socket.ws.send(input);
    await socket.closed;
  }
  const wrong = await connectRuntime(s.base, config, "audience", false);
  wrong.send({ type: "hello", token });
  assert.equal(await wrong.closed, 1008);
  const repeated = await connectRuntime(s.base, config, "audience");
  repeated.send({ type: "hello", token: new URL(config.join_url).hash.slice(3) });
  assert.equal(await repeated.closed, 1002);
  for (const [path, origin] of [
    ["/missing", undefined],
    [`/ws/audience/${config.room_id}`, "https://evil.example"],
  ]) {
    const ws = new WebSocket(`${s.base.replace(/^http/, "ws")}${path}`, origin ? { origin } : {});
    ws.on("error", () => {});
    await new Promise((resolve) => ws.once("close", resolve));
  }
  await ended(s, config);
  await p.closed;
  const ws = new WebSocket(`${s.base.replace(/^http/, "ws")}/ws/presenter/${config.room_id}`);
  ws.on("error", () => {});
  await new Promise((resolve) => ws.once("close", resolve));
});

test("SQLite restart retains fencing and display without retaining/replaying event bodies", {
  timeout: 10000,
}, async (t) => {
  const s = await setup(t);
  const config = await s.create();
  const p = await connectRuntime(s.base, config, "presenter");
  const a = await connectRuntime(s.base, config, "audience");
  pause(p, "12", true);
  let state;
  do {
    state = await p.next("state");
  } while (state.display_epoch !== "12");
  a.send({
    type: "comment",
    request_id: "sensitive",
    body: "transient event body",
    handle: "transient name",
  });
  await p.next("event");
  await s.restart();
  await p.closed;
  await a.closed;
  assert.deepEqual(await s.create(), config);
  const resumed = await connectRuntime(s.base, config, "presenter");
  assert.equal(resumed.welcome.presenter_epoch, "2");
  assert.equal(resumed.welcome.display_epoch, "12");
  assert.equal(resumed.welcome.audience_connections, 0);
  const bytes = await readFile(s.options.database);
  assert.equal(bytes.includes(Buffer.from("transient event body")), false);
  assert.equal(bytes.includes(Buffer.from(config.presenter_token)), false);
  await ended(s, config);
  await s.restart();
  assert.equal((await ended(s, config)).status, 200);
});

test("receipt timeout, grace/deadline expiry and retained-metadata cleanup use runtime clock", {
  timeout: 10000,
}, async (t) => {
  let now = 0;
  const s = await setup(t, { now: () => now, roomMs: 1000, receiptMs: 10, graceMs: 20 });
  const config = await s.create();
  const p = await connectRuntime(s.base, config, "presenter");
  const a = await connectRuntime(s.base, config, "audience");
  a.send(reaction("timeout"));
  await p.next("event");
  now = 10;
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal((await a.next("result")).status, "unknown");
  p.ws.close();
  await p.closed;
  let state;
  do {
    state = await a.next("state");
  } while (state.available);
  now = 50;
  await new Promise((resolve) => setTimeout(resolve, 130));
  await a.closed;
  assert.equal((await ended(s, config)).status, 200);
  const expired = await s.create("expires");
  now = 2000;
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal((await ended(s, expired)).status, 200);
  now = 86410000;
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal((await ended(s, config)).status, 404);
});

test("configuration, listener, corrupted storage and storage-write failures fail closed", {
  timeout: 10000,
}, async (t) => {
  const s = await setup(t);
  const config = await s.create();
  for (const extra of [
    { publicOrigin: "http://relay.example" },
    { publicOrigin: "https://relay.example/path" },
    { createToken: "bad" },
    { roomMs: -1 },
    { storageKey: Buffer.alloc(2) },
  ])
    await assert.rejects(startRelay({ ...s.options, ...extra }));
  await assert.rejects(startRelay({ ...s.options, database: ":memory:", port: s.runtime.port }));
  const p = await connectRuntime(s.base, config, "presenter");
  const db = new DatabaseSync(s.options.database);
  db.exec("DROP TABLE rooms");
  pause(p, "1", true);
  await p.closed;
  assert.equal((await ended(s, config)).status, 503);
  const retry = await fetch(`${s.base}/api/relay/v1/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ idempotency_key: "test" }),
  });
  assert.equal(retry.status, 503);
  db.close();
  await s.runtime.stop();
  const corrupt = new DatabaseSync(s.options.database);
  corrupt.exec("CREATE TABLE rooms(id TEXT PRIMARY KEY, record TEXT NOT NULL)");
  corrupt
    .prepare("INSERT INTO rooms VALUES(?,?)")
    .run(
      "bad",
      JSON.stringify({ metadata: { id: "bad", expiresAt: 9999999999999, state: "bogus" } }),
    );
  corrupt.close();
  await assert.rejects(startRelay(s.options));
});

test("CLI validates private config, prints connection credentials and terminates", {
  timeout: 10000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-server-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  const config = {
    database: join(dir, "room.sqlite"),
    storageKey: "01".repeat(32),
    createToken: token,
    publicOrigin: "http://127.0.0.1:19231",
    port: 0,
  };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, ["dist/src/cli.js", path], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => child.kill());
  const [output] = await once(child.stdout, "data");
  assert.equal(output.includes(Buffer.from(token)), true);
  const exit = once(child, "exit");
  child.send("ignored-parent-message");
  child.send("shutdown");
  assert.equal((await exit)[0], 0);
  for (const args of [[], ["/missing/path"], [path, "extra"]]) {
    const child = spawn(process.execPath, ["dist/src/cli.js", ...args], { stdio: "ignore" });
    assert.equal((await once(child, "exit"))[0], 1);
  }
  await writeFile(path, '{"unknown":true}', { mode: 0o600 });
  const bad = spawn(process.execPath, ["dist/src/cli.js", path], { stdio: "ignore" });
  assert.equal((await once(bad, "exit"))[0], 1);
});

for (const { name, body } of emojiComments)
  test(`emoji comments survive relay round trip: ${name}`, { timeout: 10000 }, async (t) => {
    const s = await setup(t);
    const config = await s.create();
    const presenter = await connectRuntime(s.base, config, "presenter");
    const audience = await connectRuntime(s.base, config, "audience");
    try {
      audience.send({ type: "comment", request_id: "emoji_comment", body, handle: emojiHandle });
      const event = await presenter.next("event");
      assert.equal(event.payload.body, body);
      assert.equal(event.payload.handle, emojiHandle);
      presenter.send(receipt(event));
      assert.deepEqual(await audience.next("result"), {
        protocol: "qp.audience",
        version: "1",
        type: "result",
        request_id: "emoji_comment",
        status: "accepted",
      });
    } finally {
      presenter.ws.close();
      audience.ws.close();
    }
  });

test("v1 rejects the retired draft HTTP path and socket discriminator", async (t) => {
  const s = await setup(t);
  const legacy = await fetch(`${s.base}/api/relay/draft-1/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ idempotency_key: "legacy" }),
  });
  assert.equal(legacy.status, 404);
  const config = await s.create("v1");
  const client = await connectRuntime(s.base, config, "audience", false);
  client.send({
    type: "hello",
    version: "1-draft.1",
    token: new URL(config.join_url).hash.slice(3),
  });
  assert.equal(await client.closed, 1002);
});
