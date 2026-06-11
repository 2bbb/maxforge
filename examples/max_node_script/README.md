# maxforge node.script demo

This is a Max runtime smoke test for `node.script -> thispatcher` generation.

## Files

- `maxforge_node_script_demo.maxpat` — open this in Max.
- `maxforge_node_script_demo.maxdsl` — source for the Max harness patch above.
- `maxforge_node_script_demo.cjs` — node.script code that imports the local maxforge build.
- `generated_patch.maxdsl` — DSL compiled inside Max at runtime.
- `generated_patch.maxpat` — precompiled reference output for the runtime-generated patch.

## Run

From the repository root:

```bash
npm install
npm run build
```

Then open `examples/max_node_script/maxforge_node_script_demo.maxpat` in Max.

1. Open the Max Console.
2. Click `generate`.
3. Confirm generated objects appear in the same patcher.
4. Click the generated message box; it should print to the Max Console through the generated `print maxforge-generated` object.
5. Click `clear` to remove the generated boxes.

## Known limitation

This demo intentionally generates a flat patcher. Nested subpatcher commands are represented by `targetPath` in the maxforge API, but this simple Max patch does not include a nested-patcher router.
