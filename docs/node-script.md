# `node.script` and `thispatcher` integration

maxforge can turn DSL into arrays representing Max `thispatcher` scripting
messages. This is a library integration for projects already using
`node.script`; it is separate from the native `maxforge.sync` and MCP path.

## Flat patch example

```js
// max-api is supplied by Max, not by maxforge.
const maxApi = require("max-api");

async function compileToThispatcher(dsl) {
  const { compileDslToThispatcherCommands, loadDatabase } =
    await import("maxforge");
  const db = await loadDatabase();
  const result = compileDslToThispatcherCommands(dsl, db);

  if (!result.success) {
    maxApi.error(JSON.stringify(result.errors));
    return;
  }

  for (const command of result.commands) {
    if (command.targetPath.length === 0) {
      maxApi.outlet(...command.message);
    } else {
      maxApi.post(JSON.stringify(command));
    }
  }
}

maxApi.addHandler("dsl", compileToThispatcher);
```

Connect the `node.script` outlet to `thispatcher` to apply top-level commands.

## Nested targets

DSL-defined subpatchers and the `asSubpatcher` API option produce commands with
a non-empty `targetPath`. A plain connection to one top-level `thispatcher`
does not route those messages into nested patchers. A Max-side router/helper is
required, or the generated patch must remain flat.

This limitation is explicit: maxforge emits routing information but does not
claim that `thispatcher` provides nested routing by itself.

## Repository example

The runnable flat-patcher smoke test is in `examples/max_node_script/`.

```bash
npm install
npm run build
open examples/max_node_script/maxforge_node_script_demo.maxpat
```

See the [example README](../examples/max_node_script/README.md) for the files,
controls, and expected result.

## When to use the native path instead

Use `maxforge.sync` with `maxforge-mcp` when an agent must inspect a live patch,
maintain revisions, reconcile human edits, or operate several registered Max
windows. That path mutates through the Max SDK and does not require
`node.script`, JavaScript, or `thispatcher` wiring. See [MCP control](mcp.md).
