# Self-hosted runtime (through stage 5)

Version `1.0.2`, Relay Protocol `1`. This is a single-process Node runtime.
The loopback fixture command runs it with temporary storage. Release versioning
does not guarantee production availability. Use Node 22.13.0+ in the 22.x line
or Node >=24.0.0, npm and a writable local directory. Node 23.x is not supported. Node's built-in SQLite avoids a separate database service.

## Install or build

Install the compiled server with `npm install --global quick-presenter-relay@1.0.2`.
Run `quick-presenter-relay /absolute/path/to/server.json` after creating the private
configuration below. The optional `--qp-config /absolute/path/to/new-client.toml`
exports client configuration without printing the creation token. The npm server
package includes its runtime code, schemas and core/browser dependencies; no
compiler or repository checkout is needed by an installed server.

Alternatively, build and validate a source checkout:

## Build and configure

```sh
npm ci
npm run ci
```

Keep the installed `quick-presenter-audience-web` dependency alongside the build.
Its exported HTML and ES module are the single browser source. The build copies the
protocol schemas into `dist/protocol/`. Source-build commands run from this checkout; the npm CLI can run from any directory.

For a loopback test, create a private configuration outside tracked source:

```sh
node --input-type=module <<'JS'
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
await mkdir('./local-state', { mode: 0o700 });
await writeFile('./local-state/server.json', JSON.stringify({
  database: './local-state/rooms.sqlite',
  storageKey: randomBytes(32).toString('hex'),
  createToken: randomBytes(32).toString('base64url'),
  publicOrigin: 'http://127.0.0.1:17891',
  host: '127.0.0.1',
  port: 17891,
  roomMs: 3600000
}), { flag: 'wx', mode: 0o600 });
JS
npm start -- ./local-state/server.json
```

Ignore this state directory in your checkout, or place it outside the repository.
Keep the configuration and storage directory owner-only; use user-controlled ACLs
on Windows. The CLI checks configuration permissions on Unix. `storageKey` must
remain unchanged across restarts: changing it makes cached creation responses
unreadable. Preserve database, WAL files and configuration together when backing up.
Do not commit or log tokens, creation responses or audience event bodies.

For remote access, configure `publicOrigin` as an HTTPS origin without a path,
userinfo, query or fragment. Terminate TLS at your reverse proxy and forward the
HTTP and WebSocket routes to the configured listener. The runtime ignores Host
and forwarded headers when creating URLs and trusts only its explicit origin.
Browser Origin must match it; native clients without Origin authenticate normally.
HTTP is allowed only for loopback development. No TLS certificate bypass, port
mapping or automatic proxy configuration is provided.

## Configure qp and create rooms

After building, start the relay with its private server configuration:

```sh
npm start -- ./local-state/server.json
```

Startup prints the configured relay URL, creation token, and a qp TOML example.
The creation token is an operator credential; protect terminal captures and do not
paste it into tracked files or public logs. No room is created by startup.
The server-side JSON remains the runtime/storage configuration, not a qp room file.

To export a qp configuration instead of printing the token:

```sh
npm start -- ./local-state/server.json --qp-config /absolute/path/to/new-config.toml
```

The file contains only `[audience]`, `transport = "remote"`, `relay`, and
`create_token`. It is created with exclusive access and mode 0600 on Unix;
existing files are never overwritten. On Windows use a user-private directory with
appropriate ACLs. File mode prints the relay URL but omits the creation token.
Output failures stop the just-started server and return a nonzero exit status.
Use HTTPS remotely; for local qp testing use a literal loopback IP origin.

With a qp revision implementing TOML configuration and room creation:

```sh
quick-presenter --config /absolute/path/to/new-config.toml presentation.pdf
```

For normal launches, put the TOML file at qp's standard config location:
- macOS: `~/Library/Application Support/Quick Presenter/config.toml`
- Windows: `%APPDATA%\Quick Presenter\config.toml`
- Linux: `$XDG_CONFIG_HOME/quick-presenter/config.toml`, otherwise
  `~/.config/quick-presenter/config.toml`

ON creates a room, authenticates the presenter, then displays the join URL/QR.
OFF ends that room; another ON creates a new one. Pause changes display policy only.
The old qp client from PR #466 requires a pre-created room JSON and cannot consume
this TOML export; use the follow-up client implementing automatic room creation.

The creation API remains `POST /api/relay/v1/rooms`, authenticated with the
operator Bearer credential and a JSON `idempotency_key`. A new key returns 201;
repeating it within 24 hours returns the same credentials with 200 while the room
remains nonterminal. Ended/expired rooms return 410. Restart does not reset the
absolute room expiry. This retention interval is provisional.

