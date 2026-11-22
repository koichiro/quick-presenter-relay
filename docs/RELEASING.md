# Releasing Quick Presenter Relay

The server, portable core and audience browser are released together as version
`1.0.2`. All three npm packages use Apache-2.0 and retain LICENSE and NOTICE.
Relay Protocol `1` and extension API `1-draft.1` are versioned independently.

## Verify a candidate

Use a clean checkout of the selected public commit:

```sh
npm ci
npm run ci
npm audit
npm run pack:core
npm run pack:web
npm run pack:server
```

The functional suite installs actual tarballs into fresh consumers. It verifies
standalone core types, browser asset identity and installed-server HTTP/WebSocket
operation without source or build tools. Every measured file must retain at least
80% statements, branches, functions and lines, including unexecuted source.

Review all source and tarball entries, embedded source maps, dependency licenses,
package metadata and examples. Include no credentials, databases, customer data,
logs or machine paths. Record per-file/source/package hashes with the exact public
commit. Never reuse an old archive's review to approve changed bytes.

Large fan-out, saturation, close-burst and sustained diagnostics are explicit
local commands (`npm run test:pressure`, `npm run test:capacity`). They are excluded
from ordinary CI and the release workflow. Do not interpret finite local tests as
production capacity or exactly-once delivery. Reconnect never replays content.

## Prepare the tagged artifacts

Keep package versions and the server's exact core/browser dependencies aligned.
Create a `vMAJOR.MINOR.PATCH` tag on a reviewed commit reachable from `main`.
Run **npm release** (`.github/workflows/publish.yml`) with that tag and `publish`
left false. It verifies the source/version identity, executes functional CI and
uploads three tarballs plus `SHA256SUMS` as the `npm-packages` artifact.

The three distribution names are:

- `quick-presenter-relay`: compiled Node CLI, schemas, documentation and exact core/browser dependencies.
- `quick-presenter-relay-core`: portable ESM/types and protocol assets, with no runtime npm dependencies.
- `quick-presenter-audience-web`: HTML/ES module and notices, with no runtime npm dependencies.

Attach the verified artifacts to the matching GitHub release. Source history and
package contents are separate review boundaries. Consumers must explicitly adopt
and verify changed browser assets even when wire compatibility is preserved.

## First registry publication

A maintainer must authenticate with npm and have permission to create the package
names. Configure 2FA according to npm's publishing requirements. Download the
verified workflow artifact, check its checksums and publish its exact tarballs in
dependency order:

```sh
RELEASE_VERSION=1.0.2 # Set this to the selected release tag without its v prefix.
npm login --registry=https://registry.npmjs.org/
npm publish "./quick-presenter-relay-core-${RELEASE_VERSION}.tgz" --ignore-scripts --access=public
npm publish "./quick-presenter-audience-web-${RELEASE_VERSION}.tgz" --ignore-scripts --access=public
npm publish "./quick-presenter-relay-${RELEASE_VERSION}.tgz" --ignore-scripts --access=public
```

Complete any npm browser/2FA challenge directly; never put credentials into source,
issues or workflow logs. Verify each published version's integrity against the
reviewed tarball and test installation from the registry. A locally authenticated
bootstrap publication does not carry GitHub Actions OIDC provenance.

## Subsequent trusted publishing

After the packages exist, configure each npm trusted publisher for owner
`koichiro`, repository `quick-presenter-relay`, workflow `publish.yml`, environment
`npm`, with direct publishing allowed. The
[npm trusted publisher documentation](https://docs.npmjs.com/trusted-publishers/)
describes required authentication and configuration expiry: new connections must
complete a successful publication within two days. Create or renew the connection
when preparing the next publication.

Run the same workflow with `publish` true for the reviewed tag. Its separate
publish job uses OIDC and provenance, verifies the downloaded checksums and
publishes in dependency order. It skips an existing version only when its registry
integrity exactly matches the tarball; network errors or conflicting bytes stop
publication. A partial failure can be retried after its cause is corrected.
Verify that all three registry versions have provenance attestations, compare their
SHA-512 integrity with the workflow tarballs and test an anonymous installation.
Publish the matching GitHub release only after those checks pass.
No npm write token is stored in this repository. An existing name/version cannot
be replaced; fix a released defect with a new version.
