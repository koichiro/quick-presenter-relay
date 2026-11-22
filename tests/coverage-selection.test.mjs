// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("coverage dependency overrides still fail on unexecuted source per file", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-coverage-gate-")));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/used.mjs"), "console.log('Synthetic coverage fixture');\n");
    writeFileSync(join(dir, "src/unexecuted.mjs"), "export function value() { return 1; }\n");
    const run = () =>
      spawnSync(
        process.execPath,
        [
          resolve("node_modules/c8/bin/c8.js"),
          "--all",
          "--per-file",
          "--check-coverage",
          "--statements=80",
          "--branches=80",
          "--functions=80",
          "--lines=80",
          "--include=src/**/*.mjs",
          "--reporter=json-summary",
          process.execPath,
          "src/used.mjs",
        ],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 30000,
          // Isolate nested c8 from the enclosing CI coverage directory.
          env: { ...process.env, NODE_V8_COVERAGE: join(dir, "coverage/tmp") },
        },
      );
    const failed = run();
    assert.equal(failed.status, 1, failed.stderr);
    const report = JSON.parse(readFileSync(join(dir, "coverage/coverage-summary.json"), "utf8"));
    assert.equal(report[join(dir, "src/unexecuted.mjs")].lines.pct, 0);
    writeFileSync(
      join(dir, "src/used.mjs"),
      "import { value } from './unexecuted.mjs'; value();\n",
    );
    const passed = run();
    assert.equal(passed.status, 0, passed.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
