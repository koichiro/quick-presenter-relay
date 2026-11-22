// SPDX-License-Identifier: Apache-2.0
// A transient self-hosted runtime for qp interoperability, with no pre-created room.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOutput, showConnection } from "./client-config.js";
import { startRelay } from "./runtime.js";
import { waitForShutdown } from "./shutdown.mjs";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let port = 18765;
  if (args[0] === "--port") {
    if (!args[1] || !/^[0-9]+$/.test(args[1])) throw new Error("Invalid fixture port");
    port = Number(args[1]);
    args.splice(0, 2);
  }
  if (port < 0 || port > 65535) throw new Error("Invalid fixture port");
  const output = parseOutput(args);
  const directory = await mkdtemp(join(tmpdir(), "qp-relay-fixture-"));
  const origin = `http://127.0.0.1:${port}`;
  const token = randomBytes(32).toString("base64url");
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    relay = await startRelay({
      database: join(directory, "rooms.sqlite"),
      storageKey: randomBytes(32),
      createToken: token,
      publicOrigin: origin,
      host: "127.0.0.1",
      port,
    });
    await showConnection(relay.origin, token, output);
    await waitForShutdown();
  } finally {
    await relay?.stop();
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const reason =
    typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
      ? code
      : "invalid arguments or configuration";
  // Error messages may contain paths or credentials; expose only a bounded code.
  console.error(
    `Cannot start relay fixture (${reason}). Check arguments, listener and output permissions.`,
  );
  process.exitCode = 1;
});
