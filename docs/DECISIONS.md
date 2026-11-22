# Decisions

| ID      | Decision                                                  | Status                 |
| ------- | --------------------------------------------------------- | ---------------------- |
| ADR-001 | Independent relay project                                 | Accepted               |
| ADR-002 | Apache-2.0 for new project-owned artifacts                | Accepted               |
| ADR-003 | TypeScript core and Node self-hosted runtime              | Implemented stages 2–3 |
| ADR-004 | qp receipt precedes accepted; transient events, no replay | Draft contract         |
| ADR-005 | Separate role credentials and presenter fencing           | Draft contract         |
| ADR-006 | Display epochs preserve A7 pause                          | Draft contract         |
| ADR-007 | Generic admission hooks with deterministic test stubs     | Accepted scope         |
| ADR-008 | Room metadata persistence without event-body retention    | Draft                  |
| ADR-009 | Stable v1 requires cross-language/server conformance      | Accepted gate          |
| ADR-010 | Biome conventions and per-file 80% coverage gate          | Accepted gate          |

## Licensing provenance

Apache-2.0 is the adopted license for new code, schemas, fixtures and documentation.
Do not copy GPL-only qp implementation into an Apache-only project without verified
permission/provenance. Shared protocol specifications and test vectors are the
starting point for compatibility. Retain dependency licenses and notices.

References:
- https://www.apache.org/licenses/LICENSE-2.0
- https://www.apache.org/licenses/GPL-compatibility.html

## Current guarantees

Stages 0–1 established contracts. Stages 2–3 add a working single-process runtime
and real transport/storage tests. Stable v1, broad recovery conformance and
production availability are not yet established. See SELF_HOSTED.md for limits.
