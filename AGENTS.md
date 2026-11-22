# Agent instructions

- Communicate with the user in Japanese. All source code, comments, documentation,
  developer-facing strings, commit messages, and GitHub interactions are English.
- Use Apache-2.0 for new project-owned artifacts. Do not copy GPL-only qp code
  without documented permission. Preserve unrelated changes and project boundaries.
- Keep this repository limited to its documented open-source scope. Do not add
  unrelated product plans, implementation details or business information.
- Implement only the requested milestone. Keep Room Core platform-independent;
  isolate transport/storage adapters. Audience events contain no PDFs, notes,
  paths or presentation-control commands.
- Use the checked-in Biome rules. For code, contracts, dependencies or CI changes,
  run `npm ci`, then `npm run ci`. For documentation-only changes, run `git diff --check`.
- Maintain at least 80% statements, branches, functions and lines per measured
  source file. Test meaningful behavior; never weaken thresholds, omit source or
  add coverage-ignore directives to bypass a failure.
- Update protocol docs, schemas and positive/negative fixtures together. Cover
  admission, stale epochs, pause, reconnect, room deadlines and failure paths.
  Do not claim schema tests prove authentication or runtime reliability.
- Use dummy credentials and synthetic comments in tests; never log real secrets.
  Do not publish, push, deploy or create GitHub issues/PRs without task authorization.
