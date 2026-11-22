// SPDX-License-Identifier: Apache-2.0
import { startRelay } from "../../dist/src/runtime.js";

const runtime = await startRelay({
  database: process.argv[2],
  storageKey: Buffer.alloc(32, 1),
  createToken: "A".repeat(43),
  publicOrigin: "https://relay.example",
  heartbeatMs: 20,
});
process.send({ port: runtime.port });
process.on("message", async (message) => {
  if (message === "shutdown") {
    await runtime.stop();
    process.disconnect();
  }
});
