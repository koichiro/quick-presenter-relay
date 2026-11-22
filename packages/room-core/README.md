# Quick Presenter Relay Core

Portable Room Core and extension API for Relay Protocol `1`.
Package version: `1.0.2`. Apache-2.0; see LICENSE and NOTICE.
Install with `npm install quick-presenter-relay-core@1.0.2`.

Import `Room`, its port/input/metadata types, `AdmissionPolicies` and its SDK types,
`strictJSON`, and `normalizeBody` from `quick-presenter-relay-core`.
Schemas and synthetic fixtures are available under `quick-presenter-relay-core/protocol/*`.

Adapters authenticate and validate input before core transitions. Supply time,
identity, synchronous metadata persistence, connection effects and lifecycle ticks.
The package has no Node, filesystem, socket, SQLite or runtime dependencies.
Persistence failure handling and asynchronous durable commits belong to the adapter;
the existing synchronous save port does not itself provide durable transactions.

The extension API supplies trusted hooks only; it implements no abuse policies.
See the repository's protocol and extension documents for behavioral contracts.

Optional `RoomCheckpoint` restoration preserves authenticated connection identity
and epochs without replay. It requires an adapter-supplied opaque cryptographic
request fingerprint. See the repository core-package guide for commit/recovery
responsibilities. Default JSON request fingerprints cannot be checkpointed.
