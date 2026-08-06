import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import { parse, compile, decompile } from "../src/index.js";
import { toClipboardText, fromClipboardText } from "../src/core/clipboard.js";
import { ObjectDatabase } from "../src/core/types.js";
import dbData from "../data/objects.json" with { type: "json" };

const db = dbData as ObjectDatabase;
const fixturesDir = path.join(__dirname, "fixtures");
const examplesDir = path.join(__dirname, "..", "examples");

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), "utf-8");
}

// ---------------------------------------------------------------------------
// Snapshot tests
// ---------------------------------------------------------------------------
describe("snapshot", () => {
  const fixtures = [
    "basic_synth.maxdsl",
    "midi_synth.maxdsl",
    "subpatcher.maxdsl",
    "trigger_and_routing.maxdsl",
    "position_override.maxdsl",
    "edge_cases.maxdsl",
  ];

  for (const name of fixtures) {
    it(`matches snapshot: ${path.basename(name, ".maxdsl")}`, () => {
      const source = loadFixture(name);
      const { ast, errors } = parse(source);
      expect(errors).toHaveLength(0);
      const result = compile(ast, db);
      expect(result.success).toBe(true);
      expect(result.output!.patcher).toMatchSnapshot(
        path.basename(name, ".maxdsl")
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Public examples
// ---------------------------------------------------------------------------
describe("examples", () => {
  const examples = fs
    .readdirSync(examplesDir)
    .filter((name) => name.endsWith(".maxdsl"))
    .sort();

  for (const name of examples) {
    it(`compiles example: ${name}`, () => {
      const source = fs.readFileSync(path.join(examplesDir, name), "utf-8");
      const { ast, errors } = parse(source);
      expect(errors).toHaveLength(0);

      const result = compile(ast, db);
      expect(result.success).toBe(true);
    });
  }

  it("compiles the Max node.script demo harness with unknown Max runtime objects", () => {
    const source = fs.readFileSync(
      path.join(examplesDir, "max_node_script", "maxforge_node_script_demo.maxdsl"),
      "utf-8"
    );
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);

    const result = compile(ast, db, true);
    expect(result.success).toBe(true);
  });

  it("compiles the Max node.script runtime-generated DSL with unknown print object", () => {
    const source = fs.readFileSync(
      path.join(examplesDir, "max_node_script", "generated_patch.maxdsl"),
      "utf-8"
    );
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);

    const result = compile(ast, db, true);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round-trip (deep property comparison)
// ---------------------------------------------------------------------------
describe("round-trip", () => {
  function boxKey(bw: { box: { patching_rect: number[] } }): string {
    return bw.box.patching_rect.join(",");
  }

  it("preserves all box properties (basic_synth)", () => {
    const source = loadFixture("basic_synth.maxdsl");
    const { ast } = parse(source);
    const original = compile(ast, db);
    expect(original.success).toBe(true);

    const dsl = decompile(original.output!);
    const { ast: ast2, errors } = parse(dsl);
    expect(errors).toHaveLength(0);

    const recompiled = compile(ast2, db);
    expect(recompiled.success).toBe(true);

    const origBoxes = original.output!.patcher.boxes;
    const reBoxes = recompiled.output!.patcher.boxes;
    expect(reBoxes.length).toBe(origBoxes.length);

    for (const ob of origBoxes) {
      const rb = reBoxes.find((b) => boxKey(b) === boxKey(ob));
      expect(rb).toBeDefined();
      expect(rb!.box.maxclass).toBe(ob.box.maxclass);
      expect(rb!.box.numinlets).toBe(ob.box.numinlets);
      expect(rb!.box.numoutlets).toBe(ob.box.numoutlets);
      expect(rb!.box.text ?? "").toBe(ob.box.text ?? "");
    }
  });

  it("preserves all line connections (basic_synth)", () => {
    const source = loadFixture("basic_synth.maxdsl");
    const { ast } = parse(source);
    const original = compile(ast, db);
    const dsl = decompile(original.output!);
    const { ast: ast2 } = parse(dsl);
    const recompiled = compile(ast2, db);

    const origLines = original.output!.patcher.lines;
    const reLines = recompiled.output!.patcher.lines;
    expect(reLines.length).toBe(origLines.length);

    // Build id→index maps for position-based matching
    const origMap = new Map(
      original.output!.patcher.boxes.map((b, i) => [b.box.id, i])
    );
    const reMap = new Map(
      recompiled.output!.patcher.boxes.map((b, i) => [b.box.id, i])
    );

    for (const ol of origLines) {
      const match = reLines.find((rl) => {
        const oSrcIdx = origMap.get(ol.patchline.source[0]) ?? -1;
        const oDstIdx = origMap.get(ol.patchline.destination[0]) ?? -1;
        const rSrcIdx = reMap.get(rl.patchline.source[0]) ?? -1;
        const rDstIdx = reMap.get(rl.patchline.destination[0]) ?? -1;
        return (
          oSrcIdx === rSrcIdx &&
          ol.patchline.source[1] === rl.patchline.source[1] &&
          oDstIdx === rDstIdx &&
          ol.patchline.destination[1] === rl.patchline.destination[1]
        );
      });
      expect(match).toBeDefined();
    }
  });

  it("round-trips subpatcher preserving box count", () => {
    const source = loadFixture("subpatcher.maxdsl");
    const { ast } = parse(source);
    const original = compile(ast, db);
    const dsl = decompile(original.output!);
    const { ast: ast2 } = parse(dsl);
    const recompiled = compile(ast2, db);

    expect(recompiled.output!.patcher.boxes.length).toBe(
      original.output!.patcher.boxes.length
    );
    expect(recompiled.output!.patcher.lines.length).toBe(
      original.output!.patcher.lines.length
    );
  });
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------
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
    expect(ast.statements.filter((s) => s.type === "object_def")).toHaveLength(
      4
    );
    expect(
      ast.statements.filter((s) => s.type === "connection")
    ).toHaveLength(1);
  });

  it("parses patch declaration", () => {
    const source = `patch "Test" | "A test" | 800x600\nosc = cycle~ 440`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.patchDecl?.name).toBe("Test");
    expect(ast.patchDecl?.description).toBe("A test");
    expect(ast.patchDecl?.size).toEqual([800, 600]);
  });

  it("parses escaped patch metadata without splitting quoted pipes", () => {
    const source = String.raw`patch "A | \"quoted\" title" | "Line\nA | B" | 801x601
n = number`;
    const { ast, errors } = parse(source);

    expect(errors).toHaveLength(0);
    expect(ast.patchDecl).toEqual({
      name: 'A | "quoted" title',
      description: "Line\nA | B",
      size: [801, 601],
    });
  });

  it("rejects malformed and duplicate patch declarations", () => {
    for (const source of [
      'patch "Test" | description | 800x600',
      'patch "Test" | "Description" | wide',
      'patch ""',
      'patch "Test" | "Description" | 0x600',
      'patch "Test\\q"',
      'patch "Test" | "Description" | 800x600 | extra',
      'patch "First"\npatch "Second"',
    ]) {
      const { errors } = parse(source);
      expect(errors, source).toHaveLength(1);
      expect(errors[0].code).toBe("E007");
    }
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
  in = inlet signal
  out = outlet signal
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

describe("stable object ids", () => {
  it("derives ids from DSL names instead of statement order", () => {
    const compileIds = (source: string) => {
      const { ast, errors } = parse(source);
      expect(errors).toHaveLength(0);
      const result = compile(ast, db);
      expect(result.success).toBe(true);
      return result.output!.patcher.boxes.map(({ box }) => box.id);
    };

    expect(compileIds("osc = cycle~ 440\ndac = ezdac~")).toEqual([
      "obj-osc",
      "obj-dac",
    ]);
    expect(compileIds("gain = *~ 0.5\nosc = cycle~ 440\ndac = ezdac~")).toEqual([
      "obj-gain",
      "obj-osc",
      "obj-dac",
    ]);
  });

});

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------
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

  it("compiles a button output connection", () => {
    const source = `
fire = button
value = random 128
display = number
fire -> value -> display
`;
    const { ast, errors: parseErrors } = parse(source);
    expect(parseErrors).toHaveLength(0);

    const result = compile(ast, db);
    expect(result.success).toBe(true);
    expect(result.output!.patcher.lines).toHaveLength(2);

    const button = result.output!.patcher.boxes.find(
      ({ box }) => box.maxclass === "button"
    )!.box;
    expect(button.numoutlets).toBe(1);
    expect(button.outlettype).toEqual(["bang"]);
  });

  it("allows unknown objects with flag", () => {
    const source = `
a = custom_object
b = custom_sink
a[4] -> b[3]
`;
    const { ast } = parse(source);
    const result = compile(ast, db, true);
    expect(result.success).toBe(true);
    expect(result.output!.patcher.lines[0].patchline.source).toEqual(["obj-a", 4]);
    expect(result.output!.patcher.lines[0].patchline.destination).toEqual(["obj-b", 3]);
  });

  it("emits patch declaration metadata into patcher JSON", () => {
    const source = `patch "Meta" | "Generated patch" | 900x700\nn = number`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    expect(result.output!.patcher.rect).toEqual([100, 100, 900, 700]);
    expect(result.output!.patcher.title).toBe("Meta");
    expect(result.output!.patcher.description).toBe("Generated patch");
    expect(decompile(result.output!)).toContain(
      'patch "Meta" | "Generated patch" | 900x700'
    );
  });

  it("warns and emits one line for duplicate connections", () => {
    const source = `
a = toggle
b = toggle
a -> b
a -> b
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    expect(result.output!.patcher.lines).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe("W001");
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
  in = inlet signal "audio"
  out = outlet signal "audio"
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
    expect(topBox.outlettype).toEqual(["signal"]);
    expect(topBox.patcher).toBeDefined();
  });

  it("emits inlet and outlet labels as comments inside subpatchers", () => {
    const source = `
fx = p labelled {
  in = inlet "control input"
  out = outlet signal "audio output"
  in -> out
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    const innerBoxes = result.output!.patcher.boxes[0].box.patcher!.boxes;
    const inlet = innerBoxes.find((b) => b.box.maxclass === "inlet")!.box;
    const outlet = innerBoxes.find((b) => b.box.maxclass === "outlet")!.box;
    expect(inlet.text).toBeUndefined();
    expect(inlet.outlettype).toEqual([""]);
    expect(inlet.comment).toBe("control input");
    expect(outlet.text).toBeUndefined();
    expect(outlet.comment).toBe("audio output");
  });

  it("uses real Max inlet/outlet classes for signal ports", () => {
    const source = `
fx = p mixed_ports {
  audio_in = inlet signal "audio input"
  control_in = inlet "control input"
  audio_out = outlet signal "audio output"
  control_out = outlet "control output"
  audio_in -> audio_out
  control_in -> control_out
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(true);

    const subpatcher = result.output!.patcher.boxes[0].box;
    expect(subpatcher.numinlets).toBe(2);
    expect(subpatcher.numoutlets).toBe(2);
    expect(subpatcher.outlettype).toEqual(["signal", ""]);

    const inner = subpatcher.patcher!.boxes.map(({ box }) => box);
    expect(inner.map((box) => box.maxclass)).toEqual([
      "inlet",
      "inlet",
      "outlet",
      "outlet",
    ]);
    expect(inner[0].outlettype).toEqual(["signal"]);
    expect(inner[1].outlettype).toEqual([""]);

    const decompiled = decompile(result.output!);
    expect(decompiled).toContain('audio_in = inlet signal "audio input"');
    expect(decompiled).toContain('audio_out = outlet signal "audio output"');
    expect(decompiled).not.toContain("inlet~");
    expect(decompiled).not.toContain("outlet~");
  });

  it("rejects fabricated inlet~ and outlet~ object names", () => {
    const { ast, errors } = parse(`
fx = p invalid_ports {
  in = inlet~
  out = outlet~
}
`);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(["E003", "E003"]);
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
      const gate = result.output!.patcher.boxes.find(
        (bw) => bw.box.text === "gate 4"
      )!.box;
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
      const route = result.output!.patcher.boxes.find(
        (bw) => bw.box.text === "route 1 2 3"
      )!.box;
      expect(route.numinlets).toBe(4);
      expect(route.numoutlets).toBe(4);
    });

    it("does not invent a fixed upper bound for runtime-defined ports", () => {
      const source = `
voice = poly~ voice.maxpat 8
out = dac~
voice[3] -> out[1]
`;
      const { ast } = parse(source);
      const result = compile(ast, db);
      expect(result.success).toBe(true);
      expect(result.output!.patcher.lines[0].patchline.source).toEqual(["obj-voice", 3]);
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
      const pack = result.output!.patcher.boxes.find(
        (bw) => bw.box.text === "pack 0 0. 0"
      )!.box;
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
      const sel = result.output!.patcher.boxes.find(
        (bw) => bw.box.text === "selector~ 4"
      )!.box;
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
      const route = result.output!.patcher.boxes.find(
        (bw) => bw.box.text === "route set get"
      )!.box;
      expect(route.numoutlets).toBe(3);
    });

    it("resolves trigger outlets and types from args", () => {
      const source = `
trig = trigger bang float int
lb = loadbang
lb -> trig
`;
      const { ast } = parse(source);
      const result = compile(ast, db);
      expect(result.success).toBe(true);
      const t = result.output!.patcher.boxes.find((bw) =>
        bw.box.text?.startsWith("trigger ")
      )!.box;
      expect(t.numoutlets).toBe(3);
      expect(t.outlettype).toEqual(["bang", "float", "int"]);
    });

    it("resolves t alias with shorthand types", () => {
      const source = `
trig = t b f i l
lb = loadbang
lb -> trig
`;
      const { ast } = parse(source);
      const result = compile(ast, db);
      expect(result.success).toBe(true);
      const t = result.output!.patcher.boxes.find((bw) =>
        bw.box.text?.startsWith("t ")
      )!.box;
      expect(t.numoutlets).toBe(4);
      expect(t.outlettype).toEqual(["bang", "float", "int", ""]);
    });
  });
});

// ---------------------------------------------------------------------------
// Error detection (E001–E008)
// ---------------------------------------------------------------------------
describe("error detection", () => {
  it("E001: duplicate name", () => {
    const { ast } = parse(`a = cycle~ 440\na = cycle~ 220`);
    const result = compile(ast, db);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === "E001")).toBe(true);
  });

  it("E002: undefined reference", () => {
    const { ast } = parse(`a = toggle\na -> b`);
    const result = compile(ast, db);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === "E002")).toBe(true);
  });

  it("E003: unknown object type", () => {
    const { ast } = parse(`a = nonexistent_object`);
    const result = compile(ast, db);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === "E003")).toBe(true);
  });

  it("E004: outlet index out of range", () => {
    const { ast } = parse(`a = cycle~ 440\nb = ezdac~\na[5] -> b`);
    const result = compile(ast, db);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === "E004")).toBe(true);
  });

  it("E005: inlet index out of range", () => {
    const { ast } = parse(`a = toggle\nb = toggle\na -> b[5]`);
    const result = compile(ast, db);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === "E005")).toBe(true);
  });

  it("E006: inlet/outlet outside subpatcher", () => {
    const { ast } = parse(`a = inlet`);
    const result = compile(ast, db);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === "E006")).toBe(true);
  });

  it("E007: syntax error", () => {
    const { errors } = parse(`this is garbage`);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.code === "E007")).toBe(true);
  });

  it("E008: subpatcher with no inlet or outlet", () => {
    const source = `
fx = p empty {
  x = cycle~ 440
}
`;
    const { ast } = parse(source);
    const result = compile(ast, db);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === "E008")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  it("comment with -> is not treated as connection", () => {
    const source = `cmt = comment "A -> B -> C"`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.statements[0].type).toBe("object_def");
  });

  it("parses at(x,y) position override", () => {
    const source = `osc = cycle~ 440 at(100, 200)`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const obj = ast.statements[0];
    if (obj.type === "object_def") {
      expect(obj.pos).toEqual([100, 200]);
      expect(obj.objectText).toBe("cycle~ 440");
    }
  });

  it("respects at(x,y) in compiled output", () => {
    const source = `
a = cycle~ 440 at(100, 200)
b = cycle~ 220
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    const a = result.output!.patcher.boxes.find(
      (b) => b.box.text === "cycle~ 440"
    )!.box;
    const b = result.output!.patcher.boxes.find(
      (b) => b.box.text === "cycle~ 220"
    )!.box;
    expect(a.patching_rect[0]).toBe(100);
    expect(a.patching_rect[1]).toBe(200);
    // b should be auto-layouted, not at (0,0)
    expect(b.patching_rect[0]).toBe(50);
  });

  it("handles nested subpatchers", () => {
    const source = `
outer = p outer_patch {
  o_in = inlet
  o_out = outlet
  inner = p inner_patch {
    in = inlet
    out = outlet
    in -> out
  }
  o_in -> inner -> o_out
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    const outer = result.output!.patcher.boxes[0].box;
    expect(outer.patcher).toBeDefined();
    const innerBox = outer.patcher!.boxes.find(
      (b: { box: { text: string } }) => b.box.text === "p inner_patch"
    );
    expect(innerBox).toBeDefined();
    expect(innerBox!.box.patcher).toBeDefined();
  });

  it("handles empty patch", () => {
    const source = `patch "Empty"`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    expect(result.output!.patcher.boxes).toHaveLength(0);
  });

  it("handles send/receive pair", () => {
    const source = `
snd = send mybus
rcv = receive mybus
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    const s = result.output!.patcher.boxes.find(
      (b) => b.box.text === "send mybus"
    )!.box;
    const r = result.output!.patcher.boxes.find(
      (b) => b.box.text === "receive mybus"
    )!.box;
    expect(s.numinlets).toBe(1);
    expect(s.numoutlets).toBe(0);
    expect(r.numinlets).toBe(0);
    expect(r.numoutlets).toBe(1);
  });

  it("decompiles operator objects preserving text", () => {
    const source = `
mul = *~ 0.5
add = +~ 0.1
mul -> add
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    const dsl = decompile(result.output!);
    expect(dsl).toContain("*~ 0.5");
    expect(dsl).toContain("+~ 0.1");
  });

  it("decompiles with unique names for duplicate operators", () => {
    const source = `
a = *~ 0.5
b = *~ 0.3
dac = ezdac~
a -> dac
b -> dac[1]
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    const dsl = decompile(result.output!);
    const { ast: ast2, errors: errors2 } = parse(dsl);
    expect(errors2).toHaveLength(0);
  });

  it("handles message objects", () => {
    const source = `
msg = message "open file.txt"
tog = toggle
tog -> msg
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    const msg = result.output!.patcher.boxes.find(
      (b) => b.box.maxclass === "message"
    )!.box;
    expect(msg.text).toBe("open file.txt");
  });

  it("uses the Max 9 loadbang port shape", () => {
    const source = `lb = loadbang`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    const lb = result.output!.patcher.boxes[0].box;
    expect(lb.numinlets).toBe(1);
    expect(lb.numoutlets).toBe(1);
  });
});

describe("clipboard", () => {
  it("produces valid compressed text with markers", () => {
    const source = loadFixture("basic_synth.maxdsl");
    const { ast } = parse(source);
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    const json = JSON.stringify(result.output);
    const clip = toClipboardText(json);

    expect(clip).toContain("----------begin_max5_patcher-----------");
    expect(clip).toContain("-----------end_max5_patcher-----------");
    expect(clip).toMatch(/^\d+\./m);
  });

  it("round-trips through clipboard format", () => {
    const source = loadFixture("basic_synth.maxdsl");
    const { ast } = parse(source);
    const result = compile(ast, db);
    expect(result.success).toBe(true);

    const json = JSON.stringify(result.output);
    const clip = toClipboardText(json);
    const recovered = fromClipboardText(clip);
    const recoveredObj = JSON.parse(recovered);

    expect(recoveredObj.patcher.boxes.length).toBe(
      result.output!.patcher.boxes.length
    );
    expect(recoveredObj.patcher.lines.length).toBe(
      result.output!.patcher.lines.length
    );
  });

  it("clipboard → DSL round-trip produces valid DSL", () => {
    const source = loadFixture("basic_synth.maxdsl");
    const { ast } = parse(source);
    const result = compile(ast, db);
    expect(result.success).toBe(true);

    const json = JSON.stringify(result.output);
    const clip = toClipboardText(json);
    const recoveredJson = fromClipboardText(clip);
    const patch = JSON.parse(recoveredJson);
    const dsl = decompile(patch);

    const { ast: ast2, errors } = parse(dsl);
    expect(errors).toHaveLength(0);
    const recompiled = compile(ast2, db);
    expect(recompiled.success).toBe(true);
    expect(recompiled.output!.patcher.boxes.length).toBe(
      result.output!.patcher.boxes.length
    );
  });
});

// ---------------------------------------------------------------------------
// Attribute tests
// ---------------------------------------------------------------------------
describe("attributes", () => {
  it("parses single @key value into attrs", () => {
    const { ast, errors } = parse('freq = number @minimum 0');
    expect(errors).toHaveLength(0);
    expect(ast.statements).toHaveLength(1);
    const stmt = ast.statements[0] as any;
    expect(stmt.type).toBe("object_def");
    expect(stmt.objectText).toBe("number");
    expect(stmt.attrs).toEqual({ minimum: [0] });
  });

  it("parses multiple @key value pairs", () => {
    const { ast, errors } = parse('freq = number @minimum 0 @maximum 127');
    expect(errors).toHaveLength(0);
    const stmt = ast.statements[0] as any;
    expect(stmt.objectText).toBe("number");
    expect(stmt.attrs).toEqual({ minimum: [0], maximum: [127] });
  });

  it("parses @key with multiple values as array", () => {
    const { ast, errors } = parse('s = slider @size 20 100');
    expect(errors).toHaveLength(0);
    const stmt = ast.statements[0] as any;
    expect(stmt.attrs).toEqual({ size: [20, 100] });
  });

  it("parses @key with string value", () => {
    const { ast, errors } = parse('n = number @fontname "Courier"');
    expect(errors).toHaveLength(0);
    const stmt = ast.statements[0] as any;
    expect(stmt.attrs).toEqual({ fontname: ["Courier"] });
  });

  it("round-trips escaped quotes and backslashes in attribute strings", () => {
    const source = String.raw`n = number @fontname "A \"quoted\" \\ font"`;
    const parsed = parse(source);
    expect(parsed.errors).toHaveLength(0);
    const stmt = parsed.ast.statements[0] as any;
    expect(stmt.attrs).toEqual({ fontname: ['A "quoted" \\ font'] });

    const compiled = compile(parsed.ast, db);
    expect(compiled.success).toBe(true);
    const decompiled = decompile(compiled.output!);
    const reparsed = parse(decompiled);
    expect(reparsed.errors).toHaveLength(0);
    const recompiled = compile(reparsed.ast, db);
    expect(recompiled.output!.patcher.boxes[0].box.fontname).toBe(
      'A "quoted" \\ font'
    );
  });

  it.each([
    ["empty attribute name", "n = number @ 1", "Invalid attribute name"],
    ["missing attribute value", "n = number @minimum", "requires at least one value"],
    ["duplicate attribute", "n = number @minimum 0 @minimum 1", "Duplicate attribute"],
    ["unterminated attribute string", 'n = number @fontname "broken', "Unterminated quoted string"],
  ])("rejects %s", (_label, source, message) => {
    const { errors } = parse(source);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "E007", message: expect.stringContaining(message) }),
    ]));
  });

  it.each([
    ["comment", "c = comment unquoted"],
    ["message", "m = message"],
    ["message", 'm = message "valid" trailing'],
  ])("requires one quoted string for %s text", (_type, source) => {
    const { errors } = parse(source);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "E007",
        message: expect.stringContaining("must be one quoted string"),
      }),
    ]));
  });

  it("does not treat @ inside quoted object text as an attribute", () => {
    const { ast, errors } = parse('msg = message "@target open" @presentation 1');
    expect(errors).toHaveLength(0);
    const stmt = ast.statements[0] as any;
    expect(stmt.objectText).toBe('message "@target open"');
    expect(stmt.attrs).toEqual({ presentation: [1] });
  });

  it("preserves escaped @ arguments in object text and round-trips them", () => {
    const source = String.raw`sync = maxforge.sync \@host 127.0.0.1 \@port 8766 @presentation 1`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);

    const stmt = ast.statements[0] as any;
    expect(stmt.objectText).toBe(
      "maxforge.sync @host 127.0.0.1 @port 8766"
    );
    expect(stmt.attrs).toEqual({ presentation: [1] });

    const result = compile(ast, db);
    expect(result.success).toBe(true);
    const box = result.output!.patcher.boxes[0].box as any;
    expect(box.text).toBe("maxforge.sync @host 127.0.0.1 @port 8766");
    expect(box.host).toBeUndefined();
    expect(box.presentation).toBe(1);

    const decompiled = decompile(result.output!);
    expect(decompiled).toContain(
      String.raw`maxforge.sync \@host 127.0.0.1 \@port 8766 @presentation 1`
    );

    const reparsed = parse(decompiled);
    expect(reparsed.errors).toHaveLength(0);
    const recompiled = compile(reparsed.ast, db);
    expect(recompiled.success).toBe(true);
    expect(recompiled.output!.patcher.boxes[0].box).toMatchObject({
      text: "maxforge.sync @host 127.0.0.1 @port 8766",
      presentation: 1,
    });
  });

  it("compiles single-value attrs as scalar in box JSON", () => {
    const { ast } = parse('freq = number @minimum 0 @maximum 127');
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    const box = result.output!.patcher.boxes[0].box as any;
    expect(box.minimum).toBe(0);
    expect(box.maximum).toBe(127);
  });

  it("compiles multi-value attrs as array in box JSON", () => {
    const { ast } = parse('s = slider @size 20 100');
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    const box = result.output!.patcher.boxes[0].box as any;
    expect(box.size).toEqual([20, 100]);
  });

  it("compiles and decompiles attrs in round-trip", () => {
    const dsl = 'freq = number @minimum 0 @maximum 127\nout = number';
    const { ast } = parse(dsl);
    const result = compile(ast, db);
    expect(result.success).toBe(true);

    const decompiled = decompile(result.output!);
    expect(decompiled).toContain("@minimum 0");
    expect(decompiled).toContain("@maximum 127");

    const { ast: ast2, errors } = parse(decompiled);
    expect(errors).toHaveLength(0);
    const result2 = compile(ast2, db);
    expect(result2.success).toBe(true);

    const box1 = result.output!.patcher.boxes[0].box as any;
    const box2 = result2.output!.patcher.boxes[0].box as any;
    expect(box1.minimum).toBe(box2.minimum);
    expect(box1.maximum).toBe(box2.maximum);
  });

  it("omits unsupported structured attributes instead of corrupting them", () => {
    const patch = compile(parse("n = number").ast, db).output!;
    patch.patcher.boxes[0].box.saved_object_attributes = { attr_comment: "" };
    patch.patcher.boxes[0].box.embedstate = [["dim", 256, 256]];

    const dsl = decompile(patch);
    expect(dsl).toContain(
      "# maxforge omitted unsupported attribute @saved_object_attributes from number"
    );
    expect(dsl).toContain(
      "# maxforge omitted unsupported attribute @embedstate from number"
    );
    expect(dsl).not.toContain("[object Object]");
    expect(parse(dsl).errors).toHaveLength(0);
  });

  it("handles attrs with at(x, y) position", () => {
    const { ast, errors } = parse('freq = number @minimum 0 @maximum 127 at(100, 200)');
    expect(errors).toHaveLength(0);
    const stmt = ast.statements[0] as any;
    expect(stmt.objectText).toBe("number");
    expect(stmt.attrs).toEqual({ minimum: [0], maximum: [127] });
    expect(stmt.pos).toEqual([100, 200]);

    const result = compile(ast, db);
    expect(result.success).toBe(true);
    const box = result.output!.patcher.boxes[0].box as any;
    expect(box.minimum).toBe(0);
    expect(box.maximum).toBe(127);
    expect(box.patching_rect[0]).toBe(100);
    expect(box.patching_rect[1]).toBe(200);
  });

  it("preserves attrs through clipboard round-trip", () => {
    const dsl = 'freq = number @minimum 0 @maximum 127\nout = number';
    const { ast } = parse(dsl);
    const result = compile(ast, db);
    expect(result.success).toBe(true);

    const json = JSON.stringify(result.output);
    const clip = toClipboardText(json);
    const recoveredJson = fromClipboardText(clip);
    const patch = JSON.parse(recoveredJson);
    const decompiled = decompile(patch);

    expect(decompiled).toContain("@minimum 0");
    expect(decompiled).toContain("@maximum 127");
  });
});

// ---------------------------------------------------------------------------
// Syntax validation regression tests
// ---------------------------------------------------------------------------
describe("syntax validation regressions", () => {
  it("propagates syntax errors from subpatcher bodies", () => {
    const { errors } = parse(`
fx = p bad {
  ?bad
}
`);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("E007");
  });

  it("rejects reserved attributes that would corrupt generated box JSON", () => {
    const { ast, errors } = parse("n = number @patching_rect 1 2");
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe("E009");
  });

  it("preserves subpatcher box attrs during decompile", () => {
    const source = `
fx = p inner @color 1 0 0 1 {
  i = inlet
  o = outlet
  i -> o
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    const dsl = decompile(result.output!);
    expect(dsl).toContain("= p inner @color 1 0 0 1 at(");
  });

  it("decompiles box positions as at(x, y) and preserves them through recompile", () => {
    const source = `
osc = cycle~ 440 at(123, 234)
dac = ezdac~ at(321, 432)
osc -> dac
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(true);

    const dsl = decompile(result.output!);
    expect(dsl).toContain("cycle~ 440 at(123, 234)");
    expect(dsl).toContain("ezdac~ at(321, 432)");

    const { ast: ast2, errors: errors2 } = parse(dsl);
    expect(errors2).toHaveLength(0);
    const result2 = compile(ast2, db);
    expect(result2.success).toBe(true);
    const osc = result2.output!.patcher.boxes.find(
      (b) => b.box.text === "cycle~ 440"
    )!.box;
    const dac = result2.output!.patcher.boxes.find(
      (b) => b.box.maxclass === "ezdac~"
    )!.box;
    expect(osc.patching_rect[0]).toBe(123);
    expect(osc.patching_rect[1]).toBe(234);
    expect(dac.patching_rect[0]).toBe(321);
    expect(dac.patching_rect[1]).toBe(432);
  });

  it("parses and compiles subpatcher at(x, y) positions", () => {
    const source = `
fx = p inner @color 0 1 0 1 at(200, 300) {
  i = inlet
  o = outlet
  i -> o
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const sub = ast.statements[0] as any;
    expect(sub.pos).toEqual([200, 300]);

    const result = compile(ast, db);
    expect(result.success).toBe(true);
    const box = result.output!.patcher.boxes[0].box as any;
    expect(box.patching_rect[0]).toBe(200);
    expect(box.patching_rect[1]).toBe(300);
    expect(box.color).toEqual([0, 1, 0, 1]);
  });
});
