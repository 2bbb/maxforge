# Working documentation

This directory contains maintainer-facing material that is useful during
development and release validation but is not shipped in the npm package or
Max package.

- [Test matrix](test-matrix.md) — ownership of each validation boundary and
  known automation gaps.
- [Manual test checklist](manual-test-checklist.md) — reproducible checks that
  require Max, an MCP host, user interaction, a second machine, or OS security
  UI.

Keep the matrix honest. A test is not "automated" merely because an agent can
drive it on one developer machine. It is automated only when CI runs it and
fails deterministically without human interpretation.
