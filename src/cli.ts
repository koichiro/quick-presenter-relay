#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, statSync } from "node:fs";
import { strictJSON } from "quick-presenter-relay-core";
import { parseOutput, showConnection } from "./client-config.js";
import { loadPolicies } from "./plugin-loader.js";
import { type Options, startRelay } from "./runtime.js";
import { waitForShutdown } from "./shutdown.mjs";

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path || path.startsWith("-"))
    throw new Error(
      "Usage: quick-presenter-relay <private-config-path> [--qp-config <new-file-path>]",
    );
  const output = parseOutput(process.argv.slice(3));
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0)
    throw new Error("Configuration permissions must be 0600");
  const input = strictJSON(readFileSync(path, "utf8")) as Omit<Options, "storageKey"> & {
    storageKey: string;
    plugins?: unknown;
  };
  const allowed = new Set([
    "database",
    "storageKey",
    "createToken",
    "publicOrigin",
    "host",
    "port",
    "roomMs",
    "plugins",
  ]);
  if (
    !input ||
    Object.keys(input).some((key) => !allowed.has(key)) ||
    typeof input.database !== "string" ||
    typeof input.storageKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.storageKey)
  )
    throw new Error("Invalid configuration");
  const extensions = await loadPolicies(path, input.plugins);
  const relay = await startRelay({
    ...input,
    extensions,
    storageKey: Buffer.from(input.storageKey, "hex"),
  });
  try {
    await showConnection(relay.origin, input.createToken, output);
    await waitForShutdown();
  } finally {
    await relay.stop();
  }
}
main().catch(() => {
  console.error("Cannot run relay. Check configuration, permissions, storage and listener.");
  process.exitCode = 1;
});
