import { describe, it, expect, beforeAll } from "vitest";
import { parse, compile, decompile } from "../src/index.js";
import { ObjectDatabase } from "../src/core/types.js";
import dbData from "../data/objects.json" with { type: "json" };

const db = dbData as ObjectDatabase;

describe("parser", () => {
  it("parses a basic synth patch", () => {
    const source = `
freq = number
mt = mtof
osc = cycle~ 440
dac = ezdac~

freq -> mt -> osc -> dac
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.statements).toHaveLength(5);
    expect(ast.statements.filter((s) => s.type === "object_def")).toHaveLength(4);
    expect(ast.statements.filter((s) => s.type === "connection")).toHaveLength(1);
  });

  it("parses patch declaration", () => {
    const source = `patch "Test" | "A test" | 800x600\nosc = cycle~ 440`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.patchDecl?.name).toBe("Test");
    expect(ast.patchDecl?.description).toBe("A test");
    expect(ast.patchDecl?.size).toEqual([800, 600]);
  });

  it("parses connections with port specifiers", () => {
    const source = `
a = gate 2
b = toggle
a[1] -> b
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const conn = ast.statements.find((s) => s.type === "connection")!;
    expect(conn.type).toBe("connection");
    if (conn.type === "connection") {
      expect(conn.refs[0].outlet).toBe(1);
    }
  });

  it("handles comments and blank lines", () => {
    const source = `# comment line

osc = cycle~ 440
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.statements).toHaveLength(1);
  });

  it("parses subpatcher", () => {
    const source = `
fx = p delay {
  in = inlet~
  out = outlet~
  dly = tapin~ 500
  tap = tapout~ 250
  in -> dly -> tap -> out
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const sub = ast.statements.find((s) => s.type === "subpatcher_def")!;
    expect(sub.type).toBe("subpatcher_def");
    if (sub.type === "subpatcher_def") {
      expect(sub.subpatcherName).toBe("delay");
      expect(sub.body).toHaveLength(5);
    }
  });

  it("reports syntax errors", () => {
    const source = `this is garbage`;
    const { errors } = parse(source);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("compiler", () => {
  it("compiles a basic synth", () => {
    const source = `
freq = number
mt = mtof
osc = cycle~ 440
mul = *~ 0.5
vol = gain~
dac = ezdac~

freq -> mt -> osc -> mul -> vol -> dac
vol[1] -> dac[1]
`;
    const { ast, errors: parseErrors } = parse(source);
    expect(parseErrors).toHaveLength(0);

    const result = compile(ast, db);
    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.output!.patcher.boxes).toHaveLength(6);
    expect(result.output!.patcher.lines).toHaveLength(6);
  });

  it("detects duplicate names", () => {
    const source = `
a = cycle~ 440
a = cycle~ 220
`;
    const { ast } = parse(source);
    const result = compile(ast, db);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === "E001")).toBe(true);
  });

  it("detects undefined references", () => {
    const source = `
a = toggle
a -> b
`;
    const { ast } = parse(source);
    const result = compile(ast, db);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === "E002")).toBe(true);
  });

  it("detects unknown objects", () => {
    const source = `a = nonexistent_object`;
    const { ast } = parse(source);
    const result = compile(ast, db);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === "E003")).toBe(true);
  });

  it("allows unknown objects with flag", () => {
    const source = `a = custom_object`;
    const { ast } = parse(source);
    const result = compile(ast, db, true);
    expect(result.success).toBe(true);
  });

  it("detects outlet out of range", () => {
    const source = `
a = cycle~ 440
b = ezdac~
a[5] -> b
`;
    const { ast } = parse(source);
    const result = compile(ast, db);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === "E004")).toBe(true);
  });

  it("detects inlet outside subpatcher", () => {
    const source = `a = inlet`;
    const { ast } = parse(source);
    const result = compile(ast, db);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === "E006")).toBe(true);
  });

  it("sets correct patching_rect from auto-layout", () => {
    const source = `
a = cycle~ 440
b = *~ 0.5
a -> b
`;
    const { ast } = parse(source);
    const result = compile(ast, db);
    expect(result.success).toBe(true);

    const boxes = result.output!.patcher.boxes;
    const boxA = boxes.find((b) => b.box.text === "cycle~ 440")!.box;
    const boxB = boxes.find((b) => b.box.text === "*~ 0.5")!.box;

    expect(boxA.patching_rect[1]).toBeLessThan(boxB.patching_rect[1]);
  });

  it("does not add text field to UI objects", () => {
    const source = `
a = number
b = toggle
c = ezdac~
`;
    const { ast } = parse(source);
    const result = compile(ast, db);
    expect(result.success).toBe(true);

    const boxes = result.output!.patcher.boxes;
    for (const bw of boxes) {
      expect(bw.box.text).toBeUndefined();
    }
  });

  it("compiles subpatcher correctly", () => {
    const source = `
fx = p myfx {
  in = inlet~ "audio"
  out = outlet~ "audio"
  dly = tapin~ 500
  tap = tapout~ 250
  in -> dly -> tap -> out
}
`;
    const { ast } = parse(source);
    const result = compile(ast, db);
    expect(result.success).toBe(true);

    const topBox = result.output!.patcher.boxes[0].box;
    expect(topBox.maxclass).toBe("newobj");
    expect(topBox.text).toBe("p myfx");
    expect(topBox.numinlets).toBe(1);
    expect(topBox.numoutlets).toBe(1);
    expect(topBox.patcher).toBeDefined();
  });

  describe("argDependent resolution", () => {
    it("resolves gate outlets from arg", () => {
      const source = `
tog = toggle
g = gate 4
a = number
b = number
c = number
d = number
tog -> g
g -> a
g[1] -> b
g[2] -> c
g[3] -> d
`;
      const { ast } = parse(source);
      const result = compile(ast, db);
      expect(result.success).toBe(true);
      const gate = result.output!.patcher.boxes.find((bw) => bw.box.text === "gate 4")!.box;
      expect(gate.numoutlets).toBe(4);
      expect(gate.outlettype).toHaveLength(4);
    });

    it("resolves route outlets from arg count", () => {
      const source = `
r = route 1 2 3
a = toggle
b = toggle
c = toggle
d = toggle
r -> a
r[1] -> b
r[2] -> c
r[3] -> d
`;
      const { ast } = parse(source);
      const result = compile(ast, db);
      expect(result.success).toBe(true);
      const route = result.output!.patcher.boxes.find((bw) => bw.box.text === "route 1 2 3")!.box;
      expect(route.numoutlets).toBe(4);
    });

    it("resolves pack inlets from arg count", () => {
      const source = `
a = number
b = flonum
c = number
pk = pack 0 0. 0
a -> pk
b -> pk[1]
c -> pk[2]
`;
      const { ast } = parse(source);
      const result = compile(ast, db);
      expect(result.success).toBe(true);
      const pack = result.output!.patcher.boxes.find((bw) => bw.box.text === "pack 0 0. 0")!.box;
      expect(pack.numinlets).toBe(3);
    });

    it("resolves selector~ inlets from arg", () => {
      const source = `
sel = selector~ 4
a = cycle~ 440
b = cycle~ 220
c = cycle~ 330
d = cycle~ 110
out = ezdac~
a -> sel
b -> sel[1]
c -> sel[2]
d -> sel[3]
sel -> out
`;
      const { ast } = parse(source);
      const result = compile(ast, db);
      expect(result.success).toBe(true);
      const sel = result.output!.patcher.boxes.find((bw) => bw.box.text === "selector~ 4")!.box;
      expect(sel.numinlets).toBe(5);
    });

    it("ignores @attributes when counting args", () => {
      const source = `
r = route set get
a = toggle
b = toggle
c = toggle
r -> a
r[1] -> b
r[2] -> c
`;
      const { ast } = parse(source);
      const result = compile(ast, db);
      expect(result.success).toBe(true);
      const route = result.output!.patcher.boxes.find((bw) => bw.box.text === "route set get")!.box;
      expect(route.numoutlets).toBe(3);
    });
  });

  describe("decompile", () => {
    it("round-trips a basic synth", () => {
      const source = `
freq = number
mt = mtof
osc = cycle~ 440
mul = *~ 0.5
vol = gain~
dac = ezdac~

freq -> mt -> osc -> mul -> vol -> dac
vol[1] -> dac[1]
`;
      const { ast, errors: parseErrors } = parse(source);
      expect(parseErrors).toHaveLength(0);
      const compiled = compile(ast, db);
      expect(compiled.success).toBe(true);

      const dsl = decompile(compiled.output!);
      const { ast: ast2, errors: parseErrors2 } = parse(dsl);
      expect(parseErrors2).toHaveLength(0);

      const recompiled = compile(ast2, db);
      expect(recompiled.success).toBe(true);
      expect(recompiled.output!.patcher.boxes.length).toBe(compiled.output!.patcher.boxes.length);
      expect(recompiled.output!.patcher.lines.length).toBe(compiled.output!.patcher.lines.length);
    });

    it("preserves connection ports in round-trip", () => {
      const source = `
a = cycle~ 440
b = gain~
c = ezdac~
a -> b -> c
b[1] -> c[1]
`;
      const { ast } = parse(source);
      const compiled = compile(ast, db);
      const dsl = decompile(compiled.output!);
      expect(dsl).toContain("[1] ->");

      const { ast: ast2 } = parse(dsl);
      const recompiled = compile(ast2, db);
      const stereoLine = recompiled.output!.patcher.lines.find(
        (lw) => lw.patchline.source[1] === 1
      );
      expect(stereoLine).toBeDefined();
      expect(stereoLine!.patchline.destination[1]).toBe(1);
    });
  });
});
