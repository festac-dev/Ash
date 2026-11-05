# Contributing

Use Node 22 and Go 1.25+. Run `npm ci --ignore-scripts`, then `npm run demo` for isolated
local development. Never use production credentials or customer data in tests.

Create a topic branch. Preserve existing work before editing and use conventional
commits (`fix:`, `feat:`, `docs:`, `test:`, `chore:`). Keep provider implementations behind
the existing interfaces; business logic must not substitute demo output in live mode.
Respect typed approvals, integer minor-unit accounting, atomic writes and redaction.

Before a PR, run format, lint, typecheck, Node tests, TUI tests and production build.
Run access/TLS/browser checks when changing those boundaries. Use `npm run format` and
`gofmt` for edited code. Test meaningful behavior and failure paths; do not conceal
failures, weaken security controls or replace live integrations with mocks.

PR descriptions should state the problem, resulting behavior, validation actually run
and material limitations. Include UI screenshots when behavior or layout changes.
Reviewers must check data compatibility, secret exposure, provider effects, approval
semantics and shutdown/recovery. Merging, pushing and release deployment belong to the
repository owner. Report vulnerabilities privately; see SECURITY.md.
