# Architecture

```text
Audience browser -- HTTPS/WSS -- Runtime adapter -- Room Core
Quick Presenter  -- outgoing WSS -----^                 |
                                                      +-- RoomStorage
                                                      +-- AdmissionPolicy (optional)
```

A room has one current presenter epoch. qp initiates the connection. Room Core
must not depend on platform sockets, filesystem APIs or native UI libraries.
Inject storage, clock, send/close and deadline scheduling. Serialize state
transitions and recheck identity/revisions after asynchronous extension calls.
Single-thread scheduling does not remove races across await boundaries.

Target packages: room-core, plugin-sdk, audience-web, self-hosted and conformance.
Start with one Node instance and SQLite metadata. Horizontal clustering is not
supported by that initial topology. TLS terminates at a configured reverse proxy;
trust forwarded headers only from configured proxies. No automatic port mapping.

## Persistence and recovery

Persist room identity/state, token verifier metadata, cleanup deadlines, presenter
epoch and display revision. Do not persist event bodies or event history by default.
A process crash may lose pending results. Browser submissions are not automatically
retried. Recovery fences old presenters; missing/invalid storage must not revive
an ended room. Runtime adapters implement connection bookkeeping and idempotent
cleanup; the portable core receives explicit state and deadline inputs.

## Native boundary

The qp adapter produces AudienceEvent payloads and preserves bounded queue/log
admission, A7 history and display generation. A common Session handle replaces
LocalAudienceSession-specific UI calls. PDFium, renderer IPC, Presentation Control
Protocol and PDF/timer behavior remain separate. Relay endpoint is configurable.

## Implemented stage 2–3 boundaries

- `packages/room-core/src/room.ts`: portable synchronous transitions with injected time, event IDs,
  metadata persistence and send/close effects. It never imports Node APIs.
- `packages/room-core/src/text.mjs` and `packages/room-core/src/json.ts`: portable Unicode normalization and strict JSON.
- `src/runtime.ts`: Node HTTP/WS authentication, schema validation, socket identity,
  buffering, clocks and room registry. Input is authenticated and validated before
  core transitions; storage failures close affected connections.
- `src/storage.ts`: SQLite metadata and AES-GCM encrypted creation-response cache.
- `src/cli.ts`: private configuration, signal shutdown and secret-free status.
- `packages/audience-web`: shared, independently served mobile-first browser package.

The wire contract is Relay Protocol v1. Room Core receives validated typed input; HTTP
and socket authentication remain adapter responsibilities. An optional admission
port evaluates asynchronously and commits through the adapter's fault guard.
Core dedup/pending reservation precedes evaluation; connection and epoch checks
precede forwarding. Core never imports Node or a plugin module.

Stage 5 adds `packages/room-core/src/extensions.ts` (portable versioned SDK, bounded invocation and
cancellation) and `src/plugin-loader.ts` (Node-only trusted local startup imports).
The runtime owns creation/join hooks, terminal/disconnect notifications and policy
revision checks. It shares one creation evaluation per concurrent idempotency key,
without holding SQLite transactions across awaits. Faulted rooms dispose transient
state without another storage write. TypeScript declarations are emitted for
operator integration. See [EXTENSIONS.md](EXTENSIONS.md) for API, trust and lifetime
limits. There is no participant-count product quota.

## Portable package boundary

`quick-presenter-relay-core` is an npm workspace under `packages/room-core`.
The Node runtime imports the same public entry point as independent consumers.
Its build has no Node ambient types and no runtime dependencies. Public exports
provide Room, port/input/metadata types, extension API, JSON/text helpers and
protocol schemas/fixtures. Node HTTP/WebSocket, SQLite, crypto, CLI and dynamic
plugin loading remain in the root self-hosted package.

See [core package usage](CORE_PACKAGE.md) for packing, adapter responsibilities,
coverage and compatibility. This extracts existing behavior; it does not change
wire semantics, synchronous persistence or asynchronous admission races.

## Checkpointed runtime restoration

The optional versioned RoomCheckpoint records authenticated connection topology,
opaque request fingerprints, cached result statuses and pending receipt deadlines.
An adapter can reconstruct the core without replacing the presenter or replaying
events. External admission decisions interrupted by runtime replacement become
unknown. Metadata/checkpoint/effects must share a serialized commit boundary;
identity validation, hashing, corruption handling and persistence remain adapter
responsibilities. This is a portable API and does not change wire messages.
