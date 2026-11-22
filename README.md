# Quick Presenter Relay

Version `1.0.0` implements Relay Protocol v1. It includes a single-process Node
self-hosted runtime, a portable room core and a shared mobile audience browser.
Package versions, wire version and the extension API version are independent.
The extension SDK retains its explicitly versioned `1-draft.1` contract.

An open relay protocol and self-hosted implementation for Quick Presenter Audience
Live. The implementation uses a platform-independent TypeScript room core,
with Node.js as the first runtime. Quick Presenter remains a separate Rust/Slint
application. Licensed under Apache-2.0; see [LICENSE](LICENSE).

## Available features

- Versioned extension SDK, trusted startup modules and bounded async admission.
- Runtime failure/recovery conformance and Windows/macOS/Linux CI.
- Portable TypeScript Room Core and SQLite room metadata.
- Authenticated room creation/end APIs and room-scoped WebSockets.
- Mobile-first audience UI for reactions and comments.
- qp remote-client interoperability, pause epochs and presenter resume.
- Repository foundation and contributor guidance.
- Relay Protocol `1`, role-specific schemas and portable fixtures.
- Executable contract examples for acknowledgements, epochs, pause, room deadlines,
  connection bookkeeping and extension failures. These are specification oracles.
- Generic operator-supplied admission hooks.

Use matching v1 clients and servers; the retired draft wire is unsupported.
The native application supports the audience message subset on its local listener.
Consumers embedding the shared browser should adopt and verify the matching assets.

## Install the server

Create an owner-only server configuration as described in
[the self-hosted guide](docs/SELF_HOSTED.md), then install and run the CLI:

```sh
npm install --global quick-presenter-relay@1.0.0
quick-presenter-relay /absolute/path/to/server.json --qp-config /absolute/path/to/new-client.toml
```

The server package contains compiled code and protocol assets; installing it does
not require TypeScript or a source checkout. Node.js and a writable SQLite storage
directory are required. TLS for remote clients belongs to your reverse proxy.
The root package is a CLI distribution, not a JavaScript library API. Use
`quick-presenter-relay-core` to build an adapter and
`quick-presenter-audience-web` to serve the shared audience UI.

## Validate

Node.js >= 22.12.0 and npm are required. Contract tests need no credentials;
fixture tests bind loopback sockets and generate synthetic credentials.

```sh
npm ci
npm run ci
```

Biome checks TypeScript/JavaScript lint, formatting and import order; `tsc` checks
strict TypeScript. c8 measures scripts/src/packages/web, including unimported files
and source-mapped TypeScript. Statements,
branches, functions and lines must each reach 80% per file. `npm test` is test-only;
`npm run test:coverage` writes ignored local reports to `coverage/`.

Tests cover contracts, portable state transitions, HTTP/WebSocket routing,
SQLite crash recovery, bounded overload/shutdown and browser-controller behavior.
See [runtime conformance](docs/RUNTIME_CONFORMANCE.md) for scenarios and limits.
These checks do not certify real-device browser rendering or production capacity.

## Portable core package

`packages/room-core` contains the dependency-free `quick-presenter-relay-core`
workspace. Both adapters and tests import its public entry point; it exports Room,
ports and shared types, the extension API, JSON/text helpers and protocol assets.
Node sockets, SQLite, crypto and CLI remain in the root runtime. To build a local
installable tarball without publishing:

```sh
npm ci
npm run pack:core
```

The package includes declarations, Apache-2.0 LICENSE and NOTICE. CI tests a fresh
consumer installed from the actual tarball, including TypeScript without Node
ambient types and rejection of internal imports. See [core package usage](docs/CORE_PACKAGE.md).

## Shared audience browser package

`packages/audience-web` is the dependency-free `quick-presenter-audience-web`
workspace. The Node runtime and browser tests resolve its public exports, so the
join page and ES module have one source of truth. Adapters can install a reviewed
local tarball and serve its exported files without copying or forking the UI:

```sh
npm run pack:web
```

The standalone consumer test verifies the installed tarball, exported asset paths,
byte identity with tested source, Apache-2.0 notices and internal-path isolation.
Install the published package with `npm install quick-presenter-audience-web@1.0.0`.
See the [package README](packages/audience-web/README.md).

## Self-hosted runtime

Build, configure and run the server with the [self-hosted guide](docs/SELF_HOSTED.md).
Use `npm start -- /path/to/private-server-config.json` after `npm run build`.
Startup prints the relay URL and creation token, or exports qp TOML with
`--qp-config /path/to/new-config.toml`. It does not pre-create a room.

## qp interoperability fixture

```sh
npm run fixture -- --qp-config /absolute/path/to/new-config.toml
```

The fixture runs the self-hosted HTTP/WebSocket server on `127.0.0.1:18765` with
transient storage. Use `quick-presenter --config /absolute/path/to/new-config.toml`
with a qp revision implementing TOML room creation, then enable Audience Live.
Omit `--qp-config` to print connection credentials instead. Use `--port <PORT>`
before the output option to select another loopback port. See [fixture instructions](docs/FIXTURE.md). The relay project owns
its browser assets, wire fixtures and server test aids; qp owns the native client.

## Documentation

- [Self-hosted runtime](docs/SELF_HOSTED.md)
- [Scope and development order](docs/SCOPE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Relay Protocol v1](docs/PROTOCOL.md)
- [State transitions and delivery](docs/STATE_MACHINE.md)
- [Extension contracts](docs/EXTENSIONS.md)
- [Decision record](docs/DECISIONS.md)
- [Validation](docs/VALIDATION.md)

Audience events carry no PDFs, notes, paths or presentation-control commands.
The self-hosted implementation has no audience-size product quota. Authentication,
protocol validation, deadlines and bounded resources are core responsibilities.

Release validation and package boundaries are documented in [RELEASING.md](docs/RELEASING.md).

## Releases and dependency updates

All three packages use version `1.0.0` and Apache-2.0 with preserved notices.
The [release workflow](docs/RELEASING.md) verifies a tagged source and produces
standalone npm tarballs. Publishing is an explicit operation, separate from CI.

Dependabot checks npm and GitHub Actions weekly on Monday at 09:00 Asia/Tokyo.
It retains exact dependency pins, groups minor/patch development-tool updates
and leaves coordinated workspace releases to maintainers. Node type major updates
are reviewed with the minimum supported Node version. Security alerts and security
update PRs are separate repository settings. No automatic merge is configured.

Large fan-out, saturation, close-burst and sustained diagnostics remain manual-only:
`npm run test:pressure` and `npm run test:capacity`. Neither runs in automatic CI
or the npm release workflow's functional verification.
