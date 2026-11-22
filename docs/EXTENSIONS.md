# Extension API (stage 5)

The versioned TypeScript API is implemented in `packages/room-core/src/extensions.ts`
and exported from `quick-presenter-relay-core` with generated declarations. API and
decision version remains `1-draft.1`, independently of Relay Protocol `1`.
Registry publication remains a separate release step. Local tarball packaging is described in [CORE_PACKAGE.md](CORE_PACKAGE.md).
The OSS runtime supplies integration interfaces and synthetic test stubs, without
shipping admission-policy rules.

## Operator-selected policies

An `AdmissionPolicy` has a unique ASCII `id` (1–64 characters), `api_version`, and
optional hooks. Install at most 16 descriptors in explicit evaluation order.

| Hook                 | Context beyond operation/policy revision                                                           | Runtime placement                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `beforeRoomCreate`   | Authenticated operator role, idempotency key                                                       | After authentication/schema validation and cache lookup; before allocating credentials or committing metadata |
| `beforeAudienceJoin` | Authenticated audience role, room/connection IDs, presenter/display epochs                         | After token validation, before welcome, membership or count increment                                         |
| `beforeEventForward` | Audience role, room/connection/request IDs, presenter/display epochs, read-only normalized payload | After membership, dedup and capacity checks; before offering to qp                                            |
| `onDisconnect`       | Role, room/connection IDs                                                                          | Best-effort once per authenticated socket close                                                               |
| `onRoomEnd`          | Room ID, `Ended` or `Expired`                                                                      | Best-effort after persisting the first terminal transition                                                    |

Contexts include a server-generated operation ID and captured policy revision.
They expose no credentials, socket/request objects, client-supplied network
metadata or presentation data. Event bodies use the relay's Unicode normalization;
handles remain original. Context and event payload are frozen. Hooks cannot rewrite
content or mutate the Room Core through the interface.

Admission hooks return exactly one schema-conforming decision:

```js
{ api_version: '1-draft.1', outcome: 'allow' }
{ api_version: '1-draft.1', outcome: 'deny', reason: 'operator_selected_code' }
```

Reasons are public ASCII codes matching `[A-Za-z0-9_-]{1,64}`. Extra fields,
unknown versions/outcomes, exceptions, rejected promises and timeouts become
`policy_unavailable`; errors and stack traces are never sent to clients. A denial
stops the chain. Missing hooks allow otherwise valid operations. Notifications
return no admission decision and cannot veto completed operations.

## Load and embed

The CLI accepts an optional `plugins` array in the existing owner-protected
configuration. Entries are explicitly selected local `.mjs`/`.js` files, resolved
relative to that configuration file (absolute filesystem paths also work). Each
module default-exports an `AdmissionPolicy`. Modules load once at startup;
invalid paths, versions, duplicate IDs or import failures abort startup. Remote
URLs and client-selected modules are rejected. There are no dynamic downloads,
file watchers, network management endpoints or native plugin ABI.

For an interface smoke test, an operator can create a local module:

```js
export default {
  id: "interface-smoke-test",
  api_version: "1-draft.1",
  beforeEventForward: () => ({ api_version: "1-draft.1", outcome: "allow" }),
};
```

Add `"plugins": ["./interface-smoke-test.mjs"]` to the server configuration and
run the usual `npm start -- /path/to/server.json`. Omit `plugins` to retain the
existing runtime behavior. Do not commit operator modules containing secrets.

Embedded Node applications can construct `AdmissionPolicies(descriptors, options)`
and pass it as `startRelay({ ...options, extensions })`. One engine belongs to one
runtime; shutdown closes it. `replace(descriptors)` is a trusted in-process
configuration operation: it validates atomically, increments the revision and
cancels older evaluations. It does not import or hot-load files. Existing rooms
observe the replacement, including hooks added or removed after room creation.
`check()` evaluates a decision; adapters must still recheck captured revision and
room/connection state immediately before applying it. The shipped adapter does so.

## Deadlines, bounded work and races

Defaults are 250 ms for a complete hook chain and 64 concurrently running chains,
shared by admission and notifications. Embedded runtimes may set `timeoutMs` and
`maxPending` to positive safe integers. Notifications never block end/disconnect
or shutdown; failed, cancelled or capacity-refused notifications only increment a
count-only diagnostic. Delivery is best-effort, not durable or retryable, and hooks
may be cancelled or omitted during shutdown.

Every invocation receives `HookTools.signal`. Plugins must cooperate with abort
and settle promptly. A timed-out uncooperative promise retains its running slot
until it actually settles, so repeated timeouts cannot create unlimited detached
work. Late decisions are ignored. Shutdown aborts signals and does not await
uncooperative code. Hooks are trusted in-process dependencies, not sandboxes: no
timeout can preempt synchronous JavaScript or undo an external side effect.
Administrators are responsible for reviewing modules and their dependencies.

Concurrent creation calls with one idempotency key share one evaluation. Already
cached credentials bypass creation hooks, and the runtime rechecks the cache after
awaiting before committing. No storage transaction crosses an external await.
Abandoned/shutdown HTTP requests cannot create a room on late completion.

Deferred joins never count as audience. Closed connections, terminal rooms,
presenter replacement, display changes and changed policy revisions invalidate
stale completion. Events reserve the existing pending/dedup slot before policy
evaluation; duplicates do not rerun hooks. Receipt timeout includes evaluation
time, and forwarded offer TTL cannot extend the original remaining deadline.
Only a matching receipt for an actually forwarded event can return `accepted`.
Closing sockets, pause/resume epochs, departure, room end, storage faults and
policy revision changes prevent stale forwarding. Pause still permits fresh
history/log intake: it is a generation fence, not an admission-policy rule.
Finished results, including denied/unavailable results, retain the normal dedup
window even after a policy replacement; no automatic content retry is added.

Transport mapping preserves socket schemas: creation denial is HTTP 403 with
`denied` and a reason; policy failure is HTTP 503 `policy_unavailable`. Join denial
closes with 1008 and a public reason; failure closes with 1013. Event results use
existing `denied` / `policy_unavailable` statuses without a reason field. Stale
lifecycle completion yields `unknown` or closes the joining socket. No wire
version change or qp implementation change is required.

## Optional state

Embedded operators may supply `ExtensionOptions.state(namespace)` returning
`PolicyState` with asynchronous `get`, `set` and `delete` for JSON values. The
engine passes each descriptor's ID as its namespace and gives that policy only
the returned handle. The provider must enforce namespace separation, size,
retention, durability and cancellation/side-effect semantics. No state backend,
shared namespace enumeration or durable event body storage is supplied by default.
Policy configuration and state providers remain trusted operator responsibilities.

## Evidence and limits

`extensions.test.mjs` verifies ordered allow/deny/fault decisions, strict fixture
compatibility, descriptor validation, namespaced injection, bounded deadlines,
cancellation, revisions and notification failure. `extension-runtime.test.mjs`
uses real HTTP/WS and SQLite to test creation single-flight, role separation,
join races, dedup, epoch/revision fencing, premature receipts, storage failure and
shutdown. `core.test.mjs` checks commit-time races and remaining TTL.
`plugin-loader.test.mjs` verifies startup files and CLI failure paths.
These tests establish the integration contract, not effectiveness of any policy.
