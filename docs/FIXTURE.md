# qp interoperability runtime

The fixture command runs the actual self-hosted runtime with temporary SQLite
storage and fresh operator/storage credentials. It does not allocate a room or
export a pre-created room JSON. The portable wire fixture helper remains an
internal test aid.

```sh
npm ci
npm run fixture -- --qp-config /absolute/path/to/new-config.toml
```

The default listener/origin is `http://127.0.0.1:18765`. To change the port, put
`--port 18766` before `--qp-config`. Use `--port 0` to let the OS bind an available
port; the displayed URL, exported TOML and room URLs contain the actual bound port.
Omit the output option to print the URL,
creation token, and TOML. Output files are owner-only on Unix, are never overwritten,
and omit room credentials and storage secrets. Use restrictive Windows ACLs.
Do not copy real token output into GitHub or tracked source.

Launch a qp revision supporting TOML room creation:

```sh
quick-presenter --config /absolute/path/to/new-config.toml presentation.pdf
```

Enable Audience Live to create/connect a room and open its join URL on the same
machine. Check reactions, Unicode comments, history, pause/resume, and OFF ending
the room. A second ON creates a new room. This fixture is loopback-only; smartphone
access requires the configured HTTPS origin of a self-hosted deployment.

Ctrl+C/SIGTERM or a trusted parent IPC `"shutdown"` stops the runtime and removes
its temporary storage. Hard kills can leave the OS temporary directory behind.
The persistent CLI (`npm start -- <server-config>`) remains the deployment path.

For qp's opt-in Rust interoperability test:

```sh
QUICK_PRESENTER_TEST_CONFIG=/absolute/path/to/new-config.toml \
  cargo test --bin quick-presenter \
  audience_relay::fixture_tests::external_relay_room_creation_round_trip_and_termination -- --ignored
```

Run that command in the qp repository with this runtime still running. The test
creates rooms through HTTP and checks presenter/audience sockets, engine delivery,
termination and a second room. It does not prove rendered QR or animation behavior.

Startup failures report a bounded system error code such as `EADDRINUSE` (listener
already in use) or `EEXIST` (output file exists). Argument/configuration failures
use a fixed diagnostic. Raw error messages, output paths and credentials are not
included in failure diagnostics; failures still exit with status 1.
