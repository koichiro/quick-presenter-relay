// SPDX-License-Identifier: Apache-2.0
// Transient loopback development fixture; not a production relay runtime.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { validate } from "./contracts.mjs";

const version = "1";
const wire = (protocol, type, fields) => ({ protocol, version, type, ...fields });
const transmit = (socket, value) => socket.send(JSON.stringify(value));

export async function startFixture({ authMs = 5000, receiptMs = 3000, cacheMs = 30000 } = {}) {
  const presenterToken = randomBytes(32).toString("base64url");
  const audienceToken = randomBytes(32).toString("base64url");
  const members = new Map();
  const pending = new Map();
  const sockets = new Set();
  let presenter = null;
  let epoch = 0n;
  let display = 0n;
  let revision = 0n;
  let sequence = 0;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url !== "/join/fixture") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(page);
  });
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const snapshot = () => {
    revision++;
    if (presenter)
      transmit(
        presenter,
        wire("qp.presenter", "state", {
          revision: String(revision),
          display_epoch: String(display),
          available: true,
          audience_connections: members.size,
        }),
      );
    for (const socket of members.keys())
      transmit(
        socket,
        wire("qp.audience", "state", {
          revision: String(revision),
          available: presenter !== null,
        }),
      );
  };
  const finish = (id, status) => {
    const offer = pending.get(id);
    clearTimeout(offer.timer);
    pending.delete(id);
    offer.entry.result = wire("qp.audience", "result", { request_id: offer.request, status });
    offer.entry.finished = Date.now();
    if (offer.socket.readyState === WebSocket.OPEN) transmit(offer.socket, offer.entry.result);
  };
  const disconnect = () => {
    presenter = null;
    for (const id of pending.keys()) finish(id, "unknown");
    snapshot();
  };
  websocket.on("connection", (socket, role) => {
    sockets.add(socket);
    let authenticated = false;
    let attachedEpoch;
    const authTimer = setTimeout(() => socket.close(1008), authMs);
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearTimeout(authTimer);
      sockets.delete(socket);
      if (role === "presenter" && socket === presenter) disconnect();
      if (members.delete(socket)) {
        for (const [id, offer] of pending) {
          if (offer.socket === socket) {
            clearTimeout(offer.timer);
            pending.delete(id);
          }
        }
        snapshot();
      }
    });
    socket.on("message", (bytes, binary) => {
      let message;
      try {
        message = JSON.parse(bytes.toString());
      } catch {
        socket.close(1002);
        return;
      }
      if (binary || !validate("messages", message) || message.protocol !== `qp.${role}`) {
        socket.close(1002);
        return;
      }
      if (!authenticated) {
        const expected = role === "presenter" ? presenterToken : audienceToken;
        if (message.type !== "hello" || message.token !== expected) {
          socket.close(1008);
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        if (role === "presenter") {
          if (presenter) {
            presenter.close(1000);
            disconnect();
          }
          presenter = socket;
          attachedEpoch = String(++epoch);
          transmit(
            socket,
            wire("qp.presenter", "presenter_welcome", {
              presenter_epoch: attachedEpoch,
              display_epoch: String(display),
              audience_connections: members.size,
            }),
          );
        } else {
          const id = `c${++sequence}`;
          members.set(socket, { id, requests: new Map() });
          transmit(
            socket,
            wire("qp.audience", "welcome", {
              connection_id: id,
              capabilities: ["reactions", "comments"],
              available: presenter !== null,
              limits: { max_message_bytes: 4096, request_cache_ms: cacheMs },
            }),
          );
        }
        snapshot();
        return;
      }
      if (role === "presenter") {
        if (socket !== presenter || message.presenter_epoch !== attachedEpoch) {
          socket.close(1008);
          return;
        }
        if (message.type === "display") {
          if (BigInt(message.display_epoch) > display) {
            display = BigInt(message.display_epoch);
            snapshot();
          }
        } else if (message.type === "receipt") {
          if (pending.has(message.event_id)) finish(message.event_id, message.status);
        } else socket.close(1002);
        return;
      }
      if (!["reaction", "comment"].includes(message.type)) {
        socket.close(1002);
        return;
      }
      const member = members.get(socket);
      for (const [id, entry] of member.requests) {
        if (entry.finished !== null && Date.now() - entry.finished >= cacheMs)
          member.requests.delete(id);
      }
      const payload =
        message.type === "reaction"
          ? { type: "reaction", kind: message.kind }
          : { type: "comment", body: message.body, handle: message.handle };
      const fingerprint = JSON.stringify(payload);
      const previous = member.requests.get(message.request_id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) socket.close(1002);
        else if (previous.result) transmit(socket, previous.result);
        return;
      }
      if (member.requests.size >= 256) {
        socket.close(1013);
        return;
      }
      const entry = { fingerprint, result: null, finished: null };
      member.requests.set(message.request_id, entry);
      const id = `e${++sequence}`;
      const timer = setTimeout(() => finish(id, "unknown"), receiptMs);
      pending.set(id, { socket, request: message.request_id, entry, timer });
      if (!presenter) {
        finish(id, "unavailable");
        return;
      }
      if (pending.size > 128) {
        finish(id, "busy");
        return;
      }
      transmit(
        presenter,
        wire("qp.presenter", "event", {
          event_id: id,
          connection_id: member.id,
          request_id: message.request_id,
          presenter_epoch: String(epoch),
          display_epoch: String(display),
          offer_ttl_ms: 2000,
          payload,
        }),
      );
    });
  });
  server.on("upgrade", (request, socket, head) => {
    const role = { "/ws/presenter": "presenter", "/ws/audience": "audience" }[request.url];
    if (!role) {
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (ws) => websocket.emit("connection", ws, role));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let stopped = false;
  return {
    config: {
      room_id: "fixture",
      code: "FIXTURE",
      join_url: `${origin}/join/fixture#k=${audienceToken}`,
      presenter_url: `${origin.replace("http:", "ws:")}/ws/presenter`,
      presenter_token: presenterToken,
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const offer of pending.values()) clearTimeout(offer.timer);
      pending.clear();
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => websocket.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay Test</title>
<style>main{max-width:32rem;padding:2rem;margin:auto;font-family:sans-serif}button,textarea,input{padding:.75rem;font-size:1rem}textarea{display:block;width:90%;margin:1rem 0}</style></head>
<body><main><h1>Audience Live Test Relay</h1><output id="feedback">Waiting for connection</output>
<section aria-label="Reactions"><button data-kind="thumbs_up">👍</button><button data-kind="heart">❤️</button><button data-kind="applause">👏</button><button data-kind="laugh">😂</button><button data-kind="question">❓</button></section>
<form><label>Name <input name="nickname" maxlength="32"></label><textarea name="message" maxlength="200" aria-label="Comment"></textarea><button type="submit">Send</button></form></main>
<script>
(() => {
  const credential = new URLSearchParams(window.location.hash.substring(1)).get("k");
  window.history.replaceState({}, "", window.location.pathname);
  const channel = new WebSocket(new URL("/ws/audience", window.location.href).href.replace("http:", "ws:"));
  const feedback = document.querySelector("output");
  let sequence = 0;
  function publish(data) {
    if (channel.readyState !== WebSocket.OPEN) return;
    channel.send(JSON.stringify(Object.assign({protocol:"qp.audience", version:"1"}, data)));
  }
  channel.addEventListener("open", () => publish({type:"hello", token:credential}));
  channel.addEventListener("message", ({data}) => {
    const reply = JSON.parse(data);
    feedback.textContent = reply.status || (reply.available ? "Presenter connected" : "Presenter unavailable");
  });
  channel.addEventListener("close", () => {feedback.textContent="Connection closed. Reopen your original join link.";});
  document.querySelectorAll("[data-kind]").forEach(element => element.addEventListener("click", () => {
    publish({type:"reaction", request_id:String(++sequence), kind:element.dataset.kind});
  }));
  document.querySelector("form").addEventListener("submit", event => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    publish({type:"comment", request_id:String(++sequence), body:fields.get("message"), handle:fields.get("nickname")});
  });
})();
</script></body></html>`;
