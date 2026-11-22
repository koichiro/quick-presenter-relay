# Runtime dependencies and license inventory

This inventory describes the locked source distribution. Preserve LICENSE/NOTICE when redistributing
project packages and retain dependency notices when redistributing their code.

| Dependency           | Locked version | Declared license | Installed license file                      |
| -------------------- | -------------- | ---------------- | ------------------------------------------- |
| ajv                  | 8.20.0         | MIT              | `node_modules/ajv/LICENSE`                  |
| fast-deep-equal      | 3.1.3          | MIT              | `node_modules/fast-deep-equal/LICENSE`      |
| fast-uri             | 3.1.9          | BSD-3-Clause     | `node_modules/fast-uri/LICENSE`             |
| json-schema-traverse | 1.0.0          | MIT              | `node_modules/json-schema-traverse/LICENSE` |
| require-from-string  | 2.0.2          | MIT              | `node_modules/require-from-string/license`  |
| ws                   | 8.23.0         | MIT              | `node_modules/ws/LICENSE`                   |

The root Node runtime uses these registry dependencies, including ajv's transitive
dependencies. The two workspace packages are Apache-2.0. Room Core has no runtime
npm dependencies; its tarball includes generated source maps with project-owned
source. Audience Web ships project-owned HTML/JavaScript and has no runtime npm
dependencies. The core/browser tarballs do not bundle the Node server or the six registry packages.
The separate server tarball ships compiled server code and installs its exact
core/browser versions and declared registry dependencies through npm.
Node and its built-in SQLite implementation are supplied by the operator's Node
installation, not redistributed inside these two packages.

The lockfile and installed license texts are the review inputs. This table must
be rechecked when the dependency graph changes. Development tooling has a separate
transitive dependency graph and is installed from the lockfile for builds/tests;
its metadata and licenses must also be reviewed if tooling is redistributed.

The coverage tool remains c8 12.0.0. Its test-exclude dependency is constrained to
glob 14.0.6 and minimatch 11.0.9 through explicit overrides, addressing their
reported cancellation and pattern-amplification advisories without downgrading
c8 or changing coverage selection. Both retain the named CommonJS interfaces
used by test-exclude; the full per-file coverage run verifies their integration.
These development dependencies and the added nonrecursive-glob-match helper use
BlueOak-1.0.0; they are absent from the two runtime package tarballs. Review or
remove the overrides when test-exclude adopts fixed versions itself.