The audience browser needs no account, installation, or external web dependency.
It removes the join credential fragment immediately and displays feedback as plain
text. Loopback links work on the same computer only; smartphones need the HTTPS
reverse-proxy origin. Verify reactions/comments, original handles, participant
count, and qp history; Pause must suppress overlays while reception continues.

## Ending and persistence

`POST /api/relay/v1/rooms/{room_id}/end` requires the presenter Bearer token.
It returns `{ "room_id": "...", "state": "Ended" }` or `Expired` for a previously
expired room, and is idempotent. Audience credentials cannot end rooms.
Ctrl+C/SIGTERM stops the runtime and closes connections;
embedding Node parents can also send `"shutdown"` over a pre-existing IPC channel.
There is no network shutdown endpoint. Concurrent `stop()` calls share one
completion promise, including partial HTTP requests and incomplete upgrades; the persisted room can
resume before its original expiry and reconnect-grace deadline.

SQLite stores room metadata, token hashes and encrypted idempotency responses.
Event bodies, audience handles, pending receipts and result caches are transient.
Recovery never replays them. Presenter and display epochs survive restart; a
resuming presenter receives a new fencing epoch and authoritative count.

Defaults: room lifetime one hour; presenter reconnect grace 60 seconds; hello
wait five seconds; receiver offer TTL two seconds; receipt timeout three seconds;
request-result retention 30 seconds. A room holds at most 128 pending offers and
a live audience connection at most 256 request records. Slow sockets are closed
before buffered output plus the next serialized UTF-8 frame would exceed 64 KiB.
Closing sockets are terminated after a one-second close-handshake budget, checked
on the 100 ms maintenance tick. Up to 64 unauthenticated sockets may
await hello concurrently. These are resource/transport bounds, not commercial
participant quotas or abuse policies. Authenticated audience size has no product
limit. Resource exhaustion still depends on available CPU, memory and network.

Terminal metadata is retained until 24 hours after the original room deadline.
Expired creation records and terminal metadata are periodically removed. The
runtime's default 10,000 retained-room bound returns 503 on new creation; it does
not cap audiences. Deploy one process per database/listener. Horizontal scaling,
production recovery guarantees remain outside the gate. Stage 5 adds optional
trusted in-process hooks; configure local startup files through `plugins` or embed
`AdmissionPolicies`. See [EXTENSIONS.md](EXTENSIONS.md) for failure mappings,
cancellation, configuration revisions and trust limits. No admission-policy rules
are supplied.

## Validation and limits

`npm run ci` runs Biome, strict TypeScript, schemas, portable core tests, real
HTTP/WebSocket and SQLite restart tests, CLI checks, browser-controller tests and
coverage. Source maps attribute generated code back to every source file; each
file must meet 80% statements, branches, functions and lines, including web code.
Node 22/24/26 on Windows, macOS and Linux are tested in GitHub Actions.

The qp interoperability check on 2026-10-14 used native client revision
`6e0b80063b7996a2ebc1c1576d0e39c2bf2f6765` against this runtime and an HTTP-created
room. The existing fixture harness was temporarily adapted to the room-scoped
audience route and extended with Pause/Resume checks, then restored. It verified
reactions, Japanese comments, receipts, count, history/overlay-engine input,
paused-history behavior, stale-generation suppression and presenter resume.
No qp production source or shared GPL implementation was copied into this project.
The follow-up qp TOML interoperability test now targets this runtime directly;
it creates and ends rooms through HTTP without exporting room JSON.

Browser-controller tests simulate DOM/socket events; they do not certify mobile
browser layout or Slint animation. Stage 4 fault injection and bounded-load checks are documented in
[RUNTIME_CONFORMANCE.md](RUNTIME_CONFORMANCE.md); real-device and production-scale
checks remain outside the automated conformance gate. Storage failures fail affected rooms
closed; malformed/corrupted metadata aborts startup. No exactly-once delivery,
durable event log, abuse-policy implementation or clustered availability is claimed.

The shared browser bounds connection establishment and receipt of its first
valid welcome to ten seconds. On timeout it preserves the draft, disables
submission and offers manual reconnection; late events from the abandoned socket
cannot re-enable controls. A successful welcome cancels this deadline. Application
receipt waiting remains four seconds, without automatic replay. Invalid comment
or name input is rejected in the form using the existing Unicode scalar, byte,
control-character and whitespace rules before a frame is sent.

Run the explicit Node workload with `npm run test:capacity`; see
[Node diagnostics](NODE_DIAGNOSTICS.md) for duration bounds, resource measurements
and interpretation. It is excluded from automatic CI.
