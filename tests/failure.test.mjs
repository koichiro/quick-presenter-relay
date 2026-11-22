// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { connectClient, create, eventually, setup, token } from "./runtime-harness.mjs";
import { reaction, receipt } from "./runtime-helpers.mjs";

test("real sockets fence late receipts, duplicate lost results and idle cache expiry", {
  timeout: 10000,
}, async (t) => {
  let clock = 1000;
  const s = await setup(t, { now: () => clock, receiptMs: 10 });
  const p = await connectClient(t, s.base, s.config, "presenter");
  const a = await connectClient(t, s.base, s.config, "audience");
  a.send(reaction("lost"));
  const event = await p.next("event");
  clock += 10;
  p.send(receipt(event));
  assert.equal((await a.next("result")).status, "unknown");
  a.send(reaction("lost"));
  assert.equal((await a.next("result")).status, "unknown");
  assert.equal(s.runtime.diagnostics().pending, 0);
  assert.equal(s.runtime.diagnostics().requests, 1);
  clock += 30000;
  await eventually(() => s.runtime.diagnostics().requests === 0);
  a.send(reaction("lost"));
  const fresh = await p.next("event");
  assert.notEqual(fresh.event_id, event.event_id);
  p.send(receipt(fresh));
  assert.equal((await a.next("result")).status, "accepted");
  a.send({ ...reaction("lost"), kind: "laugh" });
  assert.equal(await a.closed, 1002);
  await eventually(() => s.runtime.diagnostics().requests === 0);
});

test("one over-budget frame disconnects the presenter without false acceptance", {
  timeout: 10000,
}, async (t) => {
  const s = await setup(t, { maxBufferedBytes: 512 });
  const p = await connectClient(t, s.base, s.config, "presenter");
  const a = await connectClient(t, s.base, s.config, "audience");
  a.send({ type: "comment", request_id: "large", body: "界".repeat(200), handle: "test" });
  assert.equal(await p.closed, 1013);
  assert.equal((await a.next("result")).status, "unknown");
  assert.equal(s.runtime.diagnostics().pending, 0);
  assert.equal(s.runtime.diagnostics().failedRooms, 0);
});

test("idle peers and unresponsive close handshakes release sockets within configured deadlines", {
  timeout: 10000,
}, async (t) => {
  let clock = 1000;
  const s = await setup(t, { now: () => clock, closeMs: 10 });
  const p = await connectClient(t, s.base, s.config, "presenter", true, { autoPong: false });
  clock += 45000;
  await p.closed;
  await eventually(() => s.runtime.diagnostics().connections === 0);
  const current = await connectClient(t, s.base, s.config, "presenter");
  current.ws.pause();
  current.ws.send("invalid json");
  await eventually(() => {
    clock += 10;
    return s.runtime.diagnostics().connections === 0;
  });
  current.ws.resume();
  await current.closed;
});

test("concurrent stop waits for partial HTTP, incomplete upgrades and unauthenticated sockets", {
  timeout: 10000,
}, async (t) => {
  const s = await setup(t);
  const unauthenticated = await connectClient(t, s.base, s.config, "presenter", false);
  const partial = connect(s.runtime.port, "127.0.0.1");
  const upgrade = connect(s.runtime.port, "127.0.0.1");
  partial.on("error", () => {});
  upgrade.on("error", () => {});
  t.after(() => {
    partial.destroy();
    upgrade.destroy();
  });
  await Promise.all([once(partial, "connect"), once(upgrade, "connect")]);
  partial.write(
    `POST /api/relay/v1/rooms HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Length: 4096\r\n\r\n{`,
  );
  upgrade.write("GET /ws/presenter/test HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n");
  await delay(20);
  assert.ok(s.runtime.diagnostics().tcpConnections >= 3);
  const stop = s.runtime.stop();
  assert.equal(s.runtime.stop(), stop);
  await stop;
  await unauthenticated.closed;
  await eventually(() => s.runtime.diagnostics().tcpConnections === 0);
  assert.equal(s.runtime.diagnostics().connections, 0);
});

