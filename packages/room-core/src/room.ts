// SPDX-License-Identifier: Apache-2.0
import type { Admission, EventContext } from "./extensions.js";
import { normalizeBody } from "./text.mjs";

// Portable state transitions. Adapters authenticate input and guard async commits.
export type Role = "presenter" | "audience";
export type Wire = Record<string, unknown>;
export type Payload =
  | { type: "reaction"; kind: string }
  | { type: "comment"; body: string; handle: string };
export type Input =
  | ({ request_id: string } & Payload)
  | { type: "display"; presenter_epoch: string; display_epoch: string; paused: boolean }
  | { type: "receipt"; presenter_epoch: string; event_id: string; status: string };
export interface Metadata {
  id: string;
  expiresAt: number;
  state: "Created" | "Active" | "PresenterDisconnected" | "Ended" | "Expired";
  presenterEpoch: string;
  displayEpoch: string;
  revision: string;
  graceUntil: number | null;
}
export interface Ports {
  now(): number;
  id(): string;
  save(metadata: Metadata): void;
  send(connection: string, message: Wire): void;
  close(connection: string, code: number): void;
  connected?(connection: string): boolean;
  fingerprint?(payload: Payload): string;
  admission?: {
    enabled?(): boolean;
    revision?(): string;
    evaluate(
      context: Omit<EventContext, "policyRevision">,
      signal: AbortSignal,
    ): Promise<Admission>;
    commit(action: () => void): void;
  };
}
export interface RoomCheckpoint {
  version: 1;
  metadata: Metadata;
  presenter: string | null;
  members: {
    connection: string;
    requests: {
      request: string;
      fingerprint: string;
      result: Wire | null;
      finished: number | null;
    }[];
  }[];
  pending: {
    event: string;
    connection: string;
    request: string;
    deadline: number;
    forwarded: boolean;
  }[];
}
const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const opaque = /^[A-Za-z0-9:_-]{1,128}$/;
const statuses = new Set([
  "accepted",
  "busy",
  "stopped",
  "unavailable",
  "unknown",
  "expired",
  "denied",
  "policy_unavailable",
]);

export interface Limits {
  receiptMs: number;
  cacheMs: number;
  graceMs: number;
  maxPending: number;
  maxRequests: number;
}
export const defaults: Limits = {
  receiptMs: 3000,
  cacheMs: 30000,
  graceMs: 60000,
  maxPending: 128,
  maxRequests: 256,
};
export const wire = (role: Role, type: string, fields: Wire): Wire => ({
  protocol: `qp.${role}`,
  version: "1",
  type,
  ...fields,
});
function increment(counter: string): string {
  const next = String(BigInt(counter) + 1n);
  if (next.length > 20) throw new Error("Counter exhausted");
  return next;
}
interface Entry {
  fingerprint: string;
  result: Wire | null;
  finished: number | null;
}
interface Pending {
  connection: string;
  request: string;
  entry: Entry;
  deadline: number;
  forwarded: boolean;
  controller: AbortController;
}

