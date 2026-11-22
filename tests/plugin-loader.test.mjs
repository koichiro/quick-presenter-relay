// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPolicies } from "../dist/src/plugin-loader.js";

test("startup loader imports only operator-selected local modules and rejects invalid exports", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-extension-loader-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "server.json");
  const module = join(dir, "synthetic.mjs");
  await writeFile(
    module,
    `export default { id: 'synthetic', api_version: '1-draft.1', beforeRoomCreate: () => ({ api_version: '1-draft.1', outcome: 'allow' }) };`,
  );
  for (const selected of [undefined, [], ["./synthetic.mjs"], [module]]) {
    const h = await loadPolicies(path, selected);
    assert.equal(
      (
        await h.check("beforeRoomCreate", {
          operationId: "op",
          role: "operator",
          idempotencyKey: "key",
        })
      ).outcome,
      "allow",
    );
    h.close();
  }
  for (const invalid of [
    "./synthetic.mjs",
    Array(17).fill(module),
    [42],
    ["synthetic.ts"],
    ["https://example.test/plugin.mjs"],
    ["file:///tmp/plugin.mjs"],
    ["data:plugin.mjs"],
    ["./missing.mjs"],
    [module, module],
  ])
    await assert.rejects(loadPolicies(path, invalid));
  await writeFile(
    join(dir, "invalid.mjs"),
    "export default { id: 'synthetic', api_version: '2' };",
  );
  await assert.rejects(loadPolicies(path, ["./invalid.mjs"]));
  const config = {
    database: join(dir, "room.sqlite"),
    storageKey: "01".repeat(32),
    createToken: "A".repeat(43),
    publicOrigin: "http://127.0.0.1:19231",
    port: 0,
    plugins: ["./synthetic.mjs"],
  };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, ["dist/src/cli.js", path], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => child.kill());
  await once(child.stdout, "data");
  const exited = once(child, "exit");
  child.send("shutdown");
  assert.equal((await exited)[0], 0);
  config.plugins = ["./invalid.mjs"];
  await writeFile(path, JSON.stringify(config));
  const bad = spawn(process.execPath, ["dist/src/cli.js", path], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  bad.stderr.on("data", (data) => {
    errors += data;
  });
  assert.equal((await once(bad, "exit"))[0], 1);
  assert.equal(errors.includes(config.createToken), false);
});