test("maintenance storage failure disconnects all rooms and rejects new creation", {
  timeout: 10000,
}, async (t) => {
  let clock = 1000;
  const s = await setup(t, { now: () => clock });
  const p = await connectClient(t, s.base, s.config, "presenter");
  const db = new DatabaseSync(s.options.database);
  db.exec("DROP TABLE creates");
  db.close();
  clock += 60000;
  await p.closed;
  const response = await fetch(`${s.base}/api/relay/v1/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ idempotency_key: "after-fault" }),
  });
  assert.equal(response.status, 503);
});

async function childRuntime(database) {
  const child = spawn(process.execPath, ["tests/fixtures/runtime-child.mjs", database], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const exited = once(child, "exit");
  const [ready] = await once(child, "message");
  return {
    child,
    base: `http://127.0.0.1:${ready.port}`,
    output: () => output,
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}

test("abrupt process death retains fencing, display and terminal metadata but no event bodies", {
  timeout: 15000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-crash-"));
  const database = join(dir, "rooms.sqlite");
  const children = [];
  t.after(async () => {
    for (const child of children) await child.kill();
    await rm(dir, { recursive: true, force: true });
  });
  let runtime = await childRuntime(database);
  children.push(runtime);
  const config = await create(runtime.base);
  const p = await connectClient(t, runtime.base, config, "presenter");
  const a = await connectClient(t, runtime.base, config, "audience");
  p.send({ type: "display", presenter_epoch: "1", display_epoch: "12", paused: true });
  let state;
  do {
    state = await p.next("state");
  } while (state.display_epoch !== "12");
  a.send({ type: "comment", request_id: "crash", body: "SYNTHETIC_CRASH_BODY", handle: "test" });
  await p.next("event");
  await runtime.kill();
  await p.closed;
  await a.closed;
  runtime = await childRuntime(database);
  children.push(runtime);
  assert.deepEqual(await create(runtime.base), config);
  const db = new DatabaseSync(database);
  let stored = JSON.parse(db.prepare("SELECT record FROM rooms").get().record);
  assert.equal(stored.metadata.state, "PresenterDisconnected");
  const grace = stored.metadata.graceUntil;
  db.close();
  await runtime.kill();
  runtime = await childRuntime(database);
  children.push(runtime);
  const inspect = new DatabaseSync(database);
  stored = JSON.parse(inspect.prepare("SELECT record FROM rooms").get().record);
  inspect.close();
  assert.equal(stored.metadata.graceUntil, grace);
  const resumed = await connectClient(t, runtime.base, config, "presenter");
  assert.equal(resumed.welcome.presenter_epoch, "2");
  assert.equal(resumed.welcome.display_epoch, "12");
  assert.equal(
    resumed.messages.some((m) => m.type === "event"),
    false,
  );
  const end = await fetch(`${runtime.base}/api/relay/v1/rooms/${config.room_id}/end`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.presenter_token}` },
  });
  assert.equal(end.status, 200);
  await resumed.closed;
  await runtime.kill();
  runtime = await childRuntime(database);
  children.push(runtime);
  const response = await fetch(`${runtime.base}/api/relay/v1/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ idempotency_key: "failure-test" }),
  });
  assert.equal(response.status, 410);
  await runtime.kill();
  const files = [database, `${database}-wal`];
  for (const file of files) {
    const bytes = await readFile(file).catch(() => Buffer.alloc(0));
    assert.equal(bytes.includes(Buffer.from("SYNTHETIC_CRASH_BODY")), false);
  }
  for (const child of children) {
    assert.equal(child.output().includes(config.presenter_token), false);
    assert.equal(child.output().includes("SYNTHETIC_CRASH_BODY"), false);
  }
});

test("queued frames after a protocol close never become audience input", {
  timeout: 10000,
}, async (t) => {
  const s = await setup(t);
  await connectClient(t, s.base, s.config, "presenter");
  const a = await connectClient(t, s.base, s.config, "audience");
  a.ws.send("invalid json");
  a.send(reaction("after-close"));
  assert.equal(await a.closed, 1002);
  assert.equal(s.runtime.diagnostics().requests, 0);
  assert.equal(s.runtime.diagnostics().pending, 0);
});

test("normal and abrupt role disconnects permit fresh delivery without replay", {
  timeout: 10000,
}, async (t) => {
  const s = await setup(t);
  const p = await connectClient(t, s.base, s.config, "presenter");
  const a = await connectClient(t, s.base, s.config, "audience");
  a.ws.close(1000);
  assert.equal(await a.closed, 1000);
  await eventually(() => s.runtime.diagnostics().connections === 1);
  const abrupt = await connectClient(t, s.base, s.config, "audience");
  abrupt.send(reaction("abrupt"));
  await p.next("event");
  abrupt.ws.terminate();
  await abrupt.closed;
  await eventually(() => s.runtime.diagnostics().pending === 0);
  p.ws.terminate();
  await p.closed;
  await eventually(() => s.runtime.diagnostics().connections === 0);
  const resumed = await connectClient(t, s.base, s.config, "presenter");
  assert.equal(resumed.welcome.presenter_epoch, "2");
  const fresh = await connectClient(t, s.base, s.config, "audience");
  fresh.send(reaction("fresh"));
  const event = await resumed.next("event");
  assert.equal(event.request_id, "fresh");
  resumed.send(receipt(event));
  assert.equal((await fresh.next("result")).status, "accepted");
  assert.equal(
    resumed.messages.some((message) => message.type === "event"),
    false,
  );
  resumed.ws.close(1000);
  assert.equal(await resumed.closed, 1000);
});
