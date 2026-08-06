# maxforge MCP bridge example

This patch lets an MCP client replace a managed Max subgraph without
`node.script`, Max JavaScript, or raw `thispatcher` commands.

The boundary is deliberately narrow:

1. `maxforge-mcp` exposes tools over MCP stdio and listens on
   `127.0.0.1:8766` by default.
2. The native `maxforge.sync` external owns the WebSocket connection,
   validates requests, and applies plans through the Max SDK.
3. `maxforge.sync` sends revision acknowledgements and live structural patch
   snapshots back to the MCP process.

## Requirements

- Node.js 20 or newer.
- The built `maxforge.sync` external from this repository.

Installing `maxforge` from npm provides the `maxforge-mcp` executable but does
not install the native external into Max. The external remains a separate
runtime prerequisite.

For a Max machine elsewhere on the LAN, set `MAXFORGE_WS_TOKEN` in the MCP
server environment. This changes the default bind host to `0.0.0.0`. Change
the example object's `@host` to the MCP machine's LAN address and add the same
`@token`. Do not use LAN mode on an untrusted network; transport is plaintext.

The external compiles the reusable WebSocket client source pinned through the
`bbb.agent` submodule. Neither the `bbb.agent.hub` external nor the
`bbb.agent` helper process is a runtime dependency.

The `.maxdsl` writes `\@host`, `\@scope`, and the other initialization
arguments with escaped leading `@` tokens. This keeps them in the `newobj`
text, which min-api reads at construction time; unescaped DSL attributes would
instead become box JSON keys.

## Build the patch and external

From the repository root:

```bash
git submodule update --init --recursive
cmake -S . -B build
cmake --build build
npm install
npm run build
maxforge compile examples/mcp_bridge/maxforge_mcp_bridge.maxdsl \
  -o examples/mcp_bridge/maxforge_mcp_bridge.maxpat
```

Make this repository visible to Max as a package, then restart Max after
building or replacing the external.

## MCP configuration

For a published package, configure the MCP client to launch:

```json
{
  "mcpServers": {
    "maxforge": {
      "command": "npx",
      "args": [
        "-y",
        "--package=maxforge@latest",
        "maxforge-mcp"
      ]
    }
  }
}
```

For repository development, use an absolute path:

```json
{
  "mcpServers": {
    "maxforge": {
      "command": "node",
      "args": [
        "/absolute/path/to/maxforge/dist/mcp/server.js"
      ]
    }
  }
}
```

For an AI agent that supports installable skills, add the live-control workflow:

```bash
npx skills add 2bbb/maxforge --skill maxforge-mcp
```

The skill provides target selection and recovery rules. It does not replace the
MCP server configuration or native external installation above.

## Run

1. Start or reconnect the MCP client so `maxforge-mcp` is running.
2. Launch Max through LaunchServices and open the bridge as a document:

   ```bash
   /usr/bin/open -F \
     -a /Applications/Max.app \
     --stdout /tmp/maxforge-max.stdout.log \
     --stderr /tmp/maxforge-max.stderr.log \
     "$PWD/examples/mcp_bridge/maxforge_mcp_bridge.maxpat"
   ```

   Pass the patch as the document operand, not after `--args`. The latter only
   forwards values to the application's `main()` and Max does not guarantee a
   command-line patch-loading interface. `-F` suppresses macOS saved-window
   restoration, but it does not disable Max's own crash recovery.

   Native startup output is captured in the two `/tmp` files. Max console and
   `maxforge.sync` messages remain in:

   ```text
   ~/Library/Application Support/Cycling '74/Max 9/Logs/Max.log
   ```

3. Call `maxforge_help` with `topic: "workflow"`. This returns the current
   agent-facing mutation and verification rules without requiring a live target.
4. Call `maxforge_list_patches`; it must report `maxforge_bridge` with scope
   `agent_demo` and `controller: true`.
5. To work in the controller itself, call `maxforge_inspect_patch` with
   `patcherId: maxforge_bridge` and scope `agent_demo`. This reads the live
   patch graph without looking at the Max window. Before the first apply,
   `comparisonAvailable` is false.
6. Call `maxforge_compile_plan` with the following arguments, replacing the
   placeholder with the full contents of `desired.maxdsl`:

   ```json
   {
     "patcherId": "maxforge_bridge",
     "scope": "agent_demo",
     "desiredDsl": "<complete desired.maxdsl source>"
   }
   ```

7. Inspect every operation and warning, then call `maxforge_apply_dsl` with the
   same arguments. Do not reduce `desiredDsl` to only the new object; it owns the
   complete managed scope.
8. Confirm eight managed toggle/number pairs appear and all of these are true:
   `acknowledgement.revision === targetRevision`, acknowledgement operations
   equal `operationCount`, and `baselineCaptured` is true.
9. Call `maxforge_inspect_patch` again and verify the expected boxes and cords.
10. Move, edit, connect, create, or delete a box manually, then call
    `maxforge_inspect_patch` again. The response reports the exact structural
    change and whether it touches maxforge-managed state.
11. Pass the next complete desired DSL to `maxforge_reconcile_patch`. Continue
    only when `canApply` is true and every returned operation is intended.
12. Call `maxforge_apply_dsl` with the same target and DSL plus
    `manualChanges: "merge"`. Inspect again and verify that the human edit and
    the agent's independent additions both remain.

Inspection alone does not adopt a managed manual change. Reconciliation performs
a three-way merge against the previous agent intent and reports same-field,
change-vs-delete, ownership, and unmanaged-cord conflicts instead of silently
choosing a winner. Apply repeats inspection and binds the resulting plan to its
`baseStructureToken`; if the patch changes again before native mutation,
`maxforge.sync` rejects the stale plan. On timeout, transport error, baseline
warning, or token rejection, inspect again rather than blindly repeating the
mutation.

To work in a separate window instead, call `maxforge_create_patch`:

```json
{
  "patcherId": "generated_patch",
  "scope": "generated",
  "title": "Generated patch"
}
```

Wait for the tool to return the registered patch, then use
`patcherId: generated_patch` and scope `generated` for compile, apply, and
inspection. The generated window also starts with one configured
`maxforge.sync` object and no bootstrap patch cords. Do not identify a patch by
its title.

After the MCP process restarts, it cannot reconstruct a graph from a revision
hash. If Max already reports an initialized revision, pass the previous full
DSL as `currentDsl` once. Guessing or using an empty current graph is rejected.
The new process can still inspect the complete live graph, but it cannot infer
pre-restart changes until an apply captures a new baseline.

## Safety boundary

The bridge patch itself is unmanaged. Only scripting names matching
`maxforge_agent_demo_obj_<dsl-name>` are mutable through this scope.

The plan is fully validated before mutation, but protocol v1 is not
transactional. A runtime operation failure can leave a partial patch; the
revision is not advanced and the MCP call fails.
