// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const run = (entry, args, cwd) =>
  execFileSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

test("packed audience UI is standalone, licensed and serves the tested browser implementation", () => {
  assert.ok(process.env.npm_execpath, "Run through npm test or npm run test:coverage");
  const directory = mkdtempSync(join(tmpdir(), "qp-web-package-"));
  try {
    const [pack] = JSON.parse(
      run(
        process.env.npm_execpath,
        [
          "pack",
          "--workspace",
          "quick-presenter-audience-web",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          directory,
        ],
        process.cwd(),
      ),
    );
    assert.deepEqual(pack.files.map((file) => file.path).sort(), [
      "LICENSE",
      "NOTICE",
      "README.md",
      "assets/audience.js",
      "assets/index.html",
      "package.json",
    ]);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { "quick-presenter-audience-web": `file:./${pack.filename}` },
      }),
    );
    run(
      process.env.npm_execpath,
      ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
      directory,
    );
    const installed = join(directory, "node_modules/quick-presenter-audience-web");
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    assert.equal(manifest.license, "Apache-2.0");
    assert.equal(manifest.private, false);
    const source = JSON.parse(readFileSync("packages/audience-web/package.json", "utf8"));
    assert.equal(manifest.version, source.version);
    assert.equal(manifest.version, JSON.parse(readFileSync("package.json", "utf8")).version);
    assert.equal(
      manifest.repository.url,
      "git+https://github.com/koichiro/quick-presenter-relay.git",
    );
    assert.equal(manifest.publishConfig.access, "public");
    assert.equal(manifest.dependencies, undefined);
    for (const name of ["LICENSE", "NOTICE"])
      assert.equal(readFileSync(join(installed, name), "utf8"), readFileSync(name, "utf8"));
    for (const name of ["index.html", "audience.js"])
      assert.equal(
        readFileSync(join(installed, "assets", name), "utf8"),
        readFileSync(join("packages/audience-web/assets", name), "utf8"),
      );
    writeFileSync(
      join(directory, "consumer.mjs"),
      `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mountAudience } from "quick-presenter-audience-web";
assert.equal(typeof mountAudience, "function");
assert(readFileSync(new URL(import.meta.resolve("quick-presenter-audience-web/index.html")), "utf8").includes('src="/assets/audience.js"'));
for (const name of ["audience.js", "LICENSE", "NOTICE"]) assert(readFileSync(new URL(import.meta.resolve("quick-presenter-audience-web/" + name))).length > 0);
await assert.rejects(import("quick-presenter-audience-web/assets/audience.js"), {code: "ERR_PACKAGE_PATH_NOT_EXPORTED"});
`,
    );
    run(join(directory, "consumer.mjs"), [], directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
