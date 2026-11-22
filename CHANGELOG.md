# Changelog

## 1.0.1

- Correct the server's Node.js requirement to 22.13.0+ within 22.x or 24.0.0+;
  Node 22.12.0 cannot load the SQLite API without an experimental flag.
- Test the exact minimum supported Node.js version in CI alongside current lines.
- Compare packed package versions against source metadata instead of a fixed
  release string, preserving exact internal dependency alignment.
- Document private vulnerability reporting and the supported security update line.
- Document verification of provenance and anonymous installation after trusted
  publication. Keep pressure and capacity diagnostics out of automatic CI.

## 1.0.0

- Initial public release of the self-hosted relay server, portable room core and
  audience browser, implementing Relay Protocol 1 under Apache-2.0.
