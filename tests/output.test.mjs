// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { sendSocket } from "../dist/src/output.js";

test("output budgets include the pending UTF-8 frame and asynchronous write failure", () => {
  const writes = [];
  let terminated = 0;
  let callback;
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(data, done) {
      writes.push(data);
      callback = done;
    },
    terminate() {
      terminated++;
    },
  };
  assert.equal(sendSocket(undefined, {}, 1), true);
  socket.readyState = 2;
  assert.equal(sendSocket(socket, {}, 1), true);
  socket.readyState = 1;
  const frame = { body: "世界" };
  const bytes = Buffer.byteLength(JSON.stringify(frame));
  assert.equal(sendSocket(socket, frame, bytes - 1), false);
  assert.equal(writes.length, 0);
  assert.equal(sendSocket(socket, frame, bytes), true);
  callback();
  assert.equal(terminated, 0);
  socket.bufferedAmount = 1;
  assert.equal(sendSocket(socket, frame, bytes), false);
  assert.equal(sendSocket(socket, frame, bytes + 1), true);
  callback(new Error("Synthetic write failure"));
  assert.equal(terminated, 1);
});
