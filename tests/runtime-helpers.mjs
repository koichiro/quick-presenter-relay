// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { validate } from "../scripts/contracts.mjs";
export async function connectRuntime(base, config, role, auth = true, options = {}) {
  const endpoint = `${base.replace(/^http/, "ws")}/ws/${role}/${config.room_id}`;
  const ws = new WebSocket(endpoint, options);
  const messages = [];
  const waiters = [];
  const closed = new Promise((resolve) =>
    ws.once("close", (code) => {
      resolve(code);
      for (const wake of waiters.splice(0)) wake();
    }),
  );
  ws.on("error", () => {});
  ws.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    assert.ok(validate("messages", message));
    messages.push(message);
    for (const wake of waiters.splice(0)) wake();
  });
  await once(ws, "open");
  const client = {
    ws,
    closed,
    messages,
    send(fields) {
      ws.send(JSON.stringify({ protocol: `qp.${role}`, version: "1", ...fields }));
    },
    async next(type) {
      for (;;) {
        const index = messages.findIndex((m) => m.type === type);
        if (index !== -1) return messages.splice(index, 1)[0];
        if (ws.readyState === WebSocket.CLOSED) throw new Error("Socket closed before message");
        await new Promise((resolve) => waiters.push(resolve));
      }
    },
  };
  if (auth) {
    client.send({
      type: "hello",
      token: role === "presenter" ? config.presenter_token : new URL(config.join_url).hash.slice(3),
    });
    client.welcome = await client.next(role === "presenter" ? "presenter_welcome" : "welcome");
  }
  return client;
}
export const reaction = (id) => ({ type: "reaction", request_id: id, kind: "heart" });
export const receipt = (event) => ({
  type: "receipt",
  presenter_epoch: event.presenter_epoch,
  event_id: event.event_id,
  status: "accepted",
});
