// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startRelay } from "../dist/src/runtime.js";
import { connectRuntime } from "./runtime-helpers.mjs";

export const token = "A".repeat(43);
export async function create(base, key = "failure-test") {
  const response = await fetch(`${base}/api/relay/v1/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ idempotency_key: key }),
  });
  assert.ok([200, 201].includes(response.status));
  return response.json();
}
export async function setup(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "relay-failure-"));
  const options = {
    database: join(dir, "rooms.sqlite"),
    storageKey: Buffer.alloc(32, 1),
    createToken: token,
    publicOrigin: "https://relay.example",
    heartbeatMs: 20,
    ...extra,
  };
  const runtime = await startRelay(options);
  t.after(async () => {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${runtime.port}`;
  return { runtime, options, dir, base, config: await create(base) };
}
// Client cleanup is independent of server cleanup: a killed TCP peer can leave
// a client half-open until the operating system detects it, especially under load.
export async function connectClient(t, ...args) {
  const client = await connectRuntime(...args);
  t.after(() => client.ws.terminate());
  return client;
}
export async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.ok(predicate(), "Expected resource cleanup within one second");
}
