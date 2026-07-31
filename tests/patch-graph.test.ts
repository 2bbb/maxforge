import { describe, expect, it } from "vitest";
import {
  compile,
  compileDslToPatchGraph,
  createEmptyPatchGraph,
  createPatchGraph,
  diffPatchGraphs,
  parse,
  PatchGraph,
  patcherToPatchGraph,
} from "../src/index.js";
import { ObjectDatabase } from "../src/core/types.js";
import dbData from "../data/objects.json" with { type: "json" };

const db = dbData as ObjectDatabase;

function compileGraph(source: string, scope = "voices"): PatchGraph {
  const result = compileDslToPatchGraph(source, db, scope);
  expect(result.errors).toHaveLength(0);
  expect(result.success).toBe(true);
  return result.graph!;
}

describe("managed patch graphs", () => {
  it("assigns stable managed varnames to generated and nested objects", () => {
    const graph = compileGraph(`
for i in 0..1 {
  osc_\${i} = cycle~ \${440 + i * 20}
}
fx = p pass {
  in = inlet~
  out = outlet~
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
  in = inlet~
  out = outlet~
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

  it("recreates subpatcher contents when the parent definition changes", () => {
    const current = compileGraph(`
fx = p pass @hidden 0 {
  in = inlet~
  out = outlet~
  in -> out
}
`);
    const desired = compileGraph(`
fx = p pass @hidden 1 {
  in = inlet~
  out = outlet~
  in -> out
}
`);
    const plan = diffPatchGraphs(current, desired);

    expect(plan.operations.filter((operation) => operation.op === "delete")).toHaveLength(3);
    expect(plan.operations.filter((operation) => operation.op === "create")).toHaveLength(3);
    expect(plan.operations.at(-1)?.op).toBe("connect");
  });
});
