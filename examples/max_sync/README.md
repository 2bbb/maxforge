# maxforge.sync native external demo

This example applies a maxforge managed `PatchPlan` directly through the
`maxforge.sync` C++ external. Max does not run JavaScript or `node.script`.

## Build and generate

From the repository root:

```bash
git submodule update --init --recursive
cmake -S . -B build
cmake --build build
npm run build
node dist/cli/index.js plan examples/max_sync/managed_patch.maxdsl \
  --scope sync_demo \
  --compact \
  -o help/managed_plan.json
node dist/cli/index.js compile examples/max_sync/maxforge_sync_demo.maxdsl \
  -o examples/max_sync/maxforge_sync_demo.maxpat
```

Make this repository visible to Max as a package, or add its `externals`
directory to Max's file preferences.

## Run

1. Open `maxforge_sync_demo.maxpat`.
2. Open the Max Console.
3. Confirm 12 toggle/number pairs and a `p generated_bank` box appear automatically.
4. Open `p generated_bank` and confirm four more managed pairs were created inside it.
5. Click **revision** and confirm the external reports the target revision.

The plan starts from an empty `sync_demo` scope. Click **apply plan** again to
confirm it is rejected because its `baseRevision` is stale. Use **import plan**
after regenerating `help/managed_plan.json`.

## Safety boundary

Only boxes whose scripting name exactly matches
`maxforge_sync_demo_obj_<dsl-name>` are managed. The demo controls,
`dict`, `print`, and `maxforge.sync` are outside that namespace.

Protocol v1 validates the entire plan before mutation, but it cannot roll back
a runtime failure after mutation has started. A partial failure is reported and
the revision is not advanced.
