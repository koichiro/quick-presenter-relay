# Portable core package

`quick-presenter-relay-core` version `1.0.0` is the public portable npm package in
`packages/room-core`. Install with `npm install quick-presenter-relay-core@1.0.0`.
Relay Protocol is independently versioned `1`; the extension SDK remains `1-draft.1`.
Pin reviewed artifacts/revisions rather than following a moving branch.

## Build and consume

From the repository root:

```sh
npm ci
npm run pack:core
```

The resulting tarball includes compiled ESM, TypeScript declarations, source maps
with embedded source, protocol schemas/fixtures, README, LICENSE and NOTICE.
Install that tarball into an independent project with `npm install /path/to/file.tgz`.
It has no runtime npm dependencies. No server, browser UI, SQLite database, local
configuration or Node adapter is included. No registry publication is required.
The prepack hook builds the core; build tools are installed at repository level.
A source checkout must run `npm ci` at that level before packing.

```ts
import { Room, type Ports, strictJSON, normalizeBody } from "quick-presenter-relay-core";
```

The root export includes Room, defaults, wire construction, shared port/metadata/
input types, AdmissionPolicies, extensionVersion and SDK types, strictJSON and
normalizeBody. `quick-presenter-relay-core/protocol/schemas/messages.schema.json`
and other protocol assets are exported explicitly through the protocol subpath.
Source/internal module paths are not supported exports.

## Adapter contract

Authenticate roles and validate wire schemas/semantics before invoking Room.
Inject time, event IDs, send/close, connection checks, metadata persistence and
optional admission effects. Drive tick/deadline processing and serialize adapter
transitions. Preserve pending-result, pause, fencing and dedup semantics.

`Ports.save` is synchronous and may throw. It must not be satisfied by an unawaited
asynchronous write. An adapter with asynchronous storage needs a reviewed commit/
failure boundary; this extraction does not supply one or change durability claims.
Core contains no HTTP routing, socket authentication, persistence implementation
or platform module loading. strictJSON and normalizeBody are helpers, not complete
wire validation. Schemas and fixtures are data assets; adapters choose validation.

The generic extension SDK runs trusted operator-supplied hooks with existing
bounded timeout/cancellation semantics. It contains no abuse-policy implementation.

## Verification and updates

`npm run ci` preserves existing runtime/conformance tests and per-file 80% coverage
for source in the workspace. A package integration test packs and installs a fresh
tarball, executes Room transitions, consumes schemas, checks standalone TypeScript
without Node globals, verifies license/notice inclusion and rejects internal imports.
The portable compiler uses ES2022 and standard Web API types, with `types: []`.
Package contents are checked for accidental platform imports and runtime assets.

Generic API changes must update declarations, package documentation and consumers
in the same review. Preserve Apache-2.0 LICENSE/NOTICE in redistributed artifacts.
Passing package tests establishes a consumption boundary, not certification of
another adapter's persistence or transport reliability.

## Optional checkpoint restoration

Adapters with resumable authenticated connections can call `Room.checkpoint()`
and pass the versioned `RoomCheckpoint` as the fourth constructor argument.
Supply matching metadata, the same limits and a stable cryptographic
`Ports.fingerprint(payload)` function. Default JSON fingerprints deliberately
cannot be checkpointed: a checkpoint must not contain event bodies or handles.
Checkpoint fingerprints must be opaque strings; the adapter is responsible for
using a collision-resistant hash rather than an encoding of content.

Checkpoints contain connection/request IDs, cached results, receipt deadlines,
metadata and opaque fingerprints. They preserve presenter/display epochs and
never resend event offers on restoration. Forwarded pending offers can receive
an authenticated current-presenter receipt until their original deadline.
Unresolved external decisions become unknown, rather than re-running a hook.
Expired offers become unknown; terminal rooms stay terminal. Normal construction
without a checkpoint retains the existing cold-restart behavior.

Commit metadata and checkpoint together after each serialized transition, before
publishing connection effects. The core does not authenticate persisted data or
socket identities. Adapters validate recovered authenticated connections, reject
corrupt snapshots and dispose mutated in-memory state after storage failure.
Do not combine checkpoints from different room/revision/configuration instances.
The checkpoint is an adapter API, not a wire protocol message or durable event log.
