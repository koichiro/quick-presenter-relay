// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

test("shutdown signal completes without IPC and removes both signal listeners", {
  timeout: 10000,
}, async () => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { waitForShutdown } from './dist/src/shutdown.mjs';
    const stopped = waitForShutdown();
    process.emit('SIGTERM');
    await stopped;
    if (process.listenerCount('SIGTERM') || process.listenerCount('SIGINT')) process.exitCode = 1;
  `,
    ],
    { stdio: "ignore" },
  );
  assert.equal((await once(child, "exit"))[0], 0);
});
