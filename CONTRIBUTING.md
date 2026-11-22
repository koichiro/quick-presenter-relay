# Contributing

Contributions are licensed under Apache-2.0. Use a Signed-off-by line to certify
Developer Certificate of Origin 1.1: https://developercertificate.org/ . This does
not transfer copyright. Keep code, documentation and every GitHub interaction in
English. Do not publish without project-owner authorization.

Keep changes small. Protocol changes include schemas, positive/negative fixtures,
state traces, compatibility notes and `npm run ci` evidence. Relay Protocol v1 uses exact version/field validation; breaking changes require
a new reviewed wire version. The extension API remains independently versioned. Do not remove failing cases merely to accommodate an implementation.
Do not submit credentials, production traffic or third-party code without license
and provenance review. Native application code stays in Quick Presenter.

## Quality gates

Run `npm ci` and `npm run ci` for code/contract/tooling changes. Biome is the
formatting/lint authority for JS/TS and JSON. Use `npm run check:fix` for safe fixes
and `npm run format` for formatting. Do not edit the lockfile by hand.

Coverage includes unimported source under scripts/src/packages, excluding tests,
declaration files and generated output. Statements, branches, functions and lines
must each reach 80% per file. Exercise normal/failure behavior; do not bypass the
threshold with ignores/exclusions. Strict TypeScript checks cover both the room core and runtime.
