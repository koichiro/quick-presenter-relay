// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.env.npm_execpath;
const run = (entry, args, cwd) =>
  execFileSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

test("packed core is standalone, typed, licensed and isolated from runtime internals", () => {
  assert.ok(npm, "Run through npm test or npm run test:coverage");
  const temp = mkdtempSync(join(tmpdir(), "qp-core-package-"));
  try {
    const [pack] = JSON.parse(
      run(
        npm,
        [
          "pack",
          "--workspace",
          "quick-presenter-relay-core",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          temp,
        ],
        root,
      ),
    );
    const paths = pack.files.map((file) => file.path);
    for (const name of [
      "LICENSE",
      "NOTICE",
      "README.md",
      "dist/index.js",
      "dist/index.d.ts",
      "protocol/schemas/messages.schema.json",
      "protocol/fixtures/wire.json",
    ])
      assert.ok(paths.includes(name), name);
    for (const path of paths)
      assert.match(
        path,
        /^(LICENSE|NOTICE|README\.md|package\.json|dist\/(index|room|extensions|json|text)\.|protocol\/)/,
      );
    writeFileSync(
      join(temp, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { "quick-presenter-relay-core": `file:./${pack.filename}` },
      }),
    );
    run(npm, ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], temp);
    const installed = join(temp, "node_modules", "quick-presenter-relay-core");
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    assert.equal(manifest.license, "Apache-2.0");
    assert.equal(manifest.private, false);
    const source = JSON.parse(readFileSync("packages/room-core/package.json", "utf8"));
    assert.equal(manifest.version, source.version);
    assert.equal(manifest.version, JSON.parse(readFileSync("package.json", "utf8")).version);
    assert.equal(
      manifest.repository.url,
      "git+https://github.com/koichiro/quick-presenter-relay.git",
    );
    assert.equal(manifest.publishConfig.access, "public");
    assert.equal(manifest.dependencies, undefined);
    assert.equal(
      readFileSync(join(installed, "LICENSE"), "utf8"),
      readFileSync(join(root, "LICENSE"), "utf8"),
    );
    assert.equal(
      readFileSync(join(installed, "NOTICE"), "utf8"),
      readFileSync(join(root, "NOTICE"), "utf8"),
    );
    for (const path of paths.filter((path) => /\.(js|mjs|d\.ts|d\.mts)$/.test(path))) {
      const source = readFileSync(join(installed, path), "utf8");
      for (const match of source.matchAll(/(?:from\s+|import\s*\(|import\s+)["']([^"']+)["']/g))
        assert.match(match[1], /^\.\//, `Platform/external import in ${path}`);
      assert.doesNotMatch(source, /\b(?:Buffer|process)\s*[.(]|\brequire\s*\(/);
    }
    writeFileSync(
      join(temp, "consumer.ts"),
      `import { Room, AdmissionPolicies, strictJSON, normalizeBody, type Ports, type Metadata, type AdmissionPolicy } from "quick-presenter-relay-core";
const metadata: Metadata = { id: "synthetic", expiresAt: 1000, state: "Created", presenterEpoch: "0", displayEpoch: "0", revision: "0", graceUntil: null };
const sent: unknown[] = [];
const ports: Ports = { now: () => 0, id: () => "synthetic-event", save: () => {}, send: (_, message) => { sent.push(message); }, close: () => {} };
const room = new Room(metadata, ports);
if (!room.attach("presenter", "presenter") || !room.attach("audience", "audience") || room.audienceCount !== 1 || sent.length === 0) throw new Error("Broken public Room API");
const policy: AdmissionPolicy = { id: "synthetic", api_version: "1-draft.1" };
new AdmissionPolicies([policy]).close();
if (normalizeBody(" a\\u3000b ") !== "a b" || strictJSON('{"ok":true}') === null) throw new Error("Broken helpers");
// @ts-expect-error String normalization must reject non-string input.
if (false) normalizeBody(123);
`,
    );
    writeFileSync(
      join(temp, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          strict: true,
          types: [],
          lib: ["ES2022", "DOM"],
          outDir: "compiled",
        },
        include: ["consumer.ts"],
      }),
    );
    run(join(root, "node_modules", "typescript", "bin", "tsc"), ["-p", "tsconfig.json"], temp);
    run(join(temp, "compiled", "consumer.js"), [], temp);
    writeFileSync(
      join(temp, "boundary.mjs"),
      `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const schema = JSON.parse(readFileSync(new URL(import.meta.resolve("quick-presenter-relay-core/protocol/schemas/messages.schema.json")), "utf8"));
assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
await assert.rejects(import("quick-presenter-relay-core/dist/room.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
await assert.rejects(import("quick-presenter-relay-core/src/room.ts"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
`,
    );
    run(join(temp, "boundary.mjs"), [], temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
