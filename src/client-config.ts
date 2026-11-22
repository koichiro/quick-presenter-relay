// SPDX-License-Identifier: Apache-2.0
import { writeFile } from "node:fs/promises";

export function parseOutput(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--qp-config" || !args[1] || args[1].startsWith("-"))
    throw new Error("Expected --qp-config <new-file-path>");
  return args[1];
}

export function qpConfig(origin: string, token: string): string {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))
    ) ||
    !/^[A-Za-z0-9_-]{43}$/.test(token)
  )
    throw new Error("Invalid client configuration");
  return `[audience]\ntransport = "remote"\nrelay = ${JSON.stringify(origin)}\ncreate_token = ${JSON.stringify(token)}\n`;
}

export async function showConnection(origin: string, token: string, path?: string): Promise<void> {
  const text = qpConfig(origin, token);
  if (path !== undefined) {
    await writeFile(path, text, { flag: "wx", mode: 0o600 });
    console.log(
      `Relay URL: ${origin}\nqp TOML configuration written. Creation token is in the file.`,
    );
  } else {
    console.log(`Relay URL: ${origin}\nCreation token: ${token}\n\n${text}`);
  }
}
