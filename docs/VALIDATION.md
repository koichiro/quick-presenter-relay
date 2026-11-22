# Validation

`npm ci && npm run ci` checks Biome lint/format/import order, schemas, wire and
semantic fixtures, state traces and regression tests. Tests use synthetic credentials/content. Runtime tests bind loopback sockets and
use temporary SQLite databases, without contacting external services.

The original small model does not prove runtime guarantees. Stage 2–5 core, HTTP/WS,
storage, CLI, crash/fault and browser-controller tests now supplement it.
See [RUNTIME_CONFORMANCE.md](RUNTIME_CONFORMANCE.md) for executable failure scenarios
and [EXTENSIONS.md](EXTENSIONS.md) for real hook integration and race tests. Application and deployment qualification should additionally cover:
- Portable fixtures passing in Rust, TS and browser validators.
- Browser -> relay -> qp admission -> result integration, including A7 history/logs.
- Review the versioned extension contract and its provider/side-effect limits.
- No content replay after reconnect or old-epoch resume.
- Role separation, configured proxy trust and secret-free logs.
- Responsive PDF navigation/rendering/shutdown during transport faults.

GitHub Actions runs on push/PR/manual dispatch on Node 22/24/26 across Windows, macOS and Linux with read-only
permissions. It does not deploy or send coverage to a third-party service. The workflow checks
lint/format/import order separately from tests and coverage. LCOV and JSON summary
reports are retained as GitHub Actions artifacts for seven days, including failed
coverage runs when reports exist. Each OS/Node combination has a distinct artifact.

The fixed `CI required` check succeeds only when every matrix verification job
succeeds; failures, cancellations and skipped verification cannot pass it. Maintainers
can select this check in branch protection or repository rulesets. The workflow
does not configure those settings automatically. Local validation does not replace
a successful GitHub Actions run.
Coverage uses c8/V8 and includes unimported scripts/src/packages/web source.
Generated JS is measured and source-mapped back to TypeScript before exclusions;
source files remain subject to per-file gates. Statements,
branches, functions and lines must each reach 80% per file. Reports are ignored in
coverage/. `npm test` alone does not enforce the coverage threshold.

Before publication, review the full repository and history, dependency licenses,
names, credentials, documentation and fixtures. Publication requires authorization.

Creation-contract fixtures include missing, empty, overlong and malformed
idempotency keys, extra properties, missing response fields, missing join secrets,
incorrect presenter-token lengths and non-WebSocket presenter URLs. These pin the
existing v1 schemas without changing their accepted contract; schema conformance
alone does not prove authentication or runtime behavior.
