# maxforge MCP bridge example

This patch lets an MCP client replace a managed Max subgraph without
`node.script`, Max JavaScript, or raw `thispatcher` commands.

The boundary is deliberately split:

1. `maxforge-mcp` exposes tools over MCP stdio and listens only on
   `127.0.0.1:8766`.
2. The native `bbb.agent.hub` external carries raw plan JSON over localhost
   WebSocket.
3. The native `maxforge.sync` external validates and applies the plan through
   the Max SDK.
4. `maxforge.sync` sends revision acknowledgements and live structural patch
   snapshots back to the MCP process.

## Requirements

- Node.js 20 or newer.
- The built `maxforge.sync` external from this repository.
- The built `bbb.agent.hub` external from the sibling
  [bbb.agent](https://github.com/2bbb/bbb.agent) package.

The `bbb.agent` helper process is not used. Only its generic native WebSocket
transport external is required.

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

Make both repositories visible to Max as packages, then restart Max after
building or replacing an external.

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

3. Call `maxforge_list_patches`; it must report `maxforge_bridge` with scope
   `agent_demo` and `controller: true`.
4. To work in the controller itself, call `maxforge_inspect_patch` with
   `patcherId: maxforge_bridge` and scope `agent_demo`. This reads the live
   patch graph without looking at the Max window. Before the first apply,
   `comparisonAvailable` is false.
5. Call `maxforge_compile_plan` with the same `patcherId` and scope plus the
   full contents of `desired.maxdsl`.
6. Inspect the plan, then call `maxforge_apply_dsl` with the same target and
   DSL.
7. Confirm eight managed toggle/number pairs appear and the tool returns a
   matching `maxforge.applied` acknowledgement.
8. Move, edit, connect, create, or delete a box manually, then call
   `maxforge_inspect_patch` again. The response reports the exact structural
   change and whether it touches maxforge-managed state.

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
inspection. Do not identify a patch by its title.

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