export class Room {
  private presenter: string | null = null;
  private members = new Map<string, Map<string, Entry>>();
  private pending = new Map<string, Pending>();
  readonly limits: Limits;
  constructor(
    readonly metadata: Metadata,
    private ports: Ports,
    limits: Partial<Limits> = {},
    checkpoint?: RoomCheckpoint,
  ) {
    this.limits = { ...defaults, ...limits };
    if (checkpoint !== undefined) this.restore(checkpoint);
    else if (metadata.state === "Active") {
      metadata.state = "PresenterDisconnected";
      metadata.graceUntil = ports.now() + this.limits.graceMs;
      ports.save({ ...metadata });
    }
    this.tick();
  }
  checkpoint(): RoomCheckpoint {
    if (!this.ports.fingerprint) throw new Error("Checkpoint requires opaque request fingerprints");
    return {
      version: 1,
      metadata: { ...this.metadata },
      presenter: this.presenter,
      members: [...this.members].map(([connection, requests]) => ({
        connection,
        requests: [...requests].map(([request, entry]) => ({
          request,
          ...entry,
          result: entry.result ? { ...entry.result } : null,
        })),
      })),
      pending: [...this.pending].map(([event, entry]) => ({
        event,
        connection: entry.connection,
        request: entry.request,
        deadline: entry.deadline,
        forwarded: entry.forwarded,
      })),
    };
  }
  private restore(checkpoint: RoomCheckpoint): void {
    if (
      !this.ports.fingerprint ||
      checkpoint.version !== 1 ||
      (Object.keys(this.metadata) as (keyof Metadata)[]).some(
        (key) => checkpoint.metadata[key] !== this.metadata[key],
      ) ||
      (checkpoint.presenter !== null && !identity(checkpoint.presenter)) ||
      (this.metadata.state === "Active") !== (checkpoint.presenter !== null) ||
      !Array.isArray(checkpoint.members) ||
      !Array.isArray(checkpoint.pending) ||
      checkpoint.pending.length > this.limits.maxPending ||
      (this.terminal && (checkpoint.members.length > 0 || checkpoint.pending.length > 0))
    )
      throw new Error("Invalid room checkpoint");
    const members = new Map<string, Map<string, Entry>>();
    const pending = new Map<string, Pending>();
    for (const member of checkpoint.members) {
      if (
        !identity(member.connection) ||
        member.connection === checkpoint.presenter ||
        members.has(member.connection) ||
        !Array.isArray(member.requests) ||
        member.requests.length > this.limits.maxRequests
      )
        throw new Error("Invalid checkpoint member");
      const requests = new Map<string, Entry>();
      for (const entry of member.requests) {
        if (
          !identity(entry.request) ||
          requests.has(entry.request) ||
          typeof entry.fingerprint !== "string" ||
          !opaque.test(entry.fingerprint) ||
          (entry.finished !== null &&
            (!Number.isSafeInteger(entry.finished) || entry.finished < 0)) ||
          (entry.result === null) !== (entry.finished === null)
        )
          throw new Error("Invalid checkpoint request");
        const result = entry.result;
        if (
          result &&
          (Object.keys(result).length !== 5 ||
            result.protocol !== "qp.audience" ||
            result.version !== "1" ||
            result.type !== "result" ||
            result.request_id !== entry.request ||
            !statuses.has(String(result.status)))
        )
          throw new Error("Invalid checkpoint result");
        requests.set(entry.request, {
          fingerprint: entry.fingerprint,
          result: result ? { ...result } : null,
          finished: entry.finished,
        });
      }
      members.set(member.connection, requests);
    }
    const reservations = new Set<Entry>();
    for (const offer of checkpoint.pending) {
      const entry = members.get(offer.connection)?.get(offer.request);
      if (
        !identity(offer.event) ||
        pending.has(offer.event) ||
        !entry ||
        entry.result !== null ||
        reservations.has(entry) ||
        !Number.isSafeInteger(offer.deadline) ||
        offer.deadline < 0 ||
        typeof offer.forwarded !== "boolean"
      )
        throw new Error("Invalid checkpoint pending offer");
      reservations.add(entry);
      pending.set(offer.event, {
        connection: offer.connection,
        request: offer.request,
        entry,
        deadline: offer.deadline,
        forwarded: offer.forwarded,
        controller: new AbortController(),
      });
    }
    for (const requests of members.values())
      for (const entry of requests.values())
        if (entry.result === null && !reservations.has(entry))
          throw new Error("Missing checkpoint pending offer");
    this.presenter = checkpoint.presenter;
    this.members = members;
    this.pending = pending;
    // An in-flight external decision cannot survive runtime replacement.
    for (const [event, offer] of pending) if (!offer.forwarded) this.finish(event, "unknown");
  }
  get terminal(): boolean {
    return ["Ended", "Expired"].includes(this.metadata.state);
  }
  get audienceCount(): number {
    return this.members.size;
  }
  diagnostics() {
    return {
      audiences: this.members.size,
      pending: this.pending.size,
      requests: [...this.members.values()].reduce((total, requests) => total + requests.size, 0),
    };
  }
  private snapshot(): void {
    this.metadata.revision = increment(this.metadata.revision);
    this.ports.save({ ...this.metadata });
    if (this.presenter)
      this.ports.send(
        this.presenter,
        wire("presenter", "state", {
          revision: this.metadata.revision,
          display_epoch: this.metadata.displayEpoch,
          available: true,
          audience_connections: this.members.size,
        }),
      );
    for (const id of this.members.keys())
      this.ports.send(
        id,
        wire("audience", "state", {
          revision: this.metadata.revision,
          available: this.presenter !== null,
        }),
      );
  }
  attach(id: string, role: Role): boolean {
    this.tick();
    if (this.terminal || (role === "audience" && !this.presenter)) {
      this.ports.close(id, 1008);
      return false;
    }
    if (role === "presenter") {
      if (this.presenter) {
        this.ports.close(this.presenter, 1000);
        this.clearPending();
      }
      this.presenter = id;
      this.metadata.presenterEpoch = increment(this.metadata.presenterEpoch);
      this.metadata.state = "Active";
      this.metadata.graceUntil = null;
      // Persist fencing before telling the presenter its epoch.
      this.ports.save({ ...this.metadata });
      this.ports.send(
        id,
        wire(role, "presenter_welcome", {
          presenter_epoch: this.metadata.presenterEpoch,
          display_epoch: this.metadata.displayEpoch,
          audience_connections: this.members.size,
        }),
      );
    } else {
      this.members.set(id, new Map());
      this.ports.send(
        id,
        wire(role, "welcome", {
          connection_id: id,
          capabilities: ["reactions", "comments"],
          available: true,
          limits: { max_message_bytes: 4096, request_cache_ms: this.limits.cacheMs },
        }),
      );
    }
    this.snapshot();
    return true;
  }
  disconnect(id: string): void {
    if (id === this.presenter) {
      this.presenter = null;
      this.clearPending();
      if (!this.terminal) {
        this.metadata.state = "PresenterDisconnected";
        this.metadata.graceUntil = this.ports.now() + this.limits.graceMs;
      }
      this.snapshot();
    }
    if (this.members.delete(id)) {
      for (const [event, offer] of this.pending)
        if (offer.connection === id) {
          offer.controller.abort();
          this.pending.delete(event);
        }
      this.snapshot();
    }
  }
  receive(id: string, message: Input): void {
    this.tick();
    if (this.terminal) return;
    if (message.type === "display" || message.type === "receipt") {
      if (id !== this.presenter || message.presenter_epoch !== this.metadata.presenterEpoch) {
        this.ports.close(id, 1008);
        return;
      }
      if (message.type === "display") {
        if (BigInt(message.display_epoch) > BigInt(this.metadata.displayEpoch)) {
          this.metadata.displayEpoch = message.display_epoch;
          this.snapshot();
        }
      } else if (this.pending.get(message.event_id)?.forwarded)
        this.finish(message.event_id, message.status);
      return;
    }
    const requests = this.members.get(id);
    if (!requests) {
      this.ports.close(id, 1008);
      return;
    }
    const payload: Payload =
      message.type === "reaction"
        ? { type: "reaction", kind: message.kind }
        : { type: "comment", body: message.body, handle: message.handle };
    const fingerprint = this.ports.fingerprint?.(payload) ?? JSON.stringify(payload);
    if (this.ports.fingerprint && (typeof fingerprint !== "string" || !opaque.test(fingerprint)))
      throw new Error("Invalid opaque fingerprint");
    const previous = requests.get(message.request_id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) this.ports.close(id, 1002);
      else if (previous.result) this.ports.send(id, previous.result);
      return;
    }
    if (requests.size >= this.limits.maxRequests) {
      this.ports.close(id, 1013);
      return;
    }
    const entry: Entry = { fingerprint, result: null, finished: null };
    requests.set(message.request_id, entry);
    const event = this.ports.id();
    const offer: Pending = {
      connection: id,
      request: message.request_id,
      entry,
      deadline: this.ports.now() + this.limits.receiptMs,
      forwarded: false,
      controller: new AbortController(),
    };
    this.pending.set(event, offer);
    if (!this.presenter) this.finish(event, "unavailable");
    else if (this.pending.size > this.limits.maxPending) this.finish(event, "busy");
    else {
      const normalized = Object.freeze(
        payload.type === "comment" ? { ...payload, body: normalizeBody(payload.body) } : payload,
      );
      const presenter = this.presenter;
      const presenterEpoch = this.metadata.presenterEpoch;
      const displayEpoch = this.metadata.displayEpoch;
      const forward = () => {
        const remaining = offer.deadline - this.ports.now();
        if (remaining < 1) {
          this.finish(event, "unknown");
          return;
        }
        offer.forwarded = true;
        this.ports.send(
          presenter,
          wire("presenter", "event", {
            event_id: event,
            connection_id: id,
            request_id: message.request_id,
            presenter_epoch: presenterEpoch,
            display_epoch: displayEpoch,
            offer_ttl_ms: Math.min(2000, remaining),
            payload: normalized,
          }),
        );
      };
      const admission = this.ports.admission;
      if (!admission || admission.enabled?.() === false) forward();
      else {
        const policyRevision = admission.revision?.();
        const context = Object.freeze({
          operationId: event,
          role: "audience" as const,
          roomId: this.metadata.id,
          connectionId: id,
          presenterEpoch,
          displayEpoch,
          requestId: message.request_id,
          payload: normalized,
        });
        const complete = (result: Admission) =>
          admission.commit(() => {
            this.tick();
            if (!this.pending.has(event)) return;
            if (
              this.ports.connected?.(id) === false ||
              this.ports.connected?.(presenter) === false ||
              this.presenter !== presenter ||
              this.metadata.presenterEpoch !== presenterEpoch ||
              this.metadata.displayEpoch !== displayEpoch
            )
              this.finish(event, "unknown");
            else if (admission.revision?.() !== policyRevision)
              this.finish(event, "policy_unavailable");
            else if (result.outcome !== "allow")
              this.finish(event, result.outcome === "deny" ? "denied" : "policy_unavailable");
            else forward();
          });
        void Promise.resolve()
          .then(() => admission.evaluate(context, offer.controller.signal))
          .then(complete, () => complete({ outcome: "policy_unavailable" }));
      }
    }
  }
  private finish(event: string, status: string): void {
    const offer = this.pending.get(event);
    if (!offer) return;
    this.pending.delete(event);
    offer.controller.abort();
    offer.entry.result = wire("audience", "result", { request_id: offer.request, status });
    offer.entry.finished = this.ports.now();
    this.ports.send(offer.connection, offer.entry.result);
  }
  private clearPending(): void {
    for (const id of this.pending.keys()) this.finish(id, "unknown");
  }
  // Release transient state after an adapter fault without another storage write.
  dispose(): void {
    for (const offer of this.pending.values()) offer.controller.abort();
    this.pending.clear();
    this.members.clear();
    this.presenter = null;
  }
  end(state: "Ended" | "Expired" = "Ended"): void {
    if (this.terminal) return;
    this.metadata.state = state;
    this.metadata.graceUntil = null;
    this.ports.save({ ...this.metadata });
    this.clearPending();
    const connections = [...this.members.keys()];
    if (this.presenter) connections.push(this.presenter);
    this.presenter = null;
    this.members.clear();
    for (const id of connections) this.ports.close(id, 1000);
  }
  tick(): void {
    for (const requests of this.members.values())
      for (const [key, entry] of requests)
        if (entry.finished !== null && this.ports.now() - entry.finished >= this.limits.cacheMs)
          requests.delete(key);
    if (
      !this.terminal &&
      (this.ports.now() >= this.metadata.expiresAt ||
        (this.metadata.graceUntil !== null && this.ports.now() >= this.metadata.graceUntil))
    ) {
      this.end("Expired");
    }
    for (const [id, offer] of this.pending)
      if (this.ports.now() >= offer.deadline) this.finish(id, "unknown");
  }
}
