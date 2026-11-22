// SPDX-License-Identifier: Apache-2.0
import type { Wire } from "quick-presenter-relay-core";
export interface SocketOutput {
  readyState: number;
  bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  terminate(): void;
}
// Return false before queueing a frame that would exceed the operator's buffer budget.
export function sendSocket(
  socket: SocketOutput | undefined,
  message: Wire,
  budget: number,
): boolean {
  if (socket?.readyState !== 1) return true;
  const encoded = JSON.stringify(message);
  if (socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") > budget) return false;
  socket.send(encoded, (error) => {
    if (error) socket.terminate();
  });
  return true;
}
