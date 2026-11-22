# Scope and development order

## Product boundary

The project provides relay routing, room lifecycle, protocols, a browser UI,
a self-hosted runtime and generic extension interfaces. There is no audience-size
product quota. PDFs, notes, files, slide identifiers and presentation control are
excluded from the audience protocol.

## Milestones

| Stage | Deliverable                                     | Exit gate                                                 |
| ----- | ----------------------------------------------- | --------------------------------------------------------- |
| 0     | Repository, Apache-2.0, instructions, decisions | Project boundaries documented                             |
| 1     | Protocol draft, schemas, fixtures, state oracle | Contract tests pass; unresolved choices explicit          |
| 2     | Minimal TS room core + Node runtime             | One presenter and multiple audiences exchange reactions   |
| 3     | qp remote adapter and comments                  | A7 history/log/pause preserved                            |
| 4     | Runtime conformance and recovery                | Reconnect, duplicate, overload, stop and restart verified |
| 5     | Stable extension API                            | Stub hook decisions and failure paths verified            |
| 6     | Relay Protocol v1 and release preparation       | Cross-language conformance, docs and license review       |

Stages 2–5 now have a portable TS core, Node HTTP/WebSocket runtime, SQLite
metadata, audience web UI and qp interoperability validation. The development
fixture remains separate. Strict TypeScript and actual runtime/storage tests
supplement the original contract oracles. Stage 4 adds crash/fault conformance,
bounded shutdown and a three-OS CI matrix; see [RUNTIME_CONFORMANCE.md](RUNTIME_CONFORMANCE.md).
Stage 5 adds versioned admission/notification hooks, trusted startup modules and
async race/failure conformance; see [EXTENSIONS.md](EXTENSIONS.md).
Relay Protocol v1 is implemented. Package release checks and documented limits
are listed in [RELEASING.md](RELEASING.md); no hosted deployment is configured. See [SELF_HOSTED.md](SELF_HOSTED.md) for current guarantees and limits.

## Native client boundary

Quick Presenter is a separate Rust/Slint application. The relay carries audience
reactions/comments and session metadata only. Queue admission does not guarantee
screen display or durable logging; pause preserves history/logging/reactions.
The native local listener uses the shared audience browser and message subset,
without implementing the relay's room management or presenter socket APIs.
No native application implementation is included in this source tree.
