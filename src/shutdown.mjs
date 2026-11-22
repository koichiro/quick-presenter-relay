// SPDX-License-Identifier: Apache-2.0
// IPC is available only to a trusted parent that launched this process with a channel.
export function waitForShutdown() {
  return new Promise((resolve) => {
    const finish = () => {
      process.removeListener("SIGINT", finish);
      process.removeListener("SIGTERM", finish);
      process.removeListener("message", onMessage);
      if (process.connected) process.disconnect();
      resolve();
    };
    const onMessage = (message) => {
      if (message === "shutdown") finish();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    if (process.connected) process.on("message", onMessage);
  });
}
