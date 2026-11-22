# Runtime conformance and recovery (stage 4)

The gate covers the single-process self-hosted runtime and portable Room Core.
Relay Protocol remains `1`: this milestone adds failure verification and
resource cleanup without changing schemas or claiming stable-v1 delivery.
All test credentials and event bodies are synthetic; no deployment is performed.

## Executable scenarios

Run `npm ci && npm run ci`. The same suite runs on Node 22/24/26 across Ubuntu,
macOS and Windows. Every measured source file must meet the existing 80% threshold
for statements, branches, functions and lines. Automatic CI selects only top-level
`tests/*.test.mjs` files. Run `npm run test:pressure` explicitly for the manual
socket/fixture saturation, 64-client fan-out and 160-client close-burst cases below.

| Scenario                                      | Evidence                                                   | Expected behavior                                                                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lost result, duplicate input and late receipt | `core.test.mjs`, `failure.test.mjs`                        | Cached result reused without another offer; receipt at/after deadline cannot change `unknown` to `accepted`                                                              |
| Idle result retention                         | `core.test.mjs`, `failure.test.mjs`                        | Maintenance removes finished request fingerprints/results after 30 seconds even without new input                                                                        |
| Presenter replacement and stale epoch         | `core.test.mjs`, `runtime.test.mjs`                        | Old connection fenced, pending requests become `unknown`, display epoch retained and no content replay                                                                   |
| Pause, resume and room end/expiry             | `core.test.mjs`, `runtime.test.mjs`                        | Display epochs remain monotonic; expired/ended rooms cannot resume; terminal transition releases members/pending state                                                   |
| Pending and dedup pressure (manual)           | `manual/socket-pressure.mjs`                               | 128 pending offers remain bounded; additional requests receive `busy`; 256 cached requests per client enforced; another room remains responsive                          |
| Audience fan-out (manual)                     | `manual/socket-pressure.mjs`                               | 64 authenticated audiences exchange receipts with no small-room product quota; disconnect releases their request records                                                 |
| Slow output/write failure                     | `output.test.mjs`, `failure.test.mjs`                      | Existing buffered bytes plus next UTF-8 frame checked before send; over-budget presenter closed with 1013, pending result stays `unknown`; write error terminates socket |
| Idle peer and withheld close response         | `failure.test.mjs`                                         | Idle/no-pong connection terminated; unresponsive close handshake cannot retain a socket indefinitely                                                                     |
| Frames queued after close                     | `failure.test.mjs`                                         | Input after protocol close is ignored and cannot create an offer                                                                                                         |
| Concurrent stop with partial HTTP/upgrade     | `failure.test.mjs`                                         | Same completion promise for every caller; WS and all TCP sockets released without waiting for incomplete request bodies                                                  |
| Abrupt process death                          | `failure.test.mjs`, `fixtures/runtime-child.mjs`           | Real child killed without cleanup; persisted credentials/epochs/display recovered; pending bodies never replayed or stored                                               |
| Repeated crash during reconnect grace         | `failure.test.mjs`                                         | Existing recovery grace deadline is not extended by another restart                                                                                                      |
| Terminal room after crash                     | `failure.test.mjs`                                         | End metadata persists and repeated creation key returns 410                                                                                                              |
| Storage faults                                | `runtime.test.mjs`, `storage.test.mjs`, `failure.test.mjs` | Corrupt metadata aborts startup; transaction rolls back; affected room fails closed; maintenance failure closes all sockets and creation returns 503                     |
| CLI lifecycle                                 | CLI tests and `shutdown.test.mjs`                          | Signal listeners cleaned up; trusted parent IPC allows graceful portable shutdown; credentials/content absent from output                                                |

## Adapter safeguards and diagnostics

A WebSocket close handshake has a one-second budget (`Options.closeMs` for embedded
runtimes). The maintenance tick is 100 ms, so observed termination may follow the
budget by one tick plus event-loop scheduling delay. No hard real-time guarantee
is implied. Shutdown destroys sockets, including partial HTTP/upgrade requests,
before closing storage. It preserves reconnectable room metadata rather than
ending rooms. Requests already accepted by qp may have an unobserved result;
`unknown` is deliberately not a rejection or a safe automatic retry instruction.

`runtime.diagnostics()` exposes only aggregate counts of retained/failed rooms,
WS/TCP/unauthenticated connections, pending offers and request records. Room Core
has a corresponding count-only snapshot. Neither exposes tokens, IDs or content;
there is no public HTTP diagnostic endpoint or durable analytics log. These
snapshots support resource cleanup assertions without timing-sensitive memory
measurements. Completed request retention is enforced by the existing room tick.

The IPC shutdown command is available only when a parent creates a Node IPC
channel. It is not a protocol extension, operator network API or admission policy.
Windows tests use IPC for graceful shutdown and force termination for crash tests;
Unix operators can continue to use SIGINT/SIGTERM. Protect configuration/database
with suitable Windows ACLs or Unix owner permissions.

## Limits of the gate

The explicitly invoked 64-client and saturation checks verify routing and resource bounds,
not deployment capacity, a benchmark or a maximum audience size. Kernel/network
backpressure is nondeterministic; exact byte accounting is tested through an
injected socket and real sockets exercise projected frame overflow and withheld
close responses. SQLite is synchronous with a five-second busy timeout; slow or
locked disks can delay the relay process. Use one process per local database,
monitor disk health and do not interpret these tests as clustered availability.

Browser-controller tests simulate DOM/WS behavior. Real mobile layout, Slint
animation, platform-specific qp rendering responsiveness, TLS reverse-proxy
operations and long-running capacity tests still need separate validation.
The prior qp interoperability check is recorded in SELF_HOSTED.md. No event log,
exactly-once delivery, automatic content replay or external hook execution is added.

Additional regressions cover normal and abrupt role disconnects followed by
fresh receipt-confirmed delivery without replay in ordinary CI. The manual
`test:pressure` suite also covers authenticated termination with 160 audience
close callbacks. The terminal case establishes connections
in bounded batches so it measures close cleanup independently of the host's TCP
accept backlog. Repeated end and same-key terminal creation retain their original
200 and 410 outcomes, with zero transient connections, pending offers or caches.
The browser and server share Unicode input fixtures, including invalid controls,
unpaired surrogates, CR/LF/TAB, emoji boundaries and the non-whitespace BOM.
The browser also tests connection/welcome timeout, late callbacks and manual
recovery with draft preservation and no resend.
