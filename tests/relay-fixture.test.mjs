// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { validate } from "../scripts/contracts.mjs";
import { connect, fixtureFor, reaction, receipt } from "./fixture-helpers.mjs";

test("fixture HTTP, tokens, authentication and malformed messages", {
  timeout: 5000,
}, async (t) => {
  const fixture = await fixtureFor(t, { authMs: 30 });
  assert.ok(validate("create-response", fixture.config));
  assert.notEqual(fixture.config.presenter_token, new URL(fixture.config.join_url).hash.slice(3));
  const page = await fetch(fixture.config.join_url);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(await page.text(), /Test Relay/);
  assert.equal((await fetch(new URL("/missing", fixture.config.join_url))).status, 404);
  const bad = new WebSocket(`${new URL(fixture.config.presenter_url).origin}/missing`);
  bad.on("error", () => {});
  await new Promise((resolve) => bad.once("close", resolve));
  const idle = await connect(fixture, "audience", false);
  await idle.closed;
  for (const value of [
    { type: "hello", token: "A".repeat(43) },
    { type: "reaction", request_id: "before", kind: "heart" },
    { type: "hello", token: "B" },
    { protocol: "qp.presenter", type: "hello", token: fixture.config.presenter_token },
  ]) {
    const client = await connect(fixture, "audience", false);
    client.send(value);
    await client.closed;
  }
  const malformed = await connect(fixture, "audience", false);
  malformed.ws.send("not JSON");
  await malformed.closed;
  const binary = await connect(fixture, "audience", false);
  binary.ws.send(
    Buffer.from(
      JSON.stringify({
        protocol: "qp.audience",
        version: "1",
        type: "hello",
        token: "A".repeat(43),
      }),
    ),
  );
  await binary.closed;
  await fixture.stop();
  await fixture.stop();
});

test("receipts, display state, dedup and resume conform to wire schemas", {
  timeout: 5000,
}, async (t) => {
  const fixture = await fixtureFor(t);
  const p = await connect(fixture, "presenter");
  const a = await connect(fixture, "audience");
  p.send({
    type: "display",
    presenter_epoch: p.welcome.presenter_epoch,
    display_epoch: "11",
    paused: false,
  });
  let state;
  do {
    state = await p.next("state");
  } while (state.display_epoch !== "11");
  assert.equal(state.audience_connections, 1);
  p.send({
    type: "display",
    presenter_epoch: p.welcome.presenter_epoch,
    display_epoch: "10",
    paused: true,
  });
  a.send(reaction("r1"));
  const event = await p.next("event");
  assert.equal(event.display_epoch, "11");
  a.send(reaction("r1"));
  p.send(receipt(event));
  assert.equal((await a.next("result")).status, "accepted");
  a.send(reaction("r1"));
  assert.equal((await a.next("result")).status, "accepted");
  a.send({ type: "comment", request_id: "c1", body: "Hello 世界", handle: " Original " });
  const comment = await p.next("event");
  assert.equal(comment.payload.handle, " Original ");
  p.send(receipt(comment, "busy"));
  assert.equal((await a.next("result")).status, "busy");
  p.send({
    type: "receipt",
    presenter_epoch: p.welcome.presenter_epoch,
    event_id: "missing",
    status: "accepted",
  });
  const replacement = await connect(fixture, "presenter");
  await p.closed;
  assert.notEqual(replacement.welcome.presenter_epoch, p.welcome.presenter_epoch);
  assert.equal(replacement.welcome.display_epoch, "11");
  a.send(reaction("r2"));
  const fresh = await replacement.next("event");
  replacement.send(receipt(fresh));
  assert.equal((await a.next("result")).status, "accepted");
  a.send(reaction("r1", "applause"));
  await a.closed;
});

test("disconnect, timeout, cache expiry and invalid presenter operations", {
  timeout: 5000,
}, async (t) => {
  const fixture = await fixtureFor(t, { receiptMs: 15, cacheMs: 20 });
  const a = await connect(fixture, "audience");
  a.send(reaction("absent"));
  assert.equal((await a.next("result")).status, "unavailable");
  let p = await connect(fixture, "presenter");
  a.send(reaction("timeout"));
  await p.next("event");
  assert.equal((await a.next("result")).status, "unknown");
  await new Promise((resolve) => setTimeout(resolve, 25));
  a.send(reaction("timeout"));
  const next = await p.next("event");
  p.send(receipt(next));
  assert.equal((await a.next("result")).status, "accepted");
  a.send(reaction("lost"));
  await p.next("event");
  p.ws.close();
  await p.closed;
  assert.equal((await a.next("result")).status, "unknown");
  p = await connect(fixture, "presenter");
  const other = await connect(fixture, "audience");
  other.send(reaction("left"));
  await p.next("event");
  other.ws.close();
  await other.closed;
  p.send({ type: "display", presenter_epoch: "0", display_epoch: "1", paused: false });
  await p.closed;
  p = await connect(fixture, "presenter");
  p.send({ type: "hello", token: fixture.config.presenter_token });
  await p.closed;
  const repeated = await connect(fixture, "audience");
  repeated.send({ type: "hello", token: "A".repeat(43) });
  await repeated.closed;
});

test("fixture CLI creates owner-only TOML without allocating a room and rejects overwrite", {
  timeout: 10000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qp-relay-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "config.toml");
  const child = spawn(
    process.execPath,
    ["scripts/run-relay-fixture.mjs", "--port", "0", "--qp-config", path],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  t.after(() => child.kill());
  await once(child.stdout, "data");
  const config = await readFile(path, "utf8");
  assert.match(config, /transport = "remote"/);
  assert.match(config, /create_token = "[A-Za-z0-9_-]{43}"/);
  assert.equal(config.includes("presenter_token"), false);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.doesNotMatch(config, /127\.0\.0\.1:0["/]/);
  const exit = once(child, "exit");
  child.send("ignored-parent-message");
  child.send("shutdown");
  assert.equal((await exit)[0], 0);
  for (const args of [["--bad"], ["--port", "0", "--qp-config", path]]) {
    const failed = spawn(process.execPath, ["scripts/run-relay-fixture.mjs", ...args], {
      stdio: "ignore",
    });
    assert.equal((await once(failed, "exit"))[0], 1);
  }
});
