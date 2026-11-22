# Node capacity and TCP pressure diagnostics

`npm run test:capacity` is an explicit, local-only diagnostic. It is excluded from
`npm run ci`. It uses synthetic credentials and comments, loopback sockets and
temporary SQLite files; it does not deploy or contact a hosted relay.

```sh
npm ci
npm run test:capacity
RELAY_DIAGNOSTIC_MS=30000 npm run test:capacity
npm run test:pressure
```

The duration defaults to 5000 milliseconds and accepts integers from 5000 through
120000. The 100- and 300-audience profiles run sequentially, each for at least the
selected duration plus setup, recovery and cleanup. Keep other load, inspector,
coverage and allocation experiments out of the same measurement interval.

`test:pressure` separately runs the socket/cache saturation, 64-audience fan-out,
160-audience terminal-close burst and fixture cache-saturation regressions in
sequence. These tests live under `tests/manual/`, outside the top-level
`tests/*.test.mjs` selection used by `test`, `test:coverage` and automatic CI.
Neither explicit diagnostic command is called by a GitHub Actions workflow.
Ordinary CI retains small deterministic limit-boundary tests, one-frame output
budget checks and normal/abrupt disconnect recovery; it does not run sustained,
large-fan-out, saturation or close-burst workloads.

Each profile starts a fresh Node server child, with clients in the parent. Join
concurrency is eight. Healthy send batches are at most sixteen and wait for every
correlated native receipt before the next batch. A 200 ms pause between rounds
keeps each healthy identity below its existing 256-record/30-second cache bound.
Two other rooms independently
pause their presenter and audience TCP readers. Bounded pressure bursts run
alongside healthy progress, then the unread transports are terminated. Replacement
identities must receive a fresh offer and accepted result without replay. End
every room and verify all transient membership, offers and request caches clear.

The aggregate report is written to ignored `coverage/capacity/report.json`, with
`complete: false` until all assertions succeed. Preserve a useful report before
rerunning. It contains server-child RSS, heap, external memory, V8 heap statistics,
cumulative user/system CPU, SQLite/WAL sizes, counts and maximum batch-result time.
It contains no room identities, URLs, tokens or event bodies. Resource samples
are taken between healthy rounds; short spikes may be missed. CPU is process CPU,
not billed usage. Heap samples are not allocation profiles or proof of a leak.

The workload is closed-loop and reports achieved work, not guaranteed offered
throughput. A paused reader exercises TCP pressure; it does not prove a zero
advertised window or that every output buffer saturated. Resource bounds may
close a pressured connection; fresh healthy delivery must still recover.
The final server process is stopped and its disposable state removed on both
success and failure. Finite local measurements are not production capacity,
cross-platform memory guarantees or a reason to change protocol deadlines,
request-cache bounds, checkpoint format or GC policy.
