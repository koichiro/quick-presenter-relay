// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseOutput, qpConfig, showConnection } from "../dist/src/client-config.js";

const token = "A".repeat(43);

test("connection output validates origins, credentials and option grammar", () => {
  assert.equal(parseOutput([]), undefined);
  assert.equal(parseOutput(["--qp-config", "a.toml"]), "a.toml");
  for (const args of [
    ["--qp-config"],
    ["--qp-config", ""],
    ["--qp-config", "--bad"],
    ["other", "a"],
    ["--qp-config", "a", "extra"],
  ])
    assert.throws(() => parseOutput(args));
  for (const origin of ["https://relay.example", "http://127.0.0.1:1234", "http://[::1]:1234"])
    assert.match(qpConfig(origin, token), /transport = "remote"/);
  for (const origin of [
    "bad",
    "https://u:p@relay.example",
    "https://relay.example/path",
    "https://relay.example?key=x",
    "http://relay.example",
    "ftp://relay.example",
  ])
    assert.throws(() => qpConfig(origin, token));
  assert.throws(() => qpConfig("https://relay.example", "invalid"));
});

test("file export is owner-only, non-overwriting and excludes server/room secrets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-qp-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "config.toml");
  await showConnection("https://relay.example", token, path);
  assert.equal(await readFile(path, "utf8"), qpConfig("https://relay.example", token));
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o077, 0);
  for (const secret of ["storageKey", "database", "presenter_token", "join_url"])
    assert.equal((await readFile(path, "utf8")).includes(secret), false);
  await assert.rejects(showConnection("https://relay.example", token, path));
  assert.equal(await readFile(path, "utf8"), qpConfig("https://relay.example", token));
});

test("server CLI exports TOML and hides token from stdout in file mode", {
  timeout: 10000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-export-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "server.json");
  const output = join(dir, "qp.toml");
  await writeFile(
    config,
    JSON.stringify({
      database: join(dir, "rooms.sqlite"),
      storageKey: "01".repeat(32),
      createToken: token,
      publicOrigin: "http://127.0.0.1:19231",
      port: 0,
    }),
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, ["dist/src/cli.js", config, "--qp-config", output], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => child.kill());
  const [text] = await once(child.stdout, "data");
  assert.equal(text.includes(token), false);
  assert.equal(await readFile(output, "utf8"), qpConfig("http://127.0.0.1:19231", token));
  const exited = once(child, "exit");
  child.send("shutdown");
  assert.equal((await exited)[0], 0);
  const failed = spawn(process.execPath, ["dist/src/cli.js", config, "--qp-config", output], {
    stdio: "ignore",
  });
  assert.equal((await once(failed, "exit"))[0], 1);
});

test("fixture console mode serves room creation and cleans up; invalid arguments fail", {
  timeout: 10000,
}, async (t) => {
  const child = spawn(process.execPath, ["scripts/run-relay-fixture.mjs", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => child.kill());
  const [text] = await once(child.stdout, "data");
  const origin = text.toString().match(/Relay URL: (\S+)/)[1];
  const credential = text.toString().match(/Creation token: ([A-Za-z0-9_-]{43})/)[1];
  const response = await fetch(`${origin}/api/relay/v1/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotency_key: "test-room" }),
  });
  assert.equal(response.status, 201);
  const room = await response.json();
  assert.ok(room.presenter_token);
  assert.equal(new URL(room.join_url).origin, origin);
  assert.equal(new URL(room.presenter_url).origin, origin.replace("http:", "ws:"));
  const exited = once(child, "exit");
  child.send("shutdown");
  assert.equal((await exited)[0], 0);
  for (const args of [
    ["--port"],
    ["--port", "bad"],
    ["--port", "-1"],
    ["--port", "65536"],
    ["--qp-config"],
    ["--port", "0", "--qp-config", "/missing/output/config.toml"],
  ]) {
    const failed = spawn(process.execPath, ["scripts/run-relay-fixture.mjs", ...args], {
      stdio: "ignore",
    });
    assert.equal((await once(failed, "exit"))[0], 1);
  }
});

test("fixture startup errors distinguish listener and output failures without exposing secrets", {
  timeout: 10000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-error-cli-"));
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => occupied.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const path = join(dir, "private-config.toml");
  await writeFile(path, "existing-file-must-stay");
  for (const [args, reason] of [
    [["--port", String(occupied.address().port)], "EADDRINUSE"],
    [["--port", "0", "--qp-config", path], "EEXIST"],
    [["--port", "invalid"], "invalid arguments or configuration"],
  ]) {
    const child = spawn(process.execPath, ["scripts/run-relay-fixture.mjs", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => child.kill());
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    assert.equal((await once(child, "exit"))[0], 1);
    assert.ok(stderr.includes(`Cannot start relay fixture (${reason})`));
    assert.equal(stderr.includes(path), false);
    assert.doesNotMatch(stderr + stdout, /Creation token:|create_token|[A-Za-z0-9_-]{43}/);
    assert.equal(stdout, "");
  }
  assert.equal(await readFile(path, "utf8"), "existing-file-must-stay");
});
