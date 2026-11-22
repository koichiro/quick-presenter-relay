// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { validate } from "../scripts/contracts.mjs";
import { startFixture } from "../scripts/relay-fixture.mjs";

export async function connect(fixture, role, authenticate = true) {
  const origin = new URL(fixture.config.presenter_url).origin;
  const ws = new WebSocket(`${origin}/ws/${role}`);
  const messages = [];
  const waiters = [];
  const closed = new Promise((resolve) => ws.once("close", resolve));
  ws.on("error", () => {});
  ws.on("message", (bytes) => {
    const value = JSON.parse(bytes.toString());
    assert.ok(validate("messages", value), JSON.stringify(value));
    messages.push(value);
    for (const waiter of waiters.splice(0)) waiter();
  });
  await once(ws, "open");
  const client = {
    ws,
    closed,
    send(fields) {
      ws.send(JSON.stringify({ protocol: `qp.${role}`, version: "1", ...fields }));
    },
    async next(type) {
      for (;;) {
        const index = messages.findIndex((m) => m.type === type);
        if (index !== -1) return messages.splice(index, 1)[0];
        await new Promise((resolve) => waiters.push(resolve));
      }
    },
  };
  if (authenticate) {
    const token =
      role === "presenter"
        ? fixture.config.presenter_token
        : new URLSearchParams(new URL(fixture.config.join_url).hash.slice(1)).get("k");
    client.send({ type: "hello", token });
    client.welcome = await client.next(role === "presenter" ? "presenter_welcome" : "welcome");
  }
  return client;
}
export const reaction = (request_id, kind = "heart") => ({ type: "reaction", request_id, kind });
export const receipt = (event, status = "accepted") => ({
  type: "receipt",
  presenter_epoch: event.presenter_epoch,
  event_id: event.event_id,
  status,
});

export async function fixtureFor(t, options) {
  const fixture = await startFixture(options);
  t.after(() => fixture.stop());
  return fixture;
}
