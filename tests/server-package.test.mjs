// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { connectRuntime, reaction, receipt } from "./runtime-helpers.mjs";

test("published server installs and serves HTTP/WebSockets without source or build tooling", {
  timeout: 30000,
}, async (t) => {
  const npm = process.env.npm_execpath;
  assert.ok(npm, "Run through npm test or npm run test:coverage");
  const root = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "relay-server-package-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runNpm = (args, cwd) =>
    execFileSync(process.execPath, [npm, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const dependencies = {};
  const sourceLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const locked = Object.fromEntries(
    Object.entries(sourceLock.packages).filter(
      ([path, entry]) => path.startsWith("node_modules/") && !entry.dev && !entry.link,
    ),
  );
  for (const name of [
    "quick-presenter-relay-core",
    "quick-presenter-audience-web",
    "quick-presenter-relay",
  ]) {
    const selection =
      name === "quick-presenter-relay" ? ["--workspaces=false"] : ["--workspace", name];
    const [pack] = JSON.parse(
      runNpm(["pack", ...selection, "--ignore-scripts", "--json", "--pack-destination", dir], root),
    );
    dependencies[name] = `file:./${pack.filename}`;
    const metadataPath =
      name === "quick-presenter-relay"
        ? "package.json"
        : name === "quick-presenter-relay-core"
          ? "packages/room-core/package.json"
          : "packages/audience-web/package.json";
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    locked[`node_modules/${name}`] = {
      version: metadata.version,
      resolved: `file:${pack.filename}`,
      integrity: pack.integrity,
      license: metadata.license,
      ...(metadata.dependencies ? { dependencies: metadata.dependencies } : {}),
      ...(metadata.bin ? { bin: metadata.bin } : {}),
      ...(metadata.engines ? { engines: metadata.engines } : {}),
    };
    if (name === "quick-presenter-relay") {
      for (const entry of pack.files)
        assert.match(
          entry.path,
          /^(package\.json|README\.md|SECURITY\.md|LICENSE|NOTICE|docs\/|dist\/(src\/|protocol\/|scripts\/contracts\.))/,
        );
      for (const path of [
        "dist/src/cli.js",
        "dist/src/runtime.js",
        "dist/scripts/contracts.mjs",
        "dist/protocol/schemas/messages.schema.json",
      ])
        assert.ok(
          pack.files.some((entry) => entry.path === path),
          path,
        );
    }
  }
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies }),
  );
  // npm ci caches tarballs, not necessarily registry packuments. Reuse its exact
  // production resolutions so the independent installation needs no metadata fetch.
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      requires: true,
      packages: { "": { dependencies }, ...locked },
    }),
  );
  runNpm(["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], dir);
  const installed = join(dir, "node_modules/quick-presenter-relay");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  const source = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(manifest.version, source.version);
  assert.equal(manifest.engines.node, source.engines.node);
  assert.equal(manifest.private, false);
  assert.equal(manifest.bin["quick-presenter-relay"], "dist/src/cli.js");
  assert.equal(manifest.dependencies["quick-presenter-relay-core"], manifest.version);
  assert.equal(manifest.dependencies["quick-presenter-audience-web"], manifest.version);
  assert.match(
    readFileSync(join(installed, manifest.bin[manifest.name]), "utf8"),
    /^#!\/usr\/bin\/env node\n/,
  );
  for (const name of ["LICENSE", "NOTICE", "SECURITY.md"])
    assert.equal(readFileSync(join(installed, name), "utf8"), readFileSync(name, "utf8"));
  for (const name of ["typescript", "c8", "@biomejs/biome"])
    assert.equal(existsSync(join(dir, "node_modules", name)), false);
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const token = "A".repeat(43);
  const configPath = join(dir, "server.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      database: join(dir, "rooms.sqlite"),
      storageKey: "01".repeat(32),
      createToken: token,
      publicOrigin: base,
      port,
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [
      resolve(installed, manifest.bin[manifest.name]),
      configPath,
      "--qp-config",
      join(dir, "client.toml"),
    ],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  await Promise.race([
    once(child.stdout, "data"),
    exited.then(() => {
      throw new Error("Installed CLI exited before readiness");
    }),
  ]);
  const response = await fetch(`${base}/api/relay/v1/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ idempotency_key: "installed-server" }),
  });
  assert.equal(response.status, 201);
  const room = await response.json();
  assert.equal((await fetch(room.join_url)).status, 200);
  assert.equal(
    await (await fetch(`${base}/assets/audience.js`)).text(),
    readFileSync(join(dir, "node_modules/quick-presenter-audience-web/assets/audience.js"), "utf8"),
  );
  const p = await connectRuntime(base, room, "presenter");
  const a = await connectRuntime(base, room, "audience");
  t.after(() => {
    p.ws.terminate();
    a.ws.terminate();
  });
  a.send(reaction("installed"));
  p.send(receipt(await p.next("event")));
  assert.equal((await a.next("result")).status, "accepted");
  assert.equal(
    (
      await fetch(`${base}/api/relay/v1/rooms/${room.room_id}/end`, {
        method: "POST",
        headers: { Authorization: `Bearer ${room.presenter_token}` },
      })
    ).status,
    200,
  );
  await Promise.all([p.closed, a.closed]);
  child.send("shutdown");
  assert.equal((await exited)[0], 0);
});
