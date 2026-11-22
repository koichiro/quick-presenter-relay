# Audience recovery and release validation

Local validation on November 22, 2026 used Node 26.13.1 on macOS arm64. The
shared wire remains Relay Protocol `1`; schemas, portable Room Core behavior,
deadlines and request-cache limits are unchanged.

The browser now refuses invalid scalar/control input before sending, matches the
contract's whitespace set and preserves drafts on validation failure. Connection
and first-welcome waiting have a ten-second deadline with manual recovery and
late-callback fencing. No automatic message resend is introduced.

## Automatic verification

`npm ci` and `npm run ci` passed all 238 functional tests. Aggregate coverage was 99.28%
statements/lines, 96.87% branches and 100% functions. Per-file minima were 97.36%,
85.29%, 100% and 97.36% respectively, above the unchanged four-metric 80% gate.
A negative synthetic-source test confirms unexecuted files still fail the gate
with the updated coverage dependencies. Unicode fixtures exercise invalid
controls and surrogates, emoji boundaries, CR/LF/TAB and the BOM distinction;
timeout tests preserve drafts and ignore late callbacks before and after retry.
Ordinary real-socket regressions cover abrupt/normal role departures and fresh
delivery. The installed-server test also verifies the actual npm tarball outside
the repository, with no TypeScript or build tools installed. Large fan-out, saturation and terminal-close bursts are excluded from
CI and `npm test`; `npm run test:pressure` passed all four explicit manual cases,
including 160-audience end cleanup and terminal creation recovery.

The final lockfile audit reported zero advisories. Runtime dependencies remain
separate from the development-only coverage overrides; see
[dependency licenses](DEPENDENCIES.md). Node 26 is added to the existing
Windows/macOS/Linux CI matrix alongside Node 22 and 24. Local success alone does
not establish results for the other matrix hosts.

## Explicit Node workload

The default five-second diagnostic and a sequential 30-second-per-size run passed.
The latter used a fresh server child per profile, with clients in a separate
process and two additional rooms containing paused TCP readers.

| Healthy audiences | Healthy accepted results | Healthy rounds | Recovered pressure rooms | Peak sampled server RSS bytes | Maximum batch-result time ms |
| ----------------- | ------------------------ | -------------- | ------------------------ | ----------------------------- | ---------------------------- |
| 100               | 12000                    | 120            | 2                        | 144507560                     | 29.33                        |
| 300               | 22200                    | 74             | 2                        | 181212232                     | 35.04                        |

All rooms ended with zero transient connections, pending offers and request
caches and no failed rooms. Reports also retain CPU, heap/external-memory and
SQLite/WAL observations. These are bounded, closed-loop local measurements,
not guaranteed throughput, hosted capacity or allocation/leak attribution.
The diagnostic's 200 ms round pause respects the existing per-identity cache
bound. An earlier faster long-run attempt exhausted that bound and timed out;
it is not counted as a successful capacity run. No server limit was raised.
Use [the diagnostic commands and interpretation](NODE_DIAGNOSTICS.md) to reproduce.

## Release artifacts

Standalone core/browser installation and license/content tests pass in the
automatic suite. Regenerate the source-only candidate, package archives and
operator-held hash/license inventory from the exact final commit following
[the release checklist](RELEASING.md). A shared-browser asset change requires
explicit consumer adoption even when wire compatibility is preserved. The source-release preparation sets all three package versions to `1.0.0` and
adds independent installed-server verification. Publishing remains an explicit
operation after the selected source and packages pass their release checks.
