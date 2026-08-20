import { describe, expect, it } from "vitest";
import {
  compile,
  compileDslToPatchGraph,
  createEmptyPatchGraph,
  createPatchGraph,
  diffPatchGraphs,
  managedIdFromVarName,
  parse,
  PatchGraph,
  patchGraphToDsl,
  patcherToPatchGraph,
} from "../src/index.js";
import { ObjectDatabase } from "../src/core/types.js";
import dbData from "../data/objects.json" with { type: "json" };

const db = dbData as unknown as ObjectDatabase;

function compileGraph(source: string, scope = "voices"): PatchGraph {
  const result = compileDslToPatchGraph(source, db, scope);
  expect(result.errors).toHaveLength(0);
  expect(result.success).toBe(true);
  return result.graph!;
}

describe("managed patch graphs", () => {
  it("rejects numeric-only managed identity suffixes", () => {
    expect(managedIdFromVarName("voices", "maxforge_voices_obj_1")).toBeNull();
    expect(managedIdFromVarName("voices", "maxforge_voices_obj_1osc")).toBe(
      "obj-1osc"
    );
  });

  it("serializes nested managed graphs to lossless explicit working DSL", () => {
    const graph = compileGraph(`
source = cycle~ 440 @presentation 1 at(-12.5, 20.25, 123.5, 31)
fx = p pass at(160, 20, 140, 28) {
  input = inlet signal "audio input" at(20, 20, 35, 22)
  output = outlet signal "audio output" at(100, 20, 35, 22)
  input -> output
}
source -> fx
`);

    const workingDsl = patchGraphToDsl(graph);
    expect(workingDsl).toContain(
      "source = cycle~ 440 @presentation 1 at(-12.5, 20.25, 123.5, 31)"
    );
    expect(workingDsl).toContain("fx = p pass at(160, 20, 140, 28)");
    expect(workingDsl).toContain(
      'input = inlet signal "audio input" at(20, 20, 35, 22)'
    );

    const roundTrip = compileGraph(workingDsl);
    expect(roundTrip).toEqual(graph);
  });

  it("preserves managed DSL names exactly when serializing a graph", () => {
    const graph = compileGraph(`
1osc = cycle~ 440 at(20, 20, 80, 22)
gain_ = *~ 0.5 at(120, 20, 60, 22)
1osc -> gain_
`);

    const workingDsl = patchGraphToDsl(graph);
    expect(workingDsl).toContain("1osc = cycle~ 440");
    expect(workingDsl).toContain("gain_ = *~ 0.5");
    expect(workingDsl).toContain("1osc -> gain_");
    expect(compileGraph(workingDsl)).toEqual(graph);
  });

  it("assigns stable managed varnames to generated and nested objects", () => {
    const graph = compileGraph(`
for i in 0..1 {
  osc_\${i} = cycle~ \${440 + i * 20}
}
fx = p pass {
  in = inlet signal
  out = outlet signal
  in -> out
}
`);

    expect(graph.patcher.boxes.map((box) => box.varName)).toEqual([
      "maxforge_voices_obj_osc_0",
      "maxforge_voices_obj_osc_1",
      "maxforge_voices_obj_fx",
    ]);
    expect(graph.patcher.boxes[2].patcher?.boxes.map((box) => box.varName)).toEqual([
      "maxforge_voices_obj_in",
      "maxforge_voices_obj_out",
    ]);
    expect(graph.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects custom varnames because they break ownership tracking", () => {
    const result = compileDslToPatchGraph(
      "osc = cycle~ 440 @varname custom",
      db,
      "voices"
    );

    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "E009",
      message: "Managed patch graphs reserve @varname for stable object identity",
      line: 1,
    });
  });

  it("creates a complete patch from an empty managed scope", () => {
    const desired = compileGraph(`
osc = cycle~ 440 at(20, 30)
dac = ezdac~ at(120, 30)
osc -> dac
`);
    const plan = diffPatchGraphs(createEmptyPatchGraph("voices"), desired);

    expect(plan.operations.map((operation) => operation.op)).toEqual([
      "create",
      "create",
      "connect",
    ]);
    expect(plan.operations[0]).toMatchObject({
      op: "create",
      targetPath: [],
      box: {
        id: "obj-osc",
        varName: "maxforge_voices_obj_osc",
        text: "cycle~ 440",
      },
    });
  });

  it("only adds new loop instances when the desired count grows", () => {
    const current = compileGraph(`
for i in 0..1 {
  osc_\${i} = cycle~ \${440 + i * 20} at(\${20 + i * 100}, 30)
  gain_\${i} = *~ 0.25 at(\${20 + i * 100}, 80)
  osc_\${i} -> gain_\${i}
}
`);
    const desired = compileGraph(`
for i in 0..2 {
  osc_\${i} = cycle~ \${440 + i * 20} at(\${20 + i * 100}, 30)
  gain_\${i} = *~ 0.25 at(\${20 + i * 100}, 80)
  osc_\${i} -> gain_\${i}
}
`);
    const plan = diffPatchGraphs(current, desired);

    expect(plan.operations.map((operation) => operation.op)).toEqual([
      "create",
      "create",
      "connect",
    ]);
    expect(plan.operations[0]).toMatchObject({
      op: "create",
      box: { id: "obj-osc_2" },
    });
    expect(plan.operations[1]).toMatchObject({
      op: "create",
      box: { id: "obj-gain_2" },
    });
  });

  it("disconnects and removes only obsolete loop instances", () => {
    const current = compileGraph(`
for i in 0..2 {
  osc_\${i} = cycle~ \${440 + i * 20} at(\${20 + i * 100}, 30)
  gain_\${i} = *~ 0.25 at(\${20 + i * 100}, 80)
  osc_\${i} -> gain_\${i}
}
`);
    const desired = compileGraph(`
for i in 0..1 {
  osc_\${i} = cycle~ \${440 + i * 20} at(\${20 + i * 100}, 30)
  gain_\${i} = *~ 0.25 at(\${20 + i * 100}, 80)
  osc_\${i} -> gain_\${i}
}
`);
    const plan = diffPatchGraphs(current, desired);

    expect(plan.operations.map((operation) => operation.op)).toEqual([
      "disconnect",
      "delete",
      "delete",
    ]);
    expect(plan.operations.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "delete", id: "obj-osc_2" }),
        expect.objectContaining({ op: "delete", id: "obj-gain_2" }),
      ])
    );
  });

  it("recreates changed objects and reconnects their stable endpoints", () => {
    const current = compileGraph(`
osc = cycle~ 440
gain = *~ 0.25
osc -> gain
`);
    const desired = compileGraph(`
osc = cycle~ 880
gain = *~ 0.25
osc -> gain
`);
    const plan = diffPatchGraphs(current, desired);

    expect(plan.operations.map((operation) => operation.op)).toEqual([
      "disconnect",
      "delete",
      "create",
      "connect",
    ]);
    expect(plan.operations[1]).toMatchObject({ op: "delete", id: "obj-osc" });
    expect(plan.operations[2]).toMatchObject({
      op: "create",
      box: { id: "obj-osc", text: "cycle~ 880" },
    });
    expect(plan.rollbackOperations?.map((operation) => operation.op)).toEqual([
      "disconnect",
      "delete",
      "create",
      "connect",
    ]);
    expect(plan.rollbackOperations?.[2]).toMatchObject({
      op: "create",
      box: { id: "obj-osc", text: "cycle~ 440" },
    });
  });

  it("uses an attribute update for position-only changes", () => {
    const current = compileGraph("osc = cycle~ 440 at(10, 20)");
    const desired = compileGraph("osc = cycle~ 440 at(30, 40)");
    const plan = diffPatchGraphs(current, desired);

    expect(plan.operations).toEqual([
      {
        op: "set",
        targetPath: [],
        id: "obj-osc",
        varName: "maxforge_voices_obj_osc",
        attribute: "patching_rect",
        value: [30, 40, 80, 22],
      },
    ]);
    expect(plan.rollbackOperations).toEqual([
      {
        op: "set",
        targetPath: [],
        id: "obj-osc",
        varName: "maxforge_voices_obj_osc",
        attribute: "patching_rect",
        value: [10, 20, 80, 22],
      },
    ]);
  });

  it("updates message text without deleting and recreating the box", () => {
    const current = compileGraph('msg = message "before"');
    const desired = compileGraph('msg = message "after"');

    expect(diffPatchGraphs(current, desired).operations).toEqual([
      {
        op: "set",
        targetPath: [],
        id: "obj-msg",
        varName: "maxforge_voices_obj_msg",
        attribute: "text",
        value: "after",
      },
    ]);
  });

  it("updates port comments and scalar attributes without replacement", () => {
    const current = compileGraph(`
fx = p pass {
  input = inlet signal "before" @presentation 0
}
`);
    const desired = compileGraph(`
fx = p pass {
  input = inlet signal "after" @presentation 1
}
`);

    expect(diffPatchGraphs(current, desired).operations).toEqual([
      {
        op: "set",
        targetPath: ["maxforge_voices_obj_fx"],
        id: "obj-input",
        varName: "maxforge_voices_obj_input",
        attribute: "comment",
        value: "after",
      },
      {
        op: "set",
        targetPath: ["maxforge_voices_obj_fx"],
        id: "obj-input",
        varName: "maxforge_voices_obj_input",
        attribute: "presentation",
        value: 1,
      },
    ]);
  });

  it("replaces boxes when an attribute or comment must be removed", () => {
    const withAttribute = compileGraph("button = button @presentation 1");
    const withoutAttribute = compileGraph("button = button");
    expect(diffPatchGraphs(withAttribute, withoutAttribute).operations.map(
      (operation) => operation.op
    )).toEqual(["delete", "create"]);

    const withComment = compileGraph(`
fx = p pass {
  input = inlet signal "label"
}
`);
    const withoutComment = compileGraph(`
fx = p pass {
  input = inlet signal
}
`);
    expect(diffPatchGraphs(withComment, withoutComment).operations.map(
      (operation) => operation.op
    )).toEqual(["delete", "create"]);
  });

  it("keeps revisions stable when declarations are only reordered", () => {
    const first = compileGraph("osc = cycle~ 440\ngain = *~ 0.25\nosc -> gain");
    const reordered = compileGraph("gain = *~ 0.25\nosc = cycle~ 440\nosc -> gain");

    expect(reordered.revision).toBe(first.revision);
    expect(diffPatchGraphs(first, reordered).operations).toEqual([]);
  });

  it("clones and freezes graph state so revisions cannot become stale", () => {
    const patcher = {
      boxes: [{
        id: "obj-osc",
        varName: "maxforge_voices_obj_osc",
        maxclass: "newobj",
        numinlets: 2,
        numoutlets: 1,
        outlettype: ["signal"],
        patchingRect: [10, 20, 80, 22] as [number, number, number, number],
        text: "cycle~ 440",
        attributes: {},
      }],
      connections: [],
    };
    const graph = createPatchGraph("voices", patcher);
    patcher.boxes[0].text = "cycle~ 880";

    expect(graph.patcher.boxes[0].text).toBe("cycle~ 440");
    expect(() => {
      (graph.patcher.boxes as unknown as unknown[]).push({});
    }).toThrow();
  });

  it("rejects unsupported protocol versions at the diff boundary", () => {
    const current = {
      ...createEmptyPatchGraph("voices"),
      protocolVersion: 2,
    } as unknown as PatchGraph;

    expect(() => diffPatchGraphs(current, createEmptyPatchGraph("voices"))).toThrow(
      "Unsupported patch graph protocol version: 2"
    );
  });

  it("ignores boxes outside the managed scope", () => {
    const current = createPatchGraph("voices", {
      boxes: [{
        id: "manual",
        varName: "manual_button",
        maxclass: "button",
        numinlets: 1,
        numoutlets: 1,
        outlettype: ["bang"],
        patchingRect: [10, 10, 24, 24],
        attributes: {},
      }],
      connections: [],
    });

    const plan = diffPatchGraphs(current, createEmptyPatchGraph("voices"));
    expect(plan.operations).toEqual([]);
  });

  it("preserves managed varnames and ignores manual boxes in patcher snapshots", () => {
    const { ast } = parse(`
osc = cycle~ 440
gain = *~ 0.25
osc -> gain
manual = button
`);
    const compiled = compile(ast, db).output!;
    const [osc, gain, manual] = compiled.patcher.boxes.map(({ box }) => box);
    osc.id = "obj-91";
    osc.varname = "maxforge_voices_obj_osc";
    gain.id = "obj-92";
    gain.varname = "maxforge_voices_obj_gain";
    manual.id = "obj-93";
    manual.varname = "manual_button";
    compiled.patcher.lines[0].patchline.source[0] = osc.id;
    compiled.patcher.lines[0].patchline.destination[0] = gain.id;

    const snapshot = patcherToPatchGraph(compiled, "voices");

    expect(snapshot.patcher.boxes.map((box) => box.id)).toEqual([
      "obj-osc",
      "obj-gain",
    ]);
    expect(snapshot.patcher.boxes.map((box) => box.varName)).toEqual([
      "maxforge_voices_obj_osc",
      "maxforge_voices_obj_gain",
    ]);
    expect(snapshot.patcher.connections[0]).toMatchObject({
      source: { id: "obj-osc" },
      destination: { id: "obj-gain" },
    });
  });

  it("does not treat a longer scope name as owned by its prefix", () => {
    const current = createPatchGraph("foo", {
      boxes: [{
        id: "obj-x",
        varName: "maxforge_foo_bar_obj_x",
        maxclass: "button",
        numinlets: 1,
        numoutlets: 1,
        outlettype: ["bang"],
        patchingRect: [10, 10, 24, 24],
        attributes: {},
      }],
      connections: [],
    });

    const plan = diffPatchGraphs(current, createEmptyPatchGraph("foo"));
    expect(plan.operations).toEqual([]);
  });

  it("creates parent subpatchers before their contents", () => {
    const desired = compileGraph(`
fx = p pass {
  in = inlet signal
  out = outlet signal
  in -> out
}
`);
    const plan = diffPatchGraphs(createEmptyPatchGraph("voices"), desired);

    expect(plan.operations.map((operation) => operation.op)).toEqual([
      "create",
      "create",
      "create",
      "connect",
    ]);
    expect(plan.operations[0]).toMatchObject({
      op: "create",
      targetPath: [],
      box: { id: "obj-fx" },
    });
    expect(plan.operations[1]).toMatchObject({
      op: "create",
      targetPath: ["maxforge_voices_obj_fx"],
      box: { id: "obj-in" },
    });
  });

  it("updates subpatcher attributes without recreating its contents", () => {
    const current = compileGraph(`
fx = p pass @hidden 0 {
  in = inlet signal
  out = outlet signal
  in -> out
}
`);
    const desired = compileGraph(`
fx = p pass @hidden 1 {
  in = inlet signal
  out = outlet signal
  in -> out
}
`);
    const plan = diffPatchGraphs(current, desired);

    expect(plan.operations).toEqual([
      {
        op: "set",
        targetPath: [],
        id: "obj-fx",
        varName: "maxforge_voices_obj_fx",
        attribute: "hidden",
        value: 1,
      },
    ]);
  });
});
