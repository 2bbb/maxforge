# Maxforge repository agent rules

## Version preflight

For the first maxforge-related task in each Agent session, use the relevant
`maxforge` or `maxforge-mcp` skill. Run
`scripts/refresh-skills.mjs --json` first. If it updates a skill, reload the
installed instructions before running `scripts/check-version.mjs --json`.

- Do not run the preflight for unrelated general Max/MSP questions.
- Do not repeat it unless configuration/package state changes, an update is
  being prepared, or the user requests another check.
- Never infer the loaded native external from filesystem metadata; live MCP
  status and patch registration are authoritative.
- A discovered update is not permission to install it. Keep MCP, broker, and
  the complete Max package on one exact version when updating.
- For an authorized update, never omit the detached broker. Rewrite only the
  maxforge MCP pin, replace the complete Max package, request a new Codex session
  when skills/config changed, and request Max relaunch only if Max was running.
