# Relay Protocol 1

Status: v1 wire contract implemented by package release `1.0.0`. Operational
qualification is separate from package versioning. No compatibility with `1-draft.1` is
provided. All client/server components must be updated together.
The discriminator `protocol` is `qp.audience` or `qp.presenter`; `version` is
`1`. Schema namespace `urn:qp-relay:1` is a local identifier, not
an endpoint or promised public hostname. Package version is independent.

## Session API

- `POST /api/relay/v1/rooms`: authenticate an operator-configured room-create
  credential; consume a bounded idempotency key.
- `POST /api/relay/v1/rooms/{room_id}/end`: presenter authority only;
  idempotent even after room has ended. Never revive a terminal room.
- Audience page `/join/{room_id}#k=<audience-secret>`; remove fragment after
  reading it. WebSocket endpoints distinguish room and role. HTTPS uses WSS.
- Creation returns room ID, display-only code, configured public join URL and
  presenter socket URL, plus independent presenter secret. Tokens have at least
  256 bits of CSPRNG entropy. Store verifiers, not raw secrets, where possible.
- The implementation must validate configured URL origins and cannot build URLs
  from an untrusted Host/Forwarded header. Disable response caching. Never log
  creation response bodies or auth messages. Creation retry bounds are defined below.

## Socket messages

See `protocol/schemas/messages.schema.json` and wire fixtures.
1. First text message is a role-specific `hello` carrying the room token.
2. Audience receives `welcome` with connection ID, capabilities and availability.
3. Audience sends `reaction` or `comment` with connection-scoped request ID.
4. Relay authenticates/validates, invokes optional policy, and captures room,
   presenter and display epochs. It sends `event` to the current presenter.
5. qp admits into its bounded queue/log pipeline and returns `receipt`.
6. Only matching current receipt produces `result: accepted` for that request.
   A `receipt` is not an acknowledgement of display or filesystem durability.

The same request ID submitted twice on a live audience connection receives the
cached result or remains pending; changing its payload closes as protocol error.
Bound retention; never evict a still-pending request to reuse its ID. Cache
retention is advertised in limits (default 30 seconds). No automatic event resend
on presenter or audience reconnect. Use relay event IDs for qp duplicate delivery
suppression, independent of local UI sequence IDs. Large counters are canonical
unsigned decimal strings, avoiding JavaScript's numeric precision boundary.

All application messages are text JSON, <=4096 UTF-8 bytes. Reject duplicate JSON
object keys before ordinary parsing. Exact fields are enforced; extension fields
require a negotiated new revision/capability. Reject unknown types/versions and
unpaired UTF-16 surrogates. Request IDs: ASCII letters/digits/_/-, 1–64 bytes.
Comment limits match A7 before normalization; use Unicode White_Space as a pinned
set (Unicode 15.1), C0/C1 controls excluded except CR/LF/TAB. Preserve submitted
handle; normalize body whitespace to a single ASCII space. Both remain plain
text. Do not interpret URLs. Scalar/UTF-8/control rules supplement JSON Schema.

Capabilities are an extensible list of identifiers. A client enables only known
capabilities; advertised `question` as a reaction is not a Q&A capability.
Required action fields stay strict. Welcome and state schema revisions are
negotiated; do not silently add fields to the existing Local v1 welcome.

## Outcomes

`accepted`, `busy`, `stopped`, `unavailable`, `unknown`, `expired`, `denied`,
`policy_unavailable`. `accepted` requires qp admission;
`unknown` means qp may have accepted before result transport failed. No caller
may treat `unknown` as definitely rejected. Policy denial discloses only a public
reason, not an internal rule. Room deadline expiry is independent of input
validation. Resource pressure returns busy; the core has no audience-size quota.

Close codes: 1000 normal end; 1002 malformed/unsupported protocol; 1008 invalid
credentials/role; 1009 oversized; 1011 runtime/extension failure; 1013 resource
pressure. Public reasons are short and secret-free. Anonymous audience tokens
never authorize creation, ending, presenter hello, or display updates. Bound
unauthenticated work/auth deadlines and enforce configured Origin; do not imply
these bounds provide network-flood protection.

## State and display synchronization

`presenter_welcome` supplies current presenter epoch, display epoch and count.
Counts represent authenticated live audience sockets, not humans. `state` carries
a revision, availability, display epoch and count snapshot. Reconnect begins with
an authoritative snapshot; do not reconstruct count from missed deltas.

On presenter welcome, qp seeds its remote display epoch from the room snapshot
before incrementing it; a fresh qp process must not assume the remote epoch is zero.
qp clears/pauses immediately and monotonically advances its display epoch. Relay
applies a `display` update only from the current presenter epoch, with a newer
display epoch. New event offers carry the relay's observed display epoch. qp keeps
history/log admission but permits comment overlay only for its current epoch
while unpaused. After resume, old-epoch input must never overlay. While the relay
has not acknowledged a new display epoch, suppress overlay conservatively.

