// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  type Admission,
  AdmissionPolicies,
  type Input,
  type Role,
  Room,
  strictJSON,
  type Wire,
} from "quick-presenter-relay-core";
import { WebSocket, WebSocketServer } from "ws";
import { validate } from "../scripts/contracts.mjs";
import { sendSocket } from "./output.js";
import { Storage, type StoredRoom } from "./storage.js";
export interface Options {
  extensions?: AdmissionPolicies;
  now?: () => number;
  heartbeatMs?: number;
  database: string;
  storageKey: Buffer;
  createToken: string;
  publicOrigin: string;
  host?: string;
  port?: number;
  roomMs?: number;
  authMs?: number;
  receiptMs?: number;
  graceMs?: number;
  maxRooms?: number;
  maxUnauthenticated?: number;
  maxBufferedBytes?: number;
  closeMs?: number;
}
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const matches = (value: string, expected: string): boolean =>
  timingSafeEqual(Buffer.from(digest(value), "hex"), Buffer.from(expected, "hex"));
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const counterPattern = /^(0|[1-9][0-9]{0,19})$/;
function checkStored(record: StoredRoom): void {
  const m = record.metadata;
  if (
    !idPattern.test(m.id) ||
    !Number.isSafeInteger(m.expiresAt) ||
    !["Created", "Active", "PresenterDisconnected", "Ended", "Expired"].includes(m.state) ||
    ![m.presenterEpoch, m.displayEpoch, m.revision].every((v) => counterPattern.test(v)) ||
    !(m.graceUntil === null || Number.isSafeInteger(m.graceUntil)) ||
    ![record.audienceHash, record.presenterHash].every((v) => /^[a-f0-9]{64}$/.test(v))
  )
    throw new Error("Invalid stored room");
}
interface Hosted {
  room: Room;
  record: StoredRoom;
  failed: boolean;
}
interface Connection {
  socket: WebSocket;
  hosted: Hosted;
  role: Role;
  authenticated: boolean;
  authorizing?: AbortController;
  opened: number;
  received: number;
  closingAt?: number;
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4096) throw new Error("Invalid body");
    chunks.push(Buffer.from(chunk));
  }
  return strictJSON(Buffer.concat(chunks).toString("utf8"));
}
function respond(response: ServerResponse, status: number, data: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

export async function startRelay(options: Options) {
  const now = options.now ?? Date.now;
  const policies = options.extensions ?? new AdmissionPolicies();
  const origin = new URL(options.publicOrigin);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
  if (
    origin.origin !== options.publicOrigin ||
    origin.username ||
    origin.password ||
    !(origin.protocol === "https:" || (loopback && origin.protocol === "http:")) ||
    !tokenPattern.test(options.createToken)
  )
    throw new Error("Invalid relay configuration");
  for (const value of [
    options.heartbeatMs,
    options.closeMs,
    options.roomMs,
    options.authMs,
    options.receiptMs,
    options.graceMs,
    options.maxRooms,
    options.maxUnauthenticated,
    options.maxBufferedBytes,
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new Error("Invalid runtime limit");
  }
  const storage = new Storage(options.database, options.storageKey);
  const rooms = new Map<string, Hosted>();
  const connections = new Map<string, Connection>();
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
  });
  const page = readFileSync(
    new URL(import.meta.resolve("quick-presenter-audience-web/index.html")),
  );
  const script = readFileSync(
    new URL(import.meta.resolve("quick-presenter-audience-web/audience.js")),
  );
  const createHash = digest(options.createToken);
  const close = (id: string, code: number) => connections.get(id)?.socket.close(code);
  const send = (id: string, message: Wire) => {
    if (!sendSocket(connections.get(id)?.socket, message, options.maxBufferedBytes ?? 65536))
      close(id, 1013);
  };
  const host = (record: StoredRoom): Hosted => {
    checkStored(record);
    let lastState = record.metadata.state;
    const hosted: Hosted = {
      record,
      failed: false,
      room: new Room(
        record.metadata,
        {
          now,
          id: randomUUID,
          send,
          close,
          connected: (id) => connections.get(id)?.socket.readyState === WebSocket.OPEN,
          save: (metadata) => {
            storage.save({ ...record, metadata });
            if (
              lastState !== "Ended" &&
              lastState !== "Expired" &&
              (metadata.state === "Ended" || metadata.state === "Expired")
            ) {
              for (const c of connections.values())
                if (c.hosted.record.metadata.id === metadata.id && !c.authenticated) {
                  c.authorizing?.abort();
                  c.socket.close(1000);
                }
              policies.notify("onRoomEnd", {
                operationId: randomUUID(),
                roomId: metadata.id,
                state: metadata.state,
              });
            }
            lastState = metadata.state;
          },
          admission: {
            enabled: () => policies.has("beforeEventForward"),
            revision: () => policies.revision,
            evaluate: (context, signal) => policies.check("beforeEventForward", context, signal),
            commit: (action) => {
              guard(hosted, action);
            },
          },
        },
        {
          ...(options.receiptMs === undefined ? {} : { receiptMs: options.receiptMs }),
          ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
        },
      ),
    };
    rooms.set(record.metadata.id, hosted);
    return hosted;
  };
  try {
    storage.prune(now());
    for (const record of storage.rooms()) host(record);
  } catch (error) {
    storage.close();
    throw error;
  }
  const guard = (hosted: Hosted, action: () => void): boolean => {
    if (hosted.failed) return false;
    try {
      action();
      return true;
    } catch {
      hosted.failed = true;
      hosted.room.dispose();
      for (const connection of connections.values())
        if (connection.hosted === hosted) connection.socket.terminate();
      return false;
    }
  };
  let storageFailed = false;
  let shuttingDown = false;
  const creating = new Map<string, { revision: string; promise: Promise<Admission> }>();
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    try {
      if (storageFailed || shuttingDown) {
        respond(response, 503, { error: "unavailable" });
        return;
      }
      const path = request.url ?? "";
      const join = /^\/join\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (request.method === "GET" && join && rooms.has(join[1])) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
        return;
      }
      if (request.method === "GET" && path === "/assets/audience.js") {
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(script);
        return;
      }
      if (request.method !== "POST") {
        respond(response, 404, { error: "not_found" });
        return;
      }
      if (request.headers.origin && request.headers.origin !== origin.origin) {
        respond(response, 403, { error: "origin_rejected" });
        return;
      }
      const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (path === "/api/relay/v1/rooms") {
        if (!bearer || !matches(bearer, createHash)) {
          respond(response, 401, { error: "unauthorized" });
          return;
        }
        let input: unknown;
        try {
          input = await body(request);
        } catch {
          respond(response, 400, { error: "invalid_request" });
          return;
        }
        if (!validate("create-request", input)) {
          respond(response, 400, { error: "invalid_request" });
          return;
        }
        const key = digest(
          `${createHash}:${(input as { idempotency_key: string }).idempotency_key}`,
        );
        let previous = storage.cached(key, now());
        if (previous) {
          const existing = rooms.get(previous.room_id);
          if (existing && !guard(existing, () => existing.room.tick())) {
            respond(response, 503, { error: "unavailable" });
            return;
          }
          if (!existing || existing.room.terminal) {
            respond(response, 410, { error: "room_ended" });
            return;
          }
          respond(response, 200, previous);
          return;
        }
        if (policies.has("beforeRoomCreate")) {
          let check = creating.get(key);
          if (!check) {
            const promise = policies.check("beforeRoomCreate", {
              operationId: randomUUID(),
              role: "operator",
              idempotencyKey: (input as { idempotency_key: string }).idempotency_key,
            });
            check = { revision: policies.revision, promise };
            creating.set(key, check);
            void promise.then(() => creating.delete(key));
          }
          let verdict = await check.promise;
          if (check.revision !== policies.revision) verdict = { outcome: "policy_unavailable" };
          if (response.destroyed || shuttingDown) return;
          if (verdict.outcome !== "allow") {
            respond(response, verdict.outcome === "deny" ? 403 : 503, {
              error: verdict.outcome === "deny" ? "denied" : "policy_unavailable",
              ...(verdict.outcome === "deny" ? { reason: verdict.reason } : {}),
            });
            return;
          }
          if (storageFailed) {
            respond(response, 503, { error: "unavailable" });
            return;
          }
          // An identical concurrent creation may have committed while the hook awaited.
          previous = storage.cached(key, now());
          if (previous) {
            const existing = rooms.get(previous.room_id);
            if (!existing || existing.failed) respond(response, 503, { error: "unavailable" });
            else if (!guard(existing, () => existing.room.tick()))
              respond(response, 503, { error: "unavailable" });
            else if (existing.room.terminal) respond(response, 410, { error: "room_ended" });
            else respond(response, 200, previous);
            return;
          }
        }
        if (rooms.size >= (options.maxRooms ?? 10000)) {
          respond(response, 503, { error: "capacity_unavailable" });
          return;
        }
        const id = randomUUID();
        const audience = randomBytes(32).toString("base64url");
        const presenter = randomBytes(32).toString("base64url");
        const createdAt = now();
        const record: StoredRoom = {
          metadata: {
            id,
            expiresAt: createdAt + (options.roomMs ?? 3600000),
            state: "Created",
            presenterEpoch: "0",
            displayEpoch: "0",
            revision: "0",
            graceUntil: null,
          },
          audienceHash: digest(audience),
          presenterHash: digest(presenter),
        };
        const config = {
          room_id: id,
          code: id.slice(0, 8).toUpperCase(),
          join_url: `${origin.origin}/join/${id}#k=${audience}`,
          presenter_url: `${origin.origin.replace(/^http/, "ws")}/ws/presenter/${id}`,
          presenter_token: presenter,
        };
        storage.create(record, key, config, createdAt + 86400000);
        host(record);
        respond(response, 201, config);
        return;
      }
      const end = /^\/api\/relay\/v1\/rooms\/([A-Za-z0-9_-]{1,64})\/end$/.exec(path);
      const hosted = end && rooms.get(end[1]);
      if (!hosted) {
        respond(response, 404, { error: "not_found" });
        return;
      }
      if (!bearer || !matches(bearer, hosted.record.presenterHash)) {
        respond(response, 401, { error: "unauthorized" });
        return;
      }
      if (
        !guard(hosted, () => {
          hosted.room.tick();
          hosted.room.end();
        })
      ) {
        respond(response, 503, { error: "unavailable" });
        return;
      }
      respond(response, 200, {
        room_id: hosted.record.metadata.id,
        state: hosted.room.metadata.state,
      });
    } catch {
      respond(response, 503, { error: "unavailable" });
    }
  });
  const tcp = new Set<Socket>();
  server.on("connection", (socket) => {
    tcp.add(socket);
    socket.once("close", () => tcp.delete(socket));
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  sockets.on("connection", (socket: WebSocket, hosted: Hosted, role: Role) => {
    const id = randomUUID();
    const connection: Connection = {
      socket,
      hosted,
      role,
      authenticated: false,
      opened: now(),
      received: now(),
    };
    connections.set(id, connection);
    socket.on("error", () => socket.terminate());
    socket.on("pong", () => {
      connection.received = now();
    });
    socket.on("close", () => {
      connections.delete(id);
      connection.authorizing?.abort();
      if (connection.authenticated) {
        guard(hosted, () => hosted.room.disconnect(id));
        policies.notify("onDisconnect", {
          operationId: randomUUID(),
          roomId: hosted.room.metadata.id,
          connectionId: id,
          role,
        });
      }
    });
    socket.on("message", (bytes, binary) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      connection.received = now();
      let message: Wire;
      try {
        message = strictJSON(bytes.toString()) as Wire;
        if (binary || !validate("messages", message) || message.protocol !== `qp.${role}`)
          throw new Error("Invalid message");
      } catch {
        socket.close(1002);
        return;
      }
      if (!connection.authenticated) {
        const expected =
          role === "presenter" ? hosted.record.presenterHash : hosted.record.audienceHash;
        if (
          connection.authorizing ||
          message.type !== "hello" ||
          !matches(String(message.token), expected)
        ) {
          socket.close(1008);
          return;
        }
        if (role === "audience" && policies.has("beforeAudienceJoin")) {
          if (!guard(hosted, () => hosted.room.tick()) || hosted.room.metadata.state !== "Active") {
            socket.close(1008);
            return;
          }
          const policyRevision = policies.revision;
          const presenterEpoch = hosted.room.metadata.presenterEpoch;
          const displayEpoch = hosted.room.metadata.displayEpoch;
          const controller = new AbortController();
          connection.authorizing = controller;
          void policies
            .check(
              "beforeAudienceJoin",
              {
                operationId: randomUUID(),
                role,
                roomId: hosted.room.metadata.id,
                connectionId: id,
                presenterEpoch,
                displayEpoch,
              },
              controller.signal,
            )
            .then((verdict) => {
              if (socket.readyState !== WebSocket.OPEN || shuttingDown || storageFailed) return;
              guard(hosted, () => {
                hosted.room.tick();
                if (
                  hosted.room.metadata.state !== "Active" ||
                  hosted.room.metadata.presenterEpoch !== presenterEpoch ||
                  hosted.room.metadata.displayEpoch !== displayEpoch
                )
                  socket.close(1008, "stale_admission");
                else if (policyRevision !== policies.revision)
                  socket.close(1013, "policy_unavailable");
                else if (verdict.outcome !== "allow")
                  socket.close(
                    verdict.outcome === "deny" ? 1008 : 1013,
                    verdict.outcome === "deny" ? verdict.reason : "policy_unavailable",
                  );
                else connection.authenticated = hosted.room.attach(id, role);
              });
              connection.authorizing = undefined;
            });
        } else
          guard(hosted, () => {
            connection.authenticated = hosted.room.attach(id, role);
          });
        return;
      }
      const allowed = role === "presenter" ? ["receipt", "display"] : ["reaction", "comment"];
      if (!allowed.includes(String(message.type))) {
        socket.close(1002);
        return;
      }
      guard(hosted, () => hosted.room.receive(id, message as Input));
    });
  });
  server.on("upgrade", (request, socket, head) => {
    const path = /^\/ws\/(presenter|audience)\/([A-Za-z0-9_-]{1,64})$/.exec(request.url ?? "");
    const hosted = path && rooms.get(path[2]);
    const unauthenticated = [...connections.values()].filter((c) => !c.authenticated).length;
    if (
      storageFailed ||
      !hosted ||
      hosted.failed ||
      (request.headers.origin && request.headers.origin !== origin.origin) ||
      unauthenticated >= (options.maxUnauthenticated ?? 64) ||
      !guard(hosted, () => hosted.room.tick()) ||
      hosted.room.terminal
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) =>
      sockets.emit("connection", ws, hosted, path[1]),
    );
  });
  let lastPrune = now();
  const tick = setInterval(() => {
    for (const hosted of rooms.values()) guard(hosted, () => hosted.room.tick());
    if (now() - lastPrune >= 60000) {
      try {
        storage.prune(now());
        for (const [id, hosted] of rooms) {
          if (hosted.room.terminal && hosted.room.metadata.expiresAt + 86400000 <= now())
            rooms.delete(id);
        }
        lastPrune = now();
      } catch {
        storageFailed = true;
        for (const connection of connections.values()) connection.socket.terminate();
      }
    }
    for (const connection of connections.values()) {
      if (connection.socket.readyState === WebSocket.CLOSING) {
        connection.closingAt ??= now();
        if (now() - connection.closingAt >= (options.closeMs ?? 1000))
          connection.socket.terminate();
      }
      if (
        (!connection.authenticated && now() - connection.opened >= (options.authMs ?? 5000)) ||
        now() - connection.received >= 45000
      )
        connection.socket.terminate();
    }
  }, 100);
  const heartbeat = setInterval(() => {
    for (const { socket } of connections.values())
      if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, options.heartbeatMs ?? 15000);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
    });
  } catch (error) {
    clearInterval(tick);
    clearInterval(heartbeat);
    storage.close();
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  // Resolve an explicitly ephemeral loopback HTTP origin only after binding.
  if (loopback && origin.protocol === "http:" && origin.port === "0") origin.port = String(port);
  let stopping: Promise<void> | undefined;
  return {
    port,
    origin: origin.origin,
    diagnostics() {
      return {
        policy: policies.diagnostics(),
        rooms: rooms.size,
        failedRooms: [...rooms.values()].filter((h) => h.failed).length,
        connections: connections.size,
        unauthenticated: [...connections.values()].filter((c) => !c.authenticated).length,
        tcpConnections: tcp.size,
        pending: [...rooms.values()].reduce((sum, h) => sum + h.room.diagnostics().pending, 0),
        requests: [...rooms.values()].reduce((sum, h) => sum + h.room.diagnostics().requests, 0),
      };
    },
    stop() {
      stopping ??= (async () => {
        shuttingDown = true;
        policies.close();
        clearInterval(tick);
        clearInterval(heartbeat);
        for (const [id, c] of connections) {
          if (c.authenticated) guard(c.hosted, () => c.hosted.room.disconnect(id));
          c.socket.terminate();
        }
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        // Also release partial HTTP requests/upgrades, which are not ws members.
        for (const socket of tcp) socket.destroy();
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        await closed;
        storage.close();
      })();
      return stopping;
    },
  };
}
