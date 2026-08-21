# Maxforge repository agent rules

## Version preflight

For the first maxforge-related task in each Agent session, use the relevant
`maxforge` or `maxforge-mcp` skill and run its bundled
`scripts/check-version.mjs --json` preflight.

- Do not run the preflight for unrelated general Max/MSP questions.
- Do not repeat it unless configuration/package state changes, an update is
  being prepared, or the user requests another check.
- Never infer the loaded native external from filesystem metadata; live MCP
  status and patch registration are authoritative.
- A discovered update is not permission to install it. Keep MCP, broker, and
  the complete Max package on one exact version when updating.