`offer_ttl_ms` bounds qp processing after receipt of an offer (maximum 2000 ms),
not an exact browser-to-screen age. Start a local monotonic deadline before
queueing; reconnect discards offers and must not renew deadlines. Relay pending
receipts have a default 3000 ms deadline, after which outcome is unknown.
These receiver-relative bounds cannot subtract unknown network transit time.
V1 makes no browser-to-screen freshness guarantee. Never
serialize Rust Instant or compare two machines' wall clocks for animations.

## V1 decisions and compatibility

V1 adopts the existing message fields, strict input rules and receipt semantics.
The breaking changes are `version: "1"`, schema namespace `urn:qp-relay:1` and
`/api/relay/v1/rooms` (including the `/end` suffix). The old draft API is not an
alias. Unsupported versions fail; no negotiation or automatic downgrade is added.
The extension API and its decision schema remain independently `1-draft.1`.
- Freshness: offer TTL is receiver-relative, at most 2000 ms. Receipt timeout
  defaults to 3000 ms. Neither bounds unknown network transit or guarantees when
  an overlay appears. Delayed offers must obey pause/epoch and local deadlines.
- Creation: the same operator/key recovers identical credentials for at least
  24 hours while the room is nonterminal. Implementations may retain them longer;
  terminal rooms are never resumed. After the recovery window a caller cannot
  assume deduplication. Never reuse a key for a different attempt, silently switch
  keys after an unknown response, or infer that a lost response means no room.
- Timing: defaults remain 60 s presenter reconnect grace and 30 s finished-result
  retention, advertised by welcome. Pending requests are never evicted for ID reuse.
  Transport heartbeat/auth limits are adapter policy, not portable wire promises.
  The Node defaults are documented in SELF_HOSTED.md; other adapters may differ.
- Credentials: qp configuration contains the relay origin and creation credential.
  Live room credentials/creation attempts are process-local. Restart may create a
  new room and QR; persistent room/QR recovery is not a v1 guarantee. An unknown
  attempt is retried with the same identity while that process retains it.
- Conformance: schemas, raw inputs and real socket state traces cover browser,
  Node and native clients. Finite tests do not certify all devices or hosting load.
- Presenter replacement: authenticated resume replaces/fences the old presenter.
  No room transfer, key migration or separate takeover API is introduced.

When replacing a retired draft implementation, stop the old test session, update server and qp,
and start a new session/QR. Reload audience pages to obtain the matching browser
module. Do not present a mixed draft/v1 deployment as supported. Rollback likewise
uses matching components and a new test session; do not restore terminal rooms.

Schemas cover messages, create request/response and plugin decisions.
The Node runtime implements these APIs and `/ws/{role}/{room_id}` endpoints.
End returns 200 with `room_id` and terminal `state` (`Ended` or `Expired`), described
by the end-response schema. Creation uses Bearer operator authority; ending uses
Bearer presenter authority. Repeated creation keys return identical credentials
within the recovery window while the room is nonterminal; retained terminal rooms
return 410. SQLite retains encrypted
creation responses with a server-configured key. Longer response retention is
implementation-specific; the portable retry guarantee is the bounded window above. No API adds fields to socket messages.
See [SELF_HOSTED.md](SELF_HOSTED.md). Protocol shape validation alone does not prove
authentication, but real runtime tests now exercise role separation and lifecycle.

Stage 5 executes the existing policy-decision draft through the versioned extension
API. It adds no socket fields: event admission failure uses existing `denied` /
`policy_unavailable` statuses; HTTP creation denial is 403 with a public reason code,
and unavailable evaluation is 503. Only forwarded events can receive qp acceptance.
See [EXTENSIONS.md](EXTENSIONS.md) for context, ordering and asynchronous fences.

### Audience browser receive validation

The browser validates the complete server envelope before changing authentication,
availability or pending-request state. Only audience welcome, state and result
messages are accepted, with the exact fields and values declared in the message
schema, including nested limits. Capability identifiers remain extensible strings
of 1–64 Unicode scalar values.
Valid surrogate pairs count as one scalar; unpaired high or low surrogates are
rejected, including inside an otherwise valid identifier. The message schema
and browser enforce the same Unicode constraint.
Invalid frames disconnect immediately and disable sending without confirming a
pending request or automatically replaying it after reconnect. The browser uses
the Apache-2.0 Room Core duplicate-decoded-key token pass, with the same 4096-byte
and 32-level limits. `protocol/fixtures/audience-server.json` and browser tests
exercise this existing contract; no wire version or schema change is required.
